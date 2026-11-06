// feed.mjs — M12: the live feed to OBS, ffmpeg-driven, phase-gated.
//
// The stream stack ships a static RTMP server (mediamtx, see
// docker-compose.yml) next to the game. While the game engine is running an
// active game (phase "ingame") this module spawns the capture pipeline
//
//   ffmpeg -f x11grab (Xvfb display) -f pulse (engine mix)
//        -> rtmp://<RTMP_URL>   (flv; default the local mediamtx)
//
// and respawns it with backoff if it dies while the phase is still ingame.
// The moment the phase leaves ingame the feed is killed: mediamtx has no
// active track, so OBS's Media Source (rtmp://<host>:1935/live/game) shows
// nothing — that is the "disabled when no game runs" behaviour, for free.
// Scene switching stays entirely in OBS (browser sources for the overlay
// views off the hwstream worker + this media source).
//
// env:
//   FEED_URL            push target (e.g. rtmp://127.0.0.1:1935/live/game
//                       against the compose mediamtx). EMPTY disables the
//                       feed entirely — local proofs run without it.
//   STREAM_WIDTH/HEIGHT grab size (default 1280x720)
//   STREAM_DISPLAY      X display the engine runs on (default :99)
//   STREAM_FPS          default 30
//   PULSE_SOURCE        pulse source to record (default hw.monitor)
//   FFMPEG_BIN          default ffmpeg
//
// NOTE: this is the OBS-targeting sibling of video.mjs's always-on RTMP push.
// The legacy pipeline (STREAM_VIDEO=1 -> slate in the feed -> $RTMP_URL)
// remains untouched for the no-OBS path; run EITHER mode, not both.

import { spawn } from "node:child_process";

const FEED_URL = process.env.FEED_URL ?? "";
const W = Number(process.env.STREAM_WIDTH ?? 1280);
const H = Number(process.env.STREAM_HEIGHT ?? 720);
const DISPLAY = process.env.STREAM_DISPLAY ?? ":99";
const FPS = Number(process.env.STREAM_FPS ?? 30);
const PULSE_SOURCE = process.env.PULSE_SOURCE ?? "hw.monitor";
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
// the tap (tap.mjs) feeds the same server straight from the engine
const TAP = process.env.STREAM_TAP === "1";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[feed]", ...a);

let proc = null;      // active ffmpeg child, null when the feed is off
let active = false;   // phase wants the feed
let backoff = 0;

function spawnFeed() {
  const args = [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    // a deep thread queue lets the grabber ride out a slow frame instead of
    // blocking, which would grow the delay until OBS shows a stale picture
    "-thread_queue_size", "512",
    "-f", "x11grab", "-framerate", String(FPS), "-video_size", `${W}x${H}`, "-i", DISPLAY,
    "-thread_queue_size", "512",
    "-f", "pulse", "-i", PULSE_SOURCE,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", String(FPS * 2),
    "-b:v", "4500k", "-maxrate", "5000k", "-bufsize", "8000k",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-flush_packets", "1", "-muxdelay", "0",
    "-f", "flv", FEED_URL,
  ];
  log("feed up ->", FEED_URL);
  let p;
  try {
    p = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    log(`spawn failed: ${e.message}`);
    return null;
  }
  p.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) process.stderr.write(`[ffmpeg] ${s}\n`);
  });
  p.on("exit", (code, sig) => {
    if (proc === p) proc = null;
    log(`ffmpeg exited code=${code} sig=${sig}`);
    // while the phase still asks for a feed, self-heal with backoff
    if (active) {
      const wait = Math.min(20000, 1500 * Math.pow(2, backoff++));
      setTimeout(() => {
        if (active && !proc) {
          backoff = 0;
          proc = spawnFeed();
        }
      }, wait);
    }
  });
  return p;
}

/** Phase entry point: keep a feed alive iff the phase is ingame. */
export function setFeedPhase(phase) {
  if (!FEED_URL || TAP) return; // no push target configured — feed disabled
  const want = phase === "ingame";
  if (want === active) return;
  active = want;
  backoff = 0;
  if (want) {
    if (!proc) proc = spawnFeed();
  } else if (proc) {
    log("feed down (not ingame)");
    proc.kill("SIGTERM");
    // ffmpeg should exit on SIGTERM; force after a grace period
    const p = proc;
    setTimeout(() => {
      if (proc === p && p.exitCode == null) p.kill("SIGKILL");
    }, 2000);
    proc = null;
  }
}

/** True when the feed is currently being kept alive. */
export function feedActive() {
  return active;
}
