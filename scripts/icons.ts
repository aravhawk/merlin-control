// Draws the app icon from the real engine contour (the same profile the 3D model is
// revolved from), in the site's own colors: cyan wireframe on the near black ground.
//
//   node scripts/icons.ts <out-dir>
//
// Writes two SVGs: `favicon.svg` (a rounded tile, shipped as the browser tab icon) and
// `icon-bleed.svg` (full bleed with no corners, the master for the raster icons because
// iOS and Android apply their own mask). See the README for the export sizes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIM, wallR } from '../src/model/merlin.ts';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/icons.ts <out-dir>');
  process.exit(1);
}

// Tokens from src/style.css
const BG = '#02040a';
const ACCENT = '#59d8ff';
const ACCENT_2 = '#9ff0ff';

const SIZE = 512;
const CX = SIZE / 2;
const STROKE = 18;
const SAFE_RADIUS = SIZE * 0.4; // maskable icons keep this central circle on every launcher

// Icon proportions: the chamber is cut short and the bell is widened a little, so the
// flare reads as a rocket nozzle at 16px.
const TOP = DIM.yBarrel + 0.12; // top of the chamber stub (m)
const XSTRETCH = 1.45;
const K = 176; // pixels per metre, vertical
const KX = K * XSTRETCH;
const FLANGE = 16; // mount flange thickness (px)
const RIM_RY = 0.17; // rim ellipse flattening (ry / rx)

const exitRx = wallR(DIM.yExit) * KX;
const rimRy = exitRx * RIM_RY;
const bodyH = (TOP - DIM.yExit) * K;
const totalH = FLANGE + bodyH + rimRy;
const yTop = (SIZE - totalH) / 2 + FLANGE; // pixel y of the top of the chamber stub
const py = (y: number) => yTop + (TOP - y) * K;
const px = (r: number, side: 1 | -1) => CX + side * r * KX;
const f = (n: number) => n.toFixed(1);

// Wall points, top to bottom.
const ys: number[] = [TOP];
for (let y = Math.min(TOP, DIM.yBarrel) - 0.02; y > DIM.yExit; y -= 0.02) ys.push(y);
ys.push(DIM.yExit);
const rightWall = ys.map((y) => `L${f(px(wallR(y), 1))} ${f(py(y))}`).join('');
const leftWall = [...ys].reverse().map((y) => `L${f(px(wallR(y), -1))} ${f(py(y))}`).join('');

// Outline: down the right wall, round the front of the rim, up the left wall.
const outline =
  `M${f(px(wallR(TOP), -1))} ${f(py(TOP))}${rightWall}` +
  `A${f(exitRx)} ${f(rimRy)} 0 0 1 ${f(px(wallR(DIM.yExit), -1))} ${f(py(DIM.yExit))}${leftWall}Z`;

// The back half of the rim shows through the wireframe.
const rimBack = `M${f(CX - exitRx)} ${f(py(DIM.yExit))}A${f(exitRx)} ${f(rimRy)} 0 0 1 ${f(CX + exitRx)} ${f(py(DIM.yExit))}`;

// Curved hoops (front arcs) around the neck and bell: they turn a flat shape into a solid of revolution.
const hoops = [DIM.yThroat, -0.45, -0.8]
  .map((y) => {
    const rx = wallR(y) * KX;
    return `<path d="M${f(CX - rx)} ${f(py(y))}A${f(rx)} ${f(rx * RIM_RY)} 0 0 0 ${f(CX + rx)} ${f(py(y))}"/>`;
  })
  .join('');

const fw = wallR(TOP) * KX + 12;
const flange = `<rect x="${f(CX - fw)}" y="${f(py(TOP) - FLANGE)}" width="${f(fw * 2)}" height="${FLANGE}" rx="5" fill="${ACCENT}" fill-opacity="0.35" stroke="${ACCENT}" stroke-width="${STROKE * 0.7}" stroke-linejoin="round"/>`;

const glyph =
  `<path d="${outline}" fill="${ACCENT}" fill-opacity="0.2" stroke="${ACCENT}" stroke-width="${STROKE}" stroke-linejoin="round"/>` +
  `<path d="${rimBack}" fill="none" stroke="${ACCENT}" stroke-opacity="0.45" stroke-width="${STROKE * 0.55}"/>` +
  `<g fill="none" stroke="${ACCENT_2}" stroke-opacity="0.75" stroke-width="${STROKE * 0.55}" stroke-linecap="round">${hoops}</g>` +
  flange;

// Safety: nothing may leave the maskable safe circle (outline points plus half the stroke).
const farthest = Math.max(
  ...ys.flatMap((y) => [-1, 1].map((s) => Math.hypot(px(wallR(y), s as 1 | -1) - CX, py(y) - SIZE / 2))),
  Math.hypot(exitRx, py(DIM.yExit) - SIZE / 2),
  Math.hypot(0, py(DIM.yExit) + rimRy - SIZE / 2),
  Math.hypot(fw, py(TOP) - FLANGE - SIZE / 2),
);
if (farthest + STROKE / 2 > SAFE_RADIUS) {
  throw new Error(`icon glyph leaves the maskable safe zone: ${(farthest + STROKE / 2).toFixed(1)} > ${SAFE_RADIUS}`);
}

const svg = (corner: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">` +
  `<rect width="${SIZE}" height="${SIZE}" rx="${corner}" fill="${BG}"/>${glyph}</svg>\n`;

mkdirSync(resolve(out), { recursive: true });
writeFileSync(resolve(out, 'favicon.svg'), svg(112));
writeFileSync(resolve(out, 'icon-bleed.svg'), svg(0));
console.log(`wrote favicon.svg and icon-bleed.svg to ${out} (glyph reach ${(farthest + STROKE / 2).toFixed(0)} of ${SAFE_RADIUS})`);
