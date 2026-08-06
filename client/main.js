import { STR } from "./strings.js";
import { commands, initTouch, touchState } from "./input.js";
import { makeKartState, step, progress, CFG } from "./physics.js";
import { createScene, KART_COLORS, KART_IDS } from "./scene.js";
import { createHud } from "./hud.js";
import { createNet } from "./net.js";
import { audio } from "./audio.js";
import { CHECKPOINTS, LAPS, gridSlot } from "./track.js";

const SIM_HZ = 60, STEP_MS = 1000 / SIM_HZ;
const POSE_EVERY = 4; // 15 Hz
const INTERP_DELAY = 120;
const DPR_CAP = 1.5;

// room + identity
let room = new URLSearchParams(location.search).get("room");
if (!room) {
  room = Math.random().toString(36).slice(2, 8);
  const u = new URL(location.href);
  u.searchParams.set("room", room);
  history.replaceState(null, "", u);
}
let playerId = sessionStorage.getItem("ck_pid");
if (!playerId) { playerId = crypto.randomUUID(); sessionStorage.setItem("ck_pid", playerId); }
const myName = "racer-" + playerId.slice(0, 4);

// seeded RNG for cosmetic scatter, same for every client in the room
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const roomSeed = [...room].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

const hud = createHud();
const canvas = document.getElementById("c");
const scene = await createScene(canvas, mulberry32(roomSeed));

function resize() {
  scene.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, DPR_CAP));
}
addEventListener("resize", resize);
addEventListener("orientationchange", resize);
resize();

initTouch(document.getElementById("steerZone"), document.getElementById("brakeBtn"), document.getElementById("driftBtn"));
if ("ontouchstart" in window) hud.showTouch(true);

// --- game state ---
let phase = "connecting"; // connecting | lobby | countdown | racing | finished
let mySeat = -1;
let seats = []; // server view: seat-indexed array of {seat,name,kartId,ready,connected,lap,nextCp,finishedAt}
let kart = null; // local physics state
let raceOrder = null;
let stepCount = 0;
let lastFinishPlace = -1;
const everPosed = new Set(); // seats seen in a live snap this race

hud.banner(STR.connecting);
hud.show("lobby");
hud.els.lobby.style.display = "none";

const net = createNet(room, playerId, myName, {
  onOpen: () => hud.banner(""),
  onDisconnect: () => hud.banner(STR.reconnecting),
  onMessage: handleMessage,
});

hud.els.readyBtn.onclick = () => {
  const me = seats[mySeat];
  net.send({ type: "ready", ready: !(me?.ready) });
};
hud.els.again.onclick = () => net.send({ type: "reset" });

function seatsArray(list) {
  const arr = [];
  for (const s of list) arr[s.seat] = s;
  return arr;
}

async function syncKartModels() {
  for (let i = 0; i < 4; i++) {
    const s = seats[i];
    if (s && !scene.hasKart(i)) await scene.addKart(i, s.kartId);
    else if (s && scene.hasKart(i)) await ensureKartId(i, s.kartId);
    else if (!s && scene.hasKart(i)) scene.removeKart(i);
  }
}
const kartIds = {};
async function ensureKartId(seat, id) {
  if (kartIds[seat] !== id) { kartIds[seat] = id; await scene.addKart(seat, id); }
}

function handleMessage(msg) {
  switch (msg.type) {
    case "state": {
      const wasPhase = phase;
      phase = msg.phase;
      mySeat = msg.you.seat;
      seats = seatsArray(msg.seats);
      syncKartModels();

      if (phase === "lobby") {
        kart = null;
        raceOrder = null;
        lastFinishPlace = -1;
        everPosed.clear();
        hud.lobbyState(seats, mySeat, seats[mySeat]?.ready ?? false);
        hud.kartPicker(seats, mySeat, (id) => net.send({ type: "kart", kartId: id }));
        if (wasPhase === "racing" || wasPhase === "countdown") hud.toast(STR.raceLost, 4000);
      }
      if ((phase === "countdown" || phase === "racing") && mySeat >= 0 && !kart) {
        kart = makeKartState(mySeat);
        if (msg.yourPose) {
          kart.x = msg.yourPose.p[0]; kart.z = msg.yourPose.p[2]; kart.yaw = msg.yourPose.yaw;
          kart.lap = msg.yourPose.lap ?? 1; kart.nextCp = msg.yourPose.nextCp ?? 1;
        }
      }
      if (mySeat < 0 && (phase === "racing" || phase === "countdown")) hud.toast(STR.spectating, 4000);
      hud.show(phase === "countdown" ? "racing" : phase);
      break;
    }
    case "countdown":
      phase = msg.n === 0 ? "racing" : "countdown";
      hud.show("racing");
      hud.countdown(msg.n);
      if (msg.n === 3) audio.play("countdown");
      if (msg.n === 0) { audio.startLoop("music"); audio.startLoop("engine"); }
      if (mySeat >= 0 && !kart) kart = makeKartState(mySeat);
      break;
    case "cp": {
      const s = seats[msg.seat];
      if (s) { s.lap = msg.lap; s.nextCp = msg.nextCp; }
      break;
    }
    case "finish":
      if (msg.seat === mySeat) {
        if (kart) kart.done = true;
        lastFinishPlace = msg.place;
        hud.finishBanner(msg.place);
        audio.play("finish");
        audio.stopLoop("engine");
      }
      if (seats[msg.seat]) seats[msg.seat].finishedAt = msg.timeMs;
      break;
    case "results":
      phase = "finished";
      raceOrder = msg.order;
      hud.show("finished");
      hud.results(raceOrder, seats, mySeat);
      break;
    case "error":
      hud.toast(STR.errors[msg.code] ?? STR.errors.bad_action);
      break;
  }
}

// --- main loop ---
let acc = 0, last = performance.now(), paused = false;
let frames = 0, fpsAt = last, fps = 0;
const dev = new URLSearchParams(location.search).has("dev");
if (dev) hud.els.dev.style.display = "block";

addEventListener("blur", () => (paused = true));
addEventListener("focus", () => { paused = false; last = performance.now(); });

function simStep(dt) {
  if (!kart || (phase !== "racing" && phase !== "finished")) return;
  const cmd = phase === "racing" ? commands() : { throttle: 0, steer: 0, drift: false };
  const remotes = net.remotePoses(INTERP_DELAY, mySeat) ?? [];
  step(kart, cmd, dt, remotes);

  if (kart.justCrossedCp >= 0) net.send({ type: "checkpoint", idx: kart.justCrossedCp });
  if (kart.justCrossedCp === 0 && kart.lap < LAPS + 1) kart.lap++; // optimistic; server confirms via cp
  if (kart.justCrossedCp >= 0) kart.nextCp = (kart.justCrossedCp + 1) % CHECKPOINTS;

  if (kart.drifting && stepCount % 3 === 0) {
    const tier = kart.driftCharge >= 1.8 ? 2 : 1;
    scene.emitSparks(kart.x, kart.z, kart.yaw, tier);
    if (stepCount % 30 === 0) audio.play("drift");
  }
  if (kart.justBoosted) {
    scene.emitSparks(kart.x, kart.z, kart.yaw, kart.justBoosted === 3 ? 3 : 2);
    audio.play("boost");
  }
  audio.enginePitch(Math.abs(kart.speed) / CFG.BOOST_SPEED);

  stepCount++;
  if (stepCount % POSE_EVERY === 0 && phase === "racing") {
    net.send({
      type: "pose",
      p: [Math.round(kart.x * 100) / 100, 0, Math.round(kart.z * 100) / 100],
      yaw: Math.round(kart.yaw * 1000) / 1000,
      v: Math.round(kart.speed * 10) / 10,
      fx: (kart.drifting ? 1 : 0) | (kart.boostTime > 0 ? 2 : 0),
    });
  }
}

function render(dtSec, now) {
  const remotes = net.remotePoses(INTERP_DELAY, mySeat) ?? [];
  for (const r of remotes) {
    scene.setKartPose(r.seat, r.x, r.z, r.yaw, { speed: r.v, drifting: !!(r.fx & 1) });
    if (r.fx & 1) scene.emitSparks(r.x, r.z, r.yaw, 1);
  }
  // karts we have never seen a live pose for (lobby, countdown) sit on their grid slot
  for (const r of remotes) everPosed.add(r.seat);
  for (const s of seats) {
    if (!s || s.seat === mySeat || everPosed.has(s.seat)) continue;
    const g = gridSlot(s.seat);
    scene.setKartPose(s.seat, g.x, g.z, g.yaw, {});
  }
  if (kart && mySeat >= 0) {
    scene.setKartPose(mySeat, kart.x, kart.z, kart.yaw, {
      speed: kart.speed, drifting: kart.drifting, driftDir: kart.driftDir, steer: 0,
    });
    scene.followKart(mySeat, kart.boostTime > 0, dtSec);
  } else {
    scene.overviewCamera(now / 1000);
    // spectator: follow the leader if racing
    if (mySeat < 0 && remotes.length && (phase === "racing" || phase === "countdown")) {
      scene.followKart(remotes[0].seat, false, dtSec);
    }
  }
  scene.updateSparks(dtSec);

  if (phase === "racing" || phase === "countdown") {
    let place = 0;
    if (kart) {
      const mine = progress(kart);
      for (const s of seats) {
        if (!s || s.seat === mySeat) continue;
        const sp = s.lap * 10 + s.nextCp / CHECKPOINTS;
        if (sp > mine) place++;
      }
      hud.race(kart.lap, place, Math.abs(kart.speed), kart.wrongWayTime > 1);
    }
    const dots = [];
    for (const r of remotes) dots.push({ seat: r.seat, x: r.x, z: r.z, color: "#" + KART_COLORS[seats[r.seat]?.kartId ?? "red"].toString(16).padStart(6, "0") });
    if (kart && mySeat >= 0) dots.push({ seat: mySeat, x: kart.x, z: kart.z, color: "#" + KART_COLORS[seats[mySeat]?.kartId ?? "red"].toString(16).padStart(6, "0") });
    hud.minimap(dots, mySeat);
  }

  scene.render();
}

function frame(now) {
  requestAnimationFrame(frame);
  if (paused) { last = now; return; }
  acc += now - last;
  last = now;
  if (acc > 250) acc = 250; // don't spiral after a hiccup
  while (acc >= STEP_MS) { simStep(STEP_MS / 1000); acc -= STEP_MS; }
  render(Math.min(0.05, (now - (frame._p ?? now)) / 1000) || 0.016, now);
  frame._p = now;

  if (dev) {
    frames++;
    if (now - fpsAt >= 500) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0; fpsAt = now;
      hud.dev(`${fps} fps | draws ${scene.drawCalls()} | snap age ${Math.round(net.snapAge())}ms | phase ${phase} | seat ${mySeat}`);
    }
  }
}
requestAnimationFrame(frame);
