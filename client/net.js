// WebSocket plumbing: connect/reconnect, send queue, snapshot interpolation buffer.
export function createNet(room, playerId, name, handlers) {
  const base = location.pathname.replace(/\/(index\.html)?$/, "");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}${base}/ws/${room}`;

  let ws = null;
  let backoff = 500;
  let queue = [];
  let closedByUs = false;

  // snapshot ring buffer + server clock offset estimate
  const snaps = [];
  let clockOffset = null; // serverTime - performance.now()

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 500;
      send({ type: "join", playerId, name });
      for (const m of queue) ws.send(JSON.stringify(m));
      queue = [];
      handlers.onOpen?.();
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "snap") {
        const est = msg.t - performance.now();
        clockOffset = clockOffset === null ? est : clockOffset * 0.9 + est * 0.1;
        snaps.push(msg);
        if (snaps.length > 40) snaps.shift();
      }
      handlers.onMessage?.(msg);
    };
    ws.onclose = () => {
      if (closedByUs) return;
      handlers.onDisconnect?.();
      setTimeout(connect, backoff);
      backoff = Math.min(5000, backoff * 1.7);
    };
    ws.onerror = () => ws.close();
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else if (msg.type !== "pose") queue.push(msg); // poses are disposable
  }

  // Interpolated remote kart poses at renderTime = serverNow - delay
  function remotePoses(delayMs, mySeat) {
    if (snaps.length < 2 || clockOffset === null) return null;
    const target = performance.now() + clockOffset - delayMs;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 1; i--) {
      if (snaps[i - 1].t <= target && snaps[i].t >= target) { a = snaps[i - 1]; b = snaps[i]; break; }
    }
    if (!a) {
      const last = snaps[snaps.length - 1];
      if (target > last.t && target - last.t < 100) { a = snaps[snaps.length - 2]; b = last; } // extrapolate max 100ms
      else return null;
    }
    const span = b.t - a.t || 1;
    const f = Math.max(0, Math.min(1.5, (target - a.t) / span));
    const out = [];
    for (const kb of b.karts) {
      if (kb.seat === mySeat) continue;
      const ka = a.karts.find((k) => k.seat === kb.seat) ?? kb;
      let dyaw = kb.yaw - ka.yaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      out.push({
        seat: kb.seat,
        x: ka.p[0] + (kb.p[0] - ka.p[0]) * f,
        z: ka.p[2] + (kb.p[2] - ka.p[2]) * f,
        yaw: ka.yaw + dyaw * f,
        v: kb.v,
        fx: kb.fx,
      });
    }
    return out;
  }

  connect();
  return {
    send,
    remotePoses,
    snapAge: () => (snaps.length ? performance.now() + (clockOffset ?? 0) - snaps[snaps.length - 1].t : -1),
    close: () => { closedByUs = true; ws?.close(); },
  };
}
