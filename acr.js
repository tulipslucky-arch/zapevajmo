"use strict";
/* ===== ZAPEVAJMO — API sloj: ACRCloud prepoznavanje + LRCLIB tekstovi ===== */

/* ---- HMAC-SHA1 potpis (WebCrypto) ---- */
async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/* ---- Mikrofon → WAV (8 kHz, mono, 16-bit) ---- */
async function recordAndBuildWav(seconds, onTick) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false,
             autoGainControl: false, channelCount: 1 }
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let cancelled = false;
  proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);

  const started = Date.now();
  await new Promise(resolve => {
    const iv = setInterval(() => {
      const left = seconds - (Date.now() - started) / 1000;
      if (onTick) onTick(Math.max(0, Math.ceil(left)));
      if (left <= 0) resolve();
    }, 200);
    window.__zapCancel = () => { cancelled = true; resolve(); };
  });

  try { proc.disconnect(); src.disconnect(); } catch (e) {}
  stream.getTracks().forEach(t => t.stop());
  if (cancelled) { ctx.close(); return null; }

  /* spajanje + resample na 8000 Hz linearnom interpolacijom */
  let total = 0; for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }

  const TARGET = 8000, ratio = ctx.sampleRate / TARGET;
  const outLen = Math.floor(merged.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, merged.length - 1);
    out[i] = merged[i0] + (merged[i1] - merged[i0]) * (pos - i0);
  }
  ctx.close();

  /* WAV header + PCM 16-bit */
  const buf = new ArrayBuffer(44 + outLen * 2), v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + outLen * 2, true); wstr(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TARGET, true); v.setUint32(28, TARGET * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* ---- ACRCloud identifikacija ---- */
async function identifySong(wavBlob) {
  const cfg = window.ZAPEVAJMO_CONFIG;
  const ts = Math.floor(Date.now() / 1000);
  const stringToSign = ["POST", "/v1/identify", cfg.accessKey, "audio", "1", ts].join("\n");
  const signature = await hmacSha1Base64(cfg.accessSecret, stringToSign);

  const fd = new FormData();
  fd.append("sample", wavBlob, "sample.wav");
  fd.append("sample_bytes", String(wavBlob.size));
  fd.append("access_key", cfg.accessKey);
  fd.append("data_type", "audio");
  fd.append("signature_version", "1");
  fd.append("signature", signature);
  fd.append("timestamp", String(ts));

  const res = await fetch("https://" + cfg.host + "/v1/identify", { method: "POST", body: fd });
  const data = await res.json();
  if (data.status && data.status.code === 0 && data.metadata &&
      data.metadata.music && data.metadata.music.length) {
    const m = data.metadata.music[0];
    return {
      title: m.title || "Nepoznata pesma",
      artist: (m.artists && m.artists[0] && m.artists[0].name) || "Nepoznat izvođač",
      album: (m.album && m.album.name) || "",
      durationMs: m.duration_ms || m.duration || 0
    };
  }
  return null; /* nije prepoznato (code 1001 ili prazno) */
}

/* ---- LRCLIB: sinhronizovani tekst ---- */
async function findLyrics(title, artist, durationMs) {
  const cfg = window.ZAPEVAJMO_CONFIG;
  const urls = [
    cfg.lrclibSearch + "?track_name=" + encodeURIComponent(title) +
      "&artist_name=" + encodeURIComponent(artist),
    cfg.lrclibSearch + "?q=" + encodeURIComponent(title + " " + artist)
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) continue;
      let best = null, bestScore = -1e9;
      for (const it of arr) {
        let score = it.syncedLyrics ? 100 : 0;
        if (durationMs && it.duration)
          score -= Math.min(15000, Math.abs(it.duration * 1000 - durationMs)) / 100;
        if (score > bestScore) { bestScore = score; best = it; }
      }
      if (best) return best;
    } catch (e) { /* probaj sledeći URL */ }
  }
  return null;
}

/* ---- LRC parser: [mm:ss.xx] → {t, text} ---- */
function parseLrc(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!times.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of times) {
      const min = +m[1], sec = +m[2];
      const fr = m[3] || "0";
      const frac = +fr / Math.pow(10, fr.length);
      out.push({ t: min * 60 + sec + frac, text });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
