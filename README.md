# Merlin 1D

A wireframe SpaceX Merlin 1D engine floating in space, driven entirely by your bare hands through a webcam. Grab it, rotate it, zoom and pan with two hands, flick it into a free spin, then catch it.

It's a browser take on the core of SpaceX's 2013 [*The Future of Design*](https://www.youtube.com/watch?v=xNqs_S-zEBY) demo, built with TypeScript, [Three.js](https://threejs.org) and [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).

## Quick start

Requires Node.js 22.18 or newer.

```bash
npm install   # also fetches the MediaPipe WASM runtime and hand model into public/
npm run dev   # → http://localhost:5173
```

Press **Hand tracking** (or `C`) and allow camera access. Hand tracking is the only way to move the engine. The mouse and touch screen don't control it. Keyboard shortcuts still work without a camera.

## Controls

### Hands

| Gesture | Effect |
| --- | --- |
| Open palm | **Grab.** Move your hand to rotate the engine; twist it to roll. |
| Fist | **Release.** Reposition your hand without moving anything. |
| Move fast, then close your fist | **Flick.** The engine keeps spinning with your hand's momentum. |
| Open palm while it spins | **Catch.** The spin eases to a stop. |
| Two open palms | Spread apart to zoom in, move together to pan, twist to roll. |

The gesture card shows what the tracker sees. The camera preview draws your hand skeleton in cyan while grabbing and amber while released.

For best tracking, light your hand evenly and keep it 40 to 80 cm from the camera with your palm facing it.

### Keyboard

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `1` `2` `3` | Wireframe · solid · both | `C` | Hand tracking on / off |
| `4`–`8` | Front · side · top · bottom · iso | `T` | Camera preview |
| `R` | Reset view | `L` | Part labels |
| `E` | Exploded view | `P` | Parts drawer |
| `Space` | Stop the spin | `S` | Settings drawer |
| `O` | Rotate model ⇄ orbit camera | `G` | Holographic glass |
| `B` | Glow | `A` | Anaglyph 3D (red / cyan) |
| `Q` | Cycle render quality | `V` | Enter VR (when available) |
| `M` | Mute | `F` | Fullscreen |
| `I` / `Esc` | Clear isolation · close panels | `H` | Hide interface |
| `?` | Help | | |

In the **Parts** drawer, hover over a part to highlight it or click it to isolate it. **Settings** holds display, quality, sensitivity and zoom-direction options.

## How it works

```
webcam ─▶ HandLandmarker ─▶ HandPipeline ─▶ GestureController ─▶ Rig ─▶ scene
          21 landmarks       filtering,      grab / release /     quaternion
          per hand           openness,       flick / catch        kinematics
                             clutch
```

- **Filtering:** every landmark passes through a [One-Euro filter](https://gery.casiez.net/1euro/). It smooths heavily when your hand is still and lightly when it moves fast.
- **Open or closed:** openness is the finger-extension ratio `|tip − wrist| / |knuckle − wrist|`, measured on MediaPipe's metric 3-D landmarks. That makes it independent of viewing angle. A Schmitt trigger with a short dwell time turns it into a clutch that never flickers.
- **Gestures:** a small state machine maps one hand to rotation and two hands to zoom, pan and roll. When your hand closes, the clutch fades the motion out, so making a fist never drags the model. Flick velocity is sampled from just *before* the hand started closing.
- **Motion:** all orientation is stored as quaternions. Input adds rotation deltas to a pending accumulator, and the rig consumes it with critically-damped smoothing. This gives the engine weight, keeps it from drifting, and records the velocity that a release turns into free spin.

To tune the feel, edit `GAINS` in `tracking/gestures.ts`, `DEFAULTS` in `tracking/handPipeline.ts`, or the time constants on `Rig`.

## The model

There are no mesh files. The engine is generated procedurally at load time from a small CAD-style kit in `model/geom.ts`: surfaces of revolution, swept tubes, filleted paths and bolt patterns. `model/merlin.ts` assembles 12 sub-assemblies from that kit, including a Rao bell nozzle, a pintle injector, the turbopump with its volutes, the gas generator, feed ducts, gimbal and actuators.

The wireframe is drawn from CAD-style edges rather than a raw triangle dump. Each primitive emits its own iso-lines and hoop rings, and these are simplified with Douglas–Peucker, so the full engine is about 10.5k line segments over roughly 115k shaded triangles. `npm run model:stats` prints the breakdown.

The proportions follow the public engine layout. This is not a licensed CAD export. Units are metres, with +Y along the thrust axis.

## Rendering

- **Wireframe:** cyan lines with max blending and a depth cue.
- **Solid mode:** PBR metals under key, fill and rim lights, with image-based lighting and shadows.
- **Optional modes:** bloom, vignette, a holographic-glass shader, anaglyph stereo, and WebXR, where you grab with controllers or pinch with your hands.
- **Auto quality:** when frames take longer than about 21 ms, the renderer lowers resolution, MSAA and shadow quality.

Sound effects are synthesised with WebAudio, so the project has no audio files.

## Project layout

```
src/
  main.ts          app wiring and frame loop
  state.ts         typed settings store (persisted to localStorage)
  model/           geom.ts (primitive kit) · merlin.ts (the engine)
  scene/           stage.ts (renderer, lights, post) · engineView.ts (modes, explode, isolate)
  tracking/        handTracker.ts · handPipeline.ts · gestures.ts · oneEuro.ts
  kinematics/      rig.ts
  ui/              hud.ts · labels.ts
  audio/ xr/       sfx.ts · xr.ts
  perf.ts          adaptive quality governor
scripts/           fetch-assets.ts · model-stats.ts
tests/             node:test suites using synthetic hands
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-check and build a self-contained bundle (model and WASM included) into `dist/` |
| `npm run preview` | Serve `dist/` |
| `npm test` | Unit tests for filtering, gestures and kinematics (no browser needed) |
| `npm run typecheck` | `tsc` in strict mode |
| `npm run model:stats` | Per-assembly edge and triangle counts |
| `npm run lan` | Build and serve over self-signed HTTPS, to test from a phone or headset on your network |

Tests and scripts run as TypeScript directly through Node's built-in type stripping. There is no compile step.

## Notes

- Browsers only allow camera access on `https://` or `localhost`. Use `npm run lan` for other devices.
- After `npm install`, hand tracking works offline. If `public/wasm` or `public/models` is missing, the app falls back to jsDelivr and Google's model CDN.
