import { STR } from "./strings.js";
import { defaultTrack, LAPS } from "./track.js";
import { KART_IDS } from "./scene.js";

const $ = (id) => document.getElementById(id);

export function createHud(inviteUrl = location.href) {
  const els = {
    lobby: $("lobby"), players: $("players"), invite: $("invite"), copyBtn: $("copy"),
    readyBtn: $("ready"), lobbyStatus: $("lobbyStatus"), kartPick: $("kartPick"),
    countdown: $("countdown"), race: $("race"), lap: $("lap"), pos: $("pos"), speed: $("speed"),
    wrongway: $("wrongway"), results: $("results"), resultRows: $("resultRows"), again: $("again"),
    toast: $("toast"), banner: $("banner"), minimap: $("minimap"), dev: $("dev"),
    touchUi: $("touchUi"), controlsHint: $("controlsHint"),
    itemSlot: $("itemSlot"), itemIcon: $("itemIcon"), pauseBtn: $("pauseBtn"),
  };

  els.invite.value = inviteUrl;
  els.copyBtn.textContent = STR.copy;
  els.readyBtn.textContent = STR.ready;
  els.again.textContent = STR.playAgain;
  els.controlsHint.textContent = STR.controls;
  $("lobbyTitle").textContent = STR.waitingRoom;
  $("inviteHint").textContent = STR.inviteHint;

  els.copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(inviteUrl); } catch { els.invite.select(); document.execCommand("copy"); }
    els.copyBtn.textContent = STR.copied;
    setTimeout(() => (els.copyBtn.textContent = STR.copy), 1200);
  };

  // minimap: static centerline redrawn per track, kart dots per frame
  const mm = els.minimap.getContext("2d");
  const MM = 140;
  const mmStatic = document.createElement("canvas");
  mmStatic.width = mmStatic.height = MM;
  let mmScale = 300;

  function drawStatic(track) {
    const g = mmStatic.getContext("2d");
    g.clearRect(0, 0, MM, MM);
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 5;
    g.lineCap = "round";
    g.beginPath();
    for (let i = 0; i <= 128; i++) {
      const p = track.curve.getPointAt(i / 128);
      const x = MM / 2 + (p.x / mmScale) * MM, y = MM / 2 + (p.z / mmScale) * MM;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  drawStatic(defaultTrack);

  const mmXY = (x, z) => [MM / 2 + (x / mmScale) * MM, MM / 2 + (z / mmScale) * MM];

  let toastTimer = 0;
  const ICONS = { donut: "./assets/icon_donut.png", shake: "./assets/icon_shake.png", turbo: "./assets/icon_turbo.png" };
  let rouletteTimer = null;

  return {
    els,

    setTrack(track) { drawStatic(track); },

    show(phase) {
      els.lobby.style.display = phase === "lobby" ? "flex" : "none";
      const inRace = phase === "racing" || phase === "countdown";
      els.race.style.display = inRace ? "block" : "none";
      els.minimap.style.display = inRace ? "block" : "none";
      els.results.style.display = phase === "finished" ? "flex" : "none";
      if (phase !== "countdown") els.countdown.style.display = "none";
      if (!inRace) { els.itemSlot.style.display = "none"; els.pauseBtn.style.display = "none"; }
      els.controlsHint.style.display = inRace || phase === "lobby" ? "block" : "none";
    },

    showRaceExtras(itemsOn, pauseOn) {
      els.itemSlot.style.display = itemsOn ? "flex" : "none";
      els.pauseBtn.style.display = pauseOn ? "block" : "none";
    },

    lobbyState(seats, mySeat, myReady) {
      els.players.innerHTML = "";
      let seated = 0;
      for (const s of seats) {
        if (!s) continue;
        seated++;
        const row = document.createElement("div");
        row.className = "prow" + (s.seat === mySeat ? " me" : "");
        row.innerHTML = `<span class="dot ${s.kartId}"></span><span>${s.name}${s.seat === mySeat ? " (" + STR.youAre + " " + STR.kartNames[s.kartId] + ")" : ""}</span><span class="rdy">${s.ready ? STR.ready : STR.unready}</span>`;
        els.players.appendChild(row);
      }
      els.readyBtn.classList.toggle("on", myReady);
      els.lobbyStatus.textContent = seated < 2 ? STR.waitingForPlayers : STR.waitingForReady;
    },

    kartPicker(seats, mySeat, onPick) {
      els.kartPick.innerHTML = "";
      const taken = new Set(seats.filter((s) => s && s.seat !== mySeat).map((s) => s.kartId));
      for (const id of KART_IDS) {
        const b = document.createElement("button");
        b.className = `kbtn ${id}` + (taken.has(id) ? " taken" : "");
        b.disabled = taken.has(id);
        const mine = seats.find((s) => s && s.seat === mySeat);
        if (mine?.kartId === id) b.classList.add("sel");
        b.onclick = () => onPick(id);
        els.kartPick.appendChild(b);
      }
    },

    countdown(n) {
      els.countdown.style.display = "block";
      els.countdown.textContent = n === 0 ? STR.go : n;
      els.countdown.classList.remove("pop");
      void els.countdown.offsetWidth;
      els.countdown.classList.add("pop");
      if (n === 0) setTimeout(() => (els.countdown.style.display = "none"), 900);
    },

    race(lap, place, speed, wrongWay) {
      els.lap.textContent = `${STR.lap} ${Math.min(lap, LAPS)}/${LAPS}`;
      els.pos.textContent = STR.place[place] ?? "";
      els.speed.textContent = `${Math.round(speed * 3.4)}`;
      els.wrongway.style.display = wrongWay ? "block" : "none";
      if (wrongWay) els.wrongway.textContent = STR.wrongWay;
    },

    placeFlash() {
      els.pos.classList.remove("flash");
      void els.pos.offsetWidth;
      els.pos.classList.add("flash");
    },

    itemSlot(slot) {
      if (slot.rolling) {
        if (!rouletteTimer) {
          const keys = Object.keys(ICONS);
          let i = 0;
          rouletteTimer = setInterval(() => {
            els.itemIcon.src = ICONS[keys[i++ % keys.length]];
          }, 60);
        }
        els.itemIcon.style.display = "block";
        return;
      }
      if (rouletteTimer) { clearInterval(rouletteTimer); rouletteTimer = null; }
      if (slot.held) {
        els.itemIcon.src = ICONS[slot.held];
        els.itemIcon.style.display = "block";
      } else {
        els.itemIcon.style.display = "none";
      }
    },

    finalLap() {
      els.banner.textContent = STR.finalLap;
      els.banner.style.display = "block";
      setTimeout(() => (els.banner.style.display = "none"), 2200);
    },

    minimap(karts, mySeat) {
      mm.clearRect(0, 0, MM, MM);
      mm.drawImage(mmStatic, 0, 0);
      for (const k of karts) {
        const [x, y] = mmXY(k.x, k.z);
        mm.fillStyle = k.color;
        mm.beginPath();
        mm.arc(x, y, k.seat === mySeat ? 5 : 3.5, 0, Math.PI * 2);
        mm.fill();
        if (k.seat === mySeat) { mm.strokeStyle = "#fff"; mm.lineWidth = 2; mm.stroke(); }
      }
    },

    results(order, seats, mySeat) {
      els.resultRows.innerHTML = "";
      $("resultsTitle").textContent = STR.results;
      order.forEach((r, i) => {
        const s = seats[r.seat];
        const row = document.createElement("div");
        row.className = "prow" + (r.seat === mySeat ? " me" : "");
        const t = r.timeMs != null ? `${(r.timeMs / 1000).toFixed(2)}s` : "-";
        row.innerHTML = `<b>${STR.place[i]}</b><span class="dot ${s?.kartId ?? "red"}"></span><span>${s?.name ?? "?"}</span><span class="rdy">${t}</span>`;
        els.resultRows.appendChild(row);
      });
    },

    banner(text) {
      els.banner.textContent = text;
      els.banner.style.display = text ? "block" : "none";
    },

    toast(text, ms = 2500) {
      els.toast.textContent = text;
      els.toast.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (els.toast.style.display = "none"), ms);
    },

    finishBanner(place) {
      els.banner.textContent = `${STR.place[place]}`;
      els.banner.style.display = "block";
      setTimeout(() => (els.banner.style.display = "none"), 2500);
    },

    dev(text) { els.dev.textContent = text; },
    showTouch(show) { els.touchUi.style.display = show ? "block" : "none"; },
  };
}
