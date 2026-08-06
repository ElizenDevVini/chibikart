import { makeKartState, step, progress, CFG } from "./physics.js";
import { makeItems } from "./items.js";
import { makeAI, PERSONALITIES } from "./ai.js";
import { KART_COLORS } from "./scene.js";
import { CHECKPOINTS } from "./track.js";

// The one race loop, shared by solo (AI + items, local countdown) and online
// (remote ghosts, server-driven phases). deps are injectable for headless tests.
export function makeRace(deps, config) {
  const { scene, hud, audio, getCommands } = deps;
  const {
    track, laps, rng,
    seats,                 // [{seat, kartId, control: "player"|"ai"|"remote", personality?}]
    items: itemsOn = false,
    countdown = "local",   // "local" | "server"
    hooks = {},            // { sendPose?, sendCp?, getRemotes? }
    onFinish = () => {},   // (seat, place, timeMs) — every local kart finish
    onAllDone = () => {},  // (order: [{seat, timeMs|null}])
  } = config;

  const karts = {};        // seat -> physics state (player + ai only)
  const ais = {};
  let playerSeat = -1;
  let aiIndex = 0;
  for (const s of seats) {
    if (s.control === "remote") continue;
    karts[s.seat] = makeKartState(s.seat, track);
    if (s.control === "player") playerSeat = s.seat;
    else if (s.control === "ai") ais[s.seat] = makeAI(s.personality ?? PERSONALITIES[aiIndex++ % PERSONALITIES.length], rng, track);
  }

  const items = itemsOn ? makeItems(track, rng) : null;
  let phase = countdown === "local" ? "countdown" : "waiting";
  let cdT = 0, lastCdN = 4;
  let raceTime = 0;
  let stepCount = 0;
  let finishOrder = [];    // seats in finish order
  let playerDoneAt = -1;
  let ended = false;
  let finalLapShown = false;
  let lastPlace = -1;
  const useFlagPrev = {};

  function computePlaces() {
    const entries = Object.entries(karts).map(([seat, k]) => ({ seat: +seat, p: progress(k), done: k.done, fi: finishOrder.indexOf(+seat) }));
    if (hooks.getRemotes) {
      // online: remote seats ranked from their lap/nextCp (server cp broadcasts)
      for (const r of config.remoteRank?.() ?? []) entries.push(r);
    }
    entries.sort((a, b) => {
      if (a.done && b.done) return a.fi - b.fi;
      if (a.done !== b.done) return a.done ? -1 : 1;
      return b.p - a.p;
    });
    const places = {};
    entries.forEach((e, i) => { places[e.seat] = i; });
    return places;
  }

  function localCheckpoint(seat, kart) {
    const idx = kart.justCrossedCp;
    kart.nextCp = (idx + 1) % CHECKPOINTS;
    if (idx !== 0) return;
    kart.lap++;
    if (seat === playerSeat && kart.lap === laps && !finalLapShown) {
      finalLapShown = true;
      hud.finalLap?.();
      audio.play("final_lap");
    }
    if (kart.lap > laps) {
      kart.done = true;
      kart.lap = laps;
      kart.finishTime = raceTime * 1000;
      finishOrder.push(seat);
      const place = finishOrder.length - 1;
      onFinish(seat, place, Math.round(raceTime * 1000));
      if (seat === playerSeat) {
        playerDoneAt = raceTime;
        audio.play("finish");
        audio.stopLoop("engine");
        hud.finishBanner(place);
      }
      if (finishOrder.length === Object.keys(karts).length) endRace();
    }
  }

  function endRace() {
    if (ended) return;
    ended = true;
    phase = "finished";
    const order = finishOrder.map((seat) => ({ seat, timeMs: Math.round(karts[seat].finishTime ?? raceTime * 1000) }));
    const rest = Object.keys(karts).map(Number).filter((s) => !finishOrder.includes(s))
      .sort((a, b) => progress(karts[b]) - progress(karts[a]))
      .map((seat) => ({ seat, timeMs: null }));
    onAllDone([...order, ...rest]);
  }

  const api = {
    get phase() { return phase; },
    get playerKart() { return karts[playerSeat] ?? null; },
    get karts() { return karts; },
    get raceTime() { return raceTime; },
    items,

    setPhase(p) { phase = p; },
    showCountdown(n) { hud.countdown(n); if (n === 3) audio.play("countdown"); if (n === 0) { phase = "racing"; audio.startLoop("music"); } },

    simStep(dt) {
      if (phase === "countdown") {
        cdT += dt;
        const n = Math.max(0, 3 - Math.floor(cdT));
        if (n !== lastCdN) {
          lastCdN = n;
          hud.countdown(n);
          if (n === 3) audio.play("countdown");
          if (n === 0) { phase = "racing"; audio.startLoop("music"); }
        }
        return;
      }
      if (phase !== "racing" && phase !== "finished") return;
      if (phase === "racing") raceTime += dt;
      audio.ensureLoops(phase === "racing" && !karts[playerSeat]?.done);

      const places = computePlaces();
      const remotes = hooks.getRemotes ? (hooks.getRemotes() ?? []) : [];
      const hazards = items?.hazardsForAI() ?? null;
      const boxes = items?.boxesForAI() ?? null;
      const kartList = Object.values(karts);
      const useFlags = {};

      for (const [seatStr, kart] of Object.entries(karts)) {
        const seat = +seatStr;
        let cmd;
        if (seat === playerSeat) {
          const c = phase === "racing" ? getCommands() : { throttle: 0, steer: 0, drift: false, item: false };
          cmd = c;
          useFlags[seat] = !!c.item && !useFlagPrev[seat];
          useFlagPrev[seat] = !!c.item;
        } else {
          const ai = ais[seat];
          const world = {
            dt, playerKart: karts[playerSeat] ?? null, karts: kartList,
            hazards, boxes,
            myItem: items?.slot(seat).held ?? null, myPlace: places[seat] ?? 3,
          };
          cmd = phase === "racing" ? ai.tick(kart, world) : { throttle: 0, steer: 0, drift: false };
          useFlags[seat] = !!cmd.useItem;
        }

        const others = kartList.filter((k) => k !== kart).concat(remotes);
        step(kart, cmd, dt, others);

        if (kart.justCrossedCp >= 0) {
          if (seat === playerSeat && hooks.sendCp) {
            hooks.sendCp(kart.justCrossedCp);
            if (kart.justCrossedCp === 0 && kart.lap < laps + 1) kart.lap++;
            kart.nextCp = (kart.justCrossedCp + 1) % CHECKPOINTS;
          } else {
            localCheckpoint(seat, kart);
          }
        }

        // effects per kart
        if (kart.drifting && stepCount % 3 === 0) {
          scene.emitSparks(kart.x, kart.z, kart.yaw, kart.driftCharge >= CFG.DRIFT_TIER2 ? 2 : 1);
          if (!kart.offroad && stepCount % 2 === 0) scene.addSkid(kart.x - Math.sin(kart.yaw) * 0.8, kart.z - Math.cos(kart.yaw) * 0.8, kart.yaw);
          if (seat === playerSeat && stepCount % 30 === 0) audio.play("drift");
        }
        if (kart.justBoosted) {
          scene.emitSparks(kart.x, kart.z, kart.yaw, kart.justBoosted === 3 ? 3 : 2);
          if (seat === playerSeat) audio.play("boost");
        }
        if (kart.justSpun && seat === playerSeat) audio.play("spin");
      }

      if (items && phase === "racing") {
        const events = items.update(dt, karts, places, useFlags);
        for (const e of events) {
          if (e.type === "pickup" && e.seat === playerSeat) audio.play("item_pickup");
          if (e.type === "throw" && e.seat === playerSeat) audio.play("item_throw");
          if (e.type === "hit") {
            const k = karts[e.seat];
            if (k) scene.emitSparks(k.x, k.z, k.yaw, 1);
            if (e.seat === playerSeat) audio.play("spin");
          }
        }
      }

      const me = karts[playerSeat];
      if (me) {
        audio.enginePitch(Math.abs(me.speed) / CFG.BOOST_SPEED);
        if (stepCount % 4 === 0 && phase === "racing" && hooks.sendPose) {
          hooks.sendPose({
            p: [Math.round(me.x * 100) / 100, 0, Math.round(me.z * 100) / 100],
            yaw: Math.round(me.yaw * 1000) / 1000,
            v: Math.round(me.speed * 10) / 10,
            fx: (me.drifting ? 1 : 0) | (me.boostTime > 0 ? 2 : 0),
          });
        }
      }

      // solo: close the race if stragglers dawdle after the player finishes
      if (!hooks.getRemotes && playerDoneAt >= 0 && raceTime - playerDoneAt > 12) endRace();
      stepCount++;
    },

    frame(dtSec, now, seatsMeta) {
      const remotes = hooks.getRemotes ? (hooks.getRemotes() ?? []) : [];
      for (const r of remotes) {
        scene.setKartPose(r.seat, r.x, r.z, r.yaw, { speed: r.v, drifting: !!(r.fx & 1) });
        if (r.fx & 1) scene.emitSparks(r.x, r.z, r.yaw, 1);
      }
      for (const [seatStr, k] of Object.entries(karts)) {
        const seat = +seatStr;
        scene.setKartPose(seat, k.x, k.z, k.yaw, {
          speed: k.speed, drifting: k.drifting, driftDir: k.driftDir,
          spin: k.spinTime > 0 ? (1 - k.spinTime / CFG.SPIN_TIME) * Math.PI * 4 : 0,
        });
      }
      if (items) scene.syncItems(items.entities(), now / 1000);
      scene.updateSparks(dtSec);
      scene.updateSkids(dtSec);

      const me = karts[playerSeat] ?? karts[0]; // bot-mode camera follows seat 0
      const camSeat = karts[playerSeat] ? playerSeat : 0;
      if (phase === "countdown" && me) {
        scene.introCamera(camSeat, Math.max(0, Math.min(1, (3 - cdT) / 3)));
      } else if (me) {
        scene.followKart(camSeat, me.boostTime > 0, dtSec);
      } else if (remotes.length) {
        scene.followKart(remotes[0].seat, false, dtSec);
      } else {
        scene.overviewCamera(now / 1000);
      }

      if ((phase === "racing" || phase === "countdown") && me) {
        const places = computePlaces();
        const myPlace = places[camSeat] ?? 0;
        if (myPlace !== lastPlace) { hud.placeFlash?.(); lastPlace = myPlace; }
        hud.race(me.lap, myPlace, Math.abs(me.speed), me.wrongWayTime > 1);
        if (items) hud.itemSlot?.(items.slot(camSeat));
        const dots = [];
        for (const [seatStr, k] of Object.entries(karts)) {
          dots.push({ seat: +seatStr, x: k.x, z: k.z, color: dotColor(+seatStr, seatsMeta) });
        }
        for (const r of remotes) dots.push({ seat: r.seat, x: r.x, z: r.z, color: dotColor(r.seat, seatsMeta) });
        hud.minimap(dots, playerSeat);
      }
    },
  };

  function dotColor(seat, seatsMeta) {
    const id = seatsMeta?.[seat]?.kartId ?? seats.find((s) => s.seat === seat)?.kartId ?? "red";
    return "#" + KART_COLORS[id].toString(16).padStart(6, "0");
  }

  return api;
}
