import { STR } from "./strings.js";
import { commands, initTouch } from "./input.js";
import { CFG } from "./physics.js";
import { createScene, KART_IDS } from "./scene.js";
import { createHud } from "./hud.js";
import { createMenu } from "./menu.js";
import { createNet } from "./net.js";
import { audio } from "./audio.js";
import { makeRace } from "./race.js";
import { makeTrack, defaultTrack, TRACKS, LAPS, CHECKPOINTS } from "./track.js";
import { PERSONALITIES } from "./ai.js";
import { mulberry32, seedFrom } from "./util.js";

const SIM_HZ = 60, STEP_MS = 1000 / SIM_HZ;
const INTERP_DELAY = 120;
const DPR_CAP = 1.5;
const CUP_POINTS = [9, 6, 3, 1];
const BOT_MODE = new URLSearchParams(location.search).get("bot") === "1";

// room + identity (used by the online director). A room param in the arriving
// URL means someone followed an invite link: boot straight into online mode.
let room = new URLSearchParams(location.search).get("room");
const arrivedViaInvite = !!room;
function ensureRoom() {
  if (!room) {
    room = Math.random().toString(36).slice(2, 8);
    const u = new URL(location.href);
    u.searchParams.set("room", room);
    history.replaceState(null, "", u);
  }
  const u = new URL(location.href);
  u.searchParams.delete("__raw");
  return u.href; // invite url
}
let playerId = sessionStorage.getItem("ck_pid");
if (!playerId) { playerId = crypto.randomUUID(); sessionStorage.setItem("ck_pid", playerId); }
const myName = "racer-" + playerId.slice(0, 4);

const hud = createHud();
const menu = createMenu();
const canvas = document.getElementById("c");
const scene = await createScene(canvas);
const deps = { scene, hud, audio, getCommands: commands };

const trackCache = [defaultTrack];
function getTrack(i) {
  if (!trackCache[i]) trackCache[i] = makeTrack(TRACKS[i]);
  return trackCache[i];
}

function resize() {
  scene.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, DPR_CAP));
}
addEventListener("resize", resize);
addEventListener("orientationchange", resize);
resize();

initTouch(
  document.getElementById("steerZone"),
  document.getElementById("brakeBtn"),
  document.getElementById("driftBtn"),
  document.getElementById("itemSlot"),
);
if ("ontouchstart" in window) hud.showTouch(true);

// ---------------------------------------------------------------- directors
let director = null;
let paused = false;

async function switchTo(next) {
  if (director?.exit) await director.exit();
  director = next;
  await director.enter();
}

// ---- menu: title over a live overview of the sunny track with parked karts
function MenuDirector() {
  return {
    async enter() {
      hud.show("none");
      hud.showRaceExtras(false, false);
      await scene.setTrack(defaultTrack, mulberry32(7));
      scene.removeAllKarts();
      for (let i = 0; i < 4; i++) {
        await scene.addKart(i, KART_IDS[i]);
        const g = defaultTrack.gridSlot(i);
        scene.setKartPose(i, g.x, g.z, g.yaw, {});
      }
      menu.title({
        onGrandPrix: () => switchTo(SoloDirector({ cup: true })),
        onSingleRace: () => switchTo(SoloDirector({ cup: false })),
        onOnline: () => switchTo(OnlineDirector()),
      });
    },
    exit() { menu.hide(); },
    simStep() {},
    frame(dtSec, now) {
      scene.overviewCamera(now / 1000);
      scene.render();
    },
    handleKey() {},
  };
}

// ---- solo: kart select -> races -> results -> podium
function SoloDirector({ cup }) {
  const total = cup ? TRACKS.length : 1;
  const cupSeed = (Date.now() / 60000) | 0; // varies per minute; fixed within a cup
  let raceIndex = 0;
  let attempt = 0;
  let race = null;
  let seatsMeta = null;
  let phase = "select"; // select | racing | results | podium
  const points = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let playerKartId = null;
  let podiumDone = false;

  function buildSeatsMeta() {
    const others = KART_IDS.filter((id) => id !== playerKartId);
    seatsMeta = {
      0: { seat: 0, kartId: playerKartId, name: myName },
      1: { seat: 1, kartId: others[0], name: STR.aiNames[PERSONALITIES[0].name] },
      2: { seat: 2, kartId: others[1], name: STR.aiNames[PERSONALITIES[1].name] },
      3: { seat: 3, kartId: others[2], name: STR.aiNames[PERSONALITIES[2].name] },
    };
  }

  async function startRace() {
    menu.hide();
    phase = "racing";
    const track = getTrack(raceIndex);
    const seed = seedFrom(`cup${cupSeed}-race${raceIndex}-try${attempt}`);
    await scene.setTrack(track, mulberry32(seed + 1));
    hud.setTrack(track);
    scene.removeAllKarts();
    for (let i = 0; i < 4; i++) await scene.addKart(i, seatsMeta[i].kartId);
    hud.show("racing");
    hud.showRaceExtras(true, true);
    race = makeRace(deps, {
      track, laps: LAPS, rng: mulberry32(seed + 2), items: true, countdown: "local",
      seats: [
        // ?bot=1 puts the player kart on autopilot — used by the headless playthrough test
        { seat: 0, kartId: seatsMeta[0].kartId, control: BOT_MODE ? "ai" : "player", personality: BOT_MODE ? PERSONALITIES[0] : undefined },
        { seat: 1, kartId: seatsMeta[1].kartId, control: "ai", personality: PERSONALITIES[0] },
        { seat: 2, kartId: seatsMeta[2].kartId, control: "ai", personality: PERSONALITIES[1] },
        { seat: 3, kartId: seatsMeta[3].kartId, control: "ai", personality: PERSONALITIES[2] },
      ],
      onFinish: () => {},
      onAllDone: (order) => {
        phase = "results";
        order.forEach((r, i) => { points[r.seat] += CUP_POINTS[i]; });
        audio.stopLoop("music");
        hud.show("none");
        menu.raceResults({
          raceIndex, total, trackName: TRACKS[raceIndex].name, order, seatsMeta,
          points, playerSeat: 0,
          onNext: async () => {
            raceIndex++;
            if (raceIndex < total) await startRace();
            else showPodium();
          },
        });
      },
    });
  }

  function showPodium() {
    phase = "podium";
    podiumDone = false;
    hud.show("none");
    hud.showRaceExtras(false, false);
    const standings = Object.keys(points).map(Number)
      .map((seat) => ({ seat, points: points[seat] }))
      .sort((a, b) => b.points - a.points);
    scene.showPodium(standings.slice(0, 3).map((s) => seatsMeta[s.seat].kartId));
    // park top three karts on the stands, rest hidden
    const spots = [[0, 2.2], [-3.2, 1.5], [3.2, 1.0]];
    for (let i = 0; i < 4; i++) {
      const obj = scene.kartObject(standings[i].seat);
      if (!obj) continue;
      if (i < 3) {
        obj.visible = true;
        obj.position.set(spots[i][0], spots[i][1], 0);
        obj.rotation.set(0, 0, 0); // camera sits at +z: face it
      } else {
        obj.visible = false;
      }
    }
    scene.confetti(0, 0);
    audio.play("finish");
    menu.podium({
      standings, seatsMeta, playerSeat: 0,
      onDone: () => { scene.hidePodium(); switchTo(MenuDirector()); },
    });
  }

  return {
    async enter() {
      hud.show("none");
      menu.kartSelect(async (id) => {
        playerKartId = id;
        buildSeatsMeta();
        await startRace();
      });
    },
    exit() { menu.hide(); scene.hidePodium(); audio.stopLoop("music"); audio.stopLoop("engine"); },
    simStep(dt) {
      if (phase === "racing" && !paused) race?.simStep(dt);
    },
    frame(dtSec, now) {
      if (phase === "racing" && race) race.frame(dtSec, now, seatsMeta);
      else if (phase === "podium") { scene.updateSparks(dtSec); scene.podiumCamera(now / 1000); if (!podiumDone && Math.random() < 0.03) scene.confetti((Math.random() - 0.5) * 8, 0); }
      else scene.overviewCamera(now / 1000);
      scene.render();
    },
    handleKey(e) {
      if (e.code !== "Escape" || phase !== "racing") return;
      paused = true;
      menu.pause({
        onResume: () => { paused = false; menu.hide(); },
        onRestart: async () => { paused = false; attempt++; await startRace(); },
        onQuit: () => { paused = false; switchTo(MenuDirector()); },
        muted: audio.muted,
        onMute: () => { audio.setMuted(!audio.muted); return audio.muted; },
      });
    },
    pauseButton() { this.handleKey({ code: "Escape" }); },
  };
}

// ---- online: the original lobby + server-driven race, no items
function OnlineDirector() {
  let net = null;
  let race = null;
  let mySeat = -1;
  let seats = [];
  let serverPhase = "connecting";
  const everPosed = new Set();

  function seatsArray(list) {
    const arr = [];
    for (const s of list) arr[s.seat] = s;
    return arr;
  }

  const kartIds = {};
  async function syncKartModels() {
    for (let i = 0; i < 4; i++) {
      const s = seats[i];
      if (s && kartIds[i] !== s.kartId) { kartIds[i] = s.kartId; await scene.addKart(i, s.kartId); }
      else if (!s && scene.hasKart(i)) { delete kartIds[i]; scene.removeKart(i); }
    }
  }

  function makeOnlineRace(yourPose) {
    race = makeRace(deps, {
      track: defaultTrack, laps: LAPS, rng: mulberry32(1), items: false, countdown: "server",
      seats: mySeat >= 0 ? [{ seat: mySeat, kartId: seats[mySeat]?.kartId ?? "red", control: "player" }] : [],
      hooks: {
        sendPose: (pose) => net.send({ type: "pose", ...pose }),
        sendCp: (idx) => net.send({ type: "checkpoint", idx }),
        getRemotes: () => net.remotePoses(INTERP_DELAY, mySeat),
      },
      remoteRank: () => seats.filter((s) => s && s.seat !== mySeat)
        .map((s) => ({ seat: s.seat, p: s.lap * 10 + s.nextCp / CHECKPOINTS, done: s.finishedAt != null, fi: 0 })),
    });
    const me = race.playerKart;
    if (me && yourPose) {
      me.x = yourPose.p[0]; me.z = yourPose.p[2]; me.yaw = yourPose.yaw;
      me.lap = yourPose.lap ?? 1; me.nextCp = yourPose.nextCp ?? 1;
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "state": {
        serverPhase = msg.phase;
        mySeat = msg.you.seat;
        seats = seatsArray(msg.seats);
        syncKartModels();
        if (msg.phase === "lobby") {
          race = null;
          everPosed.clear();
          hud.show("lobby");
          hud.lobbyState(seats, mySeat, seats[mySeat]?.ready ?? false);
          hud.kartPicker(seats, mySeat, (id) => net.send({ type: "kart", kartId: id }));
        }
        if ((msg.phase === "countdown" || msg.phase === "racing") && !race) {
          hud.show("racing");
          hud.showRaceExtras(false, false);
          makeOnlineRace(msg.yourPose);
          race.setPhase(msg.phase === "racing" ? "racing" : "waiting");
        }
        if (mySeat < 0 && (msg.phase === "racing" || msg.phase === "countdown")) hud.toast(STR.spectating, 4000);
        break;
      }
      case "countdown":
        if (!race) { hud.show("racing"); makeOnlineRace(null); }
        hud.show("racing");
        race.showCountdown(msg.n);
        break;
      case "cp": {
        const s = seats[msg.seat];
        if (s) { s.lap = msg.lap; s.nextCp = msg.nextCp; }
        break;
      }
      case "finish":
        if (msg.seat === mySeat && race?.playerKart) {
          race.playerKart.done = true;
          hud.finishBanner(msg.place);
          audio.play("finish");
          audio.stopLoop("engine");
        }
        if (seats[msg.seat]) seats[msg.seat].finishedAt = msg.timeMs;
        break;
      case "results":
        serverPhase = "finished";
        hud.show("finished");
        hud.results(msg.order, seats, mySeat);
        hud.els.again.onclick = () => net.send({ type: "reset" });
        break;
      case "error":
        hud.toast(STR.errors[msg.code] ?? STR.errors.bad_action);
        break;
    }
  }

  return {
    async enter() {
      const invite = ensureRoom();
      hud.els.invite.value = invite;
      await scene.setTrack(defaultTrack, mulberry32(seedFrom(room)));
      hud.setTrack(defaultTrack);
      scene.removeAllKarts();
      hud.banner(STR.connecting);
      hud.show("lobby");
      hud.els.readyBtn.onclick = () => net.send({ type: "ready", ready: !(seats[mySeat]?.ready) });
      net = createNet(room, playerId, myName, {
        onOpen: () => hud.banner(""),
        onDisconnect: () => hud.banner(STR.reconnecting),
        onMessage: handleMessage,
      });
    },
    exit() {
      net?.close();
      hud.banner("");
      hud.show("none");
      audio.stopLoop("music");
      audio.stopLoop("engine");
    },
    simStep(dt) { race?.simStep(dt); },
    frame(dtSec, now) {
      if (race) {
        race.frame(dtSec, now, seats);
        // karts never seen in a snap sit on the grid (lobby -> countdown)
        const posed = new Set((net.remotePoses(INTERP_DELAY, mySeat) ?? []).map((r) => r.seat));
        posed.forEach((s) => everPosed.add(s));
        for (const s of seats) {
          if (!s || s.seat === mySeat || everPosed.has(s.seat)) continue;
          const g = defaultTrack.gridSlot(s.seat);
          scene.setKartPose(s.seat, g.x, g.z, g.yaw, {});
        }
      } else {
        for (const s of seats) {
          if (!s) continue;
          const g = defaultTrack.gridSlot(s.seat);
          scene.setKartPose(s.seat, g.x, g.z, g.yaw, {});
        }
        scene.overviewCamera(now / 1000);
      }
      scene.render();
    },
    handleKey(e) {
      if (e.code === "Escape") switchTo(MenuDirector());
    },
  };
}

// ---------------------------------------------------------------- boot + loop
let acc = 0, last = performance.now();
document.getElementById("pauseBtn").onclick = () => director?.pauseButton?.();
addEventListener("keydown", (e) => { if (e.code === "Escape") director?.handleKey(e); });
addEventListener("blur", () => (paused = true));
addEventListener("focus", () => { paused = false; last = performance.now(); });

await switchTo(arrivedViaInvite ? OnlineDirector() : MenuDirector());
let frames = 0, fpsAt = last, fps = 0;
const dev = new URLSearchParams(location.search).has("dev");
if (dev) hud.els.dev.style.display = "block";

function frame(now) {
  requestAnimationFrame(frame);
  acc += now - last;
  last = now;
  if (acc > 250) acc = 250;
  if (!paused) {
    while (acc >= STEP_MS) { director.simStep(STEP_MS / 1000); acc -= STEP_MS; }
  } else {
    acc = 0;
  }
  const dtSec = Math.min(0.05, (now - (frame._p ?? now)) / 1000) || 0.016;
  director.frame(dtSec, now);
  frame._p = now;

  if (dev) {
    frames++;
    if (now - fpsAt >= 500) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0; fpsAt = now;
      hud.dev(`${fps} fps | draws ${scene.drawCalls()} | mode ${director === null ? "?" : ""}${paused ? " paused" : ""}`);
    }
  }
}
requestAnimationFrame(frame);
