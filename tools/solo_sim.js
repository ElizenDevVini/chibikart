// Headless full-race sim: 4 AI karts race each cup track through the real
// physics + ai + items code. Catches broken track params, stuck AIs, dead items.
import { makeTrack, TRACKS, CHECKPOINTS, LAPS } from "../client/track.js";
import { makeKartState, step, progress, applySpin } from "../client/physics.js";
import { makeAI, PERSONALITIES } from "../client/ai.js";
import { makeItems } from "../client/items.js";
import { mulberry32 } from "../client/util.js";

let failures = 0;
const ok = (cond, name) => {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
};

for (let ti = 0; ti < TRACKS.length; ti++) {
  const track = makeTrack(TRACKS[ti]);
  console.log(`== ${TRACKS[ti].name} (length ${track.length.toFixed(0)}m)`);

  // geometry sanity: no pinched segments
  let minSeg = Infinity;
  let prev = track.sample(0).pos;
  for (let i = 1; i <= 384; i++) {
    const p = track.sample(i / 384).pos;
    minSeg = Math.min(minSeg, p.distanceTo(prev));
    prev = p;
  }
  ok(minSeg > 0.3, `road segments don't degenerate (min ${minSeg.toFixed(2)})`);

  const rng = mulberry32(1234 + ti);
  const karts = {};
  const ais = {};
  for (let seat = 0; seat < 4; seat++) {
    karts[seat] = makeKartState(seat, track);
    ais[seat] = makeAI(PERSONALITIES[seat % PERSONALITIES.length], rng, track);
  }
  const items = makeItems(track, rng);
  const dt = 1 / 60;
  const finishOrder = [];
  let raceTime = 0;
  const stats = { throws: 0, hits: 0, spins: 0, boosts: 0, drifts: 0, maxSpeedMul: 0, minSpeedMul: 9 };

  const MAX_TIME = 240;
  while (finishOrder.length < 4 && raceTime < MAX_TIME) {
    raceTime += dt;
    const entries = Object.entries(karts).map(([s, k]) => ({ s: +s, p: progress(k), done: k.done, fi: finishOrder.indexOf(+s) }));
    entries.sort((a, b) => (a.done && b.done) ? a.fi - b.fi : (a.done !== b.done) ? (a.done ? -1 : 1) : b.p - a.p);
    const places = {};
    entries.forEach((e, i) => (places[e.s] = i));

    const hazards = items.hazardsForAI();
    const boxes = items.boxesForAI();
    const kartList = Object.values(karts);
    const useFlags = {};

    for (let seat = 0; seat < 4; seat++) {
      const kart = karts[seat];
      // player stand-in: seat 0's kart is "the player" for rubber-band purposes
      const world = { dt, playerKart: karts[0], karts: kartList, hazards, boxes, myItem: items.slot(seat).held, myPlace: places[seat] };
      const cmd = ais[seat].tick(kart, world);
      useFlags[seat] = !!cmd.useItem;
      stats.maxSpeedMul = Math.max(stats.maxSpeedMul, kart.tune.speedMul);
      stats.minSpeedMul = Math.min(stats.minSpeedMul, kart.tune.speedMul);
      if (cmd.drift) stats.drifts++;
      step(kart, cmd, dt, kartList.filter((k) => k !== kart));
      if (kart.justBoosted) stats.boosts++;
      if (kart.justSpun) stats.spins++;
      if (kart.justCrossedCp >= 0 && !kart.done) {
        const idx = kart.justCrossedCp;
        kart.nextCp = (idx + 1) % CHECKPOINTS;
        if (idx === 0) {
          kart.lap++;
          if (kart.lap > LAPS) { kart.done = true; finishOrder.push(seat); }
        }
      }
    }
    const events = items.update(dt, karts, places, useFlags);
    for (const e of events) {
      if (e.type === "throw") stats.throws++;
      if (e.type === "hit") stats.hits++;
    }
  }

  ok(finishOrder.length === 4, `all 4 AIs finish 3 laps (${finishOrder.length}/4 in ${raceTime.toFixed(0)}s)`);
  ok(raceTime < MAX_TIME, `race completes under ${MAX_TIME}s (${raceTime.toFixed(0)}s)`);
  ok(stats.boosts > 0, `boosts happened (${stats.boosts})`);
  ok(stats.throws > 0, `items were thrown (${stats.throws})`);
  ok(stats.maxSpeedMul <= 1.08 * 1.001 && stats.minSpeedMul >= 0.90 * 0.94 * 0.999,
    `rubber-band stayed in bounds (${stats.minSpeedMul.toFixed(3)}..${stats.maxSpeedMul.toFixed(3)})`);
  console.log(`   spins ${stats.spins}, hits ${stats.hits}, drift-ticks ${stats.drifts}`);
}

// spin-out honors its contract
{
  const track = makeTrack(TRACKS[0]);
  const k = makeKartState(0, track);
  k.speed = 25;
  applySpin(k);
  ok(k.justSpun === 1 && k.speed < 10, "applySpin cuts speed and flags event");
  const yawBefore = k.yaw;
  for (let i = 0; i < 30; i++) step(k, { throttle: 1, steer: 1, drift: false }, 1 / 60, []);
  ok(Math.abs(k.yaw - yawBefore) < 0.01, "controls are cut during spin (heading unchanged)");
}

process.exit(failures ? 1 : 0);
