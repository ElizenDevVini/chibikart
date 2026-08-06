import { applySpin, CFG } from "./physics.js";
import { clamp } from "./util.js";

const wrap01 = (t) => ((t % 1) + 1) % 1;

// Position-weighted rolls: leaders get defense, stragglers get speed
const WEIGHTS = [
  { donut: 30, shake: 60, turbo: 10 }, // 1st
  { donut: 40, shake: 30, turbo: 30 },
  { donut: 35, shake: 15, turbo: 50 },
  { donut: 25, shake: 5, turbo: 70 },  // 4th
];

const BOX_SETS = [0.10, 0.38, 0.65, 0.90];
const BOX_LANES = [-2.6, 0, 2.6];
const BOX_RADIUS = 1.6;
const BOX_RESPAWN = 4;
const DONUT_SPEED = 38;
const DONUT_LIFE = 4;
const DONUT_HIT_R = 2.0;
const PUDDLE_LIFE = 20;
const PUDDLE_HIT_R = 1.5;
const PUDDLE_CAP = 6;
const ROULETTE = 0.9;

export function makeItems(track, rng) {
  const L = track.length;
  const boxes = [];
  for (const t of BOX_SETS) {
    const { pos, tan } = track.sample(t);
    const sideX = tan.z, sideZ = -tan.x;
    for (const lane of BOX_LANES) {
      boxes.push({ t, lateral: lane, x: pos.x + sideX * lane, z: pos.z + sideZ * lane, alive: true, respawnAt: 0 });
    }
  }

  let donuts = [];
  let puddles = [];
  const slots = {};   // seat -> { held, rollingUntil }
  let time = 0;

  function roll(place) {
    const w = WEIGHTS[clamp(place, 0, 3)];
    const total = w.donut + w.shake + w.turbo;
    const r = rng() * total;
    if (r < w.donut) return "donut";
    if (r < w.donut + w.shake) return "shake";
    return "turbo";
  }

  function fire(kart, seat, events) {
    const held = slots[seat]?.held;
    if (!held) return;
    slots[seat] = null;
    if (held === "turbo") {
      kart.boostTime = CFG.BOOST_T2;
      kart.justBoosted = 2;
    } else if (held === "donut") {
      const t = wrap01(kart.trackT + 3 / L);
      donuts.push({
        t, lateral: clamp(kart.lateral, -(track.ROAD_HALF_WIDTH - 0.8), track.ROAD_HALF_WIDTH - 0.8),
        ownerSeat: seat, life: DONUT_LIFE, immune: 0.4, x: 0, z: 0, yaw: 0,
      });
    } else if (held === "shake") {
      const bx = kart.x - Math.sin(kart.yaw) * 2.5;
      const bz = kart.z - Math.cos(kart.yaw) * 2.5;
      const q = track.closest({ x: bx, y: 0, z: bz });
      puddles.push({ x: bx, z: bz, t: q.t, lateral: q.lateral, ownerSeat: seat, life: PUDDLE_LIFE, immune: 1.0 });
      if (puddles.length > PUDDLE_CAP) puddles.shift();
    }
    events.push({ type: "throw", seat, item: held });
  }

  return {
    // karts: array of physics states indexed by seat; places: seat -> 0-based place
    // useFlags: seat -> bool (edge-detected). Returns events for audio/fx.
    update(dt, karts, places, useFlags) {
      time += dt;
      const events = [];

      for (const b of boxes) {
        if (!b.alive && time >= b.respawnAt) b.alive = true;
      }

      for (const [seatStr, use] of Object.entries(useFlags)) {
        const seat = +seatStr;
        if (use && karts[seat] && !karts[seat].done && slots[seat]?.held && time >= (slots[seat].rollingUntil ?? 0)) {
          fire(karts[seat], seat, events);
        }
      }

      // pickups
      for (const [seatStr, kart] of Object.entries(karts)) {
        const seat = +seatStr;
        if (!kart || kart.done || slots[seat]?.held) continue;
        for (const b of boxes) {
          if (!b.alive) continue;
          const dx = kart.x - b.x, dz = kart.z - b.z;
          if (dx * dx + dz * dz < BOX_RADIUS * BOX_RADIUS) {
            b.alive = false;
            b.respawnAt = time + BOX_RESPAWN;
            slots[seat] = { held: roll(places[seat] ?? 3), rollingUntil: time + ROULETTE };
            events.push({ type: "pickup", seat });
            break;
          }
        }
      }

      // donut projectiles roll along the road
      for (const d of donuts) {
        d.life -= dt;
        d.immune = Math.max(0, d.immune - dt);
        d.t = wrap01(d.t + (DONUT_SPEED / L) * dt);
        const { pos, tan } = track.sample(d.t);
        const sideX = tan.z, sideZ = -tan.x;
        d.x = pos.x + sideX * d.lateral;
        d.z = pos.z + sideZ * d.lateral;
        d.yaw = Math.atan2(tan.x, tan.z);
        for (const [seatStr, kart] of Object.entries(karts)) {
          const seat = +seatStr;
          if (!kart || kart.done || kart.spinTime > 0) continue;
          if (seat === d.ownerSeat && d.immune > 0) continue;
          const dx = kart.x - d.x, dz = kart.z - d.z;
          if (dx * dx + dz * dz < DONUT_HIT_R * DONUT_HIT_R) {
            applySpin(kart);
            d.life = 0;
            events.push({ type: "hit", seat, item: "donut" });
            break;
          }
        }
      }
      donuts = donuts.filter((d) => d.life > 0);

      for (const p of puddles) {
        p.life -= dt;
        p.immune = Math.max(0, p.immune - dt);
        for (const [seatStr, kart] of Object.entries(karts)) {
          const seat = +seatStr;
          if (!kart || kart.done || kart.spinTime > 0) continue;
          if (seat === p.ownerSeat && p.immune > 0) continue;
          const dx = kart.x - p.x, dz = kart.z - p.z;
          if (dx * dx + dz * dz < PUDDLE_HIT_R * PUDDLE_HIT_R) {
            applySpin(kart);
            p.life = 0;
            events.push({ type: "hit", seat, item: "shake" });
            break;
          }
        }
      }
      puddles = puddles.filter((p) => p.life > 0);

      return events;
    },

    hazardsForAI() {
      const out = [];
      for (const p of puddles) out.push({ t: p.t, lateral: p.lateral, r: PUDDLE_HIT_R, type: "shake" });
      for (const d of donuts) out.push({ t: d.t, lateral: d.lateral, r: DONUT_HIT_R, type: "donut" });
      return out;
    },
    boxesForAI() { return boxes; },
    slot(seat) {
      const s = slots[seat];
      if (!s) return { held: null, rolling: false };
      return { held: s.held, rolling: time < s.rollingUntil };
    },
    entities() { return { boxes, donuts, puddles }; },
  };
}
