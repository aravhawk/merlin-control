import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { HandPipeline, type RawHand, type Track } from '../src/tracking/handPipeline.ts';
import { GestureController, type GestureEvent } from '../src/tracking/gestures.ts';
import { Rig } from '../src/kinematics/rig.ts';
import { OneEuro } from '../src/tracking/oneEuro.ts';
import { makeHand } from './helpers.ts';

const FPS = 30;
const settings = () => ({ sensitivity: 1, invertZoom: false });

function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}

test('One-Euro filter removes jitter on a still signal but tracks fast motion', () => {
  const f = new OneEuro({ minCutoff: 1.2, beta: 20, dCutoff: 1 });
  const r = rng(3);
  let maxStill = 0;
  for (let i = 0; i < 90; i++) maxStill = Math.max(maxStill, Math.abs(f.filter(0.5 + r() * 0.01, i / 30) - 0.5));
  assert.ok(maxStill < 0.004, `still jitter ${maxStill}`);
  const g = new OneEuro({ minCutoff: 1.2, beta: 20, dCutoff: 1 });
  let last = 0;
  for (let i = 0; i < 30; i++) last = g.filter(i * 0.05, i / 30); // 1.5 u/s
  assert.ok(Math.abs(last - 29 * 0.05) < 0.12, `lag ${Math.abs(last - 29 * 0.05)}`);
});

test('openness separates open palm from fist and the clutch has hysteresis (no flicker)', () => {
  const p = new HandPipeline();
  let t = 0;
  const step = (open: number): Track => {
    t += 1 / FPS;
    return p.update([makeHand({ open })], t)[0];
  };
  let tr = step(1);
  for (let i = 0; i < 9; i++) tr = step(1);
  assert.equal(tr.open, true);
  assert.ok(tr.extension > 1.5, `open ext ${tr.extension}`);
  for (let i = 0; i < 10; i++) tr = step(0);
  assert.equal(tr.open, false);
  assert.ok(tr.extension < 1.1, `fist ext ${tr.extension}`);
  // jitter around the mid-point must not toggle the state
  for (let i = 0; i < 10; i++) tr = step(1);
  let flips = 0;
  let prev = tr.open;
  const r = rng(11);
  for (let i = 0; i < 120; i++) {
    tr = step(0.42 + r() * 0.16); // ratio 1.2–1.55: inside the hysteresis band
    if (tr.open !== prev) flips++;
    prev = tr.open;
  }
  assert.ok(flips <= 2, `state flipped ${flips} times while hovering`);
});

function drive(frames: RawHand[][], gc: GestureController, p: HandPipeline, t0 = 0): number {
  let t = t0;
  for (const hands of frames) {
    t += 1 / FPS;
    p.update(hands, t);
    gc.update(p.tracks, t);
  }
  return t;
}

test('grab → rotate follows hand motion; fist release without motion gives no spin', () => {
  const rig = new Rig();
  const p = new HandPipeline();
  const events: GestureEvent['type'][] = [];
  const gc = new GestureController(rig, settings, (e) => events.push(e.type));
  const frames: RawHand[][] = [];
  for (let i = 0; i < 12; i++) frames.push([makeHand({ open: 1, x: 0.5, y: 0.5 })]);
  // slowly move right
  for (let i = 0; i < 30; i++) frames.push([makeHand({ open: 1, x: 0.5 + i * 0.004, y: 0.5 })]);
  for (let i = 0; i < 15; i++) frames.push([makeHand({ open: 1, x: 0.62, y: 0.5 })]); // pause
  for (let i = 0; i < 12; i++) frames.push([makeHand({ open: 0, x: 0.62, y: 0.5 })]); // fist
  const t = drive(frames, gc, p);
  for (let i = 0; i < 60; i++) rig.update(1 / 60);
  // mirrored: moving right (image x increases) = user's left → but either way a yaw happened
  const e = rig.view.clone();
  assert.ok(Math.abs(e.y) > 0.02, `expected yaw, got q=${e.toArray().map((v) => v.toFixed(3))}`);
  assert.ok(events.includes('grab') && events.includes('release'));
  assert.ok(!events.includes('flick'), 'a deliberate stop must not flick');
  assert.ok(rig.omega.length() < 0.1);
  assert.ok(t > 0);
});

test('fast movement then closing the fist imparts spin; reopening catches it smoothly', () => {
  const rig = new Rig();
  const p = new HandPipeline();
  const events: GestureEvent['type'][] = [];
  const gc = new GestureController(rig, settings, (e) => events.push(e.type));
  let t = 0;
  const frames: RawHand[][] = [];
  for (let i = 0; i < 12; i++) frames.push([makeHand({ open: 1, x: 0.3, y: 0.5 })]);
  // fast sweep (~3 frame-widths/s) while hand starts closing at the end
  for (let i = 0; i < 14; i++) frames.push([makeHand({ open: 1, x: 0.3 + i * 0.03, y: 0.5 })]);
  for (let i = 0; i < 8; i++) frames.push([makeHand({ open: Math.max(0, 1 - i * 0.2), x: 0.72 + i * 0.01, y: 0.5 })]);
  for (let i = 0; i < 8; i++) frames.push([makeHand({ open: 0, x: 0.8, y: 0.5 })]);
  t = drive(frames, gc, p);
  assert.ok(events.includes('flick'), `events ${events}`);
  const w0 = rig.omega.length();
  assert.ok(w0 > 1.0, `spin ${w0}`);
  // free spin decays slowly
  for (let i = 0; i < 60; i++) rig.update(1 / 60);
  const w1 = rig.omega.length();
  assert.ok(w1 < w0 && w1 > 0.5 * w0, `light damping ${w0} → ${w1}`);
  // reopen palm → catch
  const frames2: RawHand[][] = [];
  for (let i = 0; i < 6; i++) frames2.push([makeHand({ open: 1, x: 0.5, y: 0.5 })]);
  t = drive(frames2, gc, p, t);
  assert.ok(events.includes('catch'));
  // the spin is damped to ~0 within ~0.7 s but not instantly
  rig.update(1 / 60);
  assert.ok(rig.omega.length() > 0.1 * w1, 'not an instant stop');
  for (let i = 0; i < 60; i++) rig.update(1 / 60);
  assert.ok(rig.omega.length() < 0.05, `caught ${rig.omega.length()}`);
});

test('two open hands: spreading changes zoom, midpoint pans', () => {
  const rig = new Rig();
  const p = new HandPipeline();
  const gc = new GestureController(rig, settings);
  const frames: RawHand[][] = [];
  const two = (sep: number, cx: number, cy: number) => [makeHand({ open: 1, x: cx - sep / 2, y: cy }), makeHand({ open: 1, x: cx + sep / 2, y: cy })];
  for (let i = 0; i < 10; i++) frames.push(two(0.4, 0.5, 0.5));
  for (let i = 0; i < 20; i++) frames.push(two(0.4 - i * 0.008, 0.5 + i * 0.004, 0.5));
  drive(frames, gc, p);
  assert.equal(gc.state, 'dual');
  assert.ok(rig.distTarget > rig.homeDist, `hands closer should zoom out (dist ${rig.distTarget})`);
  assert.ok(Math.abs(rig.panTarget.x) > 0.02, `pan ${rig.panTarget.x}`);
});

test('rig API: a flick imparts spin and stopSpin catches it', () => {
  const rig = new Rig();
  rig.beginGrab();
  let t = 0;
  for (let i = 0; i < 12; i++) {
    t += 0.016;
    rig.addRotation(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.05), 0.016, t);
    rig.update(0.016);
  }
  rig.endGrab(t, { from: 0.12, to: 0 });
  assert.ok(rig.omega.y > 2, `omega ${rig.omega.y}`);
  rig.stopSpin();
  for (let i = 0; i < 80; i++) rig.update(1 / 60);
  assert.ok(rig.omega.length() < 0.02);
});

test('switching model ⇄ orbit keeps the pan offset on screen', () => {
  const rig = new Rig();
  rig.panBy(0.3, -0.2);
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  const halfH = rig.cameraDist * rig.tanHalfFov;
  const halfW = halfH * rig.aspect;

  rig.setMode('orbit');
  assert.equal(rig.pan.x, 0);
  assert.ok(Math.abs(rig.target.x + 0.3 * halfW) < 1e-3 && Math.abs(rig.target.y - 0.2 * halfH) < 1e-3, 'pan becomes the orbit target');

  // orbit the camera, then check the model centre's screen offset survives the switch back
  rig.addRotation(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6), 0.1, 1);
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  const inCam = rig.target.clone().negate().applyQuaternion(rig.qc.clone().invert());
  rig.setMode('model');
  assert.ok(Math.abs(rig.pan.x * halfW - inCam.x) < 1e-3 && Math.abs(rig.pan.y * halfH - inCam.y) < 1e-3, `pan ${rig.pan.x}, ${rig.pan.y}`);
  assert.equal(rig.target.lengthSq(), 0);
});
