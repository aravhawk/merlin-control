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

const alphaFor = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export interface OneEuroParams {
  /** Hz — cutoff when the signal is still (lower = smoother, laggier) */
  minCutoff?: number;
  /** speed coefficient — how much the cutoff rises with velocity (higher = less lag) */
  beta?: number;
  /** Hz — cutoff for the derivative estimate */
  dCutoff?: number;
}

export class OneEuro {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  x: number | null = null;
  dx = 0;
  t: number | null = null;

  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 }: OneEuroParams = {}) {
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

  /** `value` is the raw sample, `t` its timestamp in seconds. */
  filter(value: number, t: number): number {
    if (this.x === null || this.t === null) {
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

export type Vec3Tuple = [number, number, number];

/** Filter for a fixed-size vector (e.g. one landmark's x,y,z). */
export class OneEuroVec {
  readonly f: OneEuro[];

  constructor(size: number, params?: OneEuroParams) {
    this.f = Array.from({ length: size }, () => new OneEuro(params));
  }
  reset() {
    this.f.forEach((f) => f.reset());
  }
  /** Filters one 3-component sample into `out`; takes scalars so per-landmark filtering allocates nothing. */
  filter3(x: number, y: number, z: number, t: number, out: Vec3Tuple): Vec3Tuple {
    out[0] = this.f[0].filter(x, t);
    out[1] = this.f[1].filter(y, t);
    out[2] = this.f[2].filter(z, t);
    return out;
  }
}
