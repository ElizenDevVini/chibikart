// Live netcode gate test against the deployed room server.
// Usage: node tools/nettest.js wss://<host>/ws/<room>
import * as THREE from "three";
import { sample, CHECKPOINTS } from "../client/track.js";

const URL = process.argv[2];
if (!URL) { console.error("usage: node tools/nettest.js wss://host/ws/room"); process.exit(2); }

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok" : "FAIL"} - ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(playerId, name) {
  const c = {
    playerId, name, ws: null, msgs: [], state: null, phase: null, seat: -1,
    countdowns: [], snaps: 0, cps: [], finishes: [], results: null, errors: [],
    open: false,
  };
  c.connect = () => new Promise((resolve) => {
    c.ws = new WebSocket(URL);
    c.ws.onopen = () => { c.open = true; c.send({ type: "join", playerId, name }); resolve(); };
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      c.msgs.push(m);
      if (m.type === "state") { c.state = m; c.phase = m.phase; c.seat = m.you.seat; }
      if (m.type === "countdown") { c.countdowns.push(m.n); if (m.n === 0) c.phase = "racing"; }
      if (m.type === "snap") c.snaps++;
      if (m.type === "cp") c.cps.push(m);
      if (m.type === "finish") c.finishes.push(m);
      if (m.type === "results") { c.results = m; c.phase = "finished"; }
      if (m.type === "error") c.errors.push(m.code);
    };
    c.ws.onclose = () => { c.open = false; };
  });
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.close = () => c.ws.close();
  return c;
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  console.log(`FAIL - timeout waiting for ${what}`);
  failures++;
  return false;
}

// Drives the spline at real pace, sending poses at 15 Hz and checkpoints in order.
function startDriver(c, opts = {}) {
  const state = { t: 0.012, nextCp: 1, lap: 1, done: false, stopped: false, timer: null };
  const SPEED_T = 1 / 18 / 15; // full lap every ~18s at 15Hz ticks (gates ~1.5s apart)
  state.timer = setInterval(() => {
    if (state.stopped || state.done) return;
    state.t = (state.t + SPEED_T) % 1;
    const { pos, tan } = sample(state.t);
    c.send({ type: "pose", p: [pos.x, 0, pos.z], yaw: Math.atan2(tan.x, tan.z), v: 25, fx: 0 });
    const gate = state.nextCp / CHECKPOINTS;
    const before = ((state.t - SPEED_T - gate) % 1 + 1) % 1;
    const after = ((state.t - gate) % 1 + 1) % 1;
    if (before > 0.85 && after < 0.15) {
      c.send({ type: "checkpoint", idx: state.nextCp });
      if (state.nextCp === 0) {
        state.lap++;
        if (state.lap > 3) state.done = true;
      }
      state.nextCp = (state.nextCp + 1) % CHECKPOINTS;
    }
  }, 1000 / 15);
  return state;
}

const A = client("net-a", "alpha");
const B = client("net-b", "bravo");

console.log("== lobby ==");
await A.connect();
await waitFor(() => A.seat === 0, 5000, "A seated");
await B.connect();
await waitFor(() => B.seat === 1, 5000, "B seated");
ok(A.seat === 0 && B.seat === 1, `seats assigned (A=${A.seat}, B=${B.seat})`);

A.send({ type: "kart", kartId: "yellow" });
await waitFor(() => A.state?.seats.find((s) => s.seat === 0)?.kartId === "yellow", 3000, "kart pick");
ok(A.state.seats.find((s) => s.seat === 0).kartId === "yellow", "kart selection propagates");

console.log("== countdown ==");
A.send({ type: "ready", ready: true });
B.send({ type: "ready", ready: true });
await waitFor(() => A.countdowns.includes(0) && B.countdowns.includes(0), 8000, "countdown to GO");
ok(A.countdowns.join(",").includes("3") && A.countdowns.includes(0), `countdown sequence ${A.countdowns.join(",")}`);

console.log("== racing (3 laps each, ~55s) ==");
const drvA = startDriver(A);
const drvB = startDriver(B);

// out-of-order checkpoint must be rejected: B claims gate 7 while expecting a low gate
await sleep(2000);
const cpCountBefore = A.cps.filter((m) => m.seat === 1).length;
B.send({ type: "checkpoint", idx: 7 });
await sleep(1000);
const cheated = A.cps.filter((m) => m.seat === 1).some((m) => m.idx === 7);
ok(!cheated, "out-of-order checkpoint rejected by referee");

// snaps flow at ~15Hz with both karts
await sleep(2000);
const snapsAt = A.snaps;
await sleep(2000);
const rate = (A.snaps - snapsAt) / 2;
ok(rate > 10 && rate < 20, `snap rate ~15Hz (got ${rate.toFixed(1)}/s)`);
const lastSnap = A.msgs.filter((m) => m.type === "snap").pop();
ok(lastSnap.karts.length === 2, "snapshots carry both karts");

// mid-race reconnect: A drops and rejoins with the same playerId
console.log("== mid-race reconnect ==");
drvA.stopped = true;
A.close();
await sleep(1500);
await A.connect();
const got = await waitFor(() => A.state?.yourPose && A.seat === 0, 6000, "A rejoined with pose");
if (got) {
  ok(A.seat === 0, "reconnect reclaims seat 0");
  ok(Array.isArray(A.state.yourPose.p), `yourPose restored (lap ${A.state.yourPose.lap}, nextCp ${A.state.yourPose.nextCp})`);
  // resume driving from restored progress
  drvA.stopped = false;
  drvA.nextCp = A.state.yourPose.nextCp;
  drvA.lap = A.state.yourPose.lap;
}

// spectator: third connection mid-race gets no seat
const C = client("net-c", "charlie");
await C.connect();
await waitFor(() => C.state, 5000, "spectator state");
ok(C.seat === -1, "mid-race joiner is a spectator");
ok(C.errors.includes("room_full"), "spectator informed via error code");

console.log("== finish ==");
await waitFor(() => A.results || B.results, 120000, "race results");
clearInterval(drvA.timer);
clearInterval(drvB.timer);
const res = A.results ?? B.results;
ok(!!res, "results broadcast");
ok(res.order.length === 2, `results rank both racers: ${JSON.stringify(res.order)}`);
ok(A.finishes.length >= 1, "finish events broadcast");
ok(C.results != null, "spectator saw the results too");

console.log("== reset loop ==");
A.send({ type: "reset" });
await waitFor(() => A.phase === "lobby" && B.phase === "lobby", 5000, "back to lobby");
ok(A.phase === "lobby", "play-again returns room to lobby");
ok(A.state.seats.length === 2, "both seats survive the reset");
ok(A.state.seats.every((s) => !s.ready), "ready flags cleared");

A.close(); B.close(); C.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
