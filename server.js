const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const MEDIA_DIR = path.join(ROOT_DIR, ".cache-youtube");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function parseJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Payload muito grande."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const obj = raw ? JSON.parse(raw) : {};
        resolve(obj);
      } catch (err) {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });
}

function isYoutubeUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be";
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = stderr.trim() || stdout.trim() || `Falha em ${command}.`;
        console.error(`[Command Failed] ${command}\n${message}`);
        reject(new Error(message));
      }
    });
  });
}

async function commandExists(command, args = ["--version"]) {
  try {
    await runCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

async function resolveYtDlpRunner() {
  if (await commandExists("yt-dlp", ["--version"])) {
    return { command: "yt-dlp", prefixArgs: [] };
  }
  // Try local binary
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localYtDlp = path.join(ROOT_DIR, binaryName);
  
  if (fs.existsSync(localYtDlp)) {
    return { command: localYtDlp, prefixArgs: [] };
  }
    
  if (await commandExists("python", ["-m", "yt_dlp", "--version"])) {
    return { command: "python", prefixArgs: ["-m", "yt_dlp"] };
  }
  return null;
}

async function resolveFfmpegCommand() {
  if (await commandExists("ffmpeg", ["-version"])) {
    return "ffmpeg";
  }
  
  // Try static ffmpeg
  try {
    const ffmpegPath = require("ffmpeg-static");
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
       return ffmpegPath;
    }
  } catch (e) {
    // maybe module not installed
  }

  try {
    const { stdout } = await runCommand("python", [
      "-c",
      "import imageio_ffmpeg as m; print(m.get_ffmpeg_exe())"
    ]);
    const exe = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (exe && fs.existsSync(exe)) return exe;
  } catch {
    // noop
  }
  return null;
}

async function getYoutubeDependenciesStatus() {
  const [ytRunner, ffmpegCmd] = await Promise.all([
    resolveYtDlpRunner(),
    resolveFfmpegCommand()
  ]);
  const ytDlp = !!ytRunner;
  const ffmpeg = !!ffmpegCmd;
  const missing = [];
  if (!ytDlp) missing.push("yt-dlp");
  if (!ffmpeg) missing.push("ffmpeg");
  return { ytDlp, ffmpeg, missing };
}

async function extractYoutubeTitle(url, ytRunner, ffmpegCmd) {
  try {
    const args = [
      ...ytRunner.prefixArgs,
      "--no-playlist",
      "--print",
      "%(title)s",
      "--skip-download",
      "--no-check-certificates",
      "--force-ipv4",
      "--extractor-args", "youtube:player_client=ios",
      url
    ];
    if (ffmpegCmd && !ffmpegCmd.startsWith("python")) {
       args.push("--ffmpeg-location", ffmpegCmd);
    }
    
    // Check for cookies in env
    const cookiesPath = path.join(ROOT_DIR, "cookies.txt");
    if (process.env.YOUTUBE_COOKIES) {
      fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
      args.unshift("--cookies", cookiesPath);
    } else if (fs.existsSync(cookiesPath)) {
      args.unshift("--cookies", cookiesPath);
    }
    
    console.log(`[Extracting Title] CMD: ${ytRunner.command} ${args.join(" ")}`);
    const { stdout } = await runCommand(ytRunner.command, args);
    return stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "YouTube";
  } catch (err) {
    console.error("Error extracting title:", err.message);
    return "YouTube";
  }
}

async function downloadYoutubeAudio(url, jobDir, ytRunner, ffmpegCmd) {
  const outTpl = path.join(jobDir, "audio.%(ext)s");
  const args = [
    ...ytRunner.prefixArgs,
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "-f", "bestaudio",
    "-o", outTpl,
    "--print", "after_move:filepath",
    "--no-check-certificates",
    "--force-ipv4",
    "--extractor-args", "youtube:player_client=ios",
    url
  ];
  if (ffmpegCmd && !ffmpegCmd.startsWith("python")) {
    args.push("--ffmpeg-location", ffmpegCmd);
  }

  // Check for cookies in env or file
  const cookiesPath = path.join(ROOT_DIR, "cookies.txt");
  if (process.env.YOUTUBE_COOKIES) {
    // Write if not exists or update? Just ensure file exists with content
    try { fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES); } catch {}
    args.unshift("--cookies", cookiesPath);
  } else if (fs.existsSync(cookiesPath)) {
    args.unshift("--cookies", cookiesPath);
  }

  console.log(`[Downloading Audio] CMD: ${ytRunner.command} ${args.join(" ")}`);
  const { stdout } = await runCommand(ytRunner.command, args);

  const candidates = stdout.trim().split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  const audioPath = candidates.length ? candidates[candidates.length - 1] : "";
  if (!audioPath) {
    throw new Error("Nao foi possivel localizar o arquivo de audio baixado.");
  }
  const resolved = path.isAbsolute(audioPath) ? audioPath : path.join(ROOT_DIR, audioPath);

  await fsp.access(resolved);
  return resolved;
}

async function convertToWavMono(inputPath, outputPath, ffmpegCommand) {
  await runCommand(ffmpegCommand, [
    "-y",
    "-i", inputPath,
    "-ac", "1",
    "-ar", "44100",
    "-f", "wav",
    outputPath
  ]);
}

function parseWavMonoFloat32(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Arquivo WAV invalido.");
  }

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (id === "fmt ") {
      audioFormat = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataOffset = start;
      dataSize = size;
      break;
    }

    offset = start + size + (size % 2);
  }

  if (dataOffset < 0) {
    throw new Error("WAV sem chunk data.");
  }
  if (channels !== 1) {
    throw new Error("WAV precisa estar em mono.");
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error("Formato WAV nao suportado.");
  }

  const sampleCount = audioFormat === 1
    ? Math.floor(dataSize / (bitsPerSample / 8))
    : Math.floor(dataSize / 4);
  const out = new Float32Array(sampleCount);

  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < sampleCount; i++) {
      const v = buffer.readInt16LE(dataOffset + i * 2);
      out[i] = v / 32768;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < sampleCount; i++) {
      out[i] = buffer.readFloatLE(dataOffset + i * 4);
    }
  } else {
    throw new Error("WAV deve ser PCM16 ou float32.");
  }

  return { samples: out, sampleRate };
}

function buildBeatmapFromSamples(samples, sampleRate, title) {
  const frameSize = Math.floor(sampleRate * 0.02);
  const hop = Math.floor(sampleRate * 0.01);
  const energies = [];

  for (let i = 0; i + frameSize < samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const v = samples[i + j];
      sum += v * v;
    }
    energies.push(sum / frameSize);
  }

  let maxE = 0;
  for (const e of energies) {
    if (e > maxE) maxE = e;
  }
  const norm = energies.map((e) => (maxE ? e / maxE : 0));

  const peaks = [];
  const threshold = 0.22;
  const minGapFrames = 8;
  for (let i = 1; i < norm.length - 1; i++) {
    if (norm[i] > threshold && norm[i] > norm[i - 1] && norm[i] > norm[i + 1]) {
      if (peaks.length === 0 || (i - peaks[peaks.length - 1]) >= minGapFrames) {
        peaks.push(i);
      }
    }
  }

  const notes = [];
  for (const p of peaks) {
    const tSec = (p * hop) / sampleRate;
    const tMs = Math.round(tSec * 1000);
    if (tMs < 600) continue;

    const r = (tMs / 137) % 1;
    let lane = 0;
    if (r < 0.25) lane = 0;
    else if (r < 0.50) lane = 1;
    else if (r < 0.75) lane = 2;
    else lane = 3;
    notes.push({ t: tMs, lane });
  }

  return {
    version: 1,
    title: title || "YouTube Auto Map",
    artist: "Generated",
    bpm: 0,
    offsetMs: 0,
    notes
  };
}

function safePathFromUrlPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const noLead = decoded.replace(/^\/+/, "");
  const normalized = path.normalize(noLead);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return null;
  }
  return path.join(ROOT_DIR, normalized);
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(ROOT_DIR, "index.html") : safePathFromUrlPath(pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

async function cleanupOldJobs() {
  try {
    const entries = await fsp.readdir(MEDIA_DIR, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = 6 * 60 * 60 * 1000;

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const dir = path.join(MEDIA_DIR, entry.name);
      const st = await fsp.stat(dir);
      if ((now - st.mtimeMs) > maxAgeMs) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }));
  } catch {
    // noop
  }
}

async function handleYoutubeBeatmap(req, res) {
  let payload = {};
  try {
    payload = await parseJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }

  const url = String(payload.url || "").trim();
  if (!url || !isYoutubeUrl(url)) {
    sendJson(res, 400, { ok: false, error: "Informe uma URL valida do YouTube." });
    return;
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(MEDIA_DIR, jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    const [ytRunner, ffmpegCommand] = await Promise.all([
      resolveYtDlpRunner(),
      resolveFfmpegCommand()
    ]);
    if (!ytRunner || !ffmpegCommand) {
      throw new Error("Dependencia ausente: instale yt-dlp e ffmpeg no PATH.");
    }

    const title = await extractYoutubeTitle(url, ytRunner, ffmpegCommand);
    const mp3Path = await downloadYoutubeAudio(url, jobDir, ytRunner, ffmpegCommand);
    const wavPath = path.join(jobDir, "audio.wav");
    await convertToWavMono(mp3Path, wavPath, ffmpegCommand);

    const wav = await fsp.readFile(wavPath);
    const { samples, sampleRate } = parseWavMonoFloat32(wav);
    const beatmap = buildBeatmapFromSamples(samples, sampleRate, title);

    const fileName = path.basename(mp3Path);
    sendJson(res, 200, {
      ok: true,
      title,
      audioUrl: `/media/${jobId}/${fileName}`,
      beatmap
    });
  } catch (err) {
    const msg = String(err.message || err);
    const toolHint = msg.includes("ENOENT")
      ? "Dependencia ausente: instale yt-dlp e ffmpeg no PATH (ou via Python: pip install yt-dlp imageio-ffmpeg)."
      : msg;
    sendJson(res, 500, { ok: false, error: toolHint });
  } finally {
    cleanupOldJobs().catch(() => {});
  }
}

async function handleMedia(req, res, pathname) {
  const rel = pathname.replace(/^\/media\//, "");
  const normalized = path.normalize(rel);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const target = path.join(MEDIA_DIR, normalized);
  if (!target.startsWith(MEDIA_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(target).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

async function main() {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  const deps = await getYoutubeDependenciesStatus();
  if (deps.missing.length > 0) {
    console.warn(`Dependencias faltando para YouTube: ${deps.missing.join(", ")}`);
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = reqUrl.pathname;

    if (req.method === "GET" && pathname === "/api/youtube/deps") {
      getYoutubeDependenciesStatus()
        .then((deps) => sendJson(res, 200, { ok: true, ...deps }))
        .catch((err) => sendJson(res, 500, { ok: false, error: String(err.message || err) }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/youtube/beatmap") {
      handleYoutubeBeatmap(req, res).catch((err) => {
        sendJson(res, 500, { ok: false, error: String(err.message || err) });
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/media/")) {
      handleMedia(req, res, pathname).catch(() => sendText(res, 500, "Internal Server Error"));
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname).catch(() => sendText(res, 500, "Internal Server Error"));
      return;
    }

    sendText(res, 405, "Method Not Allowed");
  });

  server.listen(PORT, HOST, () => {
    console.log(`Drum Hero server: http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
