import * as THREE from "three";

export const ROAD_HALF_WIDTH = 5;
export const CHECKPOINTS = 12;
export const LAPS = 3;
// Boost pads as [tStart, tEnd] ranges along the spline
export const BOOST_PADS = [[0.18, 0.205], [0.52, 0.545], [0.80, 0.825]];

// Closed circuit from a radial formula: guaranteed non-self-intersecting,
// two big sweepers and a couple of pinches. Deterministic, same on every client.
function controlPoints() {
  const pts = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 70 + 18 * Math.sin(2 * a + 0.7) + 10 * Math.sin(3 * a + 2.1);
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return pts;
}

export const curve = new THREE.CatmullRomCurve3(controlPoints(), true, "centripetal");

// Coarse lookup table for closest-point queries
const LUT_N = 512;
const lut = [];
for (let i = 0; i < LUT_N; i++) lut.push(curve.getPointAt(i / LUT_N));

export function sample(t) {
  t = ((t % 1) + 1) % 1;
  const pos = curve.getPointAt(t);
  const tan = curve.getTangentAt(t);
  return { pos, tan };
}

// Returns {t, lateral} for a world position. Coarse LUT pass + parabolic-ish refinement.
const _v = new THREE.Vector3();
export function closest(pos) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < LUT_N; i++) {
    const d = (lut[i].x - pos.x) ** 2 + (lut[i].z - pos.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  // refine between neighbors
  let t = best / LUT_N;
  let step = 1 / LUT_N;
  for (let iter = 0; iter < 8; iter++) {
    const t1 = ((t - step) % 1 + 1) % 1, t2 = (t + step) % 1;
    const p1 = curve.getPointAt(t1), p2 = curve.getPointAt(t2);
    const d1 = (p1.x - pos.x) ** 2 + (p1.z - pos.z) ** 2;
    const d2 = (p2.x - pos.x) ** 2 + (p2.z - pos.z) ** 2;
    const d0 = curve.getPointAt(t).distanceToSquared(_v.set(pos.x, 0, pos.z));
    if (d1 < d0 && d1 <= d2) t = t1;
    else if (d2 < d0) t = t2;
    else step /= 2;
  }
  const { pos: c, tan } = sample(t);
  const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
  const lateral = (pos.x - c.x) * side.x + (pos.z - c.z) * side.z;
  return { t, lateral };
}

export function isOnRoad(lateral) {
  return Math.abs(lateral) <= ROAD_HALF_WIDTH;
}

export function onBoostPad(t, lateral) {
  if (!isOnRoad(lateral)) return false;
  t = ((t % 1) + 1) % 1;
  return BOOST_PADS.some(([a, b]) => t >= a && t <= b);
}

// Grid slots: 4 karts, 2x2, just after the start line (t=0 gate), facing forward
export function gridSlot(seat) {
  const t = 0.012 + Math.floor(seat / 2) * 0.008;
  const { pos, tan } = sample(t);
  const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
  const lat = (seat % 2 === 0 ? -1 : 1) * 2.2;
  return {
    x: pos.x + side.x * lat,
    z: pos.z + side.z * lat,
    yaw: Math.atan2(tan.x, tan.z),
  };
}

// Road ribbon mesh with arc-length UVs. Also returns shoulder ribbons.
export function buildRoadGeometry(halfW = ROAD_HALF_WIDTH, segments = 384) {
  const build = (inner, outer, yOff) => {
    const pos = [], uv = [], idx = [];
    let arc = 0;
    let prev = null;
    for (let i = 0; i <= segments; i++) {
      const t = (i % segments) / segments;
      const { pos: c, tan } = sample(t);
      if (prev) arc += c.distanceTo(prev);
      prev = c;
      const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
      pos.push(c.x + side.x * inner, yOff, c.z + side.z * inner);
      pos.push(c.x + side.x * outer, yOff, c.z + side.z * outer);
      const v = arc / 8;
      uv.push(0, v, 1, v);
      if (i < segments) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  return {
    road: build(-halfW, halfW, 0.01),
    shoulderL: build(-halfW - 2.2, -halfW, 0.005),
    shoulderR: build(halfW, halfW + 2.2, 0.005),
  };
}

export function buildBoostPadGeometry() {
  const geos = [];
  for (const [a, b] of BOOST_PADS) {
    const segs = 8;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = a + (b - a) * (i / segs);
      const { pos: c, tan } = sample(t);
      const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
      const w = ROAD_HALF_WIDTH * 0.85;
      pos.push(c.x - side.x * w, 0.03, c.z - side.z * w);
      pos.push(c.x + side.x * w, 0.03, c.z + side.z * w);
      uv.push(0, i / segs, 1, i / segs);
      if (i < segs) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    geos.push(g);
  }
  return geos;
}

// Start/finish line quad at t=0
export function buildStartLineGeometry() {
  const { pos: c, tan } = sample(0);
  const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
  const w = ROAD_HALF_WIDTH, d = 1.4;
  const g = new THREE.BufferGeometry();
  const p = [
    c.x - side.x * w - tan.x * d, 0.02, c.z - side.z * w - tan.z * d,
    c.x + side.x * w - tan.x * d, 0.02, c.z + side.z * w - tan.z * d,
    c.x - side.x * w + tan.x * d, 0.02, c.z - side.z * w + tan.z * d,
    c.x + side.x * w + tan.x * d, 0.02, c.z + side.z * w + tan.z * d,
  ];
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 6, 0, 0, 1, 6, 1], 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  return g;
}
