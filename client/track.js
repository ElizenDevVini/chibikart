import * as THREE from "three";

export const CHECKPOINTS = 12;
export const LAPS = 3;
export const ROAD_HALF_WIDTH = 5;

// The cup: layouts from the radial formula (amp1+amp2 <= 0.5*baseR stays non-self-intersecting),
// themes are pure lighting/palette data consumed by scene.setTrack.
export const TRACKS = [
  {
    name: "trackDonutDowns",
    baseR: 70, terms: [[18, 2, 0.7], [10, 3, 2.1]],
    boostPads: [[0.18, 0.205], [0.52, 0.545], [0.80, 0.825]],
    theme: {
      sky: 0x9ed4f5, fogNear: 120, fogFar: 320,
      hemi: [0xfff6e0, 0x7ec850, 1.1], sun: [0xfff2cc, 1.6, [60, 100, 40]],
      grassTint: 0xffffff, roadTint: 0xffffff,
    },
  },
  {
    name: "trackSunsetSwirl",
    baseR: 62, terms: [[24, 2, 1.9], [7, 5, 0.4]],
    boostPads: [[0.12, 0.135], [0.36, 0.375], [0.60, 0.615], [0.86, 0.875]],
    theme: {
      sky: 0xf7b26a, fogNear: 100, fogFar: 300,
      hemi: [0xffd9a0, 0xb08a50, 0.9], sun: [0xffc27a, 1.4, [-80, 45, 20]],
      grassTint: 0xd8c07a, roadTint: 0xe8cdb0,
    },
  },
  {
    name: "trackMidnightGlaze",
    baseR: 78, terms: [[14, 3, 0.2], [12, 4, 3.0]],
    boostPads: [[0.22, 0.235], [0.55, 0.565], [0.88, 0.895]],
    theme: {
      sky: 0x35406e, fogNear: 90, fogFar: 260,
      hemi: [0x8090c8, 0x2c3a2c, 0.6], sun: [0x9fb4ff, 1.0, [40, 90, -60]],
      grassTint: 0x7080b0, roadTint: 0x9098c0,
    },
  },
];

export function makeTrack(params) {
  const halfW = ROAD_HALF_WIDTH;
  const BOOST_PADS = params.boostPads;

  function controlPoints() {
    const pts = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      let r = params.baseR;
      for (const [amp, freq, phase] of params.terms) r += amp * Math.sin(freq * a + phase);
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    return pts;
  }

  const curve = new THREE.CatmullRomCurve3(controlPoints(), true, "centripetal");

  const LUT_N = 512;
  const lut = [];
  let length = 0;
  for (let i = 0; i < LUT_N; i++) {
    lut.push(curve.getPointAt(i / LUT_N));
    if (i) length += lut[i].distanceTo(lut[i - 1]);
  }
  length += lut[0].distanceTo(lut[LUT_N - 1]);

  function sample(t) {
    t = ((t % 1) + 1) % 1;
    return { pos: curve.getPointAt(t), tan: curve.getTangentAt(t) };
  }

  const _v = new THREE.Vector3();
  function closest(pos) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < LUT_N; i++) {
      const d = (lut[i].x - pos.x) ** 2 + (lut[i].z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
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

  const isOnRoad = (lateral) => Math.abs(lateral) <= halfW;

  function onBoostPad(t, lateral) {
    if (!isOnRoad(lateral)) return false;
    t = ((t % 1) + 1) % 1;
    return BOOST_PADS.some(([a, b]) => t >= a && t <= b);
  }

  function gridSlot(seat) {
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

  function buildRoadGeometry(hw = halfW, segments = 384) {
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
        const v = arc / 10; // one texture tile per road-width for square, chunky cartoon detail
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
      road: build(-hw, hw, 0.01),
      shoulderL: build(-hw - 2.2, -hw, 0.005),
      shoulderR: build(hw, hw + 2.2, 0.005),
    };
  }

  function buildBoostPadGeometry() {
    const geos = [];
    for (const [a, b] of BOOST_PADS) {
      const segs = 8;
      const pos = [], uv = [], idx = [];
      for (let i = 0; i <= segs; i++) {
        const t = a + (b - a) * (i / segs);
        const { pos: c, tan } = sample(t);
        const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
        const w = halfW * 0.85;
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

  function buildStartLineGeometry() {
    const { pos: c, tan } = sample(0);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
    const w = halfW, d = 1.4;
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

  return {
    sample, closest, isOnRoad, onBoostPad, gridSlot,
    buildRoadGeometry, buildBoostPadGeometry, buildStartLineGeometry,
    curve, length,
    BOOST_PADS, CHECKPOINTS, LAPS, ROAD_HALF_WIDTH: halfW,
    theme: params.theme, name: params.name,
  };
}

// Back-compat shim: the online path, physics defaults, and test tools keep
// importing singletons for the original circuit.
export const defaultTrack = makeTrack(TRACKS[0]);
export const { sample, closest, isOnRoad, onBoostPad, gridSlot, curve } = defaultTrack;
export const BOOST_PADS = defaultTrack.BOOST_PADS;
export const buildRoadGeometry = defaultTrack.buildRoadGeometry;
export const buildBoostPadGeometry = defaultTrack.buildBoostPadGeometry;
export const buildStartLineGeometry = defaultTrack.buildStartLineGeometry;
