// Headless logic smoke test: drives a bot kart through the real physics + track
// code and asserts the race loop works (gates in order, laps, drift boost, pads).
import * as THREE from "three";
import { sample, closest, gridSlot, isOnRoad, CHECKPOINTS, BOOST_PADS, ROAD_HALF_WIDTH } from "../client/track.js";
import { makeKartState, step, progress, CFG } from "../client/physics.js";

let failures = 0;
const ok = (cond, name) => {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
};

// --- track sanity ---
for (let seat = 0; seat < 4; seat++) {
  const g = gridSlot(seat);
  const q = closest(new THREE.Vector3(g.x, 0, g.z));
  ok(isOnRoad(q.lateral), `grid slot ${seat} is on the road (lateral ${q.lateral.toFixed(2)})`);
}

// closest() accuracy: sample points ON the centerline should return tiny lateral
let maxLat = 0;
for (let i = 0; i < 50; i++) {
  const t = i / 50;
  const { pos } = sample(t);
  const q = closest(pos);
  maxLat = Math.max(maxLat, Math.abs(q.lateral));
}
ok(maxLat < 0.5, `closest() lateral error on centerline < 0.5 (got ${maxLat.toFixed(3)})`);

// road min curvature radius vs width: adjacent samples shouldn't pinch
let minSeg = Infinity;
let prev = sample(0).pos;
for (let i = 1; i <= 384; i++) {
  const p = sample(i / 384).pos;
  minSeg = Math.min(minSeg, p.distanceTo(prev));
  prev = p;
}
ok(minSeg > 0.3, `road segments don't degenerate (min ${minSeg.toFixed(3)})`);

// --- bot drives the whole track: gates must fire 1,2,...,11,0 and lap must advance ---
const s = makeKartState(0);
const dt = 1 / 60;
const gates = [];
let steps = 0;
const MAX_STEPS = 60 * 180; // 3 minutes cap
while (s.lap < 2 && steps < MAX_STEPS) {
  // steer toward a lookahead point on the centerline
  const look = sample((s.trackT + 0.015) % 1).pos;
  const desired = Math.atan2(look.x - s.x, look.z - s.z);
  let d = desired - s.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const cmd = { throttle: 1, steer: Math.max(-1, Math.min(1, -d * 2.5)), drift: false };
  step(s, cmd, dt, []);
  if (s.justCrossedCp >= 0) {
    gates.push(s.justCrossedCp);
    s.nextCp = (s.justCrossedCp + 1) % CHECKPOINTS;
    if (s.justCrossedCp === 0) s.lap++;
  }
  steps++;
}
ok(s.lap === 2, `bot completed a lap in ${(steps / 60).toFixed(1)}s (lap=${s.lap})`);
const expected = [...Array(CHECKPOINTS - 1).keys()].map((i) => i + 1).concat([0]);
ok(JSON.stringify(gates) === JSON.stringify(expected), `gates fired in order: ${gates.join(",")}`);

// steering sign note: cmd.steer uses -d because physics yaw decreases with positive steer
ok(steps < MAX_STEPS, "bot did not time out");

// --- drift charge and boost tiers ---
const k2 = makeKartState(1);
k2.speed = 20;
let boosted = 0;
for (let i = 0; i < 60 * 2.0; i++) {
  step(k2, { throttle: 1, steer: 1, drift: true }, dt, []);
}
step(k2, { throttle: 1, steer: 0, drift: false }, dt, []);
ok(k2.boostTime > 0.5, `2s drift grants tier-2 boost (boostTime ${k2.boostTime.toFixed(2)})`);

// --- boost pad triggers ---
const k3 = makeKartState(2);
const padT = (BOOST_PADS[0][0] + BOOST_PADS[0][1]) / 2;
const padPos = sample(padT).pos;
k3.x = padPos.x; k3.z = padPos.z; k3.trackT = padT - 0.01;
step(k3, { throttle: 0, steer: 0, drift: false }, dt, []);
ok(k3.boostTime > 0 && k3.justBoosted === 3, `boost pad triggers (boostTime ${k3.boostTime.toFixed(2)})`);

// --- kart-kart soft separation ---
const k4 = makeKartState(0);
const before = { x: k4.x, z: k4.z };
step(k4, { throttle: 0, steer: 0, drift: false }, dt, [{ x: k4.x + 0.5, z: k4.z }]);
ok(k4.x < before.x, "overlapping remote kart pushes own kart away");

// --- progress metric is monotonic along the lap ---
const p1 = makeKartState(0);
p1.lap = 1; p1.nextCp = 3; p1.trackT = 0.2;
const p2 = makeKartState(0);
p2.lap = 1; p2.nextCp = 3; p2.trackT = 0.23;
ok(progress(p2) > progress(p1), "progress increases approaching the next gate");

process.exit(failures ? 1 : 0);
