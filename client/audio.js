// Audio with graceful degradation: missing generated assets log once and stay silent.
const files = {
  music: "./assets/music_loop.m4a",
  engine: "./assets/sfx_engine.mp3",
  drift: "./assets/sfx_drift.mp3",
  boost: "./assets/sfx_boost.mp3",
  countdown: "./assets/sfx_countdown.mp3",
  finish: "./assets/sfx_finish.mp3",
  item_pickup: "./assets/sfx_item_pickup.mp3",
  item_throw: "./assets/sfx_item_throw.mp3",
  spin: "./assets/sfx_spin.mp3",
  final_lap: "./assets/sfx_final_lap.mp3",
};

const clips = {};
let unlocked = false;

for (const [k, url] of Object.entries(files)) {
  const a = new Audio();
  a.src = url;
  a.preload = "auto";
  a.onerror = () => { clips[k] = null; console.warn(`audio missing, staying silent: ${url}`); };
  clips[k] = a;
}
if (clips.music) { clips.music.loop = true; clips.music.volume = 0.35; }
if (clips.engine) { clips.engine.loop = true; clips.engine.volume = 0.25; }
for (const k of ["drift", "boost", "countdown", "finish", "item_pickup", "item_throw", "spin", "final_lap"]) if (clips[k]) clips[k].volume = 0.8;

let muted = false;

// browsers require a user gesture before playback
function unlock() {
  unlocked = true;
  removeEventListener("pointerdown", unlock);
  removeEventListener("keydown", unlock);
}
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);

export const audio = {
  get muted() { return muted; },
  setMuted(m) {
    muted = m;
    if (m) for (const c of Object.values(clips)) c && !c.paused && c.pause();
  },
  play(name) {
    const c = clips[name];
    if (!c || !unlocked || muted) return;
    c.currentTime = 0;
    c.play().catch(() => {});
  },
  startLoop(name) {
    const c = clips[name];
    if (!c || !unlocked || muted || !c.paused) return;
    c.play().catch(() => {});
  },
  stopLoop(name) {
    const c = clips[name];
    if (c && !c.paused) c.pause();
  },
  enginePitch(speedFrac) {
    const c = clips.engine;
    if (c) c.playbackRate = 0.7 + speedFrac * 0.9;
  },
  // loops can't start before the first user gesture; retry once racing
  ensureLoops(racing) {
    if (!racing || !unlocked) return;
    this.startLoop("music");
    this.startLoop("engine");
  },
};
