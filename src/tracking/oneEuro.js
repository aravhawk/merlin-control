/**
 * One-Euro filter (Casiez, Roussel, Vogel — CHI 2012).
 * An adaptive low-pass: heavy smoothing when the signal is slow (kills jitter),
 * light smoothing when it is fast (keeps responsiveness).
 *
 *   cutoff = minCutoff + beta * |filtered derivative|
 *
 * Timestamps are supplied by the caller (seconds) so the filter stays correct
 * even though camera frames arrive at an irregular rate.
 */

const alphaFor = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  /** @param {number} value  raw sample  @param {number} t  seconds */
  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      this.dx = 0;
      return value;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    const aD = alphaFor(this.dCutoff, dt);
    this.dx = this.dx + aD * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alphaFor(cutoff, dt);
    this.x = this.x + a * (value - this.x);
    return this.x;
  }
}

/** Filter for a fixed-size vector (e.g. one landmark's x,y,z). */
export class OneEuroVec {
  constructor(size, params) {
    this.f = Array.from({ length: size }, () => new OneEuro(params));
  }
  reset() {
    this.f.forEach((f) => f.reset());
  }
  /** filters in place into `out` (array-like) */
  filter(input, t, out = []) {
    for (let i = 0; i < this.f.length; i++) out[i] = this.f[i].filter(input[i], t);
    return out;
  }
  /** 3-component variant that takes scalars, so per-landmark filtering allocates nothing */
  filter3(x, y, z, t, out) {
    out[0] = this.f[0].filter(x, t);
    out[1] = this.f[1].filter(y, t);
    out[2] = this.f[2].filter(z, t);
    return out;
  }
}
