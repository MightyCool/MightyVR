import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makePanel, canvasTex, card, text } from '../ui/kit.js';

const YAWS = 12, PITCHES = [-45, -22.5, 0, 22.5, 45], CELLS = YAWS * PITCHES.length;
const SCAN_R = 2.6, SEEN_COS = Math.cos((26 * Math.PI) / 180);
const ROUND = 60, MAX_TARGETS = 6, HIT_R = 0.25, DRAW_RANGE = 0.1, GRAVITY = 3.5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rnd = (a, b) => a + Math.random() * (b - a);

/** Orientation-only room scan: which directions around you have you looked at? (iPhone Safari has no depth sensing, so this maps directions, not surfaces.) */
export function cellDir(i, out = new THREE.Vector3()) {
  const yaw = ((i % YAWS) * 2 * Math.PI) / YAWS, pitch = (PITCHES[(i / YAWS) | 0] * Math.PI) / 180;
  return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

function arrowGeometry() {
  const shaft = new THREE.CylinderGeometry(0.0055, 0.0055, 0.46, 6).rotateX(Math.PI / 2).translate(0, 0, -0.23);
  const head = new THREE.ConeGeometry(0.014, 0.06, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.49);
  const tail = new THREE.BoxGeometry(0.03, 0.002, 0.07).translate(0, 0, -0.03);
  const paint = (g, r, gg, b) => { const n = g.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; };
  return mergeGeometries([paint(shaft, 0.9, 0.82, 0.6), paint(head, 0.35, 0.35, 0.4), paint(tail, 0.9, 0.2, 0.2)]);
}

/**
 * AR Game: scan your space by looking around, then shoot targets with a bow and arrow.
 * Hand tracking: pinch to nock, pull your hand back toward your face to draw, release to shoot along your aim.
 * No hand tracking (or no hand in view): look at a target for a moment and an arrow flies at it.
 */
export const arGame = {
  id: 'ar',
  name: 'AR Game',
  icon: '🎯',

  init(ctx) {
    const A = (this.A = ctx.actions);
    this.ctx = ctx; this.scene = ctx.scene; this.head = A.head; this.hands = A.hands;
    this.wasHands = A.settings.hands; this.wasPT = A.settings.passthrough;
    this.objs = [];
    if (!this.wasHands) A.setHands(true);
    if (!this.wasPT) A.setPassthrough(true); // real camera behind the targets
    this.seen = new Uint8Array(CELLS); this.dirs = Array.from({ length: CELLS }, (_, i) => cellDir(i));
    this.phase = 'scan'; this.score = 0; this.time = ROUND; this.targets = []; this.arrows = []; this.fx = [];
    this.drawing = false; this.draw = 0; this.d0 = 0.4; this.aimHist = []; this.gz = 0; this.hudT = 0; this.msg = '';
    this.v = new THREE.Vector3(); this.v2 = new THREE.Vector3(); this.v3 = new THREE.Vector3();

    // scan dots (one draw call)
    const pos = new Float32Array(CELLS * 3), col = new Float32Array(CELLS * 3);
    this.dirs.forEach((d, i) => { pos.set([d.x * SCAN_R, d.y * SCAN_R, d.z * SCAN_R], i * 3); col.set([0.35, 0.4, 0.5], i * 3); });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.dots = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
    this.dots.frustumCulled = false;
    this.add(this.dots);

    // shared bits
    this.arrowGeo = arrowGeometry();
    this.arrowMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const ring = canvasTex(128, 128, (c, w) => { [[1, '#d33'], [0.72, '#fff'], [0.5, '#d33'], [0.28, '#fff'], [0.12, '#d33']].forEach(([r, col]) => { c.beginPath(); c.arc(w / 2, w / 2, (w / 2) * r, 0, 7); c.fillStyle = col; c.fill(); }); });
    this.ringTex = ring;

    // bow: limbs, string, nocked arrow (forward = -Z)
    this.bow = new THREE.Group();
    const limb = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.22, 0), new THREE.Vector3(0, 0, -0.16), new THREE.Vector3(0, -0.22, 0)), 16, 0.007, 6),
      new THREE.MeshLambertMaterial({ color: 0x8a5a2b }));
    this.stringGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.22, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.22, 0)]);
    this.string = new THREE.Line(this.stringGeo, new THREE.LineBasicMaterial({ color: 0xeeeeee }));
    this.nock = new THREE.Mesh(this.arrowGeo, this.arrowMat);
    this.nock.visible = false;
    this.bow.add(limb, this.string, this.nock);
    this.bow.visible = false;
    this.add(this.bow);

    // UI (kept inside y -1.3..1.3, below the standard title row)
    this.hud = makePanel({ w: 2.6, h: 0.3, r: 2.8, y: 1.15, px: 768, draw: () => {} });
    this.info = makePanel({ w: 3.2, h: 1.0, r: 2.8, y: 0.15, px: 1024, draw: () => {} });
    ctx.parent.add(this.hud, this.info);
    const btn = (label, angle) => ctx.button({
      w: 1.1, h: 0.34, r: 2.75, angle, y: -1.1, px: 320,
      draw: (c, w, h) => { card(c, w, h, 'rgba(79,124,255,.6)', 40); text(c, label, w / 2, h / 2, 40, { weight: '600' }); },
      onClick: () => this.press(label),
    });
    this.bStart = btn('Start now', 0); this.bAgain = btn('Play again', -12); this.bRescan = btn('Rescan', 12);
    this.showPhase();
  },

  add(o) { this.scene.add(o); this.objs.push(o); },

  press(label) {
    if (label === 'Start now' && this.phase === 'scan') this.startPlay();
    else if (label === 'Play again' && this.phase === 'over') this.startPlay();
    else if (label === 'Rescan') { this.seen.fill(0); this.clearTargets(); this.phase = 'scan'; this.showPhase(); }
  },

  coverage() { let n = 0; for (let i = 0; i < CELLS; i++) n += this.seen[i]; return n / CELLS; },

  startPlay() {
    this.clearTargets(); this.score = 0; this.time = ROUND; this.phase = 'play';
    if (this.coverage() < 0.08) { this.seen.fill(1); } // nothing scanned: use the whole sphere
    for (let i = 0; i < MAX_TARGETS; i++) this.spawn();
    this.showPhase();
  },

  showPhase() {
    this.bStart.visible = this.phase === 'scan';
    this.bAgain.visible = this.phase === 'over'; this.bRescan.visible = this.phase === 'over' || this.phase === 'play';
    this.info.visible = this.phase !== 'play';
    this.dots.visible = this.phase === 'scan';
    this.drawInfo(); this.drawHud();
  },

  drawInfo() {
    const c = this.info.userData.tex.image, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height); card(g, c.width, c.height, 'rgba(14,20,40,.9)', 30);
    const lines = this.phase === 'scan'
      ? ['Scan your space', 'Look slowly all around you until the dots turn green.', 'Then: pinch, pull your hand back, release to shoot.', 'No hand tracking? Just look at a target.']
      : [`Time! Score ${this.score}`, 'Play again with the same space, or rescan.'];
    lines.forEach((l, i) => text(g, l, c.width / 2, 120 + i * 130 - (lines.length < 3 ? 0 : 60) , i === 0 ? 70 : 36, { color: i === 0 ? '#fff' : '#9fb0d8', weight: i === 0 ? '700' : '500' }));
    this.info.userData.tex.needsUpdate = true;
  },

  drawHud() {
    const c = this.hud.userData.tex.image, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height); card(g, c.width, c.height, 'rgba(14,20,40,.9)', 36);
    const s = this.phase === 'scan' ? `Scanning… ${Math.round(this.coverage() * 100)}%` : this.phase === 'play' ? `Score ${this.score}    ⏱ ${Math.ceil(this.time)}s` : `Final score ${this.score}`;
    text(g, this.msg || s, c.width / 2, c.height / 2, 42, { weight: '700' });
    this.hud.userData.tex.needsUpdate = true;
  },

  spawn() {
    const free = []; for (let i = 0; i < CELLS; i++) if (this.seen[i]) free.push(i);
    for (let tries = 0; tries < 12; tries++) {
      const d = this.dirs[free[(Math.random() * free.length) | 0]].clone();
      d.applyAxisAngle(new THREE.Vector3(0, 1, 0), rnd(-0.2, 0.2)); d.y = clamp(d.y + rnd(-0.12, 0.12), -0.7, 0.7); d.normalize();
      const p = d.multiplyScalar(rnd(1.8, 3.4));
      if (this.targets.some((t) => t.position.distanceTo(p) < 0.7)) continue;
      const m = new THREE.Mesh(new THREE.CircleGeometry(HIT_R - 0.03, 28), new THREE.MeshBasicMaterial({ map: this.ringTex, transparent: true, side: THREE.DoubleSide }));
      m.position.copy(p); m.lookAt(this.head.position);
      m.userData = { y0: p.y, ph: Math.random() * 6, age: 0, hit: 0 };
      this.add(m); this.targets.push(m);
      return m;
    }
    return null;
  },

  kill(arr, m, own = true) { // own: the mesh owns its material/geometry (targets); arrows share theirs
    const i = arr.indexOf(m); if (i >= 0) arr.splice(i, 1);
    this.scene.remove(m); const j = this.objs.indexOf(m); if (j >= 0) this.objs.splice(j, 1);
    if (own) { m.material.dispose(); m.geometry.dispose(); }
  },
  clearTargets() { [...this.targets].forEach((t) => this.kill(this.targets, t)); [...this.arrows].forEach((a) => this.kill([], a.mesh, false)); this.arrows.length = 0; },

  fire(from, dir, speed) {
    if (this.arrows.length >= 8) return;
    const mesh = new THREE.Mesh(this.arrowGeo, this.arrowMat);
    mesh.position.copy(from); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    this.add(mesh);
    this.arrows.push({ mesh, vel: dir.clone().multiplyScalar(speed), life: 3, prev: from.clone() });
  },

  /** Closest distance from point p to segment a-b. */
  segDist(a, b, p) {
    const ab = this.v.subVectors(b, a), t = clamp(this.v2.subVectors(p, a).dot(ab) / (ab.lengthSq() || 1), 0, 1);
    return this.v3.copy(a).addScaledVector(ab, t).distanceTo(p);
  },

  update(dt) {
    dt = Math.min(dt, 0.1);
    const head = this.head;
    // --- scan phase: mark the directions you have looked at
    if (this.phase === 'scan') {
      const fwd = this.v.set(0, 0, -1).applyQuaternion(head.quaternion);
      const col = this.dots.geometry.attributes.color;
      for (let i = 0; i < CELLS; i++) if (!this.seen[i] && this.dirs[i].dot(fwd) > SEEN_COS) { this.seen[i] = 1; col.setXYZ(i, 0.3, 1, 0.5); col.needsUpdate = true; }
      if (this.coverage() >= 0.55) this.startPlay();
    }
    // --- bow (hand) or gaze fallback
    const hp = this.hands.pointer, handOn = hp.active;
    this.bow.visible = handOn && this.phase === 'play';
    if (handOn && this.phase === 'play') this.bowUpdate(dt, hp); else { this.drawing = false; this.nock.visible = false; this.gazeFire(dt); }
    // --- play phase: timer, target motion, hits
    if (this.phase === 'play') {
      this.time -= dt;
      this.targets.forEach((t) => { const u = t.userData; u.age += dt; if (!u.hit) t.position.y = u.y0 + Math.sin(u.age * 1.3 + u.ph) * 0.06; else { u.hit += dt; t.scale.setScalar(1 + u.hit * 3); t.material.opacity = Math.max(0, 1 - u.hit * 4); if (u.hit > 0.25) { this.kill(this.targets, t); if (this.time > 0) this.spawn(); } } });
      if (this.time <= 0) { this.phase = 'over'; this.msg = ''; this.clearTargets(); this.showPhase(); }
    }
    // --- arrows
    for (const a of [...this.arrows]) {
      a.prev.copy(a.mesh.position);
      a.vel.y -= GRAVITY * dt; a.mesh.position.addScaledVector(a.vel, dt); a.life -= dt;
      this.v2.copy(a.vel).normalize(); a.mesh.quaternion.setFromUnitVectors(this.v3.set(0, 0, -1), this.v2);
      for (const t of this.targets) {
        if (t.userData.hit) continue;
        if (this.segDist(a.prev, a.mesh.position, t.position) < HIT_R) { t.userData.hit = 0.001; this.score += 10 + Math.round(t.position.length() * 5); this.msg = ''; a.life = 0; this.drawHud(); break; }
      }
      if (a.life <= 0) { this.arrows.splice(this.arrows.indexOf(a), 1); this.scene.remove(a.mesh); this.objs.splice(this.objs.indexOf(a.mesh), 1); }
    }
    this.hudT += dt;
    if (this.hudT > 0.2) { this.hudT = 0; this.drawHud(); }
  },

  bowUpdate(dt, hp) {
    const head = this.head, hands = this.hands;
    const pos = head.localToWorld(this.v.copy(hands.pinch3));
    this.bow.position.copy(pos);
    this.bow.lookAt(pos.x - hp.dir.x, pos.y - hp.dir.y, pos.z - hp.dir.z); // forward = -Z along the aim
    if (hp.pressed && !this.drawing) { this.drawing = true; this.d0 = hands.depth; this.draw = 0; this.aimHist.length = 0; }
    if (this.drawing) {
      this.draw += (clamp((this.d0 - hands.depth) / DRAW_RANGE, 0, 1) - this.draw) * Math.min(1, dt * 12);
      this.aimHist.push(hp.dir.clone()); if (this.aimHist.length > 8) this.aimHist.shift();
    }
    if (!hp.pressed && this.drawing) {
      this.drawing = false;
      if (this.draw > 0.2 && this.phase === 'play') {
        const d = this.aimHist[Math.max(0, this.aimHist.length - 6)] || hp.dir; // the aim from just before the release wobble
        this.fire(pos.clone().addScaledVector(d, 0.35), d.clone().normalize(), 7 + 15 * this.draw);
      }
      this.draw = 0;
    }
    const pull = this.draw * 0.28;
    this.stringGeo.attributes.position.setZ(1, pull); this.stringGeo.attributes.position.needsUpdate = true;
    this.nock.visible = this.drawing; this.nock.position.z = pull;
  },

  gazeFire(dt) {
    if (this.phase !== 'play') { this.gz = 0; return; }
    const fwd = this.v.set(0, 0, -1).applyQuaternion(this.head.quaternion);
    let hit = null;
    for (const t of this.targets) { if (!t.userData.hit && this.v2.copy(t.position).normalize().dot(fwd) > Math.cos(0.07)) { hit = t; break; } }
    this.gz = hit ? this.gz + dt : 0;
    if (hit && this.gz > 0.6) {
      this.gz = -0.4; // short cooldown
      const from = this.v2.set(0, -0.3, -0.3).applyQuaternion(this.head.quaternion).clone();
      this.fire(from, hit.position.clone().sub(from).normalize(), 18);
    }
  },

  dispose() {
    [...this.objs].forEach((o) => this.scene.remove(o));
    this.objs.length = 0;
    this.dots.geometry.dispose(); this.dots.material.dispose(); this.arrowGeo.dispose(); this.arrowMat.dispose(); this.ringTex.dispose();
    if (!this.wasHands) this.A.setHands(false);
    if (!this.wasPT) this.A.setPassthrough(false);
  },
};
