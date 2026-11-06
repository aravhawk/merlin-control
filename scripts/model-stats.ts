// Prints per-assembly line-segment and triangle counts of the procedural model.
import { buildMerlin } from '../src/model/merlin.ts';

const t0 = performance.now();
const m = buildMerlin();
console.log(`build ${Math.round(performance.now() - t0)} ms\n`);

let tris = 0;
for (const a of m.assemblies) {
  const t = a.solids.reduce((sum, s) => sum + (s.geometry.index?.count ?? 0) / 3, 0);
  tris += t;
  console.log(a.id.padEnd(10), String(Math.round(a.segments)).padStart(6), 'segs', String(t).padStart(8), 'tris');
}
console.log('\nTOTAL'.padEnd(11), String(m.totalSegments).padStart(6), 'segs', String(tris).padStart(8), 'tris');
const fmt = (v: number[]) => v.map((x) => x.toFixed(2)).join(', ');
console.log(`bounds  min (${fmt(m.bounds.min.toArray())})  max (${fmt(m.bounds.max.toArray())})`);
