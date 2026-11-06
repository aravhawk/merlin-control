// Synthetic hand generator for tests: anatomically plausible 21-landmark hand.
export function makeHand({ x = 0.5, y = 0.5, open = 1, rollDeg = 0, scale = 0.12, tiltX = 0, tiltY = 0 } = {}) {
  // hand local frame (metres): wrist at origin, fingers along +y (up), palm facing the camera (-z toward camera)
  const mcp = { 5: [-0.03, 0.09], 9: [-0.005, 0.095], 13: [0.02, 0.09], 17: [0.042, 0.08] };
  const seg = { 5: [0.04, 0.025, 0.02], 9: [0.045, 0.028, 0.022], 13: [0.042, 0.026, 0.02], 17: [0.032, 0.02, 0.018] };
  const P = Array.from({ length: 21 }, () => [0, 0, 0]);
  P[0] = [0, 0, 0];
  // thumb
  P[1] = [-0.025, 0.02, 0];
  P[2] = [-0.045, 0.045, 0];
  P[3] = [-0.06 + 0.02 * (1 - open), 0.06 - 0.02 * (1 - open), 0];
  P[4] = [-0.075 + 0.04 * (1 - open), 0.075 - 0.03 * (1 - open), 0];
  const curlMax = [1.5, 1.7, 1.2]; // rad per joint when fully curled
  for (const base of [5, 9, 13, 17]) {
    const [mx, my] = mcp[base];
    P[base] = [mx, my, 0];
    let ang = 0;
    let px = mx;
    let py = my;
    let pz = 0;
    for (let j = 0; j < 3; j++) {
      ang += curlMax[j] * (1 - open);
      // curl toward the palm (+z away from camera)
      const len = seg[base][j];
      py += Math.cos(ang) * len;
      pz += Math.sin(ang) * len;
      P[base + 1 + j] = [px, py, pz];
    }
  }
  // rotate (roll about z, tiltX about x, tiltY about y) and scale
  const r = (rollDeg * Math.PI) / 180;
  const out = P.map(([px, py, pz]) => {
    let X = px * Math.cos(r) - py * Math.sin(r);
    let Y = px * Math.sin(r) + py * Math.cos(r);
    let Z = pz;
    let Y2 = Y * Math.cos(tiltX) - Z * Math.sin(tiltX);
    let Z2 = Y * Math.sin(tiltX) + Z * Math.cos(tiltX);
    let X3 = X * Math.cos(tiltY) + Z2 * Math.sin(tiltY);
    let Z3 = -X * Math.sin(tiltY) + Z2 * Math.cos(tiltY);
    return [X3, Y2, Z3];
  });
  // image coords (mirror-free camera view): x right, y DOWN, z away. world = metres, same axes.
  const world = out.map(([X, Y, Z]) => ({ x: -X, y: -Y, z: Z })); // palm up-axis maps to image -y
  const landmarks = out.map(([X, Y, Z]) => ({ x: x + (-X / 0.7) * (scale / 0.12) * 0.5, y: y + (-Y / 0.7) * (scale / 0.12) * 0.5, z: Z }));
  return { landmarks, world };
}
