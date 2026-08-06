import * as THREE from "three";
import { closest, isOnRoad, onBoostPad, gridSlot, sample, CHECKPOINTS } from "./track.js";

export const CFG = {
  MAX_SPEED: 28,
  BOOST_SPEED: 36,
  REVERSE_MAX: 8,
  ACCEL: 14,
  BRAKE: 22,
  DRAG: 0.6,          // per-second proportional drag
  OFFROAD_FACTOR: 0.5,
  TURN_RATE: 2.4,      // rad/s at reference speed
  DRIFT_MIN_SPEED: 12,
  DRIFT_MIN_STEER: 0.3,
  DRIFT_YAW_BONUS: 1.1,
  DRIFT_SLIP: 0.30,    // rad the velocity lags behind facing while drifting
  DRIFT_TIER1: 0.9, DRIFT_TIER2: 1.8,   // seconds of charge
  BOOST_T1: 0.4, BOOST_T2: 0.9,          // seconds of boost granted
  PAD_BOOST: 0.8,
  KART_RADIUS: 0.9,
  WORLD_RADIUS: 130,
};

export function makeKartState(seat) {
  const g = gridSlot(seat);
  return {
    x: g.x, z: g.z, yaw: g.yaw,
    speed: 0,
    drifting: false, driftDir: 0, driftCharge: 0,
    boostTime: 0, padCooldown: 0,
    offroad: false,
    trackT: closest(new THREE.Vector3(g.x, 0, g.z)).t,
    lateral: 0,
    nextCp: 1, lap: 1, done: false,
    wrongWayTime: 0,
    // events for scene/audio/net, cleared each step by consumers
    justBoosted: 0, justCrossedCp: -1,
  };
}

const _pos = new THREE.Vector3();

// One fixed 1/60s step of the arcade kart model. Mutates s.
export function step(s, cmd, dt, remoteKarts) {
  s.justBoosted = 0;
  s.justCrossedCp = -1;
  if (s.done) cmd = { throttle: 0.35, steer: 0, drift: false }; // finished: auto-cruise

  // --- longitudinal ---
  if (cmd.throttle > 0) s.speed += CFG.ACCEL * cmd.throttle * dt;
  else if (cmd.throttle < 0) s.speed += CFG.BRAKE * cmd.throttle * dt;
  s.speed -= s.speed * CFG.DRAG * dt * (s.offroad ? 2.2 : 1);

  const boosting = s.boostTime > 0;
  if (boosting) {
    s.boostTime -= dt;
    s.speed += (CFG.BOOST_SPEED - s.speed) * 4 * dt;
  }
  const cap = boosting ? CFG.BOOST_SPEED : CFG.MAX_SPEED * (s.offroad ? CFG.OFFROAD_FACTOR : 1);
  s.speed = Math.max(-CFG.REVERSE_MAX, Math.min(cap, s.speed));

  // --- steering & drift ---
  const wasDrifting = s.drifting;
  const canDrift = cmd.drift && Math.abs(cmd.steer) >= CFG.DRIFT_MIN_STEER && s.speed > CFG.DRIFT_MIN_SPEED;
  if (!wasDrifting && canDrift) { s.drifting = true; s.driftDir = Math.sign(cmd.steer); s.driftCharge = 0; }
  if (wasDrifting && (!cmd.drift || s.speed < CFG.DRIFT_MIN_SPEED * 0.7)) {
    s.drifting = false;
    if (s.driftCharge >= CFG.DRIFT_TIER2) { s.boostTime = CFG.BOOST_T2; s.justBoosted = 2; }
    else if (s.driftCharge >= CFG.DRIFT_TIER1) { s.boostTime = CFG.BOOST_T1; s.justBoosted = 1; }
    s.driftCharge = 0;
  }
  if (s.drifting) s.driftCharge += dt;

  const speedFactor = Math.min(1, Math.abs(s.speed) / 8) / (1 + Math.abs(s.speed) / 40);
  let yawRate = cmd.steer * CFG.TURN_RATE * speedFactor;
  if (s.drifting) yawRate += s.driftDir * CFG.DRIFT_YAW_BONUS * speedFactor;
  s.yaw -= yawRate * dt * Math.sign(s.speed || 1);

  // --- integrate: velocity direction lags facing while drifting ---
  const slip = s.drifting ? s.driftDir * CFG.DRIFT_SLIP : 0;
  const dir = s.yaw + slip;
  s.x += Math.sin(dir) * s.speed * dt;
  s.z += Math.cos(dir) * s.speed * dt;

  // world bound: soft clamp to a big circle
  const r = Math.hypot(s.x, s.z);
  if (r > CFG.WORLD_RADIUS) { s.x *= CFG.WORLD_RADIUS / r; s.z *= CFG.WORLD_RADIUS / r; s.speed *= 0.9; }

  // --- soft kart-kart separation (own kart only, remote poses are ghosts) ---
  if (remoteKarts) {
    for (const rk of remoteKarts) {
      const dx = s.x - rk.x, dz = s.z - rk.z;
      const d = Math.hypot(dx, dz);
      const min = CFG.KART_RADIUS * 2;
      if (d > 0.001 && d < min) {
        const push = (min - d) * 0.5;
        s.x += (dx / d) * push;
        s.z += (dz / d) * push;
      }
    }
  }

  // --- track queries ---
  const prevT = s.trackT;
  const q = closest(_pos.set(s.x, 0, s.z));
  s.trackT = q.t;
  s.lateral = q.lateral;
  s.offroad = !isOnRoad(q.lateral);

  if (s.padCooldown > 0) s.padCooldown -= dt;
  if (onBoostPad(q.t, q.lateral) && s.padCooldown <= 0) {
    s.boostTime = Math.max(s.boostTime, CFG.PAD_BOOST);
    s.padCooldown = 1.5;
    s.justBoosted = 3;
  }

  // --- checkpoint crossing: forward pass through gate nextCp ---
  if (!s.done) {
    const gate = s.nextCp / CHECKPOINTS;
    const before = ((prevT - gate) % 1 + 1) % 1;
    const after = ((s.trackT - gate) % 1 + 1) % 1;
    if (before > 0.85 && after < 0.15) s.justCrossedCp = s.nextCp;
  }

  // --- wrong-way detection (HUD only) ---
  const { tan } = sample(s.trackT);
  const fwd = Math.sin(dir) * tan.x + Math.cos(dir) * tan.z;
  if (fwd < 0 && s.speed > 5) s.wrongWayTime += dt;
  else s.wrongWayTime = 0;
}

// Display-only race progress metric for live ranking:
// laps dominate, then gates, then closeness to the next gate.
export function progress(s) {
  const gate = s.nextCp / CHECKPOINTS;
  const remaining = ((gate - s.trackT) % 1 + 1) % 1;
  return s.lap * 10 + s.nextCp / CHECKPOINTS + (1 - remaining) * 0.01;
}
