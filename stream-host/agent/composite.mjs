// composite.mjs - FEED_MODE=composite: one encoder for the whole session.
//
// The classic tap (tap.mjs) starts one ffmpeg per game, so the stream ends between
// games and OBS has to pull it, compose it and encode it again. Here the agent owns
// the engine's tap ports and one ffmpeg lives from the agent's start to its end:
//
//   engine --video (NV12)--> agent -+-> [overlay blended in] -+
//          --audio (s16le)--> agent -+-> [or silence]          +-> ffmpeg -> RTMP (Twitch)
//   no engine: a slate frame (solid colour + the overlay) and silence ------+
//
// * The engine connects to the agent's ports (TAP_VIDEO_PORT/TAP_AUDIO_PORT), not to
//   ffmpeg. The agent keeps reading whatever the engine sends, so a slow encoder can
//   never hold the game up; it is the output that drops.
// * ffmpeg connects to two ports of the agent (random, on 127.0.0.1) and gets exactly
//   FPS frames and 44100 samples per second, in lock step: video frame n carries
//   n/FPS seconds and the audio written with it, so there is no drift between them and
//   the timestamps (taken from the frame count, not from a clock) are monotonic.
//   Every slot takes the newest complete engine frame (whole frames only, so the
//   switch between slate and game always falls on a frame boundary), or the slate.
// * The overlay (a worker /stream/ page, rendered about once a second by overlay.mjs)
//   is blended in by the agent: a small box per frame on game frames, once a second
//   into the cached slate frame. ffmpeg's own overlay filter was measured and is
//   slower and adds up to a second of delay (stream-host/experiments/ffmpeg-composite.md).
//
// env (besides the ones tap.mjs documents):
//   FEED_MODE         composite switches this on (default: one ffmpeg per game, tap.mjs)
//   FEED_URL          push target. Or set TWITCH_KEY (and TWITCH_INGEST, default the
//                     Sydney ingest) and the URL is rtmp://<ingest>/app/<key>. The key is
//                     never logged.
//   OVERLAY_GAME_URL  page drawn over the game (default <WORKER_URL>/stream/scoreboard.html)
//   OVERLAY_SLATE_URL page drawn over the slate (default the same)
//   OVERLAY           0 turns the overlay off
//   SLATE_COLOR       background of the slate, 0xRRGGBB (default 0d0b1e)
//   AUDIO_KBPS        AAC bitrate (default 160)
//   AUDIO_LEAD_MS     the audio track runs this far ahead of the video in the muxer (default 50, 0 = in step)
//   QSV_ASYNC_DEPTH, QSV_PRESET, QSV_LOW_POWER, QSV_SCENARIO, QSV_LOW_DELAY_BRC, QSV_EXTRA
//                     Quick Sync tuning, see qsvArgs()
//   FEED_PRIORITY     high (default) | normal: the agent and its ffmpeg run at high process priority. The frame
//                     clock needs a wake-up every few ms; on a busy PC a normal priority process was measured
//                     stalling for 100+ ms at a time (p99 80 ms vs 7 ms at high priority)
//   COMPOSITE_STATS   1 logs the forwarder's counters every 10 s

import net from "node:net";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import { startOverlay } from "./overlay.mjs";
import { blendLayer, solidNV12, rgbToYuv } from "./layer.mjs";

const env = process.env;
export const compositeEnabled = env.FEED_MODE === "composite";

const W = Number(env.STREAM_WIDTH ?? 1920);
const H = Number(env.STREAM_HEIGHT ?? 1080);
const FPS = Number(env.STREAM_FPS ?? 60);
const KBPS = Number(env.VIDEO_KBPS ?? 6000);
const AUDIO_KBPS = Number(env.AUDIO_KBPS ?? 160);
const VIDEO_PORT = Number(env.TAP_VIDEO_PORT ?? 19001);
const AUDIO_PORT = Number(env.TAP_AUDIO_PORT ?? 19002);
const FFMPEG_BIN = env.FFMPEG_BIN ?? "ffmpeg";
const FRAME = (W * H * 3) / 2;
const RATE = 44100;
const GAME_STALL_MS = Number(env.GAME_STALL_MS ?? 1500);   // a silent engine this long falls back to the slate
const AUDIO_JITTER_MS = Number(env.AUDIO_JITTER_MS ?? 50); // how much engine audio waits before it is let out
const AUDIO_LEAD_MS = Number(env.AUDIO_LEAD_MS ?? 50);     // audio runs this far ahead of the video in the muxer (see below)
const MAX_BACKLOG = FRAME * 4;                             // output bytes waiting before slots are dropped

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[composite]", ...a);

/** Where the stream goes. Never log the whole thing: it can hold the stream key. */
export function feedUrl() {
  if (env.FEED_URL) return env.FEED_URL;
  if (env.TWITCH_KEY) {
    return `rtmp://${env.TWITCH_INGEST ?? "aps20.contribute.live-video.net"}/app/${env.TWITCH_KEY}`;
  }
  return "rtmp://127.0.0.1:1935/live/game";
}
const FEED = feedUrl();
export function redact(text) {
  let s = String(text);
  try {
    const u = new URL(FEED);
    const secret = u.pathname.split("/").filter(Boolean).slice(1).join("/") + u.search;
    if (secret.length >= 12) s = s.split(secret).join("<key>");
    s = s.split(FEED).join(`${u.protocol}//${u.host}/${u.pathname.split("/")[1] ?? ""}/<key>`);
  } catch {}
  if (env.TWITCH_KEY) s = s.split(env.TWITCH_KEY).join("<key>");
  return s;
}

// ------------------------------------------------------------ encoder args --
function haveEncoder(name) {
  const r = spawnSync(FFMPEG_BIN, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return new RegExp(`\\s${name}\\s`).test(r.stdout ?? "");
}
function qsvWorks() {
  const r = spawnSync(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2:r=10",
    "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw", "-vf", "format=nv12,hwupload", "-c:v", "h264_qsv", "-frames:v", "2", "-f", "null", "-"],
  { encoding: "utf8", timeout: 20000 });
  return r.status === 0;
}

/** Picks the encoder: ENCODER if set, else qsv on Windows; falls back to software when it does not work. */
export function pickEncoder() {
  const want = env.ENCODER ?? (process.platform === "win32" ? "qsv" : "x264");
  if (want === "qsv" && !qsvWorks()) {
    log("Quick Sync does not work here, falling back to software");
    return haveEncoder("libx264") ? "x264" : haveEncoder("libopenh264") ? "openh264" : "x264";
  }
  if (want === "x264" && !haveEncoder("libx264") && haveEncoder("libopenh264")) {
    log("this ffmpeg has no libx264, using openh264");
    return "openh264";
  }
  return want;
}

const TAGS = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

export function videoArgs(encoder) {
  const rate = `${KBPS}k`;
  const gop = String(FPS * 2);
  switch (encoder) {
    case "qsv":
      // low-latency set (measured, see the experiment notes): one frame in flight, no B frames,
      // no look ahead (that would switch the rate control from CBR to LA), game streaming hints
      return [
        "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
        "-vf", `${TAGS},hwupload=extra_hw_frames=${env.QSV_EXTRA_FRAMES ?? 32}`,
        "-c:v", "h264_qsv", "-preset", env.QSV_PRESET ?? "veryfast",
        "-async_depth", env.QSV_ASYNC_DEPTH ?? "1",
        ...(env.QSV_LOW_POWER ? ["-low_power", env.QSV_LOW_POWER] : []),
        ...(env.QSV_SCENARIO && env.QSV_SCENARIO !== "0" ? ["-scenario", env.QSV_SCENARIO] : []),
        ...(env.QSV_LOW_DELAY_BRC === "1" ? ["-low_delay_brc", "1"] : []),
        "-profile:v", "high", "-b:v", rate, "-maxrate", rate, "-bufsize", env.QSV_BUFSIZE ?? rate,
        "-g", gop, "-bf", "0", "-look_ahead", "0", "-idr_interval", "0",
      ];
    case "nvenc":
      return [
        "-vf", TAGS,
        "-c:v", "h264_nvenc", "-preset", env.ENCODER_PRESET ?? "p4", "-tune", "ull", "-rc", "cbr", "-zerolatency", "1", "-delay", "0",
        "-profile:v", "high", "-b:v", rate, "-maxrate", rate, "-bufsize", rate, "-g", gop, "-bf", "0",
      ];
    case "openh264":
      return [
        "-vf", `${TAGS},format=yuv420p`,
        "-c:v", "libopenh264", "-profile:v", "main", "-rc_mode", "bitrate", "-b:v", rate, "-maxrate", rate,
        "-g", gop, "-allow_skip_frames", "0",
      ];
    default:
      return [
        "-vf", `${TAGS},format=yuv420p`,
        "-c:v", "libx264", "-preset", env.ENCODER_PRESET ?? "veryfast", "-tune", "zerolatency", "-profile:v", "high",
        "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", rate,
        "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-bf", "0",
        "-x264-params", "nal-hrd=cbr:force-cfr=1",
      ];
  }
}

export function ffmpegArgs(encoder, audioPort, videoPort, out = FEED) {
  // experiment switches (see the findings): FEED_DEBUG_NOAUDIO=1 leaves the audio out, FEED_DEBUG_WALLCLOCK=1 stamps
  // the video with the arrival time instead of the frame count
  const noAudio = env.FEED_DEBUG_NOAUDIO === "1";
  return [
    "-hide_banner", "-loglevel", env.FFMPEG_LOGLEVEL ?? "warning", "-nostdin",
    ...(env.TAP_STATS === "1" ? ["-stats", "-stats_period", "5"] : []),
    // raw video and audio from the agent, which writes exactly FPS frames and RATE samples a second,
    // so the timestamps are the counts; video first: the agent starts its clock when that connects
    "-probesize", String(FRAME), "-analyzeduration", "0", "-fflags", "+nobuffer",
    ...(env.FEED_DEBUG_WALLCLOCK === "1" ? ["-use_wallclock_as_timestamps", "1"] : []),
    "-f", "rawvideo", "-pix_fmt", "nv12", "-video_size", `${W}x${H}`, "-framerate", String(FPS), "-i", `tcp://127.0.0.1:${videoPort}`,
    ...(noAudio ? [] : [
      "-probesize", "4096", "-analyzeduration", "0", "-fflags", "+nobuffer",
      "-f", "s16le", "-ar", String(RATE), "-ac", "2", "-i", `tcp://127.0.0.1:${audioPort}`,
    ]),
    "-map", "0:v", ...(noAudio ? [] : ["-map", "1:a"]),
    ...videoArgs(encoder),
    "-fps_mode", "passthrough",
    ...(noAudio ? ["-an"] : ["-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ar", String(RATE)]),
    "-flush_packets", "1", "-muxdelay", "0", "-muxpreload", "0",
    "-f", "flv", ...(/^rtmps?:/.test(out) ? ["-rtmp_live", "live", "-rtmp_buffer", "0"] : []), out,
  ];
}

// ------------------------------------------------------------------ start --
/**
 * Starts the listeners, the encoder and the overlay. Resolves when the listeners are up.
 * Returns { engineArgs, env, stats(), stop() }.
 */
export async function compositeStart({ outUrl = FEED, overlayGameUrl, overlaySlateUrl } = {}) {
  const raise = (pid) => {
    if (env.FEED_PRIORITY === "normal") return;
    try { os.setPriority(pid, os.constants.priority.PRIORITY_HIGH); } catch (e) { log("could not raise priority:", e.message); }
  };
  raise(process.pid);
  const encoder = pickEncoder();
  const stats = {
    encoder, ffmpegStarts: 0, slots: 0, gameSlots: 0, slateSlots: 0, dupSlots: 0, droppedSlots: 0, lateSlots: 0,
    maxLateMs: 0, engineFrames: 0, engineFramesUsed: 0, games: 0, audioUnderflows: 0, audioTrimmed: 0, engineAudioBytes: 0, engineAudioChunks: 0, audioGapMaxMs: 0, audioGapsOver40: 0,
    blendMs: 0, blendCount: 0, maxBlendMs: 0, ffmpegPid: 0, chromePid: 0, startedAt: Date.now(),
  };

  // --- the slate and the layers ---
  const [sy, su, sv] = rgbToYuv(parseInt(env.SLATE_COLOR ?? "0d0b1e", 16));
  const slateBase = solidNV12(W, H, sy, su, sv);
  let slateFrame = slateBase;
  const layers = { slate: null, game: null };
  let phase = "slate";
  const rebuildSlate = () => {
    if (!layers.slate) { slateFrame = slateBase; return; }
    const f = Buffer.from(slateBase);   // a new buffer: the old one may still be on its way to ffmpeg
    blendLayer(f, W, H, layers.slate);
    slateFrame = f;
  };

  // --- engine side: the agent listens, the engine connects per game ---
  const rxBufs = [Buffer.allocUnsafe(FRAME), Buffer.allocUnsafe(FRAME)];
  let engV = null, rx = rxBufs[0], rxFill = 0, latest = null;
  let latestAt = 0, haveGame = false;
  const videoSrv = net.createServer((s) => {
    if (engV) engV.destroy();
    engV = s; rxFill = 0; latest = null; haveGame = false; stats.games++;
    s.setNoDelay(true);
    log("engine video connected");
    s.on("data", (c) => {
      let off = 0;
      while (off < c.length) {
        const n = Math.min(FRAME - rxFill, c.length - off);
        c.copy(rx, rxFill, off, off + n);
        rxFill += n; off += n;
        if (rxFill === FRAME) {              // a whole frame: from here on it can be shown
          latest = rx; rx = rx === rxBufs[0] ? rxBufs[1] : rxBufs[0];
          rxFill = 0; latestAt = performance.now(); haveGame = true; stats.engineFrames++;
          pump();
        }
      }
    });
    const gone = () => {
      if (engV === s) { engV = null; haveGame = false; latest = null; log("engine video gone"); }
    };
    s.on("close", gone);
    s.on("error", gone);
  });

  const fifo = []; let fifoBytes = 0, engA = null, audioArmed = false, lastAudioAt = 0;
  const audioSrv = net.createServer((s) => {
    if (engA) engA.destroy();
    engA = s; fifo.length = 0; fifoBytes = 0; audioArmed = false; lastAudioAt = 0;
    log("engine audio connected");
    s.on("data", (c) => {
      const tn = performance.now();
      if (lastAudioAt) { const g = tn - lastAudioAt; if (g > stats.audioGapMaxMs) stats.audioGapMaxMs = Math.round(g); if (g > 40) stats.audioGapsOver40++; }
      lastAudioAt = tn;
      stats.engineAudioBytes += c.length; stats.engineAudioChunks++;
      fifo.push(c); fifoBytes += c.length;
      // beyond the jitter buffer + 80 ms the oldest audio is dropped: after an engine stall the burst that follows would
      // otherwise leave the sound permanently late against the picture
      const maxBytes = (RATE * 4 * (AUDIO_JITTER_MS + 80)) / 1000;
      while (fifoBytes > maxBytes && fifo.length > 1) { fifoBytes -= fifo.shift().length; stats.audioTrimmed++; }
    });
    const gone = () => { if (engA === s) { engA = null; log("engine audio gone"); } };
    s.on("close", gone);
    s.on("error", gone);
  });

  const listen = (srv, port) => new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(port, "127.0.0.1", () => res(srv.address().port));
  });
  await listen(videoSrv, VIDEO_PORT);
  await listen(audioSrv, AUDIO_PORT);
  log(`tap ports ${VIDEO_PORT} (video) and ${AUDIO_PORT} (audio) are the agent's; encoder ${encoder} ${W}x${H}@${FPS} ${KBPS}k -> ${redact(outUrl)}`);

  // --- encoder side: ffmpeg connects here ---
  let encV = null, encA = null, ffProc = null, t0 = 0, slot = 0, vFrames = 0, aSamples = 0;
  const encVSrv = net.createServer((s) => { s.setNoDelay(true); s.on("error", () => {}); encV = s; s.on("close", () => { if (encV === s) encV = null; }); begin(); });
  const encASrv = net.createServer((s) => { s.setNoDelay(true); s.on("error", () => {}); encA = s; s.on("close", () => { if (encA === s) encA = null; }); begin(); });
  const encVPort = await listen(encVSrv, 0), encAPort = await listen(encASrv, 0);

  // ffmpeg opens its inputs in order (video, then audio) and reads from each until it has probed
  // it, so the video is fed at once, in real time; the audio, which connects a moment later, gets
  // everything it has missed in one go (it is only 176 kB a second)
  function begin() {
    if (encV && !t0) { t0 = performance.now(); slot = 0; log("encoder connected, clock running"); }
  }

  const pool = []; let poolFree = [];
  for (let i = 0; i < 6; i++) { const b = Buffer.allocUnsafe(FRAME); pool.push(b); poolFree.push(b); }

  function audioChunk(samples) {
    const need = samples * 4, out = Buffer.alloc(need);       // zeros: silence
    if (!engA && !fifoBytes) { audioArmed = false; return out; }
    if (!audioArmed) {
      if (fifoBytes < (RATE * 4 * AUDIO_JITTER_MS) / 1000) return out;   // still filling: silence
      audioArmed = true;
    }
    let got = 0;
    while (got < need && fifo.length) {
      const head = fifo[0], take = Math.min(need - got, head.length);
      head.copy(out, got, 0, take); got += take;
      if (take === head.length) fifo.shift(); else fifo[0] = head.subarray(take);
      fifoBytes -= take;
    }
    // the shortfall stays silent and the buffer is refilled to its target before it plays again (without that it
    // would run on empty and drop out every few ms). Only a gap while the engine is actively sending counts: it
    // sends nothing while a game loads
    if (got < need) { audioArmed = false; if (performance.now() - lastAudioAt < 150) stats.audioUnderflows++; }
    return out;
  }

  let pumping = false;
  function pump() {
    if (!t0 || !encV || pumping) return;
    pumping = true;
    try {
      const now = performance.now();
      let due = Math.floor(((now - t0) * FPS) / 1000) + 1 - slot;
      if (due <= 0) return;
      if (due > FPS * 2) { log(`behind by ${due} slots, resyncing`); t0 += (due - 1) * 1000 / FPS; due = 1; }
      if (due > 1) { stats.lateSlots++; stats.maxLateMs = Math.max(stats.maxLateMs, ((due - 1) * 1000) / FPS); }
      for (let i = 0; i < Math.min(due, 24); i++, slot++) {
        stats.slots++;
        // backlog towards ffmpeg: drop this slot (video and its audio together), never stall the engine
        if (encV.writableLength > MAX_BACKLOG) {
          stats.droppedSlots++;
          // ffmpeg has stopped reading (a hung or failed encoder): restart it, the engine is unaffected
          if (!stuckSince) stuckSince = now;
          else if (now - stuckSince > 3000) { stuckSince = 0; log("ffmpeg is not reading, restarting it"); try { ffProc?.kill(); } catch {} }
          continue;
        }
        stuckSince = 0;
        const live = engV && haveGame && latest && now - latestAt < GAME_STALL_MS;
        let frame;
        if (live) {
          const out = poolFree.pop();
          if (!out) { stats.droppedSlots++; continue; }
          latest.copy(out);
          if (layers.game) {
            const b0 = performance.now();
            blendLayer(out, W, H, layers.game);
            const ms = performance.now() - b0;
            stats.blendMs += ms; stats.blendCount++; if (ms > stats.maxBlendMs) stats.maxBlendMs = ms;
          }
          frame = out;
          stats.gameSlots++;
          if (latestAt <= lastUsedAt) stats.dupSlots++; else stats.engineFramesUsed++;
          lastUsedAt = latestAt;
          if (phase !== "game") setPhase("game");
          encV.write(out, () => poolFree.push(out));
        } else {
          if (phase !== "slate") setPhase("slate");
          stats.slateSlots++;
          encV.write(slateFrame);
        }
        vFrames++;
      }
      if (encA) {
        // The flv muxer holds a video packet until an audio packet with a later timestamp has arrived, and an AAC
        // packet is 1024 samples: audio written exactly in step with the video holds every frame back by
        // 25-100 ms (measured). So the audio track runs AUDIO_LEAD_MS ahead: it starts with that much silence and the
        // engine audio then plays that much late against the picture (60 ms is within what viewers cannot notice).
        const want = Math.floor((vFrames * RATE) / FPS) + Math.round((AUDIO_LEAD_MS * RATE) / 1000) - aSamples;
        if (want > 0) { encA.write(audioChunk(want)); aSamples += want; }
      }
    } finally {
      pumping = false;
    }
  }
  let lastUsedAt = 0, stuckSince = 0;
  const pumpTimer = setInterval(pump, 2);

  // --- the overlay ---
  const base = (env.WORKER_URL ?? "").replace(/\/$/, "");
  const urlGame = overlayGameUrl ?? env.OVERLAY_GAME_URL ?? `${base}/stream/scoreboard.html`;
  const urlSlate = overlaySlateUrl ?? env.OVERLAY_SLATE_URL ?? urlGame;
  let ov = null;
  const overlayOn = env.OVERLAY !== "0" && (overlayGameUrl || env.OVERLAY_GAME_URL || base);
  function setPhase(p) {
    phase = p;
    if (!ov || urlGame === urlSlate) return;   // one page for both: nothing to switch
    layers[p] = null;                          // show nothing until the other page has been drawn
    if (p === "slate") rebuildSlate();
    ov.setUrl(p === "game" ? urlGame : urlSlate);
  }
  if (overlayOn) {
    try {
      ov = await startOverlay({
        url: urlSlate, width: W, height: H, log,
        onLayer: (layer) => {
          if (urlGame === urlSlate) layers.slate = layers.game = layer; else layers[phase] = layer;
          if (layers.slate === layer) rebuildSlate();
        },
      });
      log("overlay renderer up:", redact(urlSlate), urlGame === urlSlate ? "" : `(game: ${urlGame})`);
    } catch (e) {
      log("overlay unavailable, streaming without it:", e.message);
    }
  }

  // --- the one encoder, restarted if it dies (the engine and the listeners stay as they are) ---
  let stopping = false, backoff = 0;
  function startFfmpeg() {
    if (stopping) return;
    encV?.destroy(); encA?.destroy();
    encV = encA = null; t0 = 0; slot = 0; vFrames = 0; aSamples = 0;
    const args = ffmpegArgs(encoder, encAPort, encVPort, outUrl);
    stats.ffmpegStarts++;
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    ffProc = proc; stats.ffmpegPid = proc.pid;
    raise(proc.pid);
    const started = Date.now();
    proc.stderr.on("data", (d) => {
      const s = redact(d.toString().trim());
      if (s) process.stderr.write(`[ffmpeg] ${s}\n`);
    });
    proc.on("error", (e) => log("ffmpeg could not start:", redact(e.message)));
    proc.on("exit", (code, sig) => {
      log(`ffmpeg exited code=${code} sig=${sig}`);
      if (ffProc === proc) ffProc = null;
      if (stopping) return;
      backoff = Date.now() - started > 30000 ? 0 : Math.min(backoff + 1, 5);
      setTimeout(startFfmpeg, 1000 * Math.max(1, backoff));
    });
  }
  startFfmpeg();

  const eld = monitorEventLoopDelay({ resolution: 5 }); eld.enable();
  const statTimer = env.COMPOSITE_STATS === "1" ? setInterval(() => log("stats", JSON.stringify(snapshot())), 10000) : null;
  function snapshot() {
    return {
      ...stats, ffmpegPid: ffProc?.pid ?? 0, chromePid: 0,
      blendMsAvg: stats.blendCount ? +(stats.blendMs / stats.blendCount).toFixed(2) : 0,
      overlay: ov ? ov.stats : null, phase,
      loopDelayMs: { p50: +(eld.percentile(50) / 1e6).toFixed(1), p99: +(eld.percentile(99) / 1e6).toFixed(1), max: +(eld.max / 1e6).toFixed(1) },
    };
  }

  return {
    stats: snapshot,
    get ffmpegPid() { return ffProc?.pid ?? 0; },
    async stop() {
      stopping = true;
      clearInterval(pumpTimer); if (statTimer) clearInterval(statTimer);
      encV?.end(); encA?.end();
      await new Promise((r) => setTimeout(r, 800));
      try { ffProc?.kill(); } catch {}
      engV?.destroy(); engA?.destroy();
      videoSrv.close(); audioSrv.close(); encVSrv.close(); encASrv.close();
      if (ov) await ov.stop();
    },
  };
}
