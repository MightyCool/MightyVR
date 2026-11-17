import * as THREE from 'three';
import { SmoothBuf } from './smooth.js';
import { HandModel } from './handmodel.js';

const BASE = import.meta.env.BASE_URL + 'mediapipe/';
const loadScript = (src) => new Promise((res, rej) => {
  if (window.Hands) { res(); return; }
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the hand model'));
  document.head.appendChild(s);
});
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Hand tracking (MediaPipe Hands, lite model, self-hosted) from the rear camera.
 *  - Scheduling: 30 Hz while a hand is tracked, 10 Hz while searching; backs off if rendering drops under 50 fps or inference is slow;
 *    never feeds the same camera frame twice.
 *  - Pointer: ray from your eyes through the pinch point, extrapolated between results so it feels immediate.
 *  - Pinch anchoring: closing your fingers moves the pinch point, so while the fingers are closing the pointer is held and only follows your
 *    knuckles (which do not move when you pinch); it re-joins the fingertips smoothly after you let go.
 *  - A glove-style 3D hand (real-size world landmarks, placed by apparent palm size) shows what is tracked.
 */
export class HandInput {
  constructor(camera, settings, head) {
    this.camera = camera; this.s = settings; this.head = head;
    this.running = false; this.ready = false; this.busy = false; this.last = 0; this.lastSeen = 0; this.lastVT = -1; this.cost = 30;
    this.lm = null; this.wl = null; this.pinch = false; this.ratio = 1;
    this.fps = 0; this.frames = 0; this.t0 = performance.now();
    this.aim = new SmoothBuf(2, 2.5, 10);
    this.shape = new SmoothBuf(63, 5, 25);
    this.mid = new Float32Array(2); this.vel = new Float32Array(2); this.resT = 0; this.prevT = 0;
    this.stab = new Float32Array(2); this.s0 = new Float32Array(2); this.fa = new Float32Array(2); this.out = new Float32Array(2);
    this.frozen = false; this.anchor = new Float32Array(2);
    this.pts = new Float32Array(63);
    this.pinch3 = new THREE.Vector3(); this.depth = 0.5;
    this.pointer = { active: false, origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), pressed: false, scroll: 0, pinchAmount: 0 };
    this.model = new HandModel();
    head.add(this.model.group);
    this.v1 = new THREE.Vector3(); this.v2 = new THREE.Vector3(); this.v3 = new THREE.Vector3(); this.tgt = new Float32Array(2);
  }

  get tracking() { return this.pointer.active; }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      this.video = await this.camera.use('hands');
      await loadScript(BASE + 'hands.js');
      this.hands = new window.Hands({ locateFile: (f) => BASE + f });
      this.hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
      this.hands.onResults((r) => this.onResults(r));
      await this.hands.initialize();
      this.ready = true;
    } catch (e) { this.stop(); throw e; }
  }

  stop() {
    this.running = false; this.ready = false;
    this.camera.release('hands');
    if (this.hands) { try { this.hands.close(); } catch { /* already closed */ } this.hands = null; }
    this.pointer.active = false; this.pointer.pressed = false; this.model.group.visible = false;
    this.aim.reset(); this.shape.reset(); this.frozen = false;
  }

  /** Call every frame. renderFps = current rendering frame rate (inference yields to rendering when it dips). */
  tick(now, renderFps = 60) {
    if (!this.ready || this.busy || !this.camera.ready) return;
    let gap = this.pointer.active ? 33 : 100;
    if (renderFps < 50) gap *= 1.7;
    gap = Math.max(gap, this.cost * 1.6); // inference that takes 40 ms is never asked more than every ~64 ms
    if (now - this.last < gap) return;
    const vt = this.video.currentTime;
    if (vt === this.lastVT) return; // same camera frame as last time
    this.lastVT = vt; this.last = now; this.busy = true;
    this.hands.send({ image: this.video }).catch(() => {}).finally(() => { this.busy = false; this.cost += (performance.now() - now - this.cost) * 0.2; });
  }

  onResults(r) {
    this.frames++;
    const now = performance.now();
    if (now - this.t0 > 1000) { this.fps = this.frames; this.frames = 0; this.t0 = now; }
    const L = r.multiHandLandmarks && r.multiHandLandmarks[0];
    const score = r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].score : 1;
    if (!L || score < 0.6) return;
    if (now - this.lastSeen > 400) { this.aim.reset(); this.shape.reset(); this.frozen = false; this.anchor[0] = this.anchor[1] = 0; this.prevT = 0; }
    const asp = this.camera.aspect, dist = (a, b) => Math.hypot((a.x - b.x) * asp, a.y - b.y); // aspect-correct image distances
    this.ratio = dist(L[4], L[8]) / (dist(L[0], L[9]) || 1);
    if (!this.pinch && this.ratio < 0.33) this.pinch = true; else if (this.pinch && this.ratio > 0.5) this.pinch = false;
    const mx = (L[4].x + L[8].x) / 2, my = (L[4].y + L[8].y) / 2;
    const dt = (now - this.prevT) / 1000;
    if (this.prevT && dt > 0.005 && dt < 0.3) { this.vel[0] = clamp((mx - this.mid[0]) / dt, -3, 3); this.vel[1] = clamp((my - this.mid[1]) / dt, -3, 3); } else { this.vel[0] = this.vel[1] = 0; }
    this.stab[0] = (L[5].x + L[9].x) / 2; this.stab[1] = (L[5].y + L[9].y) / 2; // knuckles: do not move when the fingers close
    this.mid[0] = mx; this.mid[1] = my; this.prevT = now; this.resT = now;
    this.lm = L; this.wl = r.multiHandWorldLandmarks && r.multiHandWorldLandmarks[0]; this.lastSeen = now;
  }

  /** Camera-image point -> tangent-space direction (x, y, -1); the camera's horizontal FOV is a setting. */
  local(x, y, out) {
    const t = Math.tan((this.s.camFov * Math.PI) / 360);
    return out.set((x - 0.5) * 2 * t, (0.5 - y) * 2 * (t / this.camera.aspect), -1);
  }

  update(headQuat, dt) {
    const p = this.pointer, now = performance.now();
    p.active = this.running && this.ready && now - this.lastSeen < 400 && !!this.lm;
    p.pressed = p.active && this.pinch;
    this.model.group.visible = p.active && this.s.handModel;
    if (!p.active) { this.shape.reset(); p.pinchAmount = 0; return; }
    dt = Math.min(dt, 0.1);
    const L = this.lm, since = Math.min(0.06, (now - this.resT) / 1000);

    // pointer: pinch point (smoothed, extrapolated a little between inference results); frozen to the knuckles while the fingers close
    if (!this.frozen && this.ratio < 0.75) { this.frozen = true; this.fa.set(this.out); this.s0.set(this.stab); }
    else if (this.frozen && this.ratio > 0.9) { this.frozen = false; this.anchor[0] = this.out[0] - this.mid[0]; this.anchor[1] = this.out[1] - this.mid[1]; }
    if (this.frozen) { this.tgt[0] = this.fa[0] + this.stab[0] - this.s0[0]; this.tgt[1] = this.fa[1] + this.stab[1] - this.s0[1]; }
    else {
      const f = Math.exp(-dt * 10); this.anchor[0] *= f; this.anchor[1] *= f; // re-join the fingertips smoothly after letting go
      this.tgt[0] = this.mid[0] + this.vel[0] * since * 0.6 + this.anchor[0]; this.tgt[1] = this.mid[1] + this.vel[1] * since * 0.6 + this.anchor[1];
    }
    const sm = this.aim.update(this.tgt, dt);
    this.out[0] = sm[0]; this.out[1] = sm[1];
    this.local(sm[0], sm[1], p.dir).normalize().applyQuaternion(headQuat);
    p.pinchAmount = this.pinch ? 1 : clamp((0.85 - this.ratio) / 0.52, 0, 1);

    // joints in head-local metres (real-size world landmarks, wrist placed by apparent palm size)
    const wl = this.wl, a = this.local(L[0].x, L[0].y, this.v1), b = this.local(L[9].x, L[9].y, this.v2);
    const palm = wl ? Math.hypot(wl[0].x - wl[9].x, wl[0].y - wl[9].y, wl[0].z - wl[9].z) : 0.09;
    const depth = clamp(palm / Math.max(Math.hypot(a.x - b.x, a.y - b.y), 0.02), 0.15, 0.9);
    this.depth += (depth - this.depth) * Math.min(1, dt * 8);
    const wx = a.x * depth, wy = a.y * depth, wz = -depth, pts = this.pts, q = this.v3;
    for (let i = 0; i < 21; i++) {
      this.local(L[i].x, L[i].y, q);
      pts[i * 3] = wl ? wx + (wl[i].x - wl[0].x) : q.x * depth;
      pts[i * 3 + 1] = wl ? wy - (wl[i].y - wl[0].y) : q.y * depth;
      pts[i * 3 + 2] = wl ? wz - (wl[i].z - wl[0].z) : -depth;
    }
    const s = this.shape.update(pts, dt);
    this.pinch3.set((s[12] + s[24]) / 2, (s[13] + s[25]) / 2, (s[14] + s[26]) / 2);
    if (this.model.group.visible) this.model.update(s, this.pinch);
  }
}
