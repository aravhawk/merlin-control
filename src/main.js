import * as THREE from 'three';
import { createStore } from './state.js';
import { Stage } from './scene/stage.js';
import { EngineView } from './scene/engineView.js';
import { buildMerlin } from './model/merlin.js';
import { Rig, presetQuaternion } from './kinematics/rig.js';
import { HandTracker, CameraError } from './tracking/handTracker.js';
import { HandPipeline } from './tracking/handPipeline.js';
import { GestureController } from './tracking/gestures.js';
import { Sfx } from './audio/sfx.js';
import { createHUD } from './ui/hud.js';
import { Labels } from './ui/labels.js';
import { PerfGovernor } from './perf.js';
import { XRSupport } from './xr/xr.js';

// resolves after the browser has painted the current frame (rAF fires before paint; the timeout runs after it)
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const bootMsg = (m) => {
  const e = document.getElementById('boot-msg');
  if (e) e.textContent = m;
};

async function init() {
  const store = createStore();
  const stage = new Stage(document.getElementById('stage'));
  stage.resize();
  // registered before any await so a resize during boot is never missed
  let refit = () => {};
  const onResize = () => {
    stage.resize();
    refit();
  };
  window.addEventListener('resize', onResize);
  // also catches size changes that don't fire window.resize (emulated viewports, split view, etc.)
  new ResizeObserver(() => {
    const c = stage.canvas;
    if (c.clientWidth !== stage.size.w || c.clientHeight !== stage.size.h) onResize();
  }).observe(stage.canvas);

  await nextPaint();
  bootMsg('Generating the Merlin 1D — thrust chamber, nozzle, turbopump…');
  await nextPaint();
  const model = buildMerlin();
  const view = new EngineView(model);
  stage.scene.add(view.root);
  bootMsg('Initialising controls…');

  const rig = new Rig();
  const sfx = new Sfx();
  const getSettings = () => ({ sensitivity: store.get('sensitivity'), invertZoom: store.get('invertZoom') });

  // ── scene framing ───────────────────────────────────────────────────
  refit = () => {
    rig.setHome(stage.fitDistance(view.radius * 0.8, 0.8)); // keeps the user's zoom ratio
    rig.aspect = stage.camera.aspect;
    rig.tanHalfFov = Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2));
  };
  refit();
  rig.setView(presetQuaternion('home'));

  // ── tracking ────────────────────────────────────────────────────────
  const hudRoot = document.getElementById('ui');
  let hud;
  const onEvent = (e) => {
    if (e.type === 'grab' || e.type === 'release' || e.type === 'catch' || e.type === 'flick') sfx.play(e.type);
  };
  const gestures = new GestureController(rig, getSettings, onEvent);
  const pipeline = new HandPipeline();
  let tracker;

  const xr = new XRSupport({
    stage,
    rig,
    onChange: (on) => {
      hud.setVRActive(on);
      hud.toast(on ? 'VR session started' : 'VR session ended');
    },
    onGrab: (t) => sfx.play(t),
  });

  const actions = {
    tick: () => sfx.play('ui'),
    preset(name) {
      rig.goTo({ view: presetQuaternion(name) });
      hud.toast(name === 'home' ? 'View reset' : `${name} view`);
    },
    toggleExplode() {
      store.set('explode', store.get('explode') > 0.5 ? 0 : 1);
    },
    isolate(id) {
      view.setIsolated(id);
      hud.syncIsolate(id);
    },
    toggleVR() {
      if (!xr.supported) return hud.toast('VR is not available in this browser');
      if (xr.active) xr.exit();
      else xr.enter().catch((e) => hud.toast(`VR failed: ${e.message}`));
    },
    async toggleCamera() {
      if (cameraStarting) return; // ignore repeat presses while permission / model load is pending
      if (tracker.active) stopCamera();
      else await startCamera();
    },
  };

  // One table drives both the key handler and the help overlay, so they can't drift apart.
  const cycle = (key, list) => store.set(key, list[(list.indexOf(store.get(key)) + 1) % list.length]);
  const toggle = (key, on, off) => () => hud.toast(store.toggle(key) ? on : off);
  const SHORTCUTS = [
    { keys: ['1'], help: ['1 / 2 / 3', 'Wireframe · Solid · Solid + wire'], run: () => store.set('mode', 'wire') },
    { keys: ['2'], run: () => store.set('mode', 'solid') },
    { keys: ['3'], run: () => store.set('mode', 'both') },
    { keys: ['e'], help: ['E', 'Exploded view'], run: () => { actions.toggleExplode(); hud.toast(store.get('explode') > 0.5 ? 'Exploded view' : 'Assembled'); } },
    ...['front', 'side', 'top', 'bottom', 'iso'].map((name, i) => ({
      keys: [String(4 + i)],
      help: i === 0 ? ['4 5 6 7 8', 'Front · Side · Top · Bottom · Isometric'] : null,
      run: () => actions.preset(name),
    })),
    { keys: ['r'], help: ['R', 'Reset view'], run: () => actions.preset('home') },
    { keys: [' '], help: ['Space', 'Catch / stop the spin'], run: () => { rig.stopSpin(); sfx.play('catch'); } },
    { keys: ['l'], help: ['L', 'Part labels'], run: toggle('labels', 'Labels on', 'Labels off') },
    { keys: ['i'], help: ['I / Esc', 'Clear isolate · close drawers'], run: () => actions.isolate(null) },
    { keys: ['Escape'], run: () => hud.closeOverlays() || actions.isolate(null) },
    { keys: ['g'], help: ['G', 'Holographic glass'], run: toggle('glass', 'Holographic glass', 'Glass off') },
    { keys: ['a'], help: ['A', 'Anaglyph 3-D (red/cyan)'], run: toggle('anaglyph', 'Anaglyph 3-D · red/cyan glasses', 'Anaglyph off') },
    { keys: ['b'], help: ['B', 'Glow'], run: toggle('bloom', 'Glow on', 'Glow off') },
    { keys: ['o'], help: ['O', 'Rotate model ⇄ orbit camera'], run: () => { cycle('rotationMode', ['model', 'orbit']); hud.toast(store.get('rotationMode') === 'model' ? 'Rotating the model' : 'Orbiting the camera'); } },
    { keys: ['p'], help: ['P', 'Parts drawer'], run: () => hud.toggleDrawer('parts') },
    { keys: ['s'], help: ['S', 'Settings drawer'], run: () => hud.toggleDrawer('settings') },
    { keys: ['c'], help: ['C', 'Hand tracking on/off'], run: () => actions.toggleCamera() },
    { keys: ['t'], help: ['T', 'Camera preview on/off'], run: toggle('showPip', 'Camera preview on', 'Camera preview off') },
    { keys: ['q'], help: ['Q', 'Cycle quality'], run: () => { cycle('quality', ['auto', 'low', 'medium', 'high']); hud.toast(`Quality: ${store.get('quality')}`); } },
    { keys: ['v'], help: ['V', 'Enter VR'], run: () => actions.toggleVR() },
    { keys: ['m'], help: ['M', 'Mute sound'], run: toggle('sound', 'Sound on', 'Sound muted') },
    { keys: ['f'], help: ['F', 'Fullscreen'], run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {})) },
    { keys: ['h'], help: ['H', 'Hide / show interface'], run: () => store.toggle('uiHidden') },
    { keys: ['?', '/'], help: ['?', 'This help'], run: () => hud.toggleHelp() },
  ];

  hud = createHUD({ root: hudRoot, store, model, view, actions, shortcuts: SHORTCUTS.filter((sc) => sc.help).map((sc) => sc.help) });
  tracker = new HandTracker(hud.video);
  const labels = new Labels(document.getElementById('labels'), view);

  let cameraStarting = false;
  async function startCamera() {
    if (tracker.active || cameraStarting) return;
    cameraStarting = true;
    hud.setCamera('starting');
    hud.setGesture('starting');
    try {
      await tracker.start((msg) => hud.setCamera('starting', msg));
      pipeline.reset();
      hud.setCamera('on');
      hud.toast(`Hand tracking on · ${tracker.delegate}`);
    } catch (err) {
      console.warn('[camera]', err);
      tracker.stop();
      const msgs = {
        denied: 'Camera permission was denied — allow camera access in your browser settings to control the engine.',
        notfound: 'No camera found. Connect a webcam to control the engine.',
        busy: 'The camera is in use by another application.',
        insecure: 'Camera access needs HTTPS or localhost.',
        unsupported: 'This browser cannot access a camera.',
      };
      const kind = err instanceof CameraError ? err.kind : 'other';
      hud.setCamera('off', msgs[kind] || `Hand tracking could not start (${err.message || err}).`);
    } finally {
      cameraStarting = false;
    }
  }
  function stopCamera() {
    gestures.release(performance.now() / 1000);
    tracker.stop();
    pipeline.reset();
    hud.clearPip();
    hud.setCamera('off');
    hud.toast('Hand tracking off');
  }

  // ── store → scene wiring ────────────────────────────────────────────
  store.on('mode', (v) => { view.setMode(v); stage.setLook(view.look); }, true);
  store.on('glass', (v) => { view.setGlass(v); stage.setLook(view.look); }, true);
  store.on('explode', (v) => view.setExplode(v), true);
  store.on('bloom', (v) => (stage.settings.bloom = v), true);
  store.on('vignette', (v) => (stage.settings.vignette = v), true);
  store.on('anaglyph', (v) => (stage.settings.anaglyph = v), true);
  store.on('labels', (v) => labels.setVisible(v), true);
  store.on('rotationMode', (v) => rig.setMode(v), true);
  store.on('sound', (v) => sfx.setMuted(!v), true);
  store.on('volume', (v) => sfx.setVolume(v), true);

  const autoLevel = matchMedia('(pointer: coarse)').matches ? 'medium' : 'high';
  const governor = new PerfGovernor((lvl) => {
    stage.applyQuality(lvl);
    hud.setQuality(`auto·${lvl}`);
  }, autoLevel);
  store.on('quality', (v) => {
    if (v === 'auto') {
      governor.setEnabled(true);
      governor.setLevel(autoLevel);
      stage.applyQuality(autoLevel);
      hud.setQuality('auto');
    } else {
      governor.setEnabled(false);
      stage.applyQuality(v);
      hud.setQuality(v);
    }
  }, true);

  xr.detect().then((ok) => ok && hud.showVR(actions.toggleVR));

  // ── keyboard ────────────────────────────────────────────────────────
  const keyMap = new Map(SHORTCUTS.flatMap((sc) => sc.keys.map((k) => [k, sc.run])));
  const isTextEntry = (el) => el?.isContentEditable || (el instanceof HTMLInputElement && !['range', 'checkbox'].includes(el.type));
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    const run = keyMap.get(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    if (!run) return;
    e.preventDefault(); // e.g. Space must catch the spin, not toggle the focused switch / scroll
    run();
    sfx.play('ui');
  });
  // buttons activate on Space *keyup*, so stop that too
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && !isTextEntry(e.target)) e.preventDefault();
  });

  // ── main loop ───────────────────────────────────────────────────────
  let last = performance.now();
  let lastDet = 0;
  const camera = stage.camera;
  const aspectInv = () => tracker.aspectInv;

  /** The single place that positions the engine (and, on desktop, the camera) each frame. */
  function placeRoot(t) {
    const root = view.root;
    if (xr.active) {
      // in VR the headset owns the camera; the engine floats where the user put it
      root.position.copy(xr.position);
      root.scale.setScalar(xr.scale);
      root.quaternion.copy(rig.view);
      return;
    }
    rig.frameScale = view.frameScale; // pull back as parts explode outwards
    const dist = rig.cameraDist;
    const halfH = dist * rig.tanHalfFov;
    const halfW = halfH * camera.aspect;
    const bob = Math.sin(t * 0.7) * 0.018;
    root.quaternion.copy(rig.q);
    root.scale.setScalar(1);
    if (rig.mode === 'model') {
      root.position.set(rig.pan.x * halfW, rig.pan.y * halfH + bob, 0);
      camera.position.set(0, 0, dist);
      camera.quaternion.identity();
    } else {
      root.position.set(0, bob, 0);
      camera.quaternion.copy(rig.qc);
      camera.position.set(0, 0, dist).applyQuaternion(rig.qc).add(rig.target);
    }
    stage.focusDist = dist;
  }

  function frame(nowMs) {
    const dt = THREE.MathUtils.clamp((nowMs - last) / 1000, 0.0005, 0.1);
    const t = nowMs / 1000;
    governor.tick(nowMs - last, nowMs);
    last = nowMs;

    if (tracker.active) {
      const det = tracker.detect();
      if (det) {
        pipeline.update(det.hands, det.t, aspectInv());
        gestures.update(pipeline.tracks, det.t, aspectInv());
        lastDet = det.t;
      } else if (lastDet && t - lastDet > 0.35) {
        pipeline.update([], t, aspectInv()); // keep the clock moving if the camera stalls
        gestures.update(pipeline.tracks, t, aspectInv());
      }
      // the skeleton only changes when tracking data does (≈30 Hz), not every render frame
      if ((det || t - lastDet > 0.35) && store.get('showPip')) hud.drawPip(pipeline.tracks, t);
    }

    if (xr.active) xr.update(dt, t);
    rig.update(dt);
    placeRoot(t);
    view.update(dt, camera);
    labels.update(camera, stage.size.w, stage.size.h);

    // feedback
    const spinning = rig.spinning && !rig.held;
    sfx.setSpin(rig.speed);
    hud.setSpin(rig.speed);
    let gkey = 'off';
    if (xr.active) gkey = 'xr';
    else if (tracker.active) gkey = gestures.state;
    hud.setGesture(gkey, spinning);
    hud.tickFps(nowMs);

    stage.render(dt);
  }
  stage.renderer.setAnimationLoop(frame);

  // reveal
  document.getElementById('boot').classList.add('done');
  setTimeout(() => document.getElementById('boot')?.remove(), 1200);
  // a gentle intro spin that demonstrates the momentum model
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) rig.spin(new THREE.Vector3(0.35, 1.5, 0));

  window.__merlin = { stage, view, rig, store, gestures, pipeline, tracker, xr, model, hud };
}

init().catch((err) => {
  console.error(err);
  bootMsg(`Could not start: ${err.message}`);
});
