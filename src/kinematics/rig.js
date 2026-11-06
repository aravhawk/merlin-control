/**
 * View rig — all of the "feel" lives here.
 *
 * Orientation is held as quaternions only (no Euler angles → no gimbal lock).
 * Inputs (hands, XR) never write the orientation directly. They
 * push *rotation deltas* into a pending accumulator; every frame a fraction of
 * the pending rotation is consumed (critically-damped follow). That gives a
 * weighted, filtered feel, preserves the total rotation exactly (no drift), and
 * lets us measure the angular velocity that was actually applied.
 *
 * Releasing a grab hands the measured velocity to a free-spin integrator with
 * light exponential damping. Re-grabbing ("catch") decays the spin to zero over
 * a short eased interval instead of stopping dead.
 *
 * Two styles are supported:
 *   'model' – the model rotates, the camera stays put (default, original demo)
 *   'orbit' – the camera orbits the model
 */
import { Quaternion, Vector3, MathUtils } from 'three';

const _axis = new Vector3();
const _q = new Quaternion();
const _qp = new Quaternion(); // previous view
const _qs = new Quaternion(); // setView scratch
const _qr = new Quaternion(); // scratch used only by _rotate
const _qd = new Quaternion(); // per-frame applied delta
const IDENTITY = new Quaternion();

export const PRESETS = {
  home: { yaw: -28, pitch: 12 },
  front: { yaw: 0, pitch: 0 },
  side: { yaw: -90, pitch: 0 },
  top: { yaw: 0, pitch: 90 },
  bottom: { yaw: 0, pitch: -90 },
  iso: { yaw: -42, pitch: 26 },
};

export function presetQuaternion(name) {
  const p = PRESETS[name] ?? PRESETS.home;
  const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(p.yaw));
  const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(p.pitch));
  return qx.multiply(qy);
}

/** Fraction of the remaining gap to close this frame for an exponential follow with time constant `tau`. */
const follow = (dt, tau) => 1 - Math.exp(-dt / tau);
const _w = new Vector3();

/** small-angle rotation vector → quaternion (axis*angle) */
export function quatFromRotationVector(v, out = new Quaternion()) {
  const a = v.length();
  if (a < 1e-9) return out.identity();
  _axis.copy(v).multiplyScalar(1 / a);
  return out.setFromAxisAngle(_axis, a);
}

export class Rig {
  constructor() {
    this.mode = 'model';

    this.q = new Quaternion(); // model orientation (model mode)
    this.qc = new Quaternion(); // camera orbit orientation (orbit mode)
    this.view = new Quaternion(); // effective view orientation = qc⁻¹ · q

    this.pending = new Quaternion(); // rotation requested but not yet applied
    this.omega = new Vector3(); // free-spin angular velocity (rad/s, view frame)
    this.appliedSpeed = 0; // measured angular speed of what was applied last frame
    this.catching = false; // a catch is in progress: spin decays fast until it reaches zero

    // distances are set by the app's framing (setHome); these are placeholders
    this.dist = 7;
    this.distTarget = 7;
    this.homeDist = 7;
    this.minDist = 2.8;
    this.maxDist = 24;
    this.frameScale = 1; // extra camera pull-back requested by the view (e.g. exploded parts)

    this.pan = { x: 0, y: 0 }; // NDC offset of the model (model mode)
    this.panTarget = { x: 0, y: 0 };
    this.target = new Vector3(); // orbit-mode look-at point
    this.targetGoal = new Vector3();
    this.tanHalfFov = Math.tan(MathUtils.degToRad(17));
    this.aspect = 1.6;

    this.held = false;
    this.history = []; // {t, w:Vector3} raw angular velocity samples (seconds)
    this._pool = [];
    this.goal = null;

    // tunables
    this.followTau = 0.075; // s — how quickly pending rotation is consumed
    this.spinTau = 3.2; // s — exponential damping of free spin
    this.catchTau = 0.14; // s — how fast a catch kills the spin
    this.panTau = 0.12;
    this.zoomTau = 0.14;
    this.maxSpin = 16; // rad/s
    this.minSpin = 0.9; // below this a release does not start a spin

    this.view.copy(this.q);
  }

  // ── orientation helpers ────────────────────────────────────────────
  _syncView() {
    // view = qc⁻¹ · q
    this.view.copy(this.qc).invert().multiply(this.q).normalize();
  }

  /** Apply a view-frame rotation. */
  _rotate(dq) {
    if (this.mode === 'model') {
      this.q.premultiply(dq).normalize();
    } else {
      // camera moves the opposite way: qc' = qc · dq⁻¹
      _qr.copy(dq).invert();
      this.qc.multiply(_qr).normalize();
    }
    this._syncView();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    // keep the picture identical across the switch
    this.q.copy(this.view);
    this.qc.identity();
    this.mode = mode;
    this._syncView();
  }

  setView(qv) {
    if (this.mode === 'model') this.q.copy(qv);
    else this.qc.copy(this.q).multiply(_qs.copy(qv).invert());
    this._syncView();
  }

  clearHistory() {
    for (const h of this.history) this._pool.push(h);
    this.history.length = 0;
  }

  // ── input API ──────────────────────────────────────────────────────
  /** Clutch engaged. Catches any free spin. */
  beginGrab() {
    this.held = true;
    this.catching = this.spinning; // a catch keeps decaying even if the grab is brief
    this.goal = null;
    this.pending.identity();
    this.clearHistory();
  }

  /**
   * Feed a rotation delta (view frame) that occurred over `dt` seconds at time `t` (s).
   * `weight` softly fades the delta (clutch engagement) without polluting flick history.
   */
  addRotation(dq, dt, t, weight = 1) {
    if (dt > 1e-4) {
      const angle = 2 * Math.acos(MathUtils.clamp(dq.w, -1, 1));
      const s = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
      // drop expired samples into a pool so steady tracking doesn't allocate per update
      while (this.history.length >= 40 || (this.history.length && t - this.history[0].t > 0.6)) this._pool.push(this.history.shift());
      const sample = this._pool.pop() ?? { t: 0, w: new Vector3() };
      sample.t = t;
      sample.w.set(0, 0, 0);
      if (s > 1e-6 && angle > 1e-6) {
        const a = angle > Math.PI ? angle - 2 * Math.PI : angle;
        sample.w.set(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(a / dt);
      }
      this.history.push(sample);
    }
    if (weight < 0.999) _q.copy(IDENTITY).slerp(dq, weight);
    else _q.copy(dq);
    this.pending.premultiply(_q).normalize();
  }

  /**
   * Clutch released. Estimates the hand's angular velocity just *before* release and
   * converts it into free spin. `from`/`to` bound the lookback window in seconds
   * before `tRelease` (skip the last few ms — that is where a closing fist disturbs tracking).
   */
  endGrab(tRelease, { from = 0.3, to = 0.05, flick = true } = {}) {
    this.held = false;
    if (!flick) {
      this.clearHistory();
      return;
    }
    let sum = new Vector3();
    let wsum = 0;
    for (const s of this.history) {
      const age = tRelease - s.t;
      if (age < to || age > from) continue;
      const w = Math.exp(-(age - to) / (0.5 * (from - to)));
      sum.addScaledVector(s.w, w);
      wsum += w;
    }
    this.clearHistory();
    if (wsum <= 0) return;
    sum.multiplyScalar(1 / wsum);
    const speed = sum.length();
    if (speed < this.minSpin) return;
    if (speed > this.maxSpin) sum.multiplyScalar(this.maxSpin / speed);
    this.spin(sum);
  }

  /** Start a free spin (view-frame angular velocity, rad/s). The single entry point for spins. */
  spin(omega) {
    this.omega.copy(omega);
    this.catching = false;
  }

  /** Start catching a spin (eased stop), e.g. from the Space key. */
  stopSpin() {
    this.catching = this.spinning;
  }

  /** Actual camera distance: the user's zoom times the view's framing scale. */
  get cameraDist() {
    return this.dist * this.frameScale;
  }

  /** Sets the framing distance, keeping the user's current zoom ratio. */
  setHome(home) {
    const k = home / this.homeDist;
    this.homeDist = home;
    this.minDist = home * 0.32;
    this.maxDist = home * 3.6;
    this.dist *= k;
    this.distTarget *= k;
  }

  zoomBy(factor) {
    this.goal = null;
    this.distTarget = MathUtils.clamp(this.distTarget * factor, this.minDist, this.maxDist);
  }

  /** screen-space pan in NDC units (x right, y up) */
  panBy(dx, dy) {
    this.goal = null;
    if (this.mode === 'orbit') {
      const halfH = this.cameraDist * this.tanHalfFov;
      _axis.set(-dx * halfH * this.aspect, -dy * halfH, 0).applyQuaternion(this.qc);
      this.targetGoal.add(_axis);
      return;
    }
    this.panTarget.x = MathUtils.clamp(this.panTarget.x + dx, -1.4, 1.4);
    this.panTarget.y = MathUtils.clamp(this.panTarget.y + dy, -1.4, 1.4);
  }

  /** Smoothly fly to a preset / explicit view. */
  goTo({ view, dist = this.homeDist, pan = { x: 0, y: 0 } }) {
    this.goal = { view: view.clone(), dist, pan };
    this.omega.set(0, 0, 0);
    this.pending.identity();
  }

  get spinning() {
    return this.omega.lengthSq() > 0.05 * 0.05;
  }

  // ── integration ────────────────────────────────────────────────────
  update(dt) {
    dt = Math.min(dt, 0.1);
    const prevView = _qp.copy(this.view);

    // preset fly-to (critically damped)
    if (this.goal) {
      const f = follow(dt, 0.17);
      _q.copy(this.view).slerp(this.goal.view, f);
      this.setView(_q);
      this.distTarget += (this.goal.dist - this.distTarget) * f;
      this.panTarget.x += (this.goal.pan.x - this.panTarget.x) * f;
      this.panTarget.y += (this.goal.pan.y - this.panTarget.y) * f;
      this.targetGoal.multiplyScalar(1 - f);
      const angle = this.view.angleTo(this.goal.view);
      if (angle < 0.002 && Math.abs(this.goal.dist - this.distTarget) < 0.01) {
        this.setView(this.goal.view);
        this.distTarget = this.goal.dist;
        this.panTarget.x = this.goal.pan.x;
        this.panTarget.y = this.goal.pan.y;
        this.goal = null;
      }
    }

    // consume pending (grab-driven) rotation
    if (this.pending.w < 0.9999999) {
      const f = follow(dt, this.followTau);
      _qd.copy(IDENTITY).slerp(this.pending, f);
      this._rotate(_qd);
      this.pending.premultiply(_qd.invert()).normalize();
    }

    // free spin + catch
    if (this.omega.lengthSq() > 1e-8) {
      this._rotate(quatFromRotationVector(_w.copy(this.omega).multiplyScalar(dt), _q));
      // eased damping: gentle when free, firm when the user is holding on or catching
      const tau = this.held || this.catching ? this.catchTau : this.spinTau;
      this.omega.multiplyScalar(Math.exp(-dt / tau));
      if (this.omega.lengthSq() < 0.012 * 0.012) {
        this.omega.set(0, 0, 0);
        this.catching = false;
      }
    }

    // measured applied angular velocity (for sfx / UI)
    this.appliedSpeed = this.view.angleTo(prevView) / Math.max(dt, 1e-4);

    // zoom / pan (weighted)
    const zf = follow(dt, this.zoomTau);
    this.dist = Math.exp(Math.log(this.dist) + (Math.log(this.distTarget) - Math.log(this.dist)) * zf);
    const pf = follow(dt, this.panTau);
    this.pan.x += (this.panTarget.x - this.pan.x) * pf;
    this.pan.y += (this.panTarget.y - this.pan.y) * pf;
    this.target.lerp(this.targetGoal, pf);
  }

  /** Overall angular speed (rad/s) used for audio/UI feedback. */
  get speed() {
    return Math.max(this.omega.length(), this.appliedSpeed);
  }
}
