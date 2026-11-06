import { buildMerlin } from '../src/model/merlin.js';
const t0 = performance.now();
const m = buildMerlin();
console.log('build ms', Math.round(performance.now() - t0));
let tris = 0;
for (const a of m.assemblies) {
  let t = 0;
  for (const s of a.solids) t += s.geometry.index.count / 3;
  tris += t;
  console.log(a.id.padEnd(10), String(Math.round(a.segments)).padStart(6), 'segs', String(t).padStart(8), 'tris');
}
console.log('TOTAL', m.totalSegments, 'segs', tris, 'tris');
const b = m.bounds; console.log('bounds', b.min.toArray().map(v=>v.toFixed(2)), b.max.toArray().map(v=>v.toFixed(2)));
