import { DurableObject } from "cloudflare:workers";

const CHECKPOINTS = 12;
const LAPS = 3;
const MAX_SEATS = 4;
const MIN_PLAYERS = 2;
const SNAP_MS = Math.round(1000 / 15);
const CP_MIN_INTERVAL = 1200;
const SPEED_CAP = 45;
const POSE_JUMP_LIMIT = 60;
const FINISH_GRACE = 30000;
const EMPTY_RESET = 60000;
const KART_IDS = ["red", "blue", "green", "yellow"];

// One instance per room (shard path <base>/ws/<room>). The server never simulates
// kart physics: clients own their kart, this class referees the race and relays poses.
export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.phase = "lobby"; // lobby | countdown | racing | finished
    this.seats = new Array(MAX_SEATS).fill(null);
    this.spectators = new Set();
    this.raceStartAt = 0;
    this.countdownTimer = null;
    this.snapTimer = null;
    this.graceTimer = null;
    this.emptyTimer = null;
  }

  fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("chibikart room", { status: 200 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      try { this.onMessage(server, msg); } catch (err) {
        this.sendTo(server, { type: "error", code: "bad_action" });
      }
    });
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- helpers ----
  seatOf(ws) {
    return this.seats.find((s) => s && s.ws === ws) ?? null;
  }
  seatByPlayer(playerId) {
    return this.seats.find((s) => s && s.playerId === playerId) ?? null;
  }
  allSockets() {
    const out = [];
    for (const s of this.seats) if (s?.ws) out.push(s.ws);
    for (const ws of this.spectators) out.push(ws);
    return out;
  }
  sendTo(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const ws of this.allSockets()) { try { ws.send(str); } catch {} }
  }
  publicSeats() {
    const out = [];
    for (const s of this.seats) {
      if (!s) continue;
      out.push({
        seat: s.seat, name: s.name, kartId: s.kartId, ready: s.ready,
        connected: !!s.ws, lap: s.lap, nextCp: s.nextCp,
        finishedAt: s.finishedAt,
      });
    }
    return out;
  }
  stateFor(ws) {
    const seat = this.seatOf(ws);
    const msg = {
      type: "state",
      phase: this.phase,
      you: { seat: seat ? seat.seat : -1, playerId: seat?.playerId ?? null },
      seats: this.publicSeats(),
      raceTimeMs: this.phase === "racing" ? Date.now() - this.raceStartAt : 0,
    };
    if (seat && seat.pose && (this.phase === "racing" || this.phase === "countdown")) {
      msg.yourPose = { p: seat.pose.p, yaw: seat.pose.yaw, lap: seat.lap, nextCp: seat.nextCp };
    }
    return msg;
  }
  broadcastState() {
    for (const ws of this.allSockets()) this.sendTo(ws, this.stateFor(ws));
  }
  stopTimers() {
    for (const t of ["countdownTimer", "snapTimer", "graceTimer"]) {
      if (this[t]) { clearInterval(this[t]); clearTimeout(this[t]); this[t] = null; }
    }
  }

  // ---- message routing ----
  onMessage(ws, msg) {
    switch (msg.type) {
      case "join": return this.onJoin(ws, msg);
      case "ready": return this.onReady(ws, msg);
      case "kart": return this.onKart(ws, msg);
      case "pose": return this.onPose(ws, msg);
      case "checkpoint": return this.onCheckpoint(ws, msg);
      case "reset": return this.onReset(ws);
    }
  }

  onJoin(ws, msg) {
    if (typeof msg.playerId !== "string" || msg.playerId.length > 64) return;
    if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }

    const existing = this.seatByPlayer(msg.playerId);
    if (existing) {
      // reconnect: reclaim the seat, drop any stale socket
      if (existing.ws && existing.ws !== ws) { try { existing.ws.close(); } catch {} }
      this.spectators.delete(ws);
      existing.ws = ws;
      this.sendTo(ws, this.stateFor(ws));
      this.broadcastState();
      return;
    }

    if (this.phase === "lobby") {
      const free = this.seats.findIndex((s) => s === null);
      if (free !== -1) {
        const taken = new Set(this.seats.filter(Boolean).map((s) => s.kartId));
        const kartId = KART_IDS.find((k) => !taken.has(k)) ?? KART_IDS[free];
        this.seats[free] = {
          seat: free, playerId: msg.playerId,
          name: String(msg.name ?? "racer").slice(0, 24),
          kartId, ready: false, ws,
          pose: null, lastPoseAt: 0, lap: 1, nextCp: 1, lastCpAt: 0,
          finishedAt: null, place: null, done: false,
        };
        this.broadcastState();
        return;
      }
    }
    // full room or mid-race: spectator
    this.spectators.add(ws);
    this.sendTo(ws, { type: "error", code: "room_full" });
    this.sendTo(ws, this.stateFor(ws));
  }

  onReady(ws, msg) {
    if (this.phase !== "lobby") return;
    const seat = this.seatOf(ws);
    if (!seat) return;
    seat.ready = !!msg.ready;
    this.broadcastState();
    const seated = this.seats.filter(Boolean);
    if (seated.length >= MIN_PLAYERS && seated.every((s) => s.ready && s.ws)) {
      this.startCountdown();
    }
  }

  onKart(ws, msg) {
    if (this.phase !== "lobby") return;
    const seat = this.seatOf(ws);
    if (!seat || !KART_IDS.includes(msg.kartId)) return;
    const taken = this.seats.some((s) => s && s !== seat && s.kartId === msg.kartId);
    if (!taken) { seat.kartId = msg.kartId; this.broadcastState(); }
  }

  startCountdown() {
    this.phase = "countdown";
    for (const s of this.seats) {
      if (!s) continue;
      s.lap = 1; s.nextCp = 1; s.lastCpAt = 0; s.finishedAt = null; s.place = null;
      s.done = false; s.pose = null;
    }
    this.broadcastState();
    let n = 3;
    this.broadcast({ type: "countdown", n });
    this.countdownTimer = setInterval(() => {
      n--;
      this.broadcast({ type: "countdown", n });
      if (n <= 0) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.phase = "racing";
        this.raceStartAt = Date.now();
        this.snapTimer = setInterval(() => this.snap(), SNAP_MS);
      }
    }, 1000);
  }

  snap() {
    const karts = [];
    for (const s of this.seats) {
      if (s?.pose) karts.push({ seat: s.seat, p: s.pose.p, yaw: s.pose.yaw, v: s.pose.v, fx: s.pose.fx });
    }
    if (karts.length) this.broadcast({ type: "snap", t: Date.now(), karts });
  }

  onPose(ws, msg) {
    if (this.phase !== "racing") return;
    const seat = this.seatOf(ws);
    if (!seat) return;
    if (!Array.isArray(msg.p) || msg.p.length !== 3) return;
    const v = Math.min(Math.abs(Number(msg.v) || 0), SPEED_CAP);
    const now = Date.now();
    if (seat.pose && now - seat.lastPoseAt < 2000) {
      const dx = msg.p[0] - seat.pose.p[0], dz = msg.p[2] - seat.pose.p[2];
      if (dx * dx + dz * dz > POSE_JUMP_LIMIT * POSE_JUMP_LIMIT) return; // implausible jump
    }
    seat.pose = { p: msg.p.map((n) => Number(n) || 0), yaw: Number(msg.yaw) || 0, v, fx: Number(msg.fx) | 0 };
    seat.lastPoseAt = now;
  }

  onCheckpoint(ws, msg) {
    if (this.phase !== "racing") return;
    const seat = this.seatOf(ws);
    if (!seat || seat.done) return;
    const idx = Number(msg.idx);
    const now = Date.now();
    if (idx !== seat.nextCp) return;
    if (now - seat.lastCpAt < CP_MIN_INTERVAL) return;
    seat.lastCpAt = now;
    seat.nextCp = (idx + 1) % CHECKPOINTS;
    if (idx === 0) {
      seat.lap++;
      if (seat.lap > LAPS) {
        seat.done = true;
        seat.finishedAt = now - this.raceStartAt;
        seat.place = this.seats.filter((s) => s?.done).length - 1;
        this.broadcast({ type: "finish", seat: seat.seat, timeMs: seat.finishedAt, place: seat.place });
        const racing = this.seats.filter((s) => s && !s.done);
        if (racing.length === 0) this.finishRace();
        else if (!this.graceTimer) this.graceTimer = setTimeout(() => this.finishRace(), FINISH_GRACE);
        return;
      }
    }
    this.broadcast({ type: "cp", seat: seat.seat, idx, lap: seat.lap, nextCp: seat.nextCp });
  }

  finishRace() {
    if (this.phase !== "racing") return;
    this.stopTimers();
    this.phase = "finished";
    const done = this.seats.filter((s) => s?.done).sort((a, b) => a.finishedAt - b.finishedAt);
    const rest = this.seats.filter((s) => s && !s.done)
      .sort((a, b) => b.lap * 100 + b.nextCp - (a.lap * 100 + a.nextCp));
    const order = [...done.map((s) => ({ seat: s.seat, timeMs: s.finishedAt })),
                   ...rest.map((s) => ({ seat: s.seat, timeMs: null }))];
    this.broadcast({ type: "results", order });
    this.broadcastState();
  }

  onReset(ws) {
    if (this.phase !== "finished") return;
    if (!this.seatOf(ws)) return;
    this.toLobby();
  }

  toLobby() {
    this.stopTimers();
    this.phase = "lobby";
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = this.seats[i];
      if (!s) continue;
      if (!s.ws) { this.seats[i] = null; continue; } // free disconnected seats
      s.ready = false; s.lap = 1; s.nextCp = 1; s.lastCpAt = 0;
      s.finishedAt = null; s.place = null; s.done = false; s.pose = null;
    }
    this.broadcastState();
  }

  onClose(ws) {
    this.spectators.delete(ws);
    const seat = this.seatOf(ws);
    if (seat) {
      seat.ws = null;
      if (this.phase === "lobby") {
        this.seats[seat.seat] = null; // seats only survive disconnects mid-race
      }
      this.broadcastState();
    }
    if (this.allSockets().length === 0 && !this.emptyTimer) {
      this.emptyTimer = setTimeout(() => { this.emptyTimer = null; this.toLobby(); }, EMPTY_RESET);
    }
  }
}
