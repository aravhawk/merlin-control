/**
 * Raw MediaPipe landmarks → stable, filtered per-hand features.
 *
 * Pure JS (no DOM, no three) so it can be unit-tested with synthetic hands.
 *
 *  1. associate detections with persistent tracks (nearest wrist),
 *  2. One-Euro filter every landmark (normalised image coords + metric world coords),
 *  3. derive: palm centre, in-plane roll (unwrapped), finger-extension openness,
 *  4. open/fist state through a Schmitt trigger + dwell time (clutch hysteresis).
 *
 * "View space" = what the user sees in the mirrored preview: +x right, +y up,
 * +z towards the viewer. Positions are expressed in units of frame width.
 */
import { OneEuroVec } from './oneEuro.js';

export const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12, RING_MCP: 13, RING_TIP: 16, PINKY_MCP: 17, PINKY_TIP: 20 };
const FINGERS = [
  [LM.INDEX_MCP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_TIP],
];
const PALM = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];

export const DEFAULTS = {
  // One-Euro parameters tuned for 30 Hz camera input
  imgFilter: { minCutoff: 1.0, beta: 6, dCutoff: 1.0 }, // normalised image coordinates
  worldFilter: { minCutoff: 1.3, beta: 70, dCutoff: 1.0 }, // metres
  // Finger-extension ratio |tip−wrist| / |mcp−wrist| measured on real MediaPipe world
  // landmarks:  fist ≈ 0.85 · relaxed open palm ≈ 1.5 · fully spread fingers ≈ 1.9.
  // openness 0 → 1 spans 1.0 → 1.5 so a relaxed palm already reads as fully open.
  extLo: 1.0,
  extHi: 1.5,
  openOn: 0.65, // Schmitt trigger thresholds on smoothed openness (ratio ≈ 1.33 / 1.18)
  openOff: 0.35,
  openDwell: 0.05, // s the signal must stay past the threshold
  closeDwell: 0.03,
  lostAfter: 0.22, // s without a detection before a track is dropped
  matchDist: 0.3, // max wrist jump (frame widths) when matching tracks
};

/** Wrap an angle into (−π, π]. */
export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

class Track {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts;
    this.img = Array.from({ length: 21 }, () => new OneEuroVec(3, opts.imgFilter));
    this.wld = Array.from({ length: 21 }, () => new OneEuroVec(3, opts.worldFilter));
    this.imgPts = Array.from({ length: 21 }, () => [0, 0, 0]);
    this.wldPts = Array.from({ length: 21 }, () => [0, 0, 0]);
    this.openness = 0;
    this.open = false;
    this.flipSince = null;
    this.rollRaw = null;
    this.roll = 0;
    this.lastSeen = 0;
    this.frames = 0;
    this.palm = { x: 0, y: 0 };
  }
}

export class HandPipeline {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
  }

  /**
   * @param {Array<{landmarks:{x,y,z}[], world:{x,y,z}[]}>} hands
   * @param {number} t   seconds (monotonic)
   * @param {number} aspectInv  video height / width
   * @returns {Track[]} live tracks (those seen this frame first)
   */
  update(hands, t, aspectInv = 0.75) {
    const o = this.opts;
    const seen = [];
    for (const tr of this.tracks) tr.matched = false;

    for (const h of hands) {
      const w0 = h.landmarks[LM.WRIST];
      let best = null;
      let bestD = o.matchDist;
      for (const tr of this.tracks) {
        if (tr.matched) continue;
        const d = Math.hypot(tr.imgPts[0][0] - w0.x, (tr.imgPts[0][1] - w0.y) * aspectInv);
        if (d < bestD) {
          bestD = d;
          best = tr;
        }
      }
      if (!best) {
        best = new Track(this.nextId++, o);
        this.tracks.push(best);
      }
      best.matched = true;
      this._process(best, h, t, aspectInv);
      seen.push(best);
    }

    // drop stale tracks
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen <= o.lostAfter);
    return seen;
  }

  _process(tr, h, t, aspectInv) {
    const o = this.opts;
    tr.lastSeen = t;
    tr.frames++;

    for (let i = 0; i < 21; i++) {
      const l = h.landmarks[i];
      tr.img[i].filter3(l.x, l.y, l.z, t, tr.imgPts[i]);
      const w = h.world?.[i] ?? l;
      tr.wld[i].filter3(w.x, w.y, w.z, t, tr.wldPts[i]);
    }

    // palm centre in view space (mirrored x, units = frame widths)
    let px = 0;
    let py = 0;
    for (const i of PALM) {
      px += tr.imgPts[i][0];
      py += tr.imgPts[i][1];
    }
    px /= PALM.length;
    py /= PALM.length;
    tr.palm.x = 1 - px;
    tr.palm.y = -py * aspectInv; // up is positive

    // in-plane roll: wrist → middle MCP
    const wr = tr.imgPts[LM.WRIST];
    const mm = tr.imgPts[LM.MIDDLE_MCP];
    const vx = -(mm[0] - wr[0]);
    const vy = -(mm[1] - wr[1]) * aspectInv;
    if (Math.hypot(vx, vy) > 0.035) {
      const a = Math.atan2(vy, vx);
      if (tr.rollRaw === null) tr.roll = a;
      else tr.roll += wrapPi(a - tr.rollRaw);
      tr.rollRaw = a;
    }

    // openness from finger extension (scale/orientation invariant, uses 3-D metric landmarks)
    const W = tr.wldPts;
    let ext = 0;
    for (const [mcp, tip] of FINGERS) {
      ext += dist3(W[tip], W[LM.WRIST]) / Math.max(1e-4, dist3(W[mcp], W[LM.WRIST]));
    }
    ext /= FINGERS.length;
    tr.extension = ext;
    const raw = Math.min(1, Math.max(0, (ext - o.extLo) / (o.extHi - o.extLo)));
    tr.openness = tr.frames === 1 ? raw : tr.openness + 0.55 * (raw - tr.openness);

    // clutch hysteresis (Schmitt trigger + dwell)
    const want = tr.open ? tr.openness > o.openOff : tr.openness >= o.openOn;
    if (want !== tr.open) {
      if (tr.flipSince === null) tr.flipSince = t;
      const dwell = tr.open ? o.closeDwell : o.openDwell;
      if (t - tr.flipSince >= dwell) {
        tr.open = want;
        tr.flipSince = null;
      }
    } else {
      tr.flipSince = null;
    }
    // engage-ready flag (we want ≥ a few frames of data first)
    tr.stable = tr.frames >= 3;
  }
}
