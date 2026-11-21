// Builds the social share card (1200x630) as a self-contained HTML page from the real
// procedural engine model, so the preview always shows the same geometry the app draws.
//
//   node scripts/og-image.ts <out.html>
//
// Open the page in a browser at exactly 1200x630 (device pixel ratio 1), wait for the web
// font to load, and save a screenshot as public/og-image.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildMerlin, wallR } from '../src/model/merlin.ts';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/og-image.ts <out.html>');
  process.exit(1);
}

// ── card + tokens (mirrors :root in src/style.css) ─────────────────────────────
const W = 1200;
const H = 630;
const MARGIN = 64;
const BG = '#02040a';
const INK = '#d9f4ff';
const ACCENT = '#59d8ff';
const ACCENT_2 = '#9ff0ff';

const SITE = 'merlin.aravhawk.com';
const HEADLINE = ['Rotate a rocket', 'engine with your', 'bare hands.'];
const SUBLINE = ['Spin, zoom and flick a wireframe SpaceX', 'Merlin 1D with a webcam. No install.'];

// Engine placement: the part of the card the wireframe may occupy.
const ENGINE_BOX = { x0: 664, x1: 968, y0: 56, y1: H - 56 };
const LABEL_X = W - MARGIN - 146; // part labels end on the right margin (15 characters at 14px)

// View: a three quarter angle from slightly above, with the app's lens (34 degree FOV).
const YAW = -0.74;
const PITCH = 0.3;
const CAM_DIST = 7;
const FOV = (34 * Math.PI) / 180;
const DEPTH_BINS = 8;

const model = buildMerlin();

type P = { x: number; y: number; z: number };
function view(x: number, y: number, z: number): P {
  const cy = Math.cos(YAW);
  const sy = Math.sin(YAW);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(PITCH);
  const sp = Math.sin(PITCH);
  const y1 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  const k = 1 / ((CAM_DIST - z2) * Math.tan(FOV / 2));
  return { x: x1 * k, y: y1 * k, z: z2 };
}

// Project every wire segment once, then fit the whole engine into the box.
const segs: { a: P; b: P }[] = [];
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;
for (const asm of model.assemblies) {
  const w = asm.wire;
  for (let i = 0; i < w.length; i += 6) {
    const a = view(w[i], w[i + 1], w[i + 2]);
    const b = view(w[i + 3], w[i + 4], w[i + 5]);
    segs.push({ a, b });
    for (const p of [a, b]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
}
const boxW = ENGINE_BOX.x1 - ENGINE_BOX.x0;
const boxH = ENGINE_BOX.y1 - ENGINE_BOX.y0;
const scale = Math.min(boxW / (maxX - minX), boxH / (maxY - minY));
const offX = ENGINE_BOX.x0 + (boxW - (maxX - minX) * scale) / 2 - minX * scale;
const offY = ENGINE_BOX.y0 + (boxH - (maxY - minY) * scale) / 2 + maxY * scale;
const sx = (p: P) => offX + p.x * scale;
const sy = (p: P) => offY - p.y * scale;
const f = (n: number) => n.toFixed(1);

// Depth cue: nearer segments are brighter, like the app's wireframe material.
const bins: string[] = Array.from({ length: DEPTH_BINS }, () => '');
for (const { a, b } of segs) {
  const t = ((a.z + b.z) / 2 - minZ) / (maxZ - minZ);
  const bin = Math.min(DEPTH_BINS - 1, Math.floor(t * DEPTH_BINS));
  bins[bin] += `M${f(sx(a))} ${f(sy(a))}L${f(sx(b))} ${f(sy(b))}`;
}
const mix = (c0: number[], c1: number[], t: number) => c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
const FAR = [38, 150, 196];
const NEAR = [214, 249, 255];
const wirePaths = bins
  .map((d, i) => {
    const t = i / (DEPTH_BINS - 1);
    const [r, g, b] = mix(FAR, NEAR, t);
    const opacity = (0.4 + 0.58 * t).toFixed(2);
    return `<path d="${d}" stroke="rgb(${r} ${g} ${b})" stroke-opacity="${opacity}"/>`;
  })
  .join('');

// Part labels, drawn like the app's label overlay: a dot on the part and an elbow leader.
// Anchors sit on the right hand silhouette so the leaders stay short.
const rim = (y: number): [number, number, number] => [wallR(y) * Math.cos(YAW), y, wallR(y) * Math.sin(YAW)];
const anchorOf = (id: string): [number, number, number] => {
  const asm = model.assemblies.find((a) => a.id === id);
  if (!asm) throw new Error(`unknown assembly ${id}`);
  return asm.anchor;
};
const LABELS: { text: string; at: [number, number, number] }[] = [
  { text: 'PINTLE INJECTOR', at: anchorOf('injector') },
  { text: 'TURBOPUMP', at: anchorOf('turbopump') },
  { text: 'NOZZLE', at: rim(-0.5) },
];
const labelMarkup = LABELS.map(({ text, at }) => {
  const p = view(...at);
  const x = sx(p);
  const y = sy(p);
  return (
    `<polyline points="${f(x)},${f(y)} ${f(LABEL_X - 12)},${f(y)}"/>` +
    `<circle cx="${f(x)}" cy="${f(y)}" r="3"/>` +
    `<text x="${LABEL_X}" y="${f(y + 5)}">${text}</text>`
  );
}).join('');

// Stars: sparse, deterministic, kept off the type column.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(1337);
let stars = '';
for (let i = 0; i < 150; i++) {
  const x = rand() * W;
  const y = rand() * H;
  const r = rand() < 0.12 ? 1.4 : 0.9;
  const o = 0.2 + rand() * 0.55;
  const inText = x < 640 && y > 40 && y < H - 40;
  if (inText && rand() < 0.85) continue;
  stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill-opacity="${o.toFixed(2)}"/>`;
}

const haloX = ((ENGINE_BOX.x0 + ENGINE_BOX.x1) / 2 / W) * 100;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Merlin 1D share card</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=block" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: ${BG}; }
  body { width: ${W}px; height: ${H}px; overflow: hidden; }
  .card { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${BG};
    font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace; color: ${INK}; -webkit-font-smoothing: antialiased; }
  .halo { position: absolute; inset: 0; background: radial-gradient(ellipse 340px 330px at ${haloX}% 50%, rgba(34, 150, 196, 0.24), rgba(34, 150, 196, 0) 100%); }
  .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at ${haloX}% 50%, rgba(0, 0, 0, 0) 45%, rgba(0, 0, 0, 0.5) 100%); }
  svg { position: absolute; inset: 0; width: ${W}px; height: ${H}px; }
  .glow { filter: blur(6px); }
  .glow-wide { filter: blur(20px); opacity: 0.7; }
  .wire path { fill: none; stroke-width: 1; stroke-linecap: round; }
  .stars circle { fill: #d9f4ff; }
  .labels polyline { fill: none; stroke: rgba(89, 216, 255, 0.7); stroke-width: 1; }
  .labels circle { fill: ${ACCENT_2}; }
  .labels text { fill: ${INK}; font: 500 14px/16px 'JetBrains Mono', monospace; letter-spacing: 0.09em; }
  .copy { position: absolute; left: ${MARGIN}px; top: ${MARGIN}px; bottom: ${MARGIN}px; width: 560px; display: flex; flex-direction: column; justify-content: space-between; }
  .mark { font-size: 24px; line-height: 32px; letter-spacing: 0.5em; font-weight: 500; color: #fff; white-space: nowrap; }
  h1 { margin: 0; font-size: 60px; line-height: 64px; font-weight: 600; letter-spacing: -0.035em; color: #fff; }
  h1 span { display: block; white-space: nowrap; }
  p { margin: 24px 0 0; font-size: 20px; line-height: 32px; font-weight: 400; color: rgba(190, 228, 245, 0.75); }
  p span { display: block; white-space: nowrap; }
  .url { display: flex; align-items: center; gap: 12px; font-size: 18px; line-height: 28px; letter-spacing: 0.06em; color: ${ACCENT}; font-weight: 500; }
  .url i { width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT}; box-shadow: 0 0 12px ${ACCENT}; }
</style>
</head>
<body>
<div class="card">
  <div class="halo"></div>
  <svg class="stars" viewBox="0 0 ${W} ${H}" aria-hidden="true">${stars}</svg>
  <svg class="wire glow-wide" viewBox="0 0 ${W} ${H}" aria-hidden="true">${wirePaths}</svg>
  <svg class="wire glow" viewBox="0 0 ${W} ${H}" aria-hidden="true">${wirePaths}</svg>
  <svg class="wire" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wireframe of the Merlin 1D engine">${wirePaths}</svg>
  <svg class="labels" viewBox="0 0 ${W} ${H}" aria-hidden="true">${labelMarkup}</svg>
  <div class="vignette"></div>
  <div class="copy">
    <div class="mark">MERLIN&nbsp;1D</div>
    <div>
      <h1>${HEADLINE.map((l) => `<span>${l}</span>`).join('')}</h1>
      <p>${SUBLINE.map((l) => `<span>${l}</span>`).join('')}</p>
    </div>
    <div class="url"><i></i>${SITE}</div>
  </div>
</div>
</body>
</html>
`;

mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} kB, ${segs.length} segments)`);
