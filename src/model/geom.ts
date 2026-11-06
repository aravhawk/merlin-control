/**
 * Procedural CAD-style geometry kit.
 *
 * Every primitive returns a `Part`: { solid, wire }
 *   solid – indexed THREE.BufferGeometry (position + normal) for the shaded mesh
 *   wire  – flat number[] of line-segment endpoints (x1,y1,z1,x2,y2,z2,...)
 *
 * The wireframe is NOT a triangle mesh dump. It is a deliberate "CAD edge" set:
 * longitudinal iso-lines + hoop rings, adaptively decimated (Douglas-Peucker) so
 * straight runs cost one segment and curved runs only as many as they need.
 * That is what gives the dense-but-clean look of an NX wireframe.
 */
import * as THREE from 'three';

/** A primitive's output: shaded mesh (optional) + flat line-segment endpoints. */
export interface Part {
  solid: THREE.BufferGeometry | null;
  wire: number[];
}

/** Profile point for `revolve`: [r, y] or [r, y, crease] (crease is truthy to split strips). */
export type ProfilePoint = readonly number[];
export type Vec3Like = THREE.Vector3 | readonly [number, number, number];
export type Axis = 'x' | 'y' | 'z';

export const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();

// ───────────────────────────────────────────────────────── helpers ──

/** Douglas-Peucker polyline decimation (works on Vector3[]). */
export function decimate(pts: THREE.Vector3[], tol: number): THREE.Vector3[] {
  const n = pts.length;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();
  while (stack.length) {
    const [a, b] = stack.pop()!;
    ab.subVectors(pts[b], pts[a]);
    const abLen2 = ab.lengthSq();
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      ap.subVectors(pts[i], pts[a]);
      let t = abLen2 > 1e-12 ? ap.dot(ab) / abLen2 : 0;
      t = THREE.MathUtils.clamp(t, 0, 1);
      const dx = ap.x - ab.x * t;
      const dy = ap.y - ab.y * t;
      const dz = ap.z - ab.z * t;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol * tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function pushPolyline(out: number[], pts: readonly THREE.Vector3[]): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

function pushLoop(out: number[], pts: readonly THREE.Vector3[]): void {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

/** Small deterministic RNG so the model is identical on every load. */
export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────── transforms ──

export const M = {
  /** translation */
  t: (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z),
  rx: (a: number) => new THREE.Matrix4().makeRotationX(a),
  ry: (a: number) => new THREE.Matrix4().makeRotationY(a),
  rz: (a: number) => new THREE.Matrix4().makeRotationZ(a),
  /** compose a sequence, applied right-to-left like matrix multiplication */
  mul: (...ms: THREE.Matrix4[]) => ms.reduce((acc, m) => acc.multiply(m), new THREE.Matrix4()),
  /** Maps local +Y onto (to - from) and the origin onto `from`. */
  along(from: THREE.Vector3, to: THREE.Vector3): { matrix: THREE.Matrix4; length: number } {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
    return {
      matrix: new THREE.Matrix4().compose(from, q, new THREE.Vector3(1, 1, 1)),
      length: len,
    };
  },
};

/** Apply a matrix to a Part in place and return it. */
export function place<P extends Part>(part: P, matrix?: THREE.Matrix4 | null): P {
  if (!matrix) return part;
  if (part.solid) part.solid.applyMatrix4(matrix);
  const w = part.wire;
  for (let i = 0; i < w.length; i += 3) {
    _v.set(w[i], w[i + 1], w[i + 2]).applyMatrix4(matrix);
    w[i] = _v.x;
    w[i + 1] = _v.y;
    w[i + 2] = _v.z;
  }
  return part;
}

// ───────────────────────────────────────────────────── custom curves ──

/** Circle (or arc) in an arbitrary plane. */
export class CircleCurve extends THREE.Curve<THREE.Vector3> {
  center: THREE.Vector3;
  radius: number;
  axis: Axis;
  a0: number;
  a1: number;

  constructor(center: THREE.Vector3, radius: number, axis: Axis = 'y', a0 = 0, a1 = TAU) {
    super();
    this.center = center.clone();
    this.radius = radius;
    this.axis = axis;
    this.a0 = a0;
    this.a1 = a1;
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = this.a0 + (this.a1 - this.a0) * t;
    const c = Math.cos(a) * this.radius;
    const s = Math.sin(a) * this.radius;
    if (this.axis === 'y') target.set(c, 0, s);
    else if (this.axis === 'z') target.set(c, s, 0);
    else target.set(0, c, s);
    return target.add(this.center);
  }
}

/** Accepts a Vector3 or an [x, y, z] array. */
const toVec3 = (p: Vec3Like): THREE.Vector3 => (p instanceof THREE.Vector3 ? p : new THREE.Vector3(p[0], p[1], p[2]));

/** Piecewise path made from straight runs + quadratic-bezier fillets at the corners. */
export function filletPath(points: readonly Vec3Like[], radius: number): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const P = points.map(toVec3);
  let cursor = P[0].clone();
  for (let i = 1; i < P.length - 1; i++) {
    const prev = P[i - 1];
    const cur = P[i];
    const next = P[i + 1];
    const d0 = prev.distanceTo(cur);
    const d1 = cur.distanceTo(next);
    const r = Math.min(radius, d0 * 0.5, d1 * 0.5);
    const a = cur.clone().lerp(prev, r / d0);
    const b = cur.clone().lerp(next, r / d1);
    if (cursor.distanceTo(a) > 1e-6) path.add(new THREE.LineCurve3(cursor, a));
    path.add(new THREE.QuadraticBezierCurve3(a, cur.clone(), b));
    cursor = b;
  }
  const last = P[P.length - 1];
  if (cursor.distanceTo(last) > 1e-6) path.add(new THREE.LineCurve3(cursor, last));
  return path;
}

// ───────────────────────────────────────────────────── surfaces of revolution ──

function sampleStrip(pts: THREE.Vector2[], smooth: boolean, spacing: number): THREE.Vector2[] {
  if (pts.length === 2 || !smooth) {
    // polylines: keep their own vertices (cheap, exact)
    return pts.map((p) => p.clone());
  }
  const c = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p.x, p.y, 0)),
    false,
    'centripetal'
  );
  const len = c.getLength();
  const n = Math.max(2, Math.ceil(len / spacing));
  return c.getSpacedPoints(n).map((p) => new THREE.Vector2(p.x, p.y));
}

/**
 * Surface of revolution about the Y axis.
 *
 * `profile` is a list of [r, y, crease?]. Orientation convention: the exterior
 * (outward normal) is on the LEFT of the direction of travel in the (r,y) plane.
 * Points flagged `crease` split the profile into separately-shaded strips and
 * always get a hoop ring in the wireframe.
 *
 * Options:
 *   radial     – solid radial segments
 *   lines      – number (or per-strip array) of longitudinal wire lines
 *   ringSpacing– extra hoop rings every N units of profile length (0 = creases only)
 *   noRings    – suppress ring generation entirely
 */
export interface RevolveOptions {
  radial?: number;
  lines?: number | number[];
  tol?: number;
  ringSpacing?: number;
  ringSeg?: number;
  smooth?: boolean;
  solidSpacing?: number;
  noRings?: boolean;
  trimEnds?: boolean;
}

export function revolve(profile: readonly ProfilePoint[], o: RevolveOptions = {}): Part {
  const opt: Required<RevolveOptions> = {
    radial: 64,
    lines: 24,
    tol: 0.003,
    ringSpacing: 0,
    ringSeg: 0,
    smooth: true,
    solidSpacing: 0.04,
    noRings: false,
    trimEnds: false,
    ...o,
  };

  // split into strips at creases
  const strips: THREE.Vector2[][] = [];
  let cur: THREE.Vector2[] = [];
  profile.forEach((p, i) => {
    cur.push(new THREE.Vector2(p[0], p[1]));
    if (i > 0 && (p[2] || i === profile.length - 1)) {
      strips.push(cur);
      cur = [new THREE.Vector2(p[0], p[1])];
    }
  });

  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const wire: number[] = [];
  const ringKeys = new Set<string>();
  const rings: [number, number][] = [];

  const addRing = (r: number, y: number) => {
    if (r < 1e-3) return;
    const key = `${r.toFixed(4)},${y.toFixed(4)}`;
    if (ringKeys.has(key)) return;
    ringKeys.add(key);
    rings.push([r, y]);
  };

  strips.forEach((strip, si) => {
    // ---- solid ----
    {
      const Q = sampleStrip(strip, opt.smooth, opt.solidSpacing);
      const m = Q.length;
      const base = pos.length / 3;
      for (let k = 0; k < m; k++) {
        const a = Q[Math.max(0, k - 1)];
        const b = Q[Math.min(m - 1, k + 1)];
        let tx = b.x - a.x;
        let ty = b.y - a.y;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const nr = -ty;
        const ny = tx;
        for (let j = 0; j <= opt.radial; j++) {
          const th = (TAU * j) / opt.radial;
          const c = Math.cos(th);
          const s = Math.sin(th);
          pos.push(Q[k].x * c, Q[k].y, Q[k].x * s);
          nor.push(nr * c, ny, nr * s);
        }
      }
      const stride = opt.radial + 1;
      for (let k = 0; k < m - 1; k++) {
        for (let j = 0; j < opt.radial; j++) {
          const a = base + k * stride + j;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
    }

    // ---- wire ----
    const L = Array.isArray(opt.lines) ? opt.lines[si] ?? 0 : opt.lines;
    const dense = sampleStrip(strip, opt.smooth, 0.01);
    const dec = decimate(
      dense.map((p) => new THREE.Vector3(p.x, p.y, 0)),
      opt.tol
    );
    if (L > 0) {
      for (let i = 0; i < L; i++) {
        const th = (TAU * i) / L;
        const c = Math.cos(th);
        const s = Math.sin(th);
        const poly = dec.map((p) => new THREE.Vector3(p.x * c, p.y, p.x * s));
        pushPolyline(wire, poly);
      }
    }

    // ring candidates: strip ends + interior spacing
    if (!opt.noRings) {
      if (si > 0 || !opt.trimEnds) addRing(strip[0].x, strip[0].y);
      if (si < strips.length - 1 || !opt.trimEnds) addRing(strip[strip.length - 1].x, strip[strip.length - 1].y);
      if (opt.ringSpacing > 0) {
        let acc = 0;
        let next = opt.ringSpacing;
        for (let k = 1; k < dense.length; k++) {
          const seg = dense[k].distanceTo(dense[k - 1]);
          acc += seg;
          while (acc >= next) {
            const f = 1 - (acc - next) / (seg || 1);
            addRing(
              dense[k - 1].x + (dense[k].x - dense[k - 1].x) * f,
              dense[k - 1].y + (dense[k].y - dense[k - 1].y) * f
            );
            next += opt.ringSpacing;
          }
        }
      }
    }
  });

  // hoop rings
  const maxL = Array.isArray(opt.lines) ? Math.max(...opt.lines, 8) : Math.max(opt.lines, 8);
  for (const [r, y] of rings) {
    const n = opt.ringSeg || Math.max(8, Math.min(maxL, Math.ceil((TAU * r) / 0.03)));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const th = (TAU * i) / n;
      pts.push(new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th)));
    }
    pushLoop(wire, pts);
  }

  let solid: THREE.BufferGeometry | null = null;
  if (pos.length) {
    solid = new THREE.BufferGeometry();
    solid.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    solid.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    solid.setIndex(idx);
  }
  return { solid, wire };
}

// ───────────────────────────────────────────────────── swept tubes ──

/**
 * Circle swept along a 3-D curve (parallel-transport frames, so no twisting).
 * `radius` is a number or (u∈[0,1], length) => number.
 */
export type RadiusFn = (u: number, length: number) => number;

export interface TubeOptions {
  radial?: number;
  lines?: number;
  ringSeg?: number;
  ringSpacing?: number;
  tol?: number;
  caps?: boolean;
  endRings?: boolean;
  closed?: boolean;
  spacing?: number;
  /** radius used for the wire (defaults to the solid radius) */
  wireRadius?: number | RadiusFn;
}

export function tube(curve: THREE.Curve<THREE.Vector3>, radius: number | RadiusFn, o: TubeOptions = {}): Part {
  const opt = {
    radial: 20,
    lines: 8,
    ringSeg: 0,
    ringSpacing: 0,
    tol: 0.0025,
    caps: true,
    endRings: true,
    closed: false,
    spacing: 0.03,
    ...o,
  };
  const len = curve.getLength();
  const N = Math.max(8, Math.ceil(len / opt.spacing));
  const frames = curve.computeFrenetFrames(N, opt.closed);
  const toFn = (r: number | RadiusFn): RadiusFn => (typeof r === 'function' ? r : () => r);
  const rad = toFn(radius);
  const wrad = opt.wireRadius ? toFn(opt.wireRadius) : rad;
  const P: THREE.Vector3[] = [];
  const R: number[] = [];
  const RW: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    P.push(curve.getPointAt(u));
    R.push(rad(u, len));
    RW.push(wrad(u, len));
  }
  const ringPoint = (i: number, a: number, RR = R): THREE.Vector3 =>
    P[i]
      .clone()
      .addScaledVector(frames.normals[i], Math.cos(a) * RR[i])
      .addScaledVector(frames.binormals[i], Math.sin(a) * RR[i]);

  const wire: number[] = [];
  let solid: THREE.BufferGeometry | null = null;

  {
    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    const stride = opt.radial + 1;
    for (let i = 0; i <= N; i++) {
      for (let k = 0; k <= opt.radial; k++) {
        const a = (TAU * k) / opt.radial;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const p = ringPoint(i, a);
        pos.push(p.x, p.y, p.z);
        const n = frames.normals[i].clone().multiplyScalar(c).addScaledVector(frames.binormals[i], s);
        nor.push(n.x, n.y, n.z);
      }
    }
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < opt.radial; k++) {
        const a = i * stride + k;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    if (opt.caps && !opt.closed) {
      const capEnd = (i: number, sign: number) => {
        const base = pos.length / 3;
        const T = frames.tangents[i];
        pos.push(P[i].x, P[i].y, P[i].z);
        nor.push(T.x * sign, T.y * sign, T.z * sign);
        for (let k = 0; k <= opt.radial; k++) {
          const p = ringPoint(i, (TAU * k) / opt.radial);
          pos.push(p.x, p.y, p.z);
          nor.push(T.x * sign, T.y * sign, T.z * sign);
        }
        for (let k = 0; k < opt.radial; k++) {
          if (sign < 0) idx.push(base, base + 2 + k, base + 1 + k);
          else idx.push(base, base + 1 + k, base + 2 + k);
        }
      };
      capEnd(0, -1);
      capEnd(N, 1);
    }
    solid = new THREE.BufferGeometry();
    solid.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    solid.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    solid.setIndex(idx);
  }

  {
    const L = opt.lines;
    const loops = opt.closed && L === 0 ? 1 : L; // a bare torus still shows its main loop
    for (let k = 0; k < loops; k++) {
      const a = (TAU * k) / loops;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= N; i++) pts.push(ringPoint(i, a, RW));
      pushPolyline(wire, decimate(pts, opt.tol));
    }
    const ringIdx = new Set<number>();
    if (opt.endRings && !opt.closed) {
      ringIdx.add(0);
      ringIdx.add(N);
    }
    if (opt.ringSpacing > 0) {
      for (let s = opt.ringSpacing; s < len - 1e-4; s += opt.ringSpacing) {
        ringIdx.add(Math.round((s / len) * N));
      }
    }
    for (const i of ringIdx) {
      const rr = RW[i];
      if (rr < 1e-3) continue;
      const m = opt.ringSeg || (L >= 6 ? L : 12);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < m; k++) pts.push(ringPoint(i, (TAU * k) / m, RW));
      pushLoop(wire, pts);
    }
  }
  return { solid, wire };
}

/** Torus ring around the Y axis (or any axis via `place`). */
export function torus(R: number, r: number, y = 0, o: TubeOptions = {}): Part {
  return tube(new CircleCurve(new THREE.Vector3(0, y, 0), R, 'y'), r, {
    radial: 16,
    lines: 6,
    ringSeg: 0,
    closed: true,
    spacing: Math.max(0.02, R / 40),
    ...o,
  });
}

// ───────────────────────────────────────────────────── mesh-based prims ──

function stripGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  out.setAttribute('normal', g.getAttribute('normal'));
  out.setIndex(g.getIndex());
  return out;
}

/** Wrap any BufferGeometry; wire = feature edges above `angle` degrees. */
export function fromGeometry(g: THREE.BufferGeometry, angle = 25, matrix: THREE.Matrix4 | null = null): Part {
  const solid = stripGeometry(g);
  const edges = new THREE.EdgesGeometry(g, angle);
  const wire = Array.from(edges.getAttribute('position').array as Float32Array);
  const part: Part = { solid, wire };
  return matrix ? place(part, matrix) : part;
}

export function box(w: number, h: number, d: number, matrix: THREE.Matrix4 | null = null): Part {
  return fromGeometry(new THREE.BoxGeometry(w, h, d), 20, matrix);
}

/** Solid cylinder about Y from y0 to y1 with optional wire line count. */
export function cylinder(r: number, y0: number, y1: number, o: Omit<RevolveOptions, 'lines'> & { lines?: number } = {}): Part {
  const { lines = 0, radial = 32, ...rest } = o;
  return revolve(
    [
      [0, y1],
      [r, y1, 1],
      [r, y0, 1],
      [0, y0],
    ],
    { radial, lines: [0, lines, 0], smooth: false, ...rest }
  );
}

/** Cylinder between two arbitrary points. */
export function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, o: Parameters<typeof cylinder>[3] = {}): Part {
  const { matrix, length } = M.along(a, b);
  return place(cylinder(r, 0, length, o), matrix);
}

/** Hex bolt head sitting on y, pointing up. Wire is the 6-edge hex outline. */
const _hexGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
export function hexBolt(size: number, height: number, matrix?: THREE.Matrix4): Part {
  const solid = stripGeometry(_hexGeo.clone());
  solid.scale(size, height, size);
  solid.translate(0, height / 2, 0);
  const wire: number[] = [];
  const top: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (TAU * i) / 6 + Math.PI / 6;
    top.push(new THREE.Vector3(Math.cos(a) * size, height, Math.sin(a) * size));
  }
  pushLoop(wire, top); // just the hex outline — keeps the wireframe light
  return place({ solid, wire }, matrix);
}

/** A ring of hex bolts on a horizontal plane, heads facing +Y. */
export function boltRing(radius: number, y: number, count: number, size: number, height: number, phase = 0): Part[] {
  const parts: Part[] = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (TAU * i) / count;
    parts.push(hexBolt(size, height, M.t(Math.cos(a) * radius, y, Math.sin(a) * radius)));
  }
  return parts;
}

/** Small polygon circle (orifice / port) lying in the XZ plane. */
export function circleWire(cx: number, y: number, cz: number, r: number, seg = 6): Part {
  const wire: number[] = [];
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (TAU * i) / seg;
    pts.push(new THREE.Vector3(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r));
  }
  pushLoop(wire, pts);
  return { solid: null, wire };
}

/** Thin cable: a polyline (wire) + a very thin tube (solid). */
export function cable(points: readonly Vec3Like[], radius = 0.006): Part {
  const curve = new THREE.CatmullRomCurve3(
    points.map(toVec3),
    false,
    'centripetal'
  );
  return tube(curve, radius, { radial: 5, lines: 1, spacing: 0.05, caps: false, endRings: false, tol: 0.004 });
}

/** Flat annulus / ring body with rectangular section (closed profile). */
export function annulus(ri: number, ro: number, y0: number, y1: number, o: RevolveOptions = {}): Part {
  return revolve(
    [
      [ro, y1],
      [ro, y0, 1],
      [ri, y0, 1],
      [ri, y1, 1],
      [ro, y1, 1],
    ],
    { smooth: false, lines: 0, ...o }
  );
}

/**
 * Circular (or elliptical, with `radY`) arc for revolve profiles: angles in radians,
 * (cr, cy) centre. Pass `creaseEnd` to make the last point a profile crease.
 */
export function arc(cr: number, cy: number, rad: number, a0: number, a1: number, n = 12, { radY = rad, creaseEnd = false } = {}): ProfilePoint[] {
  const out: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cr + Math.cos(a) * rad, cy + Math.sin(a) * radY]);
  }
  if (creaseEnd) out[n].push(1);
  return out;
}

/**
 * Rectangular hoop stiffener sitting on a wall of inner radius `ri` at height `y`
 * (half-height `h`, radial depth `depth`). Only its two outer hoops are drawn.
 */
export function hoopBand(ri: number, y: number, h: number, depth: number, { radial = 96, ringSeg = 44 } = {}): Part {
  return revolve([[ri, y + h], [ri + depth, y + h, 1], [ri + depth, y - h, 1], [ri, y - h]], {
    lines: 0,
    radial,
    smooth: false,
    trimEnds: true,
    ringSeg,
  });
}

// ───────────────────────────────────────────────────── merging ──

/** Collects Parts, groups the solids by material, and flattens wire data. */
export type MaterialKey = 'steel' | 'chrome' | 'bronze' | 'copper' | 'inconel' | 'titanium' | 'black';

export class Builder {
  readonly wire: number[] = [];
  readonly solids = new Map<MaterialKey, THREE.BufferGeometry[]>();

  add(part: Part | Part[], material: MaterialKey = 'steel', matrix: THREE.Matrix4 | null = null): this {
    if (Array.isArray(part)) {
      part.forEach((p) => this.add(p, material, matrix));
      return this;
    }
    if (matrix) place(part, matrix);
    for (let i = 0; i < part.wire.length; i++) this.wire.push(part.wire[i]);
    if (part.solid) {
      let list = this.solids.get(material);
      if (!list) this.solids.set(material, (list = []));
      list.push(part.solid);
    }
    return this;
  }
  /** Wire-only extras (e.g. decorative lines) */
  addWire(wire: readonly number[]): this {
    for (let i = 0; i < wire.length; i++) this.wire.push(wire[i]);
    return this;
  }
  get segmentCount(): number {
    return this.wire.length / 6;
  }
}
