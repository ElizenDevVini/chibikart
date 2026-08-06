// All input methods reduce to one command object: {throttle, steer, drift}
const BIND = {
  KeyW: "up", ArrowUp: "up",
  KeyS: "down", ArrowDown: "down",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  Space: "drift", ShiftLeft: "drift", ShiftRight: "drift",
  KeyE: "item", Enter: "item",
};
const held = new Set();

addEventListener("keydown", (e) => {
  const c = BIND[e.code];
  if (c) { held.add(c); e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  const c = BIND[e.code];
  if (c) held.delete(c);
});
addEventListener("blur", () => held.clear());

// Touch: left half = horizontal steering strip, right half = brake + drift buttons.
// Throttle is auto-held on touch devices (gas pedal is implicit).
export const touchState = { active: false, steer: 0, brake: false, drift: false, item: false };
let steerTouchId = null;

function bindTouchButtons(brakeEl, driftEl) {
  const hold = (el, key) => {
    el.addEventListener("touchstart", (e) => { touchState[key] = true; touchState.active = true; e.preventDefault(); }, { passive: false });
    el.addEventListener("touchend", (e) => { touchState[key] = false; e.preventDefault(); }, { passive: false });
    el.addEventListener("touchcancel", () => { touchState[key] = false; });
  };
  hold(brakeEl, "brake");
  hold(driftEl, "drift");
}

function bindSteerZone(zoneEl) {
  const steerFrom = (t) => {
    const r = zoneEl.getBoundingClientRect();
    const x = (t.clientX - r.left) / r.width; // 0..1 within zone
    touchState.steer = Math.max(-1, Math.min(1, (x - 0.5) * 2.5));
  };
  zoneEl.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    steerTouchId = t.identifier;
    touchState.active = true;
    steerFrom(t);
    e.preventDefault();
  }, { passive: false });
  zoneEl.addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) if (t.identifier === steerTouchId) steerFrom(t);
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) if (t.identifier === steerTouchId) { steerTouchId = null; touchState.steer = 0; }
  };
  zoneEl.addEventListener("touchend", end);
  zoneEl.addEventListener("touchcancel", end);
}

export function initTouch(steerZone, brakeBtn, driftBtn, itemEl) {
  bindSteerZone(steerZone);
  bindTouchButtons(brakeBtn, driftBtn);
  if (itemEl) {
    itemEl.addEventListener("touchstart", (e) => { touchState.item = true; touchState.active = true; e.preventDefault(); }, { passive: false });
    itemEl.addEventListener("touchend", () => { touchState.item = false; });
  }
}

function gamepad() {
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp) continue;
    const stick = Math.abs(gp.axes[0]) > 0.15 ? gp.axes[0] : 0;
    const dpad = (gp.buttons[14]?.pressed ? -1 : 0) + (gp.buttons[15]?.pressed ? 1 : 0);
    const gas = gp.buttons[7]?.value || (gp.buttons[12]?.pressed ? 1 : 0);
    const brake = gp.buttons[6]?.value || (gp.buttons[13]?.pressed ? 1 : 0);
    const drift = gp.buttons[0]?.pressed || false;
    const item = gp.buttons[1]?.pressed || false;
    if (stick || dpad || gas || brake || drift || item) return { steer: stick || dpad, gas, brake, drift, item };
  }
  return null;
}

export function commands() {
  const gp = gamepad();
  if (gp) {
    return { throttle: gp.gas - gp.brake, steer: gp.steer, drift: gp.drift, item: gp.item };
  }
  if (touchState.active) {
    return {
      throttle: touchState.brake ? -1 : 1,
      steer: touchState.steer,
      drift: touchState.drift,
      item: touchState.item,
    };
  }
  return {
    throttle: (held.has("up") ? 1 : 0) - (held.has("down") ? 1 : 0),
    steer: (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0),
    drift: held.has("drift"),
    item: held.has("item"),
  };
}
