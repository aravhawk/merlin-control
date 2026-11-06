/**
 * Gesture state machine: filtered hand features → rig commands.
 *
 *   open palm  = clutch engaged ("grab")        fist = clutch released
 *   1 open hand  → trackball rotation (+ roll from twisting the hand)
 *   2 open hands → hand distance = zoom, midpoint = pan, hand-line roll = model roll
 *   release (open → fist) after fast motion → flick: angular velocity is imparted
 *   open palm while spinning → catch: the spin decays to zero over a short eased interval
 */
import { MathUtils, Quaternion, Vector3 } from 'three';
import { quatFromRotationVector, type Rig } from '../kinematics/rig.ts';
import { wrapPi, type Track } from './handPipeline.ts';

export type GestureState = 'none' | 'idle' | 'single' | 'dual';
export type GestureEvent = { type: 'grab' | 'release' | 'catch' | 'flick' };
export interface GestureSettings {
  sensitivity: number;
  invertZoom: boolean;
}

interface SingleBase {
  t: number;
  x: number;
  y: number;
  roll: number;
}
interface DualBase {
  t: number;
  mx: number;
  my: number;
  d: number;
  ang: number;
}

const _rv = new Vector3();
const _q = new Quaternion();
const Z = new Vector3(0, 0, 1);

// clutch weight fades the applied rotation to zero as the hand closes (openness W_HI → W_LO)
const W_LO = 0.3;
const W_HI = 0.65;
const clutchWeight = (tr: Track): number => MathUtils.smoothstep(tr.openness, W_LO, W_HI);

export const GAINS = {
  translate: 3.4, // rad per frame-width of palm travel
  roll: 0.8,
  rollDeadzone: 0.012, // rad per update — wrist→knuckle angle is the noisiest signal, gate it
  pan: 2.0,
  zoom: 1.5,
  deadzone: 0.003, // rad — ignore sub-jitter motion
  settle: 0.12, // s after a grab during which the baseline just follows the hand (opening the palm shifts landmarks)
};

export class GestureController {
  state: GestureState = 'none';
  /** current clutch weight 0..1 */
  weight = 0;
  private readonly rig: Rig;
  private readonly getSettings: () => GestureSettings;
  private readonly emit: (e: GestureEvent) => void;
  private base: SingleBase | DualBase | null = null;
  private activeIds: number[] = [];
  private engagedAt = 0;

  constructor(rig: Rig, getSettings: () => GestureSettings, emit: (e: GestureEvent) => void = () => {}) {
    this.rig = rig;
    this.getSettings = getSettings;
    this.emit = emit;
  }

  /** Called when tracking stops (camera off). */
  release(t = performance.now() / 1000): void {
    if (this.state === 'single' || this.state === 'dual') this.rig.endGrab(t, { flick: false });
    this.state = 'none';
    this.base = null;
    this.activeIds = [];
    this.weight = 0;
  }

  /** `tracks` are the pipeline's alive tracks; `t` uses the pipeline's clock (s); `aspectInv` = video height / width. */
  update(tracks: readonly Track[], t: number, aspectInv = 0.75): void {
    const alive = tracks.filter((tr) => tr.stable);
    const open = alive.filter((tr) => tr.open && tr.frames >= 6).sort((a, b) => a.id - b.id);
    let desired: GestureState = 'none';
    if (open.length >= 2) desired = 'dual';
    else if (open.length === 1) desired = 'single';
    else if (alive.length) desired = 'idle';

    const active = open.slice(0, desired === 'dual' ? 2 : desired === 'single' ? 1 : 0);
    const ids = active.map((x) => x.id);
    const sameIds = ids.length === this.activeIds.length && ids.every((v, i) => v === this.activeIds[i]);

    if (desired !== this.state || !sameIds) this._transition(desired, ids, t);

    if (this.state === 'single') this._single(active[0], t);
    else if (this.state === 'dual') this._dual(active, t, aspectInv);
  }

  private _transition(next: GestureState, ids: number[], t: number): void {
    const prev = this.state;
    const wasHeld = prev === 'single' || prev === 'dual';
    const willHold = next === 'single' || next === 'dual';

    if (!wasHeld && willHold) {
      const catching = this.rig.spinning;
      this.rig.beginGrab();
      this.emit({ type: 'grab' });
      if (catching) this.emit({ type: 'catch' });
    } else if (wasHeld && !willHold) {
      // single → fist: flick. Anything leaving dual: just stop.
      const flick = prev === 'single';
      this.rig.endGrab(t, { flick });
      this.emit({ type: 'release' });
      if (flick && this.rig.omega.lengthSq() > 0.01) this.emit({ type: 'flick' });
    } else if (wasHeld && willHold) {
      // hand count changed or hands swapped: keep clutch, drop stale flick history
      this.rig.clearHistory();
    }

    this.state = next;
    this.activeIds = ids;
    this.base = null; // rebase on the next frame
    if (!willHold) this.weight = 0;
  }

  private _single(tr: Track, t: number): void {
    const s = this.getSettings();
    const weight = clutchWeight(tr);
    this.weight = weight;
    if (tr.lastSeen !== t) return; // detection missed this frame — hold
    const cur: SingleBase = { t, x: tr.palm.x, y: tr.palm.y, roll: tr.roll };
    if (!this.base) {
      this.base = cur;
      this.engagedAt = t;
      return;
    }
    if (t - this.engagedAt < GAINS.settle) {
      this.base = cur;
      return;
    }
    const b = this.base as SingleBase;
    const dt = t - b.t;
    if (dt <= 0) return;

    const rv = _rv.set(-(cur.y - b.y) * GAINS.translate, (cur.x - b.x) * GAINS.translate, 0);
    const dRoll = wrapPi(cur.roll - b.roll);
    if (Math.abs(dRoll) > GAINS.rollDeadzone) rv.z = (dRoll - Math.sign(dRoll) * GAINS.rollDeadzone) * GAINS.roll;

    rv.multiplyScalar(s.sensitivity);
    if (rv.length() < GAINS.deadzone) return; // still: keep the baseline so slow drift accumulates
    this.base = cur;
    this.rig.addRotation(quatFromRotationVector(rv, _q), dt, t, weight);
  }

  private _dual(pair: Track[], t: number, aspectInv: number): void {
    const s = this.getSettings();
    const [a, b] = pair;
    this.weight = Math.min(clutchWeight(a), clutchWeight(b));
    if (a.lastSeen !== t && b.lastSeen !== t) return;
    const mx = (a.palm.x + b.palm.x) / 2;
    const my = (a.palm.y + b.palm.y) / 2;
    const dx = b.palm.x - a.palm.x;
    const dy = b.palm.y - a.palm.y;
    const cur: DualBase = { t, mx, my, d: Math.max(0.02, Math.hypot(dx, dy)), ang: Math.atan2(dy, dx) };
    if (!this.base) {
      this.base = cur;
      this.engagedAt = t;
      return;
    }
    if (t - this.engagedAt < GAINS.settle) {
      this.base = cur;
      return;
    }
    const bs = this.base as DualBase;
    const dt = t - bs.t;
    if (dt <= 0) return;
    const w = this.weight;

    // pan: midpoint travel → NDC lens shift
    this.rig.panBy((cur.mx - bs.mx) * GAINS.pan * s.sensitivity * w, ((cur.my - bs.my) * GAINS.pan * s.sensitivity * w) / aspectInv);

    // zoom: spreading the hands zooms in (pinch-to-zoom convention); invertZoom flips it
    const ratio = cur.d / bs.d;
    const k = GAINS.zoom * (s.invertZoom ? 1 : -1);
    const factor = Math.pow(ratio, k * w);
    if (Math.abs(Math.log(factor)) > 0.006) this.rig.zoomBy(factor);

    // roll about the view axis
    const dr = wrapPi(cur.ang - bs.ang) * w;
    if (Math.abs(dr) > 0.01) {
      this.rig.addRotation(_q.setFromAxisAngle(Z, dr), dt, t, 1);
    }
    this.base = cur;
  }
}

