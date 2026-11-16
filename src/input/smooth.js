/** Adaptive low-pass: heavy smoothing when slow (steady aim), light when fast (no lag). */
export class Smooth {
  constructor(min = 1.5, beta = 8) { this.min = min; this.beta = beta; this.v = null; }
  reset() { this.v = null; }
  /** x: number[] ; dt seconds ; returns smoothed array */
  update(x, dt) {
    if (!this.v) { this.v = x.slice(); return this.v; }
    const speed = Math.hypot(...x.map((a, i) => a - this.v[i])) / Math.max(dt, 1e-3);
    const a = 1 - Math.exp(-dt * (this.min + this.beta * speed));
    this.v = this.v.map((p, i) => p + (x[i] - p) * a);
    return this.v;
  }
}

/** Same adaptive low-pass on a typed array, in place (no per-frame allocation). */
export class SmoothBuf {
  constructor(n, min = 1.5, beta = 8) { this.v = new Float32Array(n); this.ready = false; this.min = min; this.beta = beta; }
  reset() { this.ready = false; }
  update(src, dt) {
    const v = this.v, n = v.length;
    if (!this.ready) { for (let i = 0; i < n; i++) v[i] = src[i]; this.ready = true; return v; }
    let d2 = 0;
    for (let i = 0; i < n; i++) { const e = src[i] - v[i]; d2 += e * e; }
    const a = 1 - Math.exp(-dt * (this.min + (this.beta * Math.sqrt(d2)) / Math.max(dt, 1e-3)));
    for (let i = 0; i < n; i++) v[i] += (src[i] - v[i]) * a;
    return v;
  }
}
