// Prepares the runtime assets MediaPipe needs so the app works fully offline:
//   - copies the WASM runtime from node_modules into public/wasm
//   - downloads the HandLandmarker model into public/models (if missing)
// If the download fails the app falls back to Google's CDN at runtime.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = resolve(root, 'public/wasm');
const modelDst = resolve(root, 'public/models/hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log('[assets] MediaPipe WASM runtime ready');
} else {
  console.warn('[assets] @mediapipe/tasks-vision not installed yet — skipping WASM copy');
}

if (!existsSync(modelDst) || statSync(modelDst).size < 1e6) {
  try {
    mkdirSync(dirname(modelDst), { recursive: true });
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()));
    console.log('[assets] Downloaded hand_landmarker.task');
  } catch (err) {
    console.warn(`[assets] Could not download hand model (${err instanceof Error ? err.message : err}). The app will fall back to the CDN at runtime.`);
  }
} else {
  console.log('[assets] hand_landmarker.task present');
}
