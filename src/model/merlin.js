/**
 * Procedural SpaceX Merlin 1D (sea-level) engine.
 *
 * Built entirely from parametric primitives (see geom.js) so no external model
 * files are required. The layout follows the public configuration of the engine:
 *
 *   gimbal bearing + thrust mount
 *   └ pintle injector head (LOX dome, fuel manifold, annular pintle, orifice field)
 *     └ regeneratively-cooled thrust chamber → throat
 *       └ regen-cooled bell nozzle with hoop stiffeners + fuel inlet manifold
 *         └ radiatively-cooled niobium-style extension skirt
 *   single-shaft turbopump (RP-1 pump | turbine | LOX pump) with spiral volutes
 *   gas generator, LOX/RP-1 feed ducts, long turbine-exhaust duct down the nozzle,
 *   TEA-TEB igniter, sensors/harness, two gimbal actuators.
 *
 * Axis convention: +Y is "up" (gimbal end), the nozzle exit points down (-Y),
 * the turbopump sits on +X. Units are metres.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Builder,
  M,
  TAU,
  annulus,
  arc,
  boltRing,
  box,
  cable,
  circleWire,
  cylinder,
  cylinderBetween,
  filletPath,
  fromGeometry,
  hoopBand,
  place,
  revolve,
  rng,
  torus,
  tube,
} from './geom.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ───────────────────────────────────────────── engine dimensions ──
export const DIM = {
  yFace: 0.66, // injector face / chamber head
  yBarrel: 0.26, // end of the fat cylindrical chamber ("vase" barrel)
  yThroat: -0.1,
  yRegen: -0.82, // end of regeneratively-cooled (copper) nozzle
  yExit: -1.24,
  rChamber: 0.265,
  rThroat: 0.125,
  rExit: 0.5, // area ratio 16
};

// ─────────────────────────────────────── thrust-chamber contour ──
/** Builds the inner wall contour (injector face → nozzle exit) as [{y, r}] top→bottom. */
function buildContour() {
  const pts = [];
  const { yFace, yBarrel, yThroat, yExit, rChamber: rc, rThroat: rt, rExit: re } = DIM;

  // fat cylindrical barrel
  pts.push({ y: yFace, r: rc });
  pts.push({ y: yBarrel, r: rc });

  // convergent section: shouldered entry, steep cone, rounded into the throat
  const nConv = 18;
  for (let i = 1; i <= nConv; i++) {
    const s = i / nConv;
    const e = 0.62 * s + 0.38 * (s * s * (3 - 2 * s));
    pts.push({ y: yBarrel + (yThroat - yBarrel) * s, r: rc + (rt - rc) * e });
  }

  // throat downstream arc (0.382 rt) then Rao parabolic bell
  const thN = (33 * Math.PI) / 180;
  const thE = (5.5 * Math.PI) / 180;
  const ra = 0.382 * rt;
  const arcN = 6;
  for (let i = 1; i <= arcN; i++) {
    const ph = (thN * i) / arcN;
    pts.push({ y: yThroat - ra * Math.sin(ph), r: rt + ra * (1 - Math.cos(ph)) });
  }
  const zN = ra * Math.sin(thN);
  const rN = rt + ra * (1 - Math.cos(thN));
  const zE = yThroat - yExit; // total length from throat plane
  const tN = Math.tan(thN);
  const tE = Math.tan(thE);
  const zI = (re - rN + tN * zN - tE * zE) / (tN - tE);
  const rI = rN + tN * (zI - zN);
  const nBell = 56;
  for (let i = 1; i <= nBell; i++) {
    const t = i / nBell;
    const z = (1 - t) * (1 - t) * zN + 2 * (1 - t) * t * zI + t * t * zE;
    const r = (1 - t) * (1 - t) * rN + 2 * (1 - t) * t * rI + t * t * re;
    pts.push({ y: yThroat - z, r });
  }
  return pts;
}

const CONTOUR = buildContour();

/** Inner wall radius at height y (linear interpolation of the contour). */
export function wallR(y) {
  if (y >= CONTOUR[0].y) return CONTOUR[0].r;
  for (let i = 1; i < CONTOUR.length; i++) {
    if (y >= CONTOUR[i].y) {
      const a = CONTOUR[i - 1];
      const b = CONTOUR[i];
      const t = (y - a.y) / (b.y - a.y);
      return a.r + (b.r - a.r) * t;
    }
  }
  return CONTOUR[CONTOUR.length - 1].r;
}

/** Contour slice as [r, y] points, top→bottom, sampled every `step` metres. */
function slice(yTop, yBot, step = 0.05, offset = 0) {
  const out = [];
  const n = Math.max(2, Math.ceil((yTop - yBot) / step));
  for (let i = 0; i <= n; i++) {
    const y = yTop + ((yBot - yTop) * i) / n;
    out.push([wallR(y) + offset, y]);
  }
  return out;
}

// ─────────────────────────────────────── shared layout anchors ──
const RC = DIM.rChamber;
const TP = V(0.74, 0.5, 0); // turbopump shaft centre
const GG_Z = 0.01; // gas generator offset (over the turbine)
const ACT_AZ = [(135 * Math.PI) / 180, (225 * Math.PI) / 180];
const Y_DOME = DIM.yFace + 0.04; // injector housing shoulder
const Y_APEX = DIM.yFace + 0.23; // top of the injector dome
const Y_COL = DIM.yFace + 0.36; // top of the central LOX column
const Y_BEAR = 1.14; // gimbal bearing centre

/** Place a part built with its axis along +Y so the axis lies along +Z at the turbopump. */
const pumpFrame = M.mul(M.t(TP.x, TP.y, TP.z), M.rx(Math.PI / 2));

/** Spiral volute + tangential discharge. Returns the part and the discharge end/tangent. */
function volute({ s, R0, R1, r0, r1, rEnd, a0, dir = 1, run = 0.12 }) {
  const pts = [];
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = a0 + dir * TAU * f;
    const R = R0 + (R1 - R0) * f;
    pts.push(V(Math.cos(a) * R, Math.sin(a) * R, s));
  }
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const tan = last.clone().sub(prev).normalize();
  const spiralPts = pts.length;
  for (let i = 1; i <= 6; i++) pts.push(last.clone().addScaledVector(tan, (run * i) / 6));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const lenTotal = curve.getLength();
  const spiralLen = new THREE.CatmullRomCurve3(pts.slice(0, spiralPts), false, 'centripetal').getLength();
  const uS = spiralLen / lenTotal;
  const radius = (u) =>
    u < uS ? r0 + (r1 - r0) * Math.pow(u / uS, 1.15) : r1 + (rEnd - r1) * ((u - uS) / (1 - uS));
  const part = tube(curve, radius, { radial: 24, lines: 6, ringSpacing: 0.22, spacing: 0.02, tol: 0.005 });
  return { part, end: pts[pts.length - 1].clone(), tangent: tan, rEnd };
}

// ──────────────────────────────────────────── assembly metadata ──
const META = [
  { id: 'gimbal', name: 'Gimbal & Thrust Mount', info: 'Spherical gimbal bearing and thrust frame transferring ~845 kN to the octaweb.', explode: [0, 0.65, 0], anchor: [0.0, 1.27, 0.0] },
  { id: 'actuators', name: 'Gimbal Actuators', info: 'Pair of hydraulic actuators steering the thrust vector ±5°.', explode: [-0.5, 0.8, 0.0], anchor: [-0.5, 1.28, 0.5] },
  { id: 'injector', name: 'Pintle Injector', info: 'Coaxial pintle injector — the throttle-friendly heart of the Merlin lineage.', explode: [0, 0.42, 0], anchor: [0.05, 0.84, 0.25] },
  { id: 'chamber', name: 'Thrust Chamber', info: 'Regeneratively cooled combustion chamber; RP-1 flows through the walls before injection.', explode: [0, 0.0, 0], anchor: [-0.27, 0.42, 0.1] },
  { id: 'nozzle', name: 'Regen-Cooled Nozzle', info: 'Copper-alloy bell with hoop stiffeners and a fuel inlet manifold feeding the cooling channels.', explode: [0, -0.4, 0], anchor: [-0.3, -0.45, 0.1] },
  { id: 'skirt', name: 'Nozzle Extension', info: 'Radiatively cooled skirt extending the sea-level nozzle to its exit plane.', explode: [0, -0.8, 0], anchor: [-0.42, -1.05, 0.1] },
  { id: 'turbopump', name: 'Turbopump', info: 'Single-shaft turbopump: RP-1 pump, open-cycle turbine and LOX pump.', explode: [0.7, 0.1, 0], anchor: [1.0, 0.5, 0.05] },
  { id: 'gg', name: 'Gas Generator', info: 'Fuel-rich gas generator driving the turbine.', explode: [0.7, 0.62, 0], anchor: [0.74, 1.0, 0.04] },
  { id: 'lox', name: 'LOX Feed System', info: 'Liquid-oxygen inlet duct and high-pressure line to the injector dome.', explode: [0.5, 0.45, 0.6], anchor: [0.78, 1.1, 0.62] },
  { id: 'fuel', name: 'RP-1 Feed System', info: 'RP-1 inlet duct and the high-pressure line to the nozzle cooling manifold.', explode: [0.45, 0.3, -0.7], anchor: [0.74, 1.0, -0.6] },
  { id: 'exhaust', name: 'Turbine Exhaust Duct', info: 'Spent turbine gas is ducted down the nozzle and vented near the exit plane.', explode: [0.85, -0.45, 0.4], anchor: [0.5, -0.7, 0.2] },
  { id: 'igniter', name: 'Igniter, Plumbing & Harness', info: 'TEA-TEB hypergolic igniter, instrumentation lines, valves and wiring harness.', explode: [-0.65, 0.4, -0.45], anchor: [-0.45, 0.9, -0.2] },
];

// ───────────────────────────────────────────── assemblies ──

function buildGimbal() {
  const b = new Builder();
  const yR = Y_DOME + 0.03; // thrust-frame ring
  b.add(cylinder(RC + 0.05, yR - 0.03, yR, { lines: 20 }), 'titanium');
  b.add(boltRing(RC + 0.03, yR, 18, 0.0105, 0.012), 'black');

  // truss struts from the ring up to the bearing socket
  for (let i = 0; i < 8; i++) {
    const a = (TAU * i) / 8 + Math.PI / 8;
    const p0 = V(Math.cos(a) * (RC + 0.03), yR, Math.sin(a) * (RC + 0.03));
    const p1 = V(Math.cos(a) * 0.1, Y_BEAR - 0.07, Math.sin(a) * 0.1);
    b.add(tube(new THREE.LineCurve3(p0, p1), 0.012, { radial: 8, lines: 2, endRings: false, caps: true }), 'titanium');
  }
  b.add(torus(0.17, 0.011, Y_COL + 0.02, { lines: 1, radial: 10, ringSeg: 30 }), 'titanium'); // truss hoop

  // bearing socket + sphere
  b.add(torus(0.125, 0.018, Y_BEAR - 0.07, { lines: 4, radial: 12 }), 'titanium');
  b.add(revolve(arc(0, Y_BEAR, 0.105, Math.PI / 2, -Math.PI / 2, 20), { lines: 10, radial: 40, ringSpacing: 0.06, tol: 0.002 }), 'chrome');

  // top mount plate
  const yP = Y_BEAR + 0.1;
  b.add(annulus(0.045, 0.34, yP, yP + 0.04, { radial: 64 }), 'titanium');
  b.add(cylinder(0.075, Y_BEAR, yP, { lines: 12 }), 'titanium');
  b.add(boltRing(0.29, yP + 0.04, 10, 0.011, 0.012, 0.1), 'black');
  for (let i = 0; i < 6; i++) {
    const a = (TAU * i) / 6 + Math.PI / 6;
    b.addWire(circleWire(Math.cos(a) * 0.2, yP + 0.0425, Math.sin(a) * 0.2, 0.036, 10).wire);
  }
  for (let i = 0; i < 4; i++) {
    const a = (TAU * i) / 4;
    const g = box(0.13, 0.012, 0.075);
    place(g, M.mul(M.ry(-a), M.t(0.12, yP - 0.06, 0), M.rz(-0.55)));
    b.add(g, 'titanium');
  }

  // actuator clevis lugs on the frame ring
  ACT_AZ.forEach((az) => {
    const g = box(0.06, 0.11, 0.045);
    place(g, M.mul(M.ry(-az), M.t(RC + 0.09, yR + 0.04, 0)));
    b.add(g, 'titanium');
    const pin = cylinder(0.011, -0.04, 0.04, { lines: 4, radial: 12 });
    place(pin, M.mul(M.ry(-az), M.t(RC + 0.105, yR + 0.06, 0), M.rx(Math.PI / 2)));
    b.add(pin, 'chrome');
  });
  return b;
}

function buildActuators() {
  const b = new Builder();
  const yR = Y_DOME + 0.03;
  ACT_AZ.forEach((az) => {
    const A = V(Math.cos(az) * (RC + 0.105), yR + 0.06, Math.sin(az) * (RC + 0.105));
    const B = V(Math.cos(az) * 0.7, 1.62, Math.sin(az) * 0.7);
    const { matrix, length: L } = M.along(A, B);

    const body = revolve(
      [
        [0.0, L * 0.64],
        [0.034, L * 0.64, 1],
        [0.048, L * 0.62, 1],
        [0.048, L * 0.1, 1],
        [0.034, L * 0.07, 1],
        [0.0, L * 0.07],
      ],
      { lines: [0, 0, 18, 0, 0], radial: 32, smooth: false, ringSpacing: 0, trimEnds: true }
    );
    const cooling = [];
    for (let k = 0; k < 6; k++) {
      cooling.push(torus(0.052, 0.006, L * (0.15 + k * 0.08), { lines: 0, radial: 8, ringSeg: 16, endRings: false }));
    }
    const rod = cylinder(0.021, L * 0.62, L * 0.94, { lines: 8, radial: 20 });
    const eyeTop = torus(0.026, 0.011, L * 0.965, { lines: 0, radial: 10, ringSeg: 12 });
    place(eyeTop, M.mul(M.t(0, L * 0.965, 0), M.rx(Math.PI / 2), M.t(0, -L * 0.965, 0)));
    const eyeBase = torus(0.028, 0.012, 0.0, { lines: 0, radial: 10, ringSeg: 12 });
    place(eyeBase, M.rx(Math.PI / 2));
    const collar = cylinder(0.062, L * 0.4, L * 0.43, { lines: 12, radial: 24 });
    const hose = (ang) => {
      const p0 = V(Math.cos(ang) * 0.058, L * 0.15, Math.sin(ang) * 0.058);
      const p1 = V(Math.cos(ang) * 0.075, L * 0.3, Math.sin(ang) * 0.075);
      const p2 = V(Math.cos(ang) * 0.058, L * 0.58, Math.sin(ang) * 0.058);
      return tube(new THREE.CatmullRomCurve3([p0, p1, p2]), 0.008, { radial: 8, lines: 3, endRings: false, spacing: 0.04 });
    };
    const parts = [
      [body, 'steel'],
      [rod, 'chrome'],
      [collar, 'titanium'],
      [eyeTop, 'titanium'],
      [eyeBase, 'titanium'],
      [hose(0.8), 'black'],
      [hose(2.4), 'black'],
      ...cooling.map((c) => [c, 'titanium']),
    ];
    for (const [p, mat] of parts) b.add(p, mat, matrix);
  });
  return b;
}

function buildInjector() {
  const b = new Builder();
  const { yFace } = DIM;
  const rh = RC + 0.025; // housing radius

  // dome + housing (travel apex → rim → down the wall → bevel to the face)
  const dome = arc(0, Y_DOME, RC - 0.01, Math.PI / 2, 0, 14, { radY: Y_APEX - Y_DOME, creaseEnd: true });
  b.add(
    revolve([...dome, [rh, Y_DOME, 1], [rh, yFace + 0.03, 1], [RC, yFace, 1]], {
      lines: [16, 0, 16, 0],
      radial: 72,
      ringSpacing: 0.06,
      tol: 0.002,
    }),
    'bronze'
  );

  // central LOX column on top of the dome, with its inlet flange
  b.add(revolve([[0.075, Y_COL], [0.075, Y_APEX - 0.02, 1]], { lines: 14, radial: 32, smooth: false, ringSpacing: 0.05 }), 'bronze');
  b.add(annulus(0.04, 0.115, Y_COL, Y_COL + 0.022, { radial: 40, ringSeg: 30 }), 'steel');
  b.add(boltRing(0.092, Y_COL + 0.022, 10, 0.008, 0.01), 'black');

  // face plate + coaxial sleeve + pintle
  b.add(
    revolve(
      [
        [RC, yFace],
        [0.09, yFace, 1],
        [0.09, yFace - 0.04, 1],
        [0.073, yFace - 0.04, 1],
        [0.073, yFace - 0.01, 1],
        [0.055, yFace - 0.01, 1],
        [0.055, yFace - 0.095, 1],
        [0.048, yFace - 0.12],
        [0.026, yFace - 0.137],
        [0, yFace - 0.143],
      ],
      { lines: [24, 14, 0, 10, 0, 12, 12], radial: 64, ringSpacing: 0.055, tol: 0.0015 }
    ),
    'steel'
  );

  // fuel orifice field (three concentric rows) on the injector face
  const rows = [
    [0.222, 30],
    [0.168, 22],
    [0.122, 14],
  ];
  for (const [rr, n] of rows) {
    for (let i = 0; i < n; i++) {
      const a = (TAU * (i + 0.5 * (rr > 0.2 ? 1 : 0))) / n;
      const hole = fromGeometry(new THREE.CircleGeometry(0.0072, 6), 20);
      place(hole, M.mul(M.t(Math.cos(a) * rr, yFace - 0.0015, Math.sin(a) * rr), M.rx(Math.PI / 2)));
      b.add(hole, 'black');
    }
  }

  // fuel manifold: stacked brass-coloured rings round the head (as on the real engine)
  [-0.03, 0.02, 0.07].forEach((dy, i) => b.add(torus(rh + 0.03, 0.021, yFace + dy, { lines: 1, radial: 14, ringSeg: 44 }), 'bronze'));
  b.add(boltRing(RC - 0.015, Y_DOME, 16, 0.0095, 0.012, 0.08), 'black');

  // LOX inlet stub on the dome (+X, towards the turbopump)
  const stubA = V(0.14, 0.9, 0);
  const stubB = V(0.4, 0.94, 0);
  b.add(cylinderBetween(stubA, stubB, 0.055, { lines: 12, radial: 24 }), 'bronze');
  b.add(cylinderBetween(stubB, stubB.clone().add(V(0.018, 0.0, 0)), 0.072, { lines: 0, radial: 24 }), 'steel');

  // instrumentation / igniter bosses round the housing
  [0.5, 1.4, 2.3, 3.9, 4.7, 5.6].forEach((a, i) => {
    const y = Y_DOME - 0.05;
    const p0 = V(Math.cos(a) * rh, y, Math.sin(a) * rh);
    const p1 = V(Math.cos(a) * (rh + 0.06), y + 0.01, Math.sin(a) * (rh + 0.06));
    b.add(cylinderBetween(p0, p1, i === 3 ? 0.026 : 0.014, { lines: 4, radial: 10 }), 'bronze');
  });
  return b;
}

function buildChamber() {
  const b = new Builder();
  const { yFace, yThroat } = DIM;
  const t = 0.02;

  // outer jacket with head flange and throat flange (copper channel wall)
  const outer = [
    [RC + 0.07, yFace],
    [RC + 0.07, yFace - 0.04, 1],
    [RC + t + 0.01, yFace - 0.04, 1],
    ...slice(yFace - 0.05, yThroat + 0.03, 0.04, t).map((p, i, a) => (i === 0 || i === a.length - 1 ? [...p, 1] : p)),
    [0.19, yThroat + 0.03, 1],
    [0.19, yThroat - 0.015, 1],
    [wallR(yThroat - 0.015) + t, yThroat - 0.015, 1],
  ];
  b.add(revolve(outer, { lines: [0, 0, 0, 48, 0, 0, 0], radial: 96, ringSpacing: 0.24, tol: 0.0022, trimEnds: true }), 'copper');

  // inner liner as seen from the nozzle (travels up, so the normal faces the axis)
  b.add(
    revolve(slice(yThroat, yFace - 0.02, 0.04, 0).reverse(), { lines: 30, radial: 64, ringSpacing: 0.22, tol: 0.002, trimEnds: true }),
    'copper'
  );

  // structural bands round the barrel and convergent
  [0.58, 0.44, 0.3, 0.16, 0.02].forEach((y) =>
    b.add(hoopBand(wallR(y) + t - 0.002, y, 0.013, 0.016, { radial: 72, ringSeg: 36 }), 'steel')
  );
  b.add(boltRing(RC + 0.045, yFace - 0.04, 20, 0.0095, 0.012, 0.05), 'black');
  b.add(boltRing(0.165, yThroat + 0.03, 12, 0.009, 0.01), 'black');

  // pressure transducer bosses
  [2.7, 3.6, 5.1].forEach((a, i) => {
    const y = 0.48 - i * 0.14;
    const r = wallR(y) + t + 0.016;
    const p0 = V(Math.cos(a) * r, y, Math.sin(a) * r);
    const p1 = V(Math.cos(a) * (r + 0.075), y, Math.sin(a) * (r + 0.075));
    b.add(cylinderBetween(p0, p1, 0.016, { lines: 6, radial: 12 }), 'steel');
  });
  return b;
}

function buildNozzle() {
  const b = new Builder();
  const y0 = DIM.yThroat - 0.015;
  const y1 = DIM.yRegen;
  const t = 0.014;

  // outer jacket (the cooling-channel bundle reads as dense longitudinal lines)
  b.add(revolve(slice(y0, y1, 0.05, t), { lines: 84, radial: 120, tol: 0.0022, noRings: true }), 'copper');
  // inner wall (hot-gas side)
  b.add(revolve(slice(y0, y1, 0.05, 0).reverse(), { lines: 32, radial: 96, tol: 0.002, ringSpacing: 0.3, trimEnds: false }), 'copper');

  // hoop stiffener ribs
  [-0.2, -0.32, -0.44, -0.56, -0.68, -0.76].forEach((y) =>
    b.add(hoopBand(wallR(y) + t - 0.002, y, 0.012, 0.018), 'titanium')
  );

  // fuel inlet manifold (stacked rings) at the bottom of the regen section
  const ym = y1 + 0.04;
  [0, 0.05].forEach((dy) => b.add(torus(wallR(ym + dy) + t + 0.024, 0.024, ym + dy, { lines: 3, radial: 20, ringSeg: 48 }), 'bronze'));
  const rf = wallR(y1) + t;
  b.add(annulus(rf - 0.002, rf + 0.055, y1 - 0.022, y1, { radial: 96, ringSeg: 48 }), 'titanium');
  b.add(boltRing(rf + 0.032, y1, 24, 0.0095, 0.011, 0.04), 'black');
  return b;
}

function buildSkirt() {
  const b = new Builder();
  const y0 = DIM.yRegen - 0.022;
  const y1 = DIM.yExit;
  const t = 0.007;
  b.add(revolve(slice(y0, y1, 0.05, t), { lines: 56, radial: 112, tol: 0.0022, ringSpacing: 0.2, trimEnds: false, ringSeg: 56 }), 'inconel');
  b.add(revolve(slice(y0, y1, 0.05, 0).reverse(), { lines: 24, radial: 96, tol: 0.002, ringSpacing: 0.3, ringSeg: 24 }), 'inconel');
  const rl = wallR(y1) + t / 2;
  b.add(torus(rl + 0.003, 0.011, y1 + 0.005, { lines: 0, radial: 12, ringSeg: 56 }), 'titanium');
  [-0.95, -1.1].forEach((y) => b.add(hoopBand(wallR(y) + t - 0.002, y, 0.01, 0.016), 'titanium'));
  return b;
}

function buildTurbopump() {
  const b = new Builder();
  const at = (part, mat) => b.add(part, mat, pumpFrame);

  // RP-1 pump: back plate, hub, inlet cone, flange (profile runs back→front, −s)
  at(
    revolve(
      [
        [0.15, -0.2],
        [0.15, -0.215, 1],
        [0.1, -0.215, 1],
        [0.1, -0.34, 1],
        [0.055, -0.4],
        [0.055, -0.415, 1],
        [0.075, -0.415, 1],
        [0.075, -0.43, 1],
        [0.055, -0.43, 1],
      ],
      { lines: [14, 0, 14, 10, 10, 0, 10, 0], radial: 48, ringSpacing: 0, tol: 0.002 }
    ),
    'steel'
  );
  at(torus(0.135, 0.012, -0.275, { lines: 0, radial: 10, ringSeg: 36 }), 'titanium');
  at(boltRing(0.065, -0.43, 8, 0.008, 0.01), 'black');

  // bearing / seal housing with cooling fins
  at(revolve([[0.078, -0.08], [0.078, -0.2, 1]], { lines: 12, radial: 40, ringSpacing: 0.03, ringSeg: 18 }), 'titanium');

  // turbine casing (ribbed) + inlet scroll
  at(
    revolve([[0.145, 0.1], [0.145, -0.08, 1], [0.078, -0.08, 1]], { lines: [16, 0], radial: 48, ringSpacing: 0.06, ringSeg: 16, tol: 0.002 }),
    'steel'
  );
  at(torus(0.172, 0.03, 0.012, { lines: 5, radial: 20 }), 'bronze');
  at(torus(0.145, 0.009, -0.075, { lines: 0, radial: 8, ringSeg: 24 }), 'titanium');
  // turbine front-plate bolt circle
  at(boltRing(0.12, -0.08, 12, 0.008, 0.01), 'black');
  b.add(cylinderBetween(V(TP.x, TP.y - 0.1, GG_Z), V(TP.x, TP.y - 0.23, GG_Z), 0.06, { lines: 10, radial: 20 }), 'steel');

  // LOX pump: front inlet flange → cone → hub → back plate (profile runs front→back, −s)
  at(
    revolve(
      [
        [0.075, 0.47],
        [0.1, 0.47, 1],
        [0.1, 0.455, 1],
        [0.075, 0.455, 1],
        [0.075, 0.44, 1],
        [0.125, 0.37],
        [0.125, 0.115, 1],
        [0.255, 0.115, 1],
        [0.255, 0.1, 1],
        [0.12, 0.1, 1],
      ],
      { lines: [0, 12, 0, 12, 12, 16, 0, 18, 0], radial: 56, ringSpacing: 0, tol: 0.002 }
    ),
    'steel'
  );
  at(boltRing(0.088, 0.455, 10, 0.008, 0.01), 'black');
  at(boltRing(0.235, 0.115, 14, 0.008, 0.01), 'black');
  at(torus(0.19, 0.012, 0.108, { lines: 0, radial: 10, ringSeg: 40 }), 'titanium');

  // volutes
  const fuelV = volute({ s: -0.275, R0: 0.122, R1: 0.168, r0: 0.02, r1: 0.05, rEnd: 0.036, a0: -Math.PI / 2, dir: -1, run: 0.1 });
  const loxV = volute({ s: 0.255, R0: 0.15, R1: 0.222, r0: 0.03, r1: 0.075, rEnd: 0.05, a0: Math.PI / 2, dir: 1, run: 0.12 });
  const atTP = M.t(TP.x, TP.y, TP.z);
  b.add(fuelV.part, 'chrome', atTP);
  b.add(loxV.part, 'chrome', atTP);

  // support struts back to the thrust chamber
  const struts = [
    [V(TP.x - 0.1, TP.y - 0.05, -0.2), V(RC + 0.04, 0.42, -0.1)],
    [V(TP.x - 0.1, TP.y - 0.05, 0.22), V(RC + 0.04, 0.42, 0.1)],
    [V(TP.x - 0.12, TP.y + 0.02, 0.0), V(RC + 0.05, 0.55, 0.0)],
  ];
  struts.forEach(([p0, p1]) => b.add(tube(new THREE.LineCurve3(p0, p1), 0.012, { radial: 8, lines: 4, endRings: true, ringSeg: 8 }), 'titanium'));

  b.fuelEnd = fuelV.end.clone().add(TP);
  b.fuelTan = fuelV.tangent.clone();
  b.loxEnd = loxV.end.clone().add(TP);
  b.loxTan = loxV.tangent.clone();
  return b;
}

function buildGG() {
  const b = new Builder();
  const x = TP.x;
  const z = GG_Z;
  const yb = TP.y + 0.16; // base of the GG, sitting on the turbine scroll
  const top = arc(0, yb + 0.3, 0.055, Math.PI / 2, 0, 6, { radY: 0.04, creaseEnd: true });
  const prof = [
    ...top,
    [0.055, yb + 0.29, 1],
    [0.068, yb + 0.29, 1],
    [0.068, yb + 0.26, 1],
    [0.055, yb + 0.26, 1],
    [0.055, yb + 0.1, 1],
    [0.072, yb + 0.08, 1],
    [0.072, yb + 0.04, 1],
    [0.1, yb + 0.04, 1],
    [0.1, yb + 0.02, 1],
    [0.045, yb + 0.02, 1],
  ];
  const part = revolve(prof, { lines: [14, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0], radial: 40, ringSpacing: 0, tol: 0.0015 });
  const atGG = M.t(x, 0, z);
  b.add(part, 'steel', atGG);
  b.add(boltRing(0.082, yb + 0.04, 8, 0.008, 0.01), 'black', atGG);
  b.add(cylinderBetween(V(x, yb + 0.27, z + 0.05), V(x, yb + 0.27, z + 0.15), 0.016, { lines: 6, radial: 12 }), 'chrome');
  b.add(cylinderBetween(V(x, yb + 0.27, z - 0.05), V(x, yb + 0.27, z - 0.15), 0.016, { lines: 6, radial: 12 }), 'chrome');
  b.add(cylinderBetween(V(x, yb + 0.02, z), V(x, yb - 0.04, z), 0.034, { lines: 8, radial: 16 }), 'steel');
  b.ggTop = yb + 0.27;
  return b;
}

function bellowsRadius(r, from, to, period, amp) {
  return (u, len) => {
    if (u < from || u > to) return r;
    const w = Math.sin((u * len * TAU) / period);
    return r + amp * (0.5 + 0.5 * w);
  };
}

function flange(center, dir, r, thick = 0.016, bolts = 0) {
  const to = center.clone().addScaledVector(dir, thick);
  const parts = [cylinderBetween(center, to, r, { lines: 0, radial: 28 })];
  if (bolts) {
    const { matrix } = M.along(to, to.clone().add(dir));
    boltRing(r * 0.78, 0, bolts, 0.007, 0.009).forEach((p) => parts.push(place(p, matrix)));
  }
  return parts;
}

function buildLox(tp, gg) {
  const b = new Builder();
  const yTop = 1.12;

  const inlet = filletPath([V(TP.x, yTop, 0.62), V(TP.x, TP.y, 0.62), V(TP.x, TP.y, 0.465)], 0.13);
  b.add(
    tube(inlet, bellowsRadius(0.068, 0.12, 0.5, 0.045, 0.011), {
      radial: 24,
      lines: 10,
      spacing: 0.012,
      tol: 0.003,
      ringSpacing: 0.1,
      wireRadius: 0.07,
    }),
    'chrome'
  );
  b.add(flange(V(TP.x, yTop, 0.62), V(0, 1, 0), 0.1, 0.02, 8), 'steel');
  b.add(flange(V(TP.x, TP.y, 0.485), V(0, 0, -1), 0.098, 0.018, 0), 'steel');

  // high-pressure LOX duct: volute discharge → injector dome stub
  const e = tp.loxEnd;
  const t = tp.loxTan;
  const stubEnd = V(0.418, 0.94, 0);
  const hp = new THREE.CatmullRomCurve3(
    [
      e,
      e.clone().addScaledVector(t, 0.08),
      V(0.5, 0.68, 0.25),
      V(0.46, 0.8, 0.2),
      V(0.47, 0.9, 0.13),
      V(0.5, 0.95, 0.07),
      V(0.48, 0.95, 0.02),
      stubEnd.clone().add(V(0.012, 0, 0)),
    ],
    false,
    'centripetal'
  );
  b.add(tube(hp, 0.048, { radial: 24, lines: 8, spacing: 0.02, tol: 0.004, ringSpacing: 0.24 }), 'chrome');
  b.add(flange(stubEnd.clone().add(V(0.012, 0, 0)), V(-1, 0, 0), 0.066, 0.01, 0), 'steel');
  [0.25, 0.62].forEach((u) => {
    const p = hp.getPointAt(u);
    b.add(torus(0.056, 0.007, 0, { lines: 0, radial: 8, ringSeg: 18 }), 'black', M.t(p.x, p.y, p.z));
  });

  // GG LOX branch
  const branch = new THREE.CatmullRomCurve3(
    [hp.getPointAt(0.34), V(0.68, 0.98, 0.17), V(0.72, 1.0, 0.1), V(TP.x, gg.ggTop, GG_Z + 0.15)],
    false,
    'centripetal'
  );
  b.add(tube(branch, 0.014, { radial: 10, lines: 4, spacing: 0.02, endRings: false }), 'chrome');
  return b;
}

function buildFuel(tp, gg) {
  const b = new Builder();
  const yTop = 1.04;

  const inlet = filletPath([V(TP.x, yTop, -0.6), V(TP.x, TP.y, -0.6), V(TP.x, TP.y, -0.44)], 0.11);
  b.add(
    tube(inlet, bellowsRadius(0.05, 0.2, 0.55, 0.04, 0.009), {
      radial: 20,
      lines: 8,
      spacing: 0.012,
      tol: 0.003,
      ringSpacing: 0.1,
      wireRadius: 0.052,
    }),
    'chrome'
  );
  b.add(flange(V(TP.x, yTop, -0.6), V(0, 1, 0), 0.075, 0.018, 8), 'steel');
  b.add(flange(V(TP.x, TP.y, -0.455), V(0, 0, 1), 0.075, 0.016, 0), 'steel');

  // high-pressure RP-1 line down to the nozzle cooling manifold
  const e = tp.fuelEnd;
  const phi = -0.95;
  const pts = [e, e.clone().addScaledVector(tp.fuelTan, 0.1), V(0.4, 0.06, -0.55)];
  const ys = [-0.15, -0.35, -0.55, -0.7, -0.78];
  const rm = (y) => wallR(y) + 0.014;
  ys.forEach((y, i) => {
    const rad = rm(y) + (i < 3 ? 0.14 : 0.095);
    const ph = phi + (i / ys.length) * 0.2;
    pts.push(V(Math.cos(ph) * rad, y, Math.sin(ph) * rad));
  });
  const ymf = DIM.yRegen + 0.065;
  const ph = phi + 0.2;
  const rad = rm(ymf) + 0.024 + 0.024 + 0.012;
  pts.push(V(Math.cos(ph) * rad, ymf, Math.sin(ph) * rad));
  const hp = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  b.add(tube(hp, 0.03, { radial: 20, lines: 8, spacing: 0.02, tol: 0.004, ringSpacing: 0.26 }), 'chrome');
  [0.18, 0.4, 0.6, 0.8].forEach((u) => {
    const p = hp.getPointAt(u);
    b.add(torus(0.037, 0.006, 0, { lines: 0, radial: 8, ringSeg: 14 }), 'black', M.t(p.x, p.y, p.z));
  });

  const br = new THREE.CatmullRomCurve3(
    [hp.getPointAt(0.04), V(0.7, 0.6, -0.22), V(0.72, 0.9, -0.16), V(TP.x, gg.ggTop, GG_Z - 0.15)],
    false,
    'centripetal'
  );
  b.add(tube(br, 0.012, { radial: 10, lines: 4, spacing: 0.02, endRings: false }), 'chrome');
  return b;
}

function buildExhaust() {
  const b = new Builder();
  const phi0 = 0.38;
  const pts = [V(TP.x, TP.y - 0.2, GG_Z), V(TP.x, 0.08, GG_Z), V(0.62, -0.1, 0.08)];
  const ys = [-0.3, -0.5, -0.7, -0.9, -1.08, -1.22];
  ys.forEach((y, i) => {
    const rad = wallR(Math.max(y, DIM.yRegen)) + 0.014 + 0.02 + 0.05 + 0.012;
    const ph = phi0 + i * 0.045;
    pts.push(V(Math.cos(ph) * rad, y, Math.sin(ph) * rad));
  });
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  b.add(
    tube(curve, bellowsRadius(0.05, 0.1, 0.3, 0.04, 0.008), {
      radial: 24,
      lines: 8,
      spacing: 0.012,
      tol: 0.004,
      ringSpacing: 0.2,
      wireRadius: 0.052,
    }),
    'inconel'
  );

  const endP = curve.getPointAt(1);
  const endT = curve.getTangentAt(1).normalize();
  const { matrix } = M.along(endP, endP.clone().add(endT));
  b.add(
    place(
      revolve([[0.05, 0.0], [0.082, 0.1, 1], [0.074, 0.1, 1], [0.045, 0.0, 1]], { lines: [16, 0, 16], radial: 32, smooth: false, trimEnds: false }),
      matrix
    ),
    'inconel'
  );

  [0.4, 0.55, 0.7, 0.85].forEach((u) => {
    const p = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const { matrix: m } = M.along(p, p.clone().add(tan));
    b.add(torus(0.062, 0.008, 0, { lines: 0, radial: 8, ringSeg: 20 }), 'black', m);
    const ax = V(p.x, 0, p.z).normalize();
    const wallP = V(ax.x * (wallR(p.y) + 0.034), p.y, ax.z * (wallR(p.y) + 0.034));
    b.add(tube(new THREE.LineCurve3(p, wallP), 0.008, { radial: 8, lines: 3, endRings: false }), 'black');
  });
  return b;
}

function buildHarness(gg) {
  const b = new Builder();
  const rand = rng(7);

  // TEA-TEB igniter canister
  const cx = -(RC + 0.17);
  const base = V(cx, 0.68, -0.22);
  const topP = V(cx, 0.95, -0.22);
  b.add(cylinderBetween(base, topP, 0.04, { lines: 14, radial: 24 }), 'steel');
  b.add(revolve(arc(0, 0, 0.04, Math.PI / 2, 0, 8), { lines: 8, radial: 24, tol: 0.001, ringSpacing: 0.02 }), 'steel', M.t(cx, 0.95, -0.22));
  b.add(torus(0.046, 0.006, 0.76, { lines: 0, radial: 8, ringSeg: 20 }), 'black', M.t(cx, 0, -0.22));
  b.add(torus(0.046, 0.006, 0.89, { lines: 0, radial: 8, ringSeg: 20 }), 'black', M.t(cx, 0, -0.22));
  const ig = new THREE.CatmullRomCurve3(
    [V(cx, 0.7, -0.22), V(cx + 0.05, 0.66, -0.2), V(-0.3, 0.7, -0.2), V(-0.28, 0.72, -0.16)],
    false,
    'centripetal'
  );
  b.add(tube(ig, 0.011, { radial: 10, lines: 4, spacing: 0.02 }), 'chrome');

  // valves / solenoids
  [
    [cx + 0.06, 0.66, -0.19, 0.055, 0.04, 0.045],
    [-0.52, 0.56, -0.1, 0.06, 0.06, 0.06],
    [0.46, 0.8, -0.26, 0.07, 0.05, 0.05],
  ].forEach(([x, y, z, w, h, d]) => b.add(box(w, h, d, M.t(x, y, z)), 'titanium'));

  // engine controller junction box
  const jb = V(-0.62, 0.42, 0.26);
  b.add(box(0.15, 0.1, 0.09, M.t(jb.x, jb.y, jb.z)), 'titanium');
  b.add(box(0.1, 0.015, 0.06, M.t(jb.x, jb.y + 0.057, jb.z)), 'black');
  [-0.05, 0, 0.05].forEach((o) => b.add(cylinderBetween(V(jb.x + o, jb.y - 0.05, jb.z), V(jb.x + o, jb.y - 0.09, jb.z), 0.012, { lines: 4, radial: 10 }), 'steel'));

  // harness cables fanning out from the junction box to sensors
  const targets = [
    V(0.5, 0.3, -0.05), // turbine speed sensor
    V(0.6, 0.62, 0.1),
    V(-0.3, 0.74, -0.18),
    V(-0.5, 0.6, -0.12),
    V(-0.2, 0.5, -0.34),
    V(-0.2, 0.38, -0.3),
    V(0.1, 0.9, 0.3),
    V(-0.2, 0.9, 0.25),
  ];
  targets.forEach((tg, i) => {
    const mid = jb.clone().lerp(tg, 0.5).add(V((rand() - 0.5) * 0.12, (rand() - 0.3) * 0.12, (rand() - 0.5) * 0.12));
    const mid2 = jb.clone().lerp(tg, 0.8).add(V((rand() - 0.5) * 0.06, (rand() - 0.5) * 0.06, (rand() - 0.5) * 0.06));
    b.add(cable([jb.clone().add(V(0, -0.05, (rand() - 0.5) * 0.06)), mid, mid2, tg], 0.0055), 'black');
  });

  // instrumentation tubing hugging the chamber and dome (the dense "plumbing" seen on the real engine)
  for (let i = 0; i < 12; i++) {
    const a = (TAU * i) / 12 + rand() * 0.25;
    const r0 = RC + 0.075 + rand() * 0.03;
    const y0 = Y_DOME + 0.08 + rand() * 0.1;
    const y1 = DIM.yFace - 0.1 - rand() * 0.55;
    const a1 = a + (rand() - 0.5) * 0.5;
    const r1 = wallR(y1) + 0.075 + rand() * 0.03;
    const mid = V(Math.cos((a + a1) / 2) * (Math.max(r0, r1) + 0.03), (y0 + y1) / 2, Math.sin((a + a1) / 2) * (Math.max(r0, r1) + 0.03));
    b.add(
      cable([V(Math.cos(a) * r0, y0, Math.sin(a) * r0), mid, V(Math.cos(a1) * r1, y1, Math.sin(a1) * r1)], 0.0045),
      i % 3 === 0 ? 'chrome' : 'steel'
    );
  }
  // fittings along those lines
  for (let i = 0; i < 10; i++) {
    const a = rand() * TAU;
    const y = 0.12 + rand() * 0.6;
    const r = wallR(y) + 0.09;
    b.add(cylinderBetween(V(Math.cos(a) * r, y, Math.sin(a) * r), V(Math.cos(a) * (r + 0.03), y, Math.sin(a) * (r + 0.03)), 0.008, { lines: 3, radial: 8 }), 'black');
  }

  // thermocouples on the nozzle
  [-0.2, -0.55].forEach((y, i) => {
    const a = 3.2 + i * 0.3;
    const r = wallR(y) + 0.014;
    const p0 = V(Math.cos(a) * r, y, Math.sin(a) * r);
    const p1 = V(Math.cos(a) * (r + 0.06), y, Math.sin(a) * (r + 0.06));
    b.add(cylinderBetween(p0, p1, 0.007, { lines: 3, radial: 8 }), 'steel');
  });
  return b;
}

// ───────────────────────────────────────────── public API ──

/**
 * Generates the engine. Returns:
 *   { assemblies: [{ id, name, info, explode, anchor, wire: Float32Array,
 *                    solids: [{ material, geometry }], segments }], totalSegments, bounds }
 */
export function buildMerlin() {
  const turbo = buildTurbopump();
  const gg = buildGG();
  const builders = {
    gimbal: buildGimbal(),
    actuators: buildActuators(),
    injector: buildInjector(),
    chamber: buildChamber(),
    nozzle: buildNozzle(),
    skirt: buildSkirt(),
    turbopump: turbo,
    gg,
    lox: buildLox(turbo, gg),
    fuel: buildFuel(turbo, gg),
    exhaust: buildExhaust(),
    igniter: buildHarness(gg),
  };

  const assemblies = META.map((m) => {
    const b = builders[m.id];
    const solids = [];
    for (const [material, geos] of b.solids) {
      const geometry = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      solids.push({ material, geometry });
    }
    return {
      ...m,
      wire: new Float32Array(b.wire),
      solids,
      segments: b.segmentCount,
    };
  });

  const total = assemblies.reduce((s, a) => s + a.segments, 0);
  const box3 = new THREE.Box3();
  const part = new THREE.Box3();
  for (const a of assemblies) box3.union(part.setFromArray(a.wire));
  return { assemblies, totalSegments: Math.round(total), bounds: box3 };
}

