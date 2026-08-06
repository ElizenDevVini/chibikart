import { STR } from "./strings.js";
import { KART_IDS } from "./scene.js";

// All non-race screens: one overlay root, plain DOM, reuses index.html CSS classes.
export function createMenu() {
  const root = document.getElementById("menuRoot");

  function screen(html) {
    root.innerHTML = html;
    root.style.display = "flex";
    return root;
  }
  function hide() {
    root.style.display = "none";
    root.innerHTML = "";
  }

  return {
    hide,

    title({ onGrandPrix, onSingleRace, onOnline }) {
      screen(`
        <div class="titleWrap">
          <h1 class="logo">chibikart</h1>
          <p class="tagline">${STR.tagline}</p>
          <div class="menuBtns">
            <button id="mGp" class="big">${STR.menuGrandPrix}</button>
            <button id="mSr">${STR.menuSingleRace}</button>
            <button id="mOn">${STR.menuOnline}</button>
          </div>
        </div>`);
      root.querySelector("#mGp").onclick = onGrandPrix;
      root.querySelector("#mSr").onclick = onSingleRace;
      root.querySelector("#mOn").onclick = onOnline;
    },

    kartSelect(onPick) {
      const s = screen(`
        <div class="card">
          <h1>${STR.pickKart}</h1>
          <div id="mKarts" class="kartGrid"></div>
        </div>`);
      const grid = s.querySelector("#mKarts");
      for (const id of KART_IDS) {
        const b = document.createElement("button");
        b.className = `kbtn ${id}`;
        b.style.width = b.style.height = "64px";
        b.onclick = () => onPick(id);
        grid.appendChild(b);
      }
    },

    pause({ onResume, onRestart, onQuit, muted, onMute }) {
      const s = screen(`
        <div class="card">
          <h1>${STR.paused}</h1>
          <div class="menuBtns">
            <button id="mRes" class="big">${STR.resume}</button>
            <button id="mRst">${STR.restart}</button>
            <button id="mMute">${STR.mute}: ${muted ? "off" : "on"}</button>
            <button id="mQuit">${STR.quit}</button>
          </div>
        </div>`);
      s.querySelector("#mRes").onclick = onResume;
      s.querySelector("#mRst").onclick = onRestart;
      s.querySelector("#mQuit").onclick = onQuit;
      s.querySelector("#mMute").onclick = () => {
        const nowMuted = onMute();
        s.querySelector("#mMute").textContent = `${STR.mute}: ${nowMuted ? "off" : "on"}`;
      };
    },

    raceResults({ raceIndex, total, trackName, order, seatsMeta, points, playerSeat, onNext }) {
      const rows = order.map((r, i) => {
        const m = seatsMeta[r.seat];
        const t = r.timeMs != null ? `${(r.timeMs / 1000).toFixed(2)}s` : "-";
        return `<div class="prow ${r.seat === playerSeat ? "me" : ""}">
          <b>${STR.place[i]}</b><span class="dot ${m.kartId}"></span><span>${m.name}</span>
          <span class="rdy">${t} · ${points[r.seat]} ${STR.points}</span></div>`;
      }).join("");
      const s = screen(`
        <div class="card">
          <h1>${STR.raceN} ${raceIndex + 1}/${total} — ${STR.trackNames[trackName] ?? ""}</h1>
          <div>${rows}</div>
          <button id="mNext" class="big" style="margin-top:12px">${raceIndex + 1 < total ? STR.next : STR.results}</button>
        </div>`);
      s.querySelector("#mNext").onclick = onNext;
    },

    podium({ standings, seatsMeta, playerSeat, onDone }) {
      const rows = standings.map((st, i) => {
        const m = seatsMeta[st.seat];
        return `<div class="prow ${st.seat === playerSeat ? "me" : ""}">
          <b>${i + 1}.</b><span class="dot ${m.kartId}"></span><span>${m.name}</span>
          <span class="rdy">${st.points} ${STR.points}</span></div>`;
      }).join("");
      const champ = seatsMeta[standings[0].seat];
      const s = screen(`
        <div class="card podiumCard">
          <h1>${STR.champion}: ${champ.name}</h1>
          <div>${rows}</div>
          <button id="mDone" class="big" style="margin-top:12px">${STR.quit}</button>
        </div>`);
      s.querySelector("#mDone").onclick = onDone;
    },
  };
}
