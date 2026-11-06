/**
 * Optional WebXR (immersive VR) mode.
 * The engine floats in front of the user; grab with a controller squeeze/trigger
 * or a hand pinch to rotate it (same Rig physics as the webcam: flick and catch
 * work), grab with both to scale and move it.
 */
import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

export class XRSupport {
  constructor({ stage, rig, onChange = () => {}, onGrab = () => {} }) {
    this.stage = stage;
    this.rig = rig;
    this.onChange = onChange;
    this.onGrab = onGrab;
    this.active = false;
    this.supported = false;
    this.position = new THREE.Vector3(0, 1.3, -0.85);
    this.scale = 0.16;
    this.grip = [false, false];
    this.inputs = [new Set(), new Set()]; // which of select/squeeze/pinch are currently down, per hand
    this.prev = [null, null];
    this.poses = [0, 1].map((i) => ({ i, p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    this.prevDist = 0;
    this.prevMid = new THREE.Vector3();
    this.wasHeld = false;
    this.wasDual = false;

    const r = stage.renderer;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');

    const handFactory = new XRHandModelFactory();
    this.sources = [0, 1].map((i) => {
      const controller = r.xr.getController(i);
      const hand = r.xr.getHand(i);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x59d8ff, toneMapped: false })
      );
      controller.add(marker);
      hand.add(handFactory.createHandModel(hand, 'spheres'));
      // a grab lasts while ANY of trigger / squeeze / pinch is held, so releasing one doesn't drop the engine
      const set = (kind, down) => () => {
        if (down) this.inputs[i].add(kind);
        else this.inputs[i].delete(kind);
        this.grip[i] = this.inputs[i].size > 0;
      };
      for (const src of [controller, hand]) {
        for (const kind of ['select', 'squeeze', 'pinch']) {
          src.addEventListener(`${kind}start`, set(kind, true));
          src.addEventListener(`${kind}end`, set(kind, false));
        }
      }
      stage.scene.add(controller, hand);
      return { controller, hand };
    });
  }

  async detect() {
    try {
      this.supported = !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')));
    } catch {
      this.supported = false;
    }
    return this.supported;
  }

  async enter() {
    if (!this.supported) throw new Error('WebXR immersive VR is not available in this browser');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    session.addEventListener('end', () => {
      // leaving mid-grab must not leave the rig "held" (that would over-damp every later spin)
      if (this.wasHeld) this.rig.endGrab(performance.now() / 1000, { flick: false });
      this.active = false;
      this.wasHeld = false;
      this.wasDual = false;
      this.grip = [false, false];
      this.inputs.forEach((s) => s.clear());
      this.prev = [null, null];
      this.onChange(false);
    });
    await this.stage.renderer.xr.setSession(session);
    this.active = true;
    this.onChange(true);
  }

  async exit() {
    await this.stage.renderer.xr.getSession()?.end();
  }

  _pose(i, outP, outQ) {
    const s = this.sources[i];
    const wrist = s.hand.joints?.wrist;
    if (wrist && wrist.visible !== false && s.hand.joints['index-finger-tip']) {
      wrist.getWorldPosition(outP);
      wrist.getWorldQuaternion(outQ);
    } else {
      s.controller.getWorldPosition(outP);
      s.controller.getWorldQuaternion(outQ);
    }
  }

  /** Call once per frame while `active`: turns controller/hand input into rig rotation, position and scale (main.js places the engine). */
  update(dt, t) {
    const held = [0, 1].filter((i) => this.grip[i]);
    const poses = held.map((i) => {
      const pose = this.poses[i];
      this._pose(i, pose.p, pose.q);
      return pose;
    });

    if (held.length === 1) {
      const { i, q } = poses[0];
      if (!this.wasHeld || this.wasDual) {
        this.rig.beginGrab();
        if (!this.wasHeld) this.onGrab('grab');
        this.prev[i] = q.clone();
      } else if (this.prev[i]) {
        // world-frame rotation delta of the controller
        _qi.copy(this.prev[i]).invert();
        _q.copy(q).multiply(_qi);
        this.rig.addRotation(_q, Math.max(dt, 1e-3), t);
        this.prev[i].copy(q);
      }
      this.wasHeld = true;
      this.wasDual = false;
    } else if (held.length === 2) {
      const [a, b] = poses;
      const d = a.p.distanceTo(b.p);
      _p.copy(a.p).add(b.p).multiplyScalar(0.5);
      if (!this.wasDual) {
        if (this.wasHeld) this.rig.endGrab(t, { flick: false });
        else this.onGrab('grab');
      } else {
        this.scale = THREE.MathUtils.clamp(this.scale * (d / Math.max(this.prevDist, 1e-3)), 0.04, 1.2);
        this.position.add(_d.copy(_p).sub(this.prevMid));
      }
      this.prevDist = d;
      this.prevMid.copy(_p);
      this.wasHeld = true;
      this.wasDual = true;
    } else if (this.wasHeld) {
      if (!this.wasDual) this.rig.endGrab(t, { from: 0.25, to: 0.02 });
      this.onGrab('release');
      this.wasHeld = false;
      this.wasDual = false;
      this.prev = [null, null];
    }
  }
}
