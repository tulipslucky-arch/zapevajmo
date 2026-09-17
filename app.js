"use strict";
/* ===== ZAPEVAJMO — UI i logika toka aplikacije ===== */

const $ = id => document.getElementById(id);
const CFG = window.ZAPEVAJMO_CONFIG;

/* ---- ekrani ---- */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
}

/* ---- toast poruke ---- */
let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

/* ---- plutajuće note u pozadini ---- */
const NOTE_CHARS = ["♪", "♫", "🎵", "🎶", "♬"];
function spawnNote() {
  const bg = $("notes-bg");
  if (bg.childElementCount > 14) return;
  const n = document.createElement("span");
  n.className = "note";
  n.textContent = NOTE_CHARS[Math.floor(Math.random() * NOTE_CHARS.length)];
  n.style.left = (Math.random() * 90 + 3) + "vw";
  n.style.fontSize = (16 + Math.random() * 26) + "px";
  n.style.animationDuration = (7 + Math.random() * 6) + "s";
  n.style.setProperty("--rot", (Math.random() * 80 - 40).toFixed(0) + "deg");
  n.style.color = "hsl(" + (Math.random() * 360).toFixed(0) + " 90% 72%)";
  bg.appendChild(n);
  setTimeout(() => n.remove(), 14000);
}
setInterval(spawnNote, 800);

/* ==== START → SLUŠANJE → PREPOZNAVANJE ==== */
let listening = false;

$("btn-start").addEventListener("click", startListening);
$("btn-cancel").addEventListener("click", () => {
  if (window.__zapCancel) window.__zapCancel();
  listening = false;
  showScreen("screen-start");
});

async function startListening() {
  $("start-error").textContent = "";
  listening = true;
  showScreen("screen-listening");
  $("listen-status").textContent = "Slušam… 🎧";

  let wav = null;
  try {
    wav = await recordAndBuildWav(CFG.recordSeconds, left => {
      $("countdown").textContent = left;
    });
  } catch (e) {
    listening = false;
    showScreen("screen-start");
    $("start-error").textContent =
      "Mikrofon nije dostupan 🙈\n(" + e.name + ": " + e.message + ")";
    return;
  }
  if (!listening || !wav) return; /* prekinuto */

  $("listen-status").textContent = "Prepoznajem pesmu… 🧠";
  try {
    const song = await identifySong(wav);
    if (!listening) return;
    if (song) {
      toast("🎶 " + song.artist + " — " + song.title);
      await openLyrics(song.title, song.artist, song.durationMs);
    } else {
      toast("Nisam prepoznao pesmu 🤔\nUkucaj izvođača i naziv…");
      showScreen("screen-manual");
      $("in-artist").focus();
    }
  } catch (e) {
    if (!listening) return;
    toast("Greška u komunikaciji ❌\n" + e.message);
    showScreen("screen-start");
  }
  listening = false;
}
/* ==== KARAOKE EKRAN ==== */
let lines = [], ticker = null, t0 = 0, offsetMs = 0, durS = 0, plainMode = false, curIdx = -1;

async function openLyrics(title, artist, durationMs) {
  showScreen("screen-lyrics");
  $("song-title").textContent = title;
  $("song-artist").textContent = artist;
  $("lyrics-box").innerHTML = '<div class="notice">Tražim tekst… 📖</div>';
  $("sync-controls").style.display = "none";
  $("progress-fill").style.width = "0";

  const item = await findLyrics(title, artist, durationMs);
  durS = durationMs / 1000;

  if (!item) {
    $("lyrics-box").innerHTML =
      '<div class="notice">Nisam našao tekst za „' + title + '” 😢<br>' +
      'Probaj ručno → ✍️ (proveri pravopis)</div>';
    return;
  }
  if (item.instrumental) {
    $("lyrics-box").innerHTML = '<div class="notice">🎵 Ovo je instrumental — nema teksta, samo uživaj!</div>';
    return;
  }

  const key = "zap-offset|" + artist.toLowerCase() + "|" + title.toLowerCase();
  offsetMs = +(localStorage.getItem(key) || 0);
  $("offset-label").textContent = (offsetMs / 1000).toFixed(1) + "s";
  $("sync-controls").style.display = "flex";

  if (item.syncedLyrics) {
    plainMode = false;
    lines = parseLrc(item.syncedLyrics);
    const box = $("lyrics-box");
    box.innerHTML = "";
    lines.forEach((l, i) => {
      const d = document.createElement("div");
      d.className = "line";
      d.textContent = l.text;
      d.dataset.i = i;
      box.appendChild(d);
    });
    curIdx = -1;
    startTicker();
  } else {
    plainMode = true;
    stopTicker();
    const box = $("lyrics-box");
    box.innerHTML = '<div class="notice">Nema sinhronizacije — prikazujem običan tekst 👇</div>';
    const p = document.createElement("div");
    p.className = "plain";
    p.textContent = item.plainLyrics || "(prazno)";
    box.appendChild(p);
  }
}

function startTicker() {
  stopTicker();
  t0 = performance.now();
  curIdx = -1;
  ticker = setInterval(tick, 100);
  tick();
}
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

function tick() {
  const pos = (performance.now() - t0) / 1000 + offsetMs / 1000;
  $("progress-fill").style.width =
    (durS ? Math.min(100, pos / durS * 100) : 0) + "%";

  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].t <= pos) idx = i;
  if (idx === curIdx) return;
  curIdx = idx;

  document.querySelectorAll("#lyrics-box .line").forEach(el => {
    const i = +el.dataset.i;
    el.classList.toggle("active", i === idx);
    el.classList.toggle("past", i < idx);
  });
  const el = document.querySelector('#lyrics-box .line[data-i="' + idx + '"]');
  if (el) {
    const box = $("lyrics-box");
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: target, behavior: "smooth" });
  }
}

/* sinhr dugmad (±0.5s) */
$("btn-back500").addEventListener("click", () => shiftOffset(-500));
$("btn-fwd500").addEventListener("click", () => shiftOffset(500));
function shiftOffset(d) {
  offsetMs += d;
  const key = "zap-offset|" + $("song-artist").textContent.toLowerCase() + "|" +
              $("song-title").textContent.toLowerCase();
  localStorage.setItem(key, String(offsetMs));
  $("offset-label").textContent = (offsetMs / 1000).toFixed(1) + "s";
  if (plainMode) return;
  tick();
}

/* ponovi od početka */
$("btn-replay").addEventListener("click", () => {
  if (!plainMode && lines.length) startTicker();
  toast("⏱️ Sinhro ponovo ide od 0 — podesi dugmad ako kasni/dostiže");
});

/* ==== RUČNA PRETRAGA ==== */
$("btn-manual").addEventListener("click", () => {
  $("manual-error").textContent = "";
  showScreen("screen-manual");
});
$("btn-home1").addEventListener("click", () => { stopTicker(); showScreen("screen-start"); });
$("btn-home2").addEventListener("click", () => showScreen("screen-start"));

$("btn-search").addEventListener("click", manualSearch);
$("in-title").addEventListener("keydown", e => { if (e.key === "Enter") manualSearch(); });

async function manualSearch() {
  const artist = $("in-artist").value.trim();
  const title = $("in-title").value.trim();
  if (!title || !artist) {
    $("manual-error").textContent = "Popuni OBA polja (izvođač + naziv pesme) 🙏";
    return;
  }
  $("manual-error").textContent = "Tražim… 🔎";
  const item = await findLyrics(title, artist, 0);
  $("manual-error").textContent = "";
  if (!item) {
    $("manual-error").textContent = "Nisam našao tekst 😢\nProveri da li je pravopis tačan.";
    return;
  }
  await openLyrics(item.trackName || title, item.artistName || artist, (item.duration || 0) * 1000);
}

/* start */
showScreen("screen-start");

/* service worker (za PWA/APK) */
if ("serviceWorker" in navigator &&
    (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

