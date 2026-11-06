// video.mjs — the display/audio supervisor. Two modes:
//
// STREAM_VIDEO=1 (M11.2 legacy, no-OBS path): the full stack in one container
//   Xvfb :99              — one display shared by the engine and the slate
//   PulseAudio (system)   — the engine's SDL audio sink; a null sink "hw" is
//                           created and default, ffmpeg taps hw.monitor
//   chromium kiosk        — the worker's /stream/ slides page, full screen
//   ffmpeg x11grab+pulse  — the feed itself: RTMP push, or a file for local
//                           proofs (STREAM_RECORD)
//   The agent switches what is on screen per phase by raising windows
//   (xdotool windowraise; no WM in the container): slate/lobby/countdown
//   raise the slides page, ingame raises the engine ("Hedgewars", exact
//   title — uStore.pas).
//
// STREAM_DISPLAYS=1 (M12 OBS mode): displays and audio ONLY —
//   Xvfb :99 (engine fullscreen) + PulseAudio, no chromium, no ffmpeg feed.
//   The compositing moves to OBS on the outside: feed.mjs pushes
//   x11grab+pulse -> mediamtx RTMP only while the phase is ingame, and the
//   overlay views are OBS browser sources off the hwstream worker. Phase
//   switching is therefore OBS's job and videoSetPhase is a no-op here.
//
// Every process is supervised: if one dies it is respawned with backoff
// (self-healing inside the loop, complementing Docker's restart: always).
//
// env (both modes):
//   STREAM_WIDTH/HEIGHT display + grab size (default 1280x720)
//   STREAM_DISPLAY      X display id for the engine (default :99)
//   STREAM_VIDEO=1      legacy full-stack mode
//   STREAM_DISPLAYS=1   OBS mode: displays + pulse only

import { spawn } from "node:child_process";

const ENABLED = process.env.STREAM_VIDEO === "1" || process.env.STREAM_DISPLAYS === "1";
const DISPLAYS_ONLY = process.env.STREAM_DISPLAYS === "1";
const W = Number(process.env.STREAM_WIDTH ?? 1280);
const H = Number(process.env.STREAM_HEIGHT ?? 720);
const FPS = Number(process.env.STREAM_FPS ?? 30);
const DISPLAY = process.env.STREAM_DISPLAY ?? ":99";
const RTMP_URL = process.env.RTMP_URL ?? "";
const RECORD_FILE = process.env.STREAM_RECORD ?? "";
const SLIDES_URL = (process.env.WORKER_URL ?? "").replace(/\/$/, "") + "/stream/";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[video]", ...a);

const specs = new Map();   // name -> {cmd, args, env, after}
const procs = new Map();   // name -> child process
const backoff = new Map(); // name -> last respawn ms

function run(name) {
  if (!ENABLED) return;
  const spec = specs.get(name);
  if (!spec) return;
  const old = procs.get(name);
  if (old && old.exitCode == null) return;
  log("spawn", name, spec.cmd);
  let p;
  try {
    p = spawn(spec.cmd, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    log(`spawn ${name} failed: ${e.message}`);
    return;
  }
  procs.set(name, p);
  p.on("error", (e) => log(`${name} spawn error: ${e.message}`));
  p.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) process.stderr.write(`[${name}] ${s}\n`);
  });
  p.on("exit", (code, sig) => {
    if (procs.get(name) === p) procs.delete(name);
    log(`${name} exited code=${code} sig=${sig}`);
    const wait = Math.min(30000, 2000 * Math.pow(2, backoff.get(name) ?? 0));
    backoff.set(name, Math.min(4, (backoff.get(name) ?? 0) + 1));
    setTimeout(() => { backoff.set(name, Math.max(0, (backoff.get(name) ?? 1) - 1)); run(name); }, wait);
  });
  // per-process post-start setup (pulse sink wiring)
  if (spec.after) setTimeout(() => spec.after().catch((e) => log(name, "after failed:", e.message)), 2500);
}

function runOnce(cmd, args, env = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: 127, out: e.message });
      return;
    }
    p.on("error", () => resolve({ code: 127, out: "spawn failed" }));
    let out = "";
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => resolve({ code: code ?? -1, out }));
  });
}

export async function videoInit() {
  if (!ENABLED) {
    log("video disabled (no STREAM_VIDEO / STREAM_DISPLAYS)");
    return;
  }
  // the engine (spawned later by the agent) inherits these
  process.env.DISPLAY = DISPLAY;
  process.env.SDL_AUDIODRIVER = "pulseaudio";
  process.env.PULSE_SERVER = "unix:/run/pulse/native";

  specs.set("xvfb", {
    cmd: "Xvfb",
    args: [DISPLAY, "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp", "+extension", "GLX", "+render", "-noreset"],
  });
  specs.set("pulse", {
    cmd: "pulseaudio",
    args: ["--system=true", "--exit-idle-time=-1", "--log-target=stderr"],
    env: { XDG_RUNTIME_DIR: "/run/pulse" },
    after: async () => {
      // the null sink comes from /etc/pulse/system.pa; only assert the default
      await runOnce("pactl", ["set-default-sink", "hw"], { PULSE_SERVER: "unix:/run/pulse/native" });
      log("pulse sink 'hw' ready");
    },
  });

  if (DISPLAYS_ONLY) {
    run("xvfb");
    await new Promise((r) => setTimeout(r, 1500));
    run("pulse");
    log(`displays up: ${DISPLAY} ${W}x${H} (OBS mode: feed.mjs gates the ffmpeg push)`);
    return;
  }

  specs.set("chromium", {
    cmd: "chromium",
    args: ["--kiosk", "--no-sandbox", "--disable-dev-shm-usage", "--ozone-platform=x11",
      "--disable-infobars", "--noerrdialogs",
      // no window manager runs in the container: kiosk auto-sizing ends up
      // half the screen, so pin the window to the full display
      `--window-position=0,0`, `--window-size=${W},${H}`, "--force-device-scale-factor=1",
      SLIDES_URL],
    env: { DISPLAY },
  });
  const feedTarget = RTMP_URL || RECORD_FILE;
  if (feedTarget) {
    specs.set("ffmpeg", {
      cmd: "ffmpeg",
      args: [
        "-hide_banner", "-loglevel", "warning", "-y",
        "-f", "x11grab", "-framerate", String(FPS), "-video_size", `${W}x${H}`, "-i", DISPLAY,
        "-f", "pulse", "-i", "hw.monitor",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-pix_fmt", "yuv420p", "-g", "60", "-b:v", "4500k", "-maxrate", "5000k", "-bufsize", "8000k",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
        "-f", "flv", feedTarget,
      ],
      env: { PULSE_SERVER: "unix:/run/pulse/native" },
    });
  } else {
    log("no RTMP_URL / STREAM_RECORD — display runs without a feed");
  }

  // display first; pulse + chromium follow, ffmpeg last (grabs once both exist)
  run("xvfb");
  await new Promise((r) => setTimeout(r, 1500));
  run("pulse");
  run("chromium");
  if (feedTarget) setTimeout(() => run("ffmpeg"), 4000);
  log(`video stack up: display ${DISPLAY} ${W}x${H}, feed ${feedTarget || "(none)"}`);
}

// Legacy mode only: switch what the stream shows (slides for slate/lobby/
// countdown, engine for the live game). There is no window manager in the
// container, so this is a raw X restack: xdotool windowraise (wmctrl's EWMH
// activation would need a WM). The engine window is titled exactly
// "Hedgewars" (uStore.pas); the slides page title starts with
// "Hedgewars Stream". In OBS mode there is nothing to restack — the feed is
// gated per phase by feed.mjs and scene switching lives in OBS.
export function videoSetPhase(phase) {
  if (!ENABLED || DISPLAYS_ONLY) return;
  const pattern = phase === "ingame" ? "^Hedgewars$" : "^Hedgewars Stream";
  runOnce("xdotool", ["search", "--onlyvisible", "--name", pattern, "windowraise"])
    .then((r) => { if (r.code !== 0) log(`xdotool ${phase}: window not up yet`); });
}

// fullscreen engine geometry so the window exactly fills the capture; the
// engine is paced to the capture rate, because without a vsync on the virtual
// display it would otherwise render ~125 frames a second nobody sees
export function videoEngineArgs() {
  if (!ENABLED) return [];
  return ["--fullscreen", "--fullscreen-width", String(W), "--fullscreen-height", String(H),
    "--frame-interval", String(Math.round(1000 / FPS))];
}
