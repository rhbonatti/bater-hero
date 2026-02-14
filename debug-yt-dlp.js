const path = require('path');
const fs = require('fs');
const { spawn } = require("child_process");

const ROOT_DIR = __dirname;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Executing: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); console.log('OUT:', d.toString()); });
    child.stderr.on("data", (d) => { stderr += d.toString(); console.log('ERR:', d.toString()); });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = stderr.trim() || stdout.trim() || `Falha em ${command}.`;
        reject(new Error(message));
      }
    });
  });
}

function resolveYtDlpRunner() {
  const localYtDlp = path.join(ROOT_DIR, "yt-dlp.exe");
  if (fs.existsSync(localYtDlp)) {
    return { command: localYtDlp, prefixArgs: [] };
  }
  throw new Error("yt-dlp.exe not found");
}

async function testDownload() {
  const ytRunner = resolveYtDlpRunner();
  console.log('Using yt-dlp at:', ytRunner.command);

  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // Rick Roll
  
  console.log("Testing extract title...");
  await runCommand(ytRunner.command, [
    "--no-playlist",
    "--print",
    "%(title)s",
    "--skip-download",
    url
  ]);

  console.log("Testing download audio...");
  const outTpl = path.join(ROOT_DIR, "test_audio.%(ext)s");
  await runCommand(ytRunner.command, [
      "--no-playlist",
      "--no-progress",
      "--no-warnings",
      "-f", "bestaudio",
      "-o", outTpl,
      "--print", "after_move:filepath",
      url
  ]);
  
  console.log("Download test complete.");
  
  // Test ffmpeg
  try {
    const ffmpegPath = require("ffmpeg-static");
    console.log("ffmpeg-static path:", ffmpegPath);
    
    if (fs.existsSync(ffmpegPath)) {
       console.log("ffmpeg binary exists.");
       // Try convert
       const input = path.join(ROOT_DIR, "test_audio.webm"); // webm based on previous output
       const output = path.join(ROOT_DIR, "test_audio.wav");
       
       if (fs.existsSync(input)) {
         console.log("Converting to wav...");
         await runCommand(ffmpegPath, [
            "-y",
            "-i", input,
            "-ac", "1",
            "-ar", "44100",
            "-f", "wav",
            output
         ]);
         console.log("Conversion complete:", output);
       } else {
         console.log("Input file not found for conversion test.");
       }
    } else {
       console.error("ffmpeg binary NOT found at static path.");
    }
  } catch (e) {
    console.error("Error checking ffmpeg:", e);
  }
}

testDownload().catch(console.error);
