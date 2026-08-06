import { CFG } from "./physics.js";
import { clamp, wrapToPi } from "./util.js";

// Three rivals, distinct lanes and temperaments so they don't drive in a train
export const PERSONALITIES = [
  { name: "sprinkles", lane: -2.0, caution: 0.55, driftHoldTarget: 1.8, baseSpeedMul: 1.00, steerGain: 2.8, itemDelay: 0.3, wobbleAmp: 0.3, wobblePeriod: 4 },
  { name: "glaze",     lane: 1.8,  caution: 0.75, driftHoldTarget: 1.8, baseSpeedMul: 0.97, steerGain: 2.4, itemDelay: 0.6, wobbleAmp: 0.5, wobblePeriod: 5 },
  { name: "crumb",     lane: 0.4,  caution: 0.90, driftHoldTarget: 0.9, baseSpeedMul: 0.94, steerGain: 2.2, itemDelay: 1.0, wobbleAmp: 0.8, wobblePeriod: 7 },
];

const signedAngle = (a, b) => Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
const wrap01 = (t) => ((t % 1) + 1) % 1;

export function makeAI(personality, rng, track) {
  const p = personality;
  const wobblePhase = rng() * Math.PI * 2;
  let raceTime = 0;
  let offroadTime = 0;
  let stuckTime = 0;
  let reversing = 0;
  let heldItemSince = -1;
  const L = track.length;
  const maxLat = track.ROAD_HALF_WIDTH - 1;

  // world: { dt, playerKart, karts, hazards, boxes, myItem, myPlace }
  function tick(kart, world) {
    const dt = world.dt;
    raceTime += dt;

    // --- rubber-band: assist only when far from the player, never near them ---
    let rubber = 1;
    if (world.playerKart) {
      const d = (world.playerKart.lap + world.playerKart.trackT) - (kart.lap + kart.trackT);
      rubber = clamp(1 + 0.35 * d, 0.90, 1.08);
      const near = Math.abs(d) < 0.02; // ~10m
      if (near) rubber = 1;
    }
    kart.tune.speedMul = rubber * p.baseSpeedMul;

    // --- recovery states ---
    if (kart.offroad) offroadTime += dt; else offroadTime = 0;
    if (Math.abs(kart.speed) < 2) stuckTime += dt; else stuckTime = 0;
    if (reversing > 0) {
      reversing -= dt;
      return { throttle: -1, steer: 0, drift: false, useItem: false };
    }
    if (stuckTime > 1.5) {
      reversing = 0.8;
      stuckTime = 0;
      return { throttle: -1, steer: 0, drift: false, useItem: false };
    }

    // --- curvature ahead ---
    const tanA = track.sample(kart.trackT).tan;
    const tanB = track.sample(kart.trackT + 8 / L).tan;
    const tanC = track.sample(kart.trackT + 16 / L).tan;
    const bendNear = signedAngle(tanA, tanB);
    const bendFar = Math.abs(signedAngle(tanA, tanC));

    // --- lane with wobble, hazard avoidance, box seeking ---
    let lat = p.lane + p.wobbleAmp * Math.sin((Math.PI * 2 * raceTime) / p.wobblePeriod + wobblePhase);
    const lookMeters = 6 + 0.55 * Math.abs(kart.speed);
    if (world.hazards) {
      for (const h of world.hazards) {
        const ahead = wrap01(h.t - kart.trackT) * L;
        if (ahead > 2 && ahead < lookMeters + 6 && Math.abs(h.lateral - lat) < h.r + 1.4) {
          lat = h.lateral + (h.lateral > 0 ? -1 : 1) * (h.r + 1.8);
        }
      }
    }
    if (world.boxes && !world.myItem) {
      for (const b of world.boxes) {
        if (!b.alive) continue;
        const ahead = wrap01(b.t - kart.trackT) * L;
        if (ahead > 2 && ahead < lookMeters + 8) {
          lat = lat + (b.lateral - lat) * 0.7;
          break;
        }
      }
    }
    lat = clamp(lat, -maxLat, maxLat);

    // --- steer at the lookahead point ---
    const lookT = kart.trackT + lookMeters / L;
    const { pos, tan } = track.sample(lookT);
    const sideX = tan.z, sideZ = -tan.x; // cross(tan, up) in XZ
    const tx = pos.x + sideX * lat, tz = pos.z + sideZ * lat;
    const err = wrapToPi(Math.atan2(tx - kart.x, tz - kart.z) - kart.yaw);
    const steer = clamp(-err * p.steerGain, -1, 1);

    // --- recovery: aim at centerline when lost ---
    if (offroadTime > 0.6 || kart.wrongWayTime > 1) {
      const c = track.sample(kart.trackT).pos;
      const rerr = wrapToPi(Math.atan2(c.x - kart.x, c.z - kart.z) - kart.yaw);
      return { throttle: 0.7, steer: clamp(-rerr * 2.5, -1, 1), drift: false, useItem: false };
    }

    // --- corner slowdown ---
    const targetSpeed = CFG.MAX_SPEED * rubber * (1 - p.caution * Math.min(0.6, bendFar * 0.55));
    let throttle = 1;
    if (kart.speed > targetSpeed + 3) throttle = -0.4;
    else if (kart.speed > targetSpeed) throttle = 0;

    // --- drift policy: lookahead steering already points into the bend ---
    let drift;
    if (kart.drifting) {
      drift = bendFar > 0.15 && kart.driftCharge < p.driftHoldTarget + 0.3;
    } else {
      drift = bendFar > 0.45 && Math.abs(steer) >= 0.4 && kart.speed > CFG.DRIFT_MIN_SPEED + 2;
    }

    // --- item usage ---
    let useItem = false;
    if (world.myItem) {
      if (heldItemSince < 0) heldItemSince = raceTime;
      const heldFor = raceTime - heldItemSince;
      if (heldFor > p.itemDelay) {
        if (world.myItem === "turbo") {
          useItem = bendFar < 0.25 && !kart.drifting || world.myPlace === 3;
        } else if (world.myItem === "donut") {
          useItem = world.karts.some((k) => {
            if (k === kart || k.done) return false;
            const gap = ((k.lap + k.trackT) - (kart.lap + kart.trackT)) * L;
            return gap > 0 && gap < 25;
          });
        } else if (world.myItem === "shake") {
          const rivalBehind = world.karts.some((k) => {
            if (k === kart || k.done) return false;
            const gap = ((kart.lap + kart.trackT) - (k.lap + k.trackT)) * L;
            return gap > 0 && gap < 15;
          });
          useItem = rivalBehind || heldFor > 8;
        }
      }
    } else {
      heldItemSince = -1;
    }

    return { throttle, steer, drift, useItem };
  }

  return { tick, personality: p };
}
