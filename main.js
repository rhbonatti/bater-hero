/* Drum Hero - Web Audio + Beatmap timing
   Keys: A S K L -> lanes 0..3
*/

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  audioFile: $("#audioFile"),
  beatmapFile: $("#beatmapFile"),
  btnLoadSample: $("#btnLoadSample"),
  btnAutoMap: $("#btnAutoMap"),
  btnYouTubeMap: $("#btnYouTubeMap"),
  btnStart: $("#btnStart"),
  btnPause: $("#btnPause"),
  btnRestart: $("#btnRestart"),
  ytUrl: $("#ytUrl"),

  offsetMs: $("#offsetMs"),
  speed: $("#speed"),
  winPerfect: $("#winPerfect"),
  winGood: $("#winGood"),
  winBad: $("#winBad"),
  preRoll: $("#preRoll"),

  status: $("#status"),
  songName: $("#songName"),

  score: $("#score"),
  combo: $("#combo"),
  mult: $("#mult"),
  acc: $("#acc"),

  jPerfect: $("#jPerfect"),
  jGood: $("#jGood"),
  jBad: $("#jBad"),
  jMiss: $("#jMiss"),
  lastJudge: $("#lastJudge"),

  game: $("#game"),
  hitLine: $("#hitLine"),
  countdown: $("#countdown"),

  timeFill: $("#timeFill"),
  timeText: $("#timeText"),
};

const lanesEls = $$(".lane");
const padsEls = $$(".pad");

const KEY_TO_LANE = { a: 0, s: 1, k: 2, l: 3 };
const LANE_CLASS = ["red", "yellow", "blue", "green"];
const API_BASE_URL = (window.localStorage.getItem("drumHeroApiBase") || "").trim();

let audioCtx = null;
let audioBuffer = null;
let audioNode = null;

let beatmap = null; // { notes:[{t,lane}], offsetMs, ... }
let notes = []; // runtime notes (sorted)
let activeNotes = new Map(); // id -> runtime note
let nextSpawnIndex = 0;

let rafId = null;
let playing = false;
let paused = false;

let startAtCtxTime = 0;      // AudioContext time when audio starts (with preRoll)
let pausedAtMs = 0;          // game time in ms when paused
let lastFrameCtxTime = 0;

let stats = {
  score: 0,
  combo: 0,
  mult: 1,
  hits: 0,
  totalJudged: 0,
  perfect: 0,
  good: 0,
  bad: 0,
  miss: 0,
};

function ensureYoutubeControls() {
  if (els.ytUrl && els.btnYouTubeMap) return;

  const statusEl = $("#status");
  if (!statusEl) return;

  const statusRow = statusEl.closest(".row");
  if (!statusRow || !statusRow.parentElement) return;

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <div class="label">YouTube URL</div>
    <div class="inlineInput">
      <input id="ytUrl" type="text" placeholder="https://www.youtube.com/watch?v=..." />
      <button id="btnYouTubeMap" class="btn secondary">Gerar Beatmap YouTube</button>
    </div>
    <div class="hint">Requer backend local com yt-dlp + ffmpeg.</div>
  `;

  statusRow.parentElement.insertBefore(row, statusRow);
  els.ytUrl = $("#ytUrl");
  els.btnYouTubeMap = $("#btnYouTubeMap");
}

function setStatus(text) {
  els.status.textContent = text;
}

function buildApiUrl(pathname) {
  if (API_BASE_URL) {
    return `${API_BASE_URL.replace(/\/+$/, "")}${pathname}`;
  }
  if (window.location.protocol === "file:") {
    return `http://127.0.0.1:3000${pathname}`;
  }
  return pathname;
}

async function refreshYoutubeDepsStatus() {
  if (!els.btnYouTubeMap) return;
  try {
    const res = await fetch(buildApiUrl("/api/youtube/deps"));
    if (!res.ok) return;
    const data = await res.json();
    const missing = Array.isArray(data?.missing) ? data.missing : [];
    if (missing.length > 0) {
      els.btnYouTubeMap.disabled = true;
      els.btnYouTubeMap.title = `Instale: ${missing.join(", ")}`;
      setStatus(`YouTube indisponivel: instale ${missing.join(" e ")} no PATH (ou via Python: pip install yt-dlp imageio-ffmpeg) e reinicie o servidor.`);
    } else {
      els.btnYouTubeMap.disabled = false;
      els.btnYouTubeMap.title = "Gera beatmap a partir de URL do YouTube";
    }
  } catch {
    // backend pode estar indisponivel; nao interrompe o restante do jogo
  }
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

async function decodeAudioFile(file) {
  const ctx = ensureAudioCtx();
  const arr = await file.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

async function decodeAudioFromUrl(url) {
  const ctx = ensureAudioCtx();
  const resolvedUrl = /^https?:\/\//i.test(url) ? url : buildApiUrl(url);
  const res = await fetch(resolvedUrl);
  if (!res.ok) throw new Error("Falha ao baixar ÃƒÂ¡udio do backend.");
  const arr = await res.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

function stopAudioNode() {
  if (audioNode) {
    try { audioNode.stop(); } catch {}
    try { audioNode.disconnect(); } catch {}
  }
  audioNode = null;
}

function resetRunState() {
  // clear notes DOM
  for (const n of activeNotes.values()) {
    n.el.remove();
  }
  activeNotes.clear();
  nextSpawnIndex = 0;

  stats = {
    score: 0,
    combo: 0,
    mult: 1,
    hits: 0,
    totalJudged: 0,
    perfect: 0,
    good: 0,
    bad: 0,
    miss: 0,
  };
  updateHUD();

  paused = false;
  playing = false;
  pausedAtMs = 0;
  startAtCtxTime = 0;
  lastFrameCtxTime = 0;

  stopAudioNode();
  cancelAnimationFrame(rafId);
  rafId = null;

  els.timeFill.style.width = "0%";
  els.timeText.textContent = `0:00 / ${audioBuffer ? fmtTime(audioBuffer.duration) : "0:00"}`;
}

function updateHUD() {
  els.score.textContent = stats.score.toString();
  els.combo.textContent = stats.combo.toString();
  els.mult.textContent = `x${stats.mult}`;
  els.jPerfect.textContent = stats.perfect.toString();
  els.jGood.textContent = stats.good.toString();
  els.jBad.textContent = stats.bad.toString();
  els.jMiss.textContent = stats.miss.toString();

  const judged = stats.totalJudged;
  const acc = judged ? Math.round((stats.hits / judged) * 100) : 0;
  els.acc.textContent = `${acc}%`;
}

function setJudgeText(label, cls) {
  els.lastJudge.className = "lastJudge";
  if (cls) els.lastJudge.classList.add(cls);
  els.lastJudge.textContent = label;
}

function canStart() {
  return !!audioBuffer && !!beatmap && Array.isArray(beatmap.notes) && beatmap.notes.length > 0;
}

function enableButtons() {
  els.btnStart.disabled = !canStart();
  els.btnPause.disabled = !playing;
  els.btnRestart.disabled = !audioBuffer && !beatmap ? true : false;
}

function cloneBeatmapToRuntime() {
  // notes sorted by time
  notes = beatmap.notes
    .map((n, idx) => ({
      id: idx + 1,
      t: Number(n.t),     // ms
      lane: Number(n.lane),
      judged: false,
      hit: false,
      el: null,
      y: -9999
    }))
    .filter(n => Number.isFinite(n.t) && n.t >= 0 && [0,1,2,3].includes(n.lane))
    .sort((a,b) => a.t - b.t);
}

function getSettings() {
  return {
    offsetMs: Number(els.offsetMs.value) || 0,
    speed: Math.max(100, Number(els.speed.value) || 550), // px/s
    winPerfect: Math.max(10, Number(els.winPerfect.value) || 50),
    winGood: Math.max(20, Number(els.winGood.value) || 100),
    winBad: Math.max(30, Number(els.winBad.value) || 160),
    preRoll: Math.max(0, Number(els.preRoll.value) || 1500),
  };
}

// Convert time(ms) to y position (px) based on travel time
function computeNoteY(currentGameMs, noteTimeMs, speedPxPerSec) {
  // Note reaches hit line exactly at noteTimeMs (adjusted)
  const hitY = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hitY")) || 520;
  const dtMs = noteTimeMs - currentGameMs; // positive if note is in future
  const dtSec = dtMs / 1000;
  // If dt is positive, note is above hit line. If negative, below.
  const y = hitY - (dtSec * speedPxPerSec);
  return y;
}

function spawnNote(runtimeNote) {
  const laneEl = lanesEls[runtimeNote.lane];
  const noteEl = document.createElement("div");
  noteEl.className = `note ${LANE_CLASS[runtimeNote.lane]}`;
  const cap = document.createElement("div");
  cap.className = "cap";
  noteEl.appendChild(cap);

  laneEl.appendChild(noteEl);
  runtimeNote.el = noteEl;
  activeNotes.set(runtimeNote.id, runtimeNote);
}

function flashPad(lane) {
  const pad = padsEls[lane];
  pad.classList.add("flash");
  setTimeout(() => pad.classList.remove("flash"), 80);
}

function triggerHitVisual(lane, judge) {
  const laneEl = lanesEls[lane];
  if (!laneEl) return;

  laneEl.classList.remove("hit");
  // Force reflow so repeated hits retrigger animation.
  void laneEl.offsetWidth;
  laneEl.classList.add("hit");
  setTimeout(() => laneEl.classList.remove("hit"), 160);

  const hitY = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hitY")) || 520;
  const burst = document.createElement("div");
  burst.className = `hitEffect ${LANE_CLASS[lane]} ${judge}`;
  burst.style.top = `${hitY - 18}px`;
  laneEl.appendChild(burst);

  setTimeout(() => burst.remove(), 260);
}

function addScore(judge) {
  // Guitar Hero-ish: base + combo/mult
  const base = judge === "perfect" ? 100 : judge === "good" ? 70 : judge === "bad" ? 30 : 0;

  if (judge === "miss") {
    stats.combo = 0;
    stats.mult = 1;
    return;
  }

  stats.combo += 1;
  // multiplicador por combo
  if (stats.combo >= 40) stats.mult = 4;
  else if (stats.combo >= 20) stats.mult = 3;
  else if (stats.combo >= 10) stats.mult = 2;
  else stats.mult = 1;

  stats.score += base * stats.mult;
}

function judgeHit(note, deltaMs, wins) {
  // deltaMs = current - noteTime ; abs smaller is better
  const ad = Math.abs(deltaMs);

  stats.totalJudged += 1;

  if (ad <= wins.winPerfect) {
    stats.perfect += 1;
    stats.hits += 1;
    addScore("perfect");
    setJudgeText("PERFECT âœ”ï¸", "perfect");
    return "perfect";
  }
  if (ad <= wins.winGood) {
    stats.good += 1;
    stats.hits += 1;
    addScore("good");
    setJudgeText("GOOD", "good");
    return "good";
  }
  if (ad <= wins.winBad) {
    stats.bad += 1;
    stats.hits += 1;
    addScore("bad");
    setJudgeText("BAD", "bad");
    return "bad";
  }

  // too far
  return null;
}

function markMiss(note) {
  if (note.judged) return;
  note.judged = true;
  note.hit = false;

  stats.totalJudged += 1;
  stats.miss += 1;
  addScore("miss");
  setJudgeText("MISS â—", "miss");

  // remove
  if (note.el) note.el.remove();
  activeNotes.delete(note.id);
}

function getGameTimeMs(ctxTimeNow) {
  // game time is aligned to audio start (preRoll included)
  // when paused, we keep pausedAtMs
  if (!playing) return 0;
  if (paused) return pausedAtMs;

  const elapsedSec = ctxTimeNow - startAtCtxTime; // since audio started (preRoll done)
  // before startAtCtxTime, elapsed is negative (during countdown/preRoll), but we clamp:
  return Math.max(0, elapsedSec * 1000);
}

function updateProgress(gameMs) {
  if (!audioBuffer) return;
  const totalMs = audioBuffer.duration * 1000;
  const pct = Math.min(1, Math.max(0, gameMs / totalMs));
  els.timeFill.style.width = `${pct * 100}%`;
  els.timeText.textContent = `${fmtTime(gameMs / 1000)} / ${fmtTime(audioBuffer.duration)}`;
}

function renderLoop() {
  if (!audioCtx) return;

  const ctxNow = audioCtx.currentTime;
  const settings = getSettings();

  const bmOffset = Number(beatmap?.offsetMs || 0);
  const userOffset = settings.offsetMs;

  const gameMs = getGameTimeMs(ctxNow);
  updateProgress(gameMs);

  // spawn window: we spawn notes when they are within "spawnAheadMs"
  // spawnAhead = time it takes to travel from top to hit line + some buffer.
  const hitY = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hitY")) || 520;
  const spawnFromY = -40; // start off screen
  const travelPx = hitY - spawnFromY;
  const travelSec = travelPx / settings.speed;
  const spawnAheadMs = travelSec * 1000 + 200;

  // spawn notes that are coming soon
  while (nextSpawnIndex < notes.length) {
    const n = notes[nextSpawnIndex];
    const adjustedNoteTime = n.t + bmOffset + userOffset;
    if (adjustedNoteTime <= gameMs + spawnAheadMs) {
      spawnNote(n);
      nextSpawnIndex++;
    } else {
      break;
    }
  }

  // update positions + miss
  for (const n of activeNotes.values()) {
    const adjustedNoteTime = n.t + bmOffset + userOffset;
    const y = computeNoteY(gameMs, adjustedNoteTime, settings.speed);
    n.y = y;
    if (n.el) n.el.style.top = `${y}px`;

    // If note passed beyond miss threshold (below hit line + bad window)
    const missAfterY = hitY + (settings.speed * (settings.winBad / 1000)) + 40;
    if (!n.judged && y > missAfterY) {
      markMiss(n);
    }
  }

  // end condition
  if (audioBuffer && !paused && playing) {
    const totalMs = audioBuffer.duration * 1000;
    if (gameMs >= totalMs + 50) {
      finishSong();
      return;
    }
  }

  lastFrameCtxTime = ctxNow;
  rafId = requestAnimationFrame(renderLoop);
}

function finishSong() {
  playing = false;
  paused = false;
  stopAudioNode();
  cancelAnimationFrame(rafId);
  rafId = null;

  // any remaining active notes count as miss
  for (const n of activeNotes.values()) {
    if (!n.judged) markMiss(n);
  }

  setStatus("Fim da mÃºsica. VocÃª pode Restart ou trocar mÃºsica/beatmap.");
  enableButtons();
}

function startCountdown(ms) {
  return new Promise((resolve) => {
    const total = Math.max(0, ms);
    if (total === 0) {
      els.countdown.classList.add("hidden");
      resolve();
      return;
    }
    els.countdown.classList.remove("hidden");

    const steps = Math.ceil(total / 1000);
    let remaining = steps;

    const tick = () => {
      if (remaining <= 0) {
        els.countdown.textContent = "GO!";
        setTimeout(() => {
          els.countdown.classList.add("hidden");
          resolve();
        }, 250);
        return;
      }
      els.countdown.textContent = String(remaining);
      remaining--;
      setTimeout(tick, 1000);
    };
    tick();
  });
}

async function startGame() {
  if (!canStart()) return;

  const ctx = ensureAudioCtx();
  await ctx.resume();

  resetRunState();
  cloneBeatmapToRuntime();

  const settings = getSettings();
  setStatus("Preparando...");

  // pre-roll: countdown + schedule audio start after preRoll
  await startCountdown(Math.min(3000, settings.preRoll)); // show up to 3s countdown (visual)
  const preRoll = settings.preRoll;

  // Create node and schedule
  stopAudioNode();
  audioNode = ctx.createBufferSource();
  audioNode.buffer = audioBuffer;

  // volume (simple)
  const gain = ctx.createGain();
  gain.gain.value = 1.0;
  audioNode.connect(gain).connect(ctx.destination);

  // We start now + small lead to ensure scheduling
  const scheduleLead = 0.06; // seconds
  startAtCtxTime = ctx.currentTime + scheduleLead; // moment audio begins
  const startDelay = scheduleLead + preRoll / 1000;

  // Start playback after preRoll
  audioNode.start(startAtCtxTime + preRoll / 1000);

  // BUT our game time should consider that notes should align when audio is playing:
  // We'll define "audio start moment" as startAtCtxTime + preRollSec.
  // We'll store startAtCtxTime as that moment (when audio actually begins),
  // so getGameTimeMs matches audio playback time.
  startAtCtxTime = startAtCtxTime + preRoll / 1000;

  playing = true;
  paused = false;

  setStatus("Jogando! (A S K L) â€¢ Pause com botÃ£o.");
  enableButtons();

  lastFrameCtxTime = ctx.currentTime;
  rafId = requestAnimationFrame(renderLoop);

  audioNode.onended = () => {
    // Some browsers call onended slightly after our finish check
    if (playing) finishSong();
  };
}

function pauseGame() {
  if (!playing || paused) return;
  if (!audioCtx) return;

  const ctxNow = audioCtx.currentTime;
  pausedAtMs = getGameTimeMs(ctxNow);
  paused = true;

  // stop audio and remember position
  stopAudioNode();

  setStatus("Pausado. Clique Pause novamente para retomar.");
  els.btnPause.textContent = "â–¶ï¸ Resume";
  enableButtons();
}

function resumeGame() {
  if (!playing || !paused) return;
  if (!audioCtx || !audioBuffer) return;

  const ctx = audioCtx;

  stopAudioNode();
  audioNode = ctx.createBufferSource();
  audioNode.buffer = audioBuffer;

  const gain = ctx.createGain();
  gain.gain.value = 1.0;
  audioNode.connect(gain).connect(ctx.destination);

  const scheduleLead = 0.06;
  const now = ctx.currentTime;

  // We want audio playback to resume at pausedAtMs
  const offsetSec = pausedAtMs / 1000;
  startAtCtxTime = now + scheduleLead - offsetSec;

  audioNode.start(now + scheduleLead, offsetSec);

  paused = false;
  setStatus("Jogando!");
  els.btnPause.textContent = "â¸ï¸ Pause";
  enableButtons();

  audioNode.onended = () => {
    if (playing) finishSong();
  };
}

function restartGame() {
  if (!audioBuffer || !beatmap) {
    resetRunState();
    setStatus("Carregue mÃºsica + beatmap.");
    enableButtons();
    return;
  }
  startGame();
}

function handleKeyDown(e) {
  const key = e.key.toLowerCase();
  if (!(key in KEY_TO_LANE)) return;

  const lane = KEY_TO_LANE[key];
  flashPad(lane);

  if (!playing || paused) return;

  // find closest unjudged note in this lane within bad window
  const ctxNow = audioCtx.currentTime;
  const gameMs = getGameTimeMs(ctxNow);

  const settings = getSettings();
  const wins = {
    winPerfect: settings.winPerfect,
    winGood: settings.winGood,
    winBad: settings.winBad,
  };
  const bmOffset = Number(beatmap?.offsetMs || 0);
  const userOffset = settings.offsetMs;

  let best = null;
  let bestAbs = Infinity;

  for (const n of activeNotes.values()) {
    if (n.judged) continue;
    if (n.lane !== lane) continue;

    const tAdj = n.t + bmOffset + userOffset;
    const delta = gameMs - tAdj;
    const ad = Math.abs(delta);

    if (ad <= wins.winBad && ad < bestAbs) {
      best = { n, delta, ad };
      bestAbs = ad;
    }
  }

  if (!best) return;

  const judge = judgeHit(best.n, best.delta, wins);
  if (!judge) return;

  triggerHitVisual(lane, judge);

  best.n.judged = true;
  best.n.hit = true;

  // remove
  if (best.n.el) best.n.el.remove();
  activeNotes.delete(best.n.id);

  updateHUD();
}

async function loadBeatmapFromFile(file) {
  const text = await file.text();
  const obj = JSON.parse(text);
  validateBeatmap(obj);
  beatmap = obj;
  setStatus(`Beatmap carregado: ${beatmap.title || "Sem tÃ­tulo"} â€¢ Notas: ${beatmap.notes?.length || 0}`);
  enableButtons();
}

function validateBeatmap(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Beatmap invÃ¡lido.");
  if (!Array.isArray(obj.notes)) throw new Error("Beatmap precisa ter 'notes' (array).");
  for (const n of obj.notes) {
    if (typeof n.t !== "number" || typeof n.lane !== "number") {
      throw new Error("Cada nota precisa ter {t:number, lane:number}.");
    }
  }
}

async function loadSampleBeatmap() {
  // fetch local sample
  const res = await fetch("./beatmaps/sample-beatmap.json");
  if (!res.ok) throw new Error("NÃ£o consegui carregar o sample-beatmap.json");
  const obj = await res.json();
  validateBeatmap(obj);
  beatmap = obj;
  setStatus(`Sample beatmap carregado â€¢ Notas: ${beatmap.notes.length}`);
  enableButtons();
}

// --- Auto Map (simple onset-ish detector) ---
// This is intentionally simple (not production-grade), but helps testing quickly.
async function autoMapFromAudio() {
  if (!audioBuffer) {
    setStatus("Carregue uma mÃºsica antes de usar Auto Map.");
    return;
  }

  setStatus("Auto Map: analisando Ã¡udio...");

  // Use mono mix
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const sampleRate = audioBuffer.sampleRate;

  const mix = new Float32Array(ch0.length);
  for (let i = 0; i < mix.length; i++) {
    mix[i] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
  }

  // compute short-time energy
  const frameSize = Math.floor(sampleRate * 0.02);  // 20ms
  const hop = Math.floor(sampleRate * 0.01);        // 10ms
  const energies = [];
  for (let i = 0; i + frameSize < mix.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const v = mix[i + j];
      sum += v * v;
    }
    energies.push(sum / frameSize);
  }

  // normalize + pick peaks above threshold
  let maxE = 0;
  for (const e of energies) if (e > maxE) maxE = e;
  const norm = energies.map(e => (maxE ? e / maxE : 0));

  const peaks = [];
  const threshold = 0.22;        // adjust if too many/few notes
  const minGapFrames = 8;        // ~80ms
  for (let i = 1; i < norm.length - 1; i++) {
    if (norm[i] > threshold && norm[i] > norm[i-1] && norm[i] > norm[i+1]) {
      if (peaks.length === 0 || (i - peaks[peaks.length - 1]) >= minGapFrames) {
        peaks.push(i);
      }
    }
  }

  // map peaks to lanes with a simple pattern
  const notesOut = [];
  let lane = 0;
  for (const p of peaks) {
    const tSec = (p * hop) / sampleRate;
    const tMs = Math.round(tSec * 1000);
    // skip first 600ms
    if (tMs < 600) continue;

    // pseudo variety
    const r = (tMs / 137) % 1;
    if (r < 0.25) lane = 0;
    else if (r < 0.50) lane = 1;
    else if (r < 0.75) lane = 2;
    else lane = 3;

    notesOut.push({ t: tMs, lane });
  }

  beatmap = {
    version: 1,
    title: "Auto Map",
    artist: "Generated",
    bpm: 0,
    offsetMs: 0,
    notes: notesOut
  };

  setStatus(`Auto Map pronto â€¢ Notas: ${notesOut.length} (ajuste Offset/Velocidade se quiser)`);
  enableButtons();
}

async function generateBeatmapFromYoutube() {
  await refreshYoutubeDepsStatus();
  if (els.btnYouTubeMap?.disabled) {
    setStatus("YouTube indisponivel: instale as dependencias e reinicie o servidor.");
    return;
  }

  const ytUrl = (els.ytUrl?.value || "").trim();
  if (!ytUrl) {
    setStatus("Cole um link do YouTube para gerar beatmap.");
    return;
  }

  try {
    if (els.btnYouTubeMap) els.btnYouTubeMap.disabled = true;
    setStatus("YouTube: baixando audio e gerando beatmap...");

    const res = await fetch(buildApiUrl("/api/youtube/beatmap"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: ytUrl })
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const msg = res.status === 404
        ? "Endpoint /api/youtube/beatmap nao encontrado. Rode `npm start` no projeto ou configure localStorage.drumHeroApiBase."
        : (data?.error || "Falha ao gerar beatmap do YouTube.");
      throw new Error(msg);
    }

    validateBeatmap(data.beatmap);
    beatmap = data.beatmap;
    audioBuffer = await decodeAudioFromUrl(data.audioUrl);
    els.songName.textContent = data.title || "YouTube";

    resetRunState();
    setStatus(`YouTube carregado: ${els.songName.textContent} - Notas: ${beatmap.notes.length}`);
    enableButtons();
  } catch (err) {
    console.error(err);
    setStatus(`YouTube falhou: ${err.message || "erro desconhecido"}`);
  } finally {
    if (els.btnYouTubeMap) els.btnYouTubeMap.disabled = false;
  }
}
// --- Events ---
els.audioFile.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    setStatus("Decodificando Ã¡udio...");
    audioBuffer = await decodeAudioFile(file);
    els.songName.textContent = file.name;
    setStatus(`MÃºsica carregada: ${file.name} â€¢ DuraÃ§Ã£o: ${fmtTime(audioBuffer.duration)}`);
    resetRunState();
    enableButtons();
  } catch (err) {
    console.error(err);
    setStatus("Falha ao carregar Ã¡udio. Tente MP3/WAV.");
  } finally {
    e.target.value = "";
  }
});

els.beatmapFile.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    await loadBeatmapFromFile(file);
    resetRunState();
    enableButtons();
  } catch (err) {
    console.error(err);
    setStatus("Falha ao carregar beatmap JSON.");
  } finally {
    e.target.value = "";
  }
});

els.btnLoadSample.addEventListener("click", async () => {
  try {
    await loadSampleBeatmap();
    resetRunState();
    enableButtons();
  } catch (err) {
    console.error(err);
    setStatus("NÃ£o consegui carregar o beatmap exemplo. Verifique o arquivo.");
  }
});

els.btnAutoMap.addEventListener("click", async () => {
  try {
    await autoMapFromAudio();
    resetRunState();
    enableButtons();
  } catch (err) {
    console.error(err);
    setStatus("Auto Map falhou.");
  }
});

els.btnStart.addEventListener("click", () => startGame());

els.btnPause.addEventListener("click", async () => {
  if (!audioCtx) return;
  await audioCtx.resume();

  if (!playing) return;
  if (!paused) pauseGame();
  else resumeGame();
});

els.btnRestart.addEventListener("click", () => restartGame());

document.addEventListener("keydown", handleKeyDown);

// init
ensureYoutubeControls();
setStatus("Carregue uma mÃºsica e um beatmap, ou use Auto Map.");
if (els.btnYouTubeMap) {
  els.btnYouTubeMap.addEventListener("click", async () => {
    await generateBeatmapFromYoutube();
  });
  refreshYoutubeDepsStatus();
}
enableButtons();
updateHUD();
