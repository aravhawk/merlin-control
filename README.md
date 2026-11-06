# Merlin 1D — hand-controlled 3D visualizer

A browser recreation of the core of SpaceX's 2013 *"The Future of Design"* demo
([video](https://www.youtube.com/watch?v=xNqs_S-zEBY)): a dense wireframe Merlin 1D floating in space that you
grab, rotate, zoom, pan, flick into a free-spin and catch — using nothing but your webcam and one open hand.
It also has a PBR solid mode, exploded view, part isolation, annotations, and holographic/anaglyph/VR modes.
The engine is manipulated with your hands only — there is no mouse or touch control.

Vanilla JS + [Three.js](https://threejs.org) + [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker), bundled with Vite.

## Run

```bash
npm install        # also copies the MediaPipe WASM and downloads the hand model into public/
npm run dev        # http://localhost:5173
```

```bash
npm run build      # production bundle in dist/ (fully self-contained, hand model + WASM included)
npm run preview    # serve dist/
npm test           # unit tests (filtering, gestures, kinematics) — no browser needed
npm run model:stats  # per-assembly edge / triangle counts of the procedural model
```

Click **Enable hand tracking** (or press `C`) and allow camera access. The camera needs `localhost` or HTTPS.
Without a camera the engine can't be grabbed; keyboard shortcuts (views, presets, explode, spin catch) still work.

## Hand gestures

| Gesture | Effect |
|---|---|
| **Open palm** | *Grab* (clutch engaged). The engine follows your hand: move to orbit it, twist your hand to roll it |
| **Fist** | *Release*. Reposition your hand freely; nothing moves |
| **Fast move, then close your fist** | *Flick* — the measured angular velocity becomes a free-spin with light damping |
| **Open palm while it spins** | *Catch* — the spin eases to zero in a fraction of a second |
| **Two open palms** | Spread your hands apart to zoom in, bring them together to zoom out (flip it with *Invert two-hand zoom* in Settings), move both to pan, twist the pair to roll |

The gesture card (bottom-left) shows the current state and a momentum bar; the camera preview shows the tracked skeleton
(cyan = grabbing, amber = released) and an openness gauge per hand. `T` hides the preview, `H` hides all UI.

## Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| `1` `2` `3` | Wireframe · Solid · Solid + wire | `C` | Hand tracking on/off |
| `E` | Exploded view | `T` | Camera preview on/off |
| `4` `5` `6` `7` `8` | Front · Side · Top · Bottom · Isometric | `L` | Part labels |
| `R` | Reset view | `I` / `Esc` | Clear isolate / close drawer or help |
| `Space` | Catch / stop the spin | `G` | Holographic glass |
| `O` | Rotate the model ⇄ orbit the camera | `A` | Anaglyph (red/cyan) |
| `B` | Bloom | `V` | Enter VR |
| `Q` | Cycle quality (auto/low/med/high) | `M` | Mute |
| `F` | Fullscreen | `H` | Hide / show UI |
| `P` | Parts drawer | `S` | Settings drawer |
| `?` | Help | | |

Open **Parts** (top-right, or `P`) and hover a part to highlight it, click to isolate it (everything else ghosts out). **Settings** (`S`) holds display, quality, sensitivity and zoom-direction options.

## The model

The engine is **generated procedurally at load time** (~0.2 s) — no external mesh, no licensing questions. `src/model/geom.js`
is a small CAD-style kit (surfaces of revolution, swept tubes, fillet paths, hex bolts, …) and `src/model/merlin.js`
assembles the Merlin 1D from it:

* Rao-style bell contour (cylindrical chamber → eased convergent → 0.382·rt throat arc → parabolic bell, area ratio ≈ 16)
* coaxial **pintle injector** (sleeve, pintle tip, 3-ring orifice field, LOX dome, fuel manifold)
* regeneratively-cooled chamber/nozzle jacket with hoop stiffeners, fuel inlet manifold, flanges and bolt rings, and a
  radiatively-cooled extension skirt
* single-shaft **turbopump** — RP-1 pump, turbine with inlet scroll, LOX pump, with spiral volutes
* gas generator, LOX and RP-1 inlet/high-pressure ducts (bellows sections, clamps), the long **turbine-exhaust duct**
  that runs down the nozzle, TEA-TEB igniter, sensors, junction box and harness, gimbal bearing/thrust mount and two
  hydraulic actuators

It is a faithful *layout and proportions* approximation of the public engine configuration, not a licensed CAD export;
dimensions are in metres with the thrust axis along Y. 12 assemblies (each with its own exploded-view offset and label anchor).

**Wireframe = CAD edges, not a triangle dump.** Each primitive emits iso-lines and hoop rings which are decimated
(Douglas-Peucker) so straight runs cost one segment. Total ≈ **9,900 line segments** (shown in the HUD) over ≈ 100k
shaded triangles. Wireframe lines are additive with a depth cue; solid + wire mode switches the lines to depth-tested
overlay. `npm run model:stats` prints the breakdown. Density is tuned by the `lines` / `ringSpacing` / `tol` arguments in
`merlin.js`.

## How the hand control works

```
camera → MediaPipe HandLandmarker → handPipeline → gestures → rig → scene
                (landmarks)        (One-Euro filter,   (state        (quaternion
                                    openness, Schmitt   machine)       kinematics)
                                    clutch)
```

* **`tracking/oneEuro.js`** — adaptive low-pass on every landmark (normalised image *and* metric world coordinates).
* **`tracking/handPipeline.js`** — track association, palm centre / in-plane roll / palm normal, and **openness** from
  finger-extension ratio `|tip−wrist| / |mcp−wrist|` on 3-D world landmarks (view-angle independent). Open/fist uses a
  **Schmitt trigger + dwell time** (hysteresis), so the clutch never flickers. Thresholds were calibrated against real
  MediaPipe output: fist ≈ 0.85, relaxed open palm ≈ 1.5, fully spread ≈ 1.9.
* **`tracking/gestures.js`** — grab/release/catch/flick state machine. The clutch fades the applied rotation to zero as the
  hand closes, so closing your fist never drags the model; the flick velocity is measured from *before* the closing motion.
* **`kinematics/rig.js`** — all orientation is **quaternions**. Inputs push rotation deltas into a *pending* accumulator
  consumed with critically-damped smoothing (weighted feel, zero drift). Release hands the measured angular velocity to a
  free-spin integrator (τ ≈ 3 s damping); a catch decays it with τ ≈ 0.14 s. Zoom/pan are smoothed in log/screen space.
  Supports **model rotation** (default) or **camera orbit**.

Tuning knobs live in `GAINS` (`gestures.js`), `DEFAULTS` (`handPipeline.js`) and the tau constants at the top of `Rig`.
The *Sensitivity* slider scales rotation and pan.

## Rendering

Dark space background with faint stars; bright cyan additive wire with optional **bloom**, **vignette** and dither;
MSAA half-float pipeline. Solid mode uses PBR metals (steel, chrome, bronze, copper, Inconel, titanium) under key/fill/rim
lights plus an image-based environment and shadow-mapped key light. Optional **holographic glass** shader, **anaglyph**
stereo, and **WebXR** (`V` / VR button: controllers or hand-tracking pinch to grab; both hands scale/move). Quality is
*Auto* by default: a governor drops resolution / MSAA / shadows when the frame time exceeds ~21 ms.

## Sound

Synthesised with WebAudio (no files): soft ticks on grab/release, a thump on catch, and a noise whoosh that follows spin
speed. `M` mutes; the *Sound* switch in Settings does the same.

## Layout

```
src/
  main.js              wiring + frame loop
  state.js             settings store (persisted subset)
  model/               geom.js (primitives) · merlin.js (the engine)
  scene/               stage.js (renderer, post, lights) · engineView.js (modes, explode, isolate)
  tracking/            handTracker.js · handPipeline.js · gestures.js · oneEuro.js
  kinematics/rig.js    quaternion view rig
  ui/                  hud.js · labels.js     audio/sfx.js     xr/xr.js     perf.js
scripts/fetch-assets.mjs   copies MediaPipe WASM, downloads hand_landmarker.task
tests/                     node:test unit tests with synthetic hands
```

## Notes

* First load of hand tracking fetches nothing from the network when `public/wasm` and `public/models` are present
  (done by `npm install`); otherwise it falls back to jsDelivr / Google's model CDN.
* Hand tracking runs on the main thread (GPU delegate, CPU fallback). For best results light your hand evenly and keep it
  roughly 40–80 cm from the camera, palm facing it.
* Browsers only expose the camera on `https://` or `http://localhost`.
