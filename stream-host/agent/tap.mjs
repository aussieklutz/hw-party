// tap.mjs - the live feed straight from the engine, with no screen in between.
//
// The engine (`--stream-video-port`, `--stream-audio-port`, `--hidden`) renders
// into a window nobody sees and writes every frame (raw BGRA) and its mixed
// audio (s16le, 44100 Hz, stereo) to two local tcp ports. An ffmpeg started
// before the engine listens on both ports, encodes and pushes to the RTMP
// server. There is no Xvfb, no PulseAudio and no screen grab, so this runs the
// same on Windows as on Linux, and can use a hardware encoder.
//
// One ffmpeg lives as long as one game: the engine closing its sockets ends it.
//
// env:
//   STREAM_TAP        1 enables the tap (default off)
//   FEED_URL          push target (default rtmp://127.0.0.1:1935/live/game)
//   STREAM_WIDTH/HEIGHT/FPS  size and rate of the game (default 1920x1080 at 60)
//   ENCODER           qsv | nvenc | x264 (default qsv on Windows, x264 elsewhere)
//   ENCODER_PRESET    encoder preset (qsv: medium, nvenc: p4, x264: veryfast)
//   VIDEO_KBPS        constant bitrate in kbit/s (default 6000)
//   TAP_FORMAT        nv12 | bgra: what the engine sends (default nv12: the graphics
//                     card converts, a third of the data, nothing left to flip)
//   TAP_FILTER        gpu | sw: where qsv converts and flips bgra frames (default gpu)
//   TAP_VIDEO_PORT/TAP_AUDIO_PORT  local ports (default 19001/19002); TAP_HINT_PORT 19003 (composite hog close-up)
//   TAP_STATS         1 logs ffmpeg's own progress (frame rate, duplicated and dropped frames)
//   FFMPEG_BIN        default ffmpeg
//   FEED_MODE         composite: one ffmpeg for the whole session, see composite.mjs

import { spawn } from "node:child_process";

const ENABLED = process.env.STREAM_TAP === "1";
const FEED_URL = process.env.FEED_URL ?? "rtmp://127.0.0.1:1935/live/game";
const W = Number(process.env.STREAM_WIDTH ?? 1920);
const H = Number(process.env.STREAM_HEIGHT ?? 1080);
const FPS = Number(process.env.STREAM_FPS ?? 60);
const ENCODER = process.env.ENCODER ?? (process.platform === "win32" ? "qsv" : "x264");
const PRESET = process.env.ENCODER_PRESET
  ?? { qsv: "medium", nvenc: "p4", x264: "veryfast" }[ENCODER];
const KBPS = Number(process.env.VIDEO_KBPS ?? 6000);
const TAP_FORMAT = process.env.TAP_FORMAT ?? "nv12";
const TAP_FILTER = process.env.TAP_FILTER ?? "gpu";
const VIDEO_PORT = Number(process.env.TAP_VIDEO_PORT ?? 19001);
const AUDIO_PORT = Number(process.env.TAP_AUDIO_PORT ?? 19002);
const HINT_PORT = Number(process.env.TAP_HINT_PORT ?? 19003);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[tap]", ...a);

// nv12 frames arrive ready for any encoder. bgra frames arrive bottom row
// first and every encoder needs them flipped and in its own pixel format.
// Constant bitrate with a keyframe every two seconds is what the streaming
// services ask for.
const NV12 = TAP_FORMAT === "nv12";
// the engine's conversion is BT.709 limited range; say so in the stream
const TAGS = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

function encoderArgs() {
  const rate = `${KBPS}k`;
  const gop = String(FPS * 2);
  switch (ENCODER) {
    case "qsv":
      return [
        ...(NV12
          ? ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
             "-vf", `${TAGS},hwupload=extra_hw_frames=32`]
          : TAP_FILTER === "gpu"
            ? ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
               "-vf", "hwupload=extra_hw_frames=32,vpp_qsv=format=nv12:transpose=vflip"]
            : ["-vf", "vflip,format=nv12"]),
        "-c:v", "h264_qsv", "-preset", PRESET,
        "-b:v", rate, "-maxrate", rate, "-bufsize", rate,
        "-g", gop, "-bf", "0", "-look_ahead", "0",
      ];
    case "nvenc":
      return [
        "-vf", NV12 ? TAGS : "vflip,format=nv12",
        "-c:v", "h264_nvenc", "-preset", PRESET, "-tune", "ll", "-rc", "cbr",
        "-b:v", rate, "-maxrate", rate, "-bufsize", rate, "-g", gop, "-bf", "0",
      ];
    default:
      return [
        "-vf", NV12 ? `${TAGS},format=yuv420p` : "vflip,format=yuv420p",
        "-c:v", "libx264", "-preset", PRESET, "-tune", "zerolatency",
        "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", rate,
        "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
        "-x264-params", "nal-hrd=cbr:force-cfr=1",
      ];
  }
}

function ffmpegArgs() {
  return [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    ...(process.env.TAP_STATS === "1" ? ["-stats", "-stats_period", "5"] : []),
    // audio first: the engine connects its audio when it starts up and its video
    // with the first frame, and ffmpeg opens its inputs in this order
    "-probesize", "32768", "-analyzeduration", "0", "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "512",
    "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", `tcp://127.0.0.1:${AUDIO_PORT}?listen`,
    "-analyzeduration", "0", "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "64",
    "-f", "rawvideo", "-pix_fmt", NV12 ? "nv12" : "bgra", "-video_size", `${W}x${H}`, "-i", `tcp://127.0.0.1:${VIDEO_PORT}?listen`,
    ...encoderArgs(),
    "-fps_mode", "cfr", "-r", String(FPS),
    "-af", "aresample=async=1000",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-flush_packets", "1", "-muxdelay", "0",
    "-f", "flv", FEED_URL,
  ];
}

// the engine's side of the tap: the same arguments and environment whoever listens on the ports
function engineSide() {
  return {
    engineArgs: [
      "--stream-video-port", String(VIDEO_PORT),
      "--stream-audio-port", String(AUDIO_PORT),
      // composite mode with the hog close-up: the engine also reports where the active hog and its target are
      ...(process.env.FEED_MODE === "composite" && process.env.HOG_VIEW !== "0" && process.env.HOG_VIEW_HINT !== "0"
        ? ["--stream-hint-port", String(HINT_PORT)] : []),
      "--hidden", "--nodampen",
      "--width", String(W), "--height", String(H),
      "--frame-interval", String(Math.max(1, Math.floor(1000 / FPS))),
    ],
    // no real sound device and, off Windows, no display server either
    env: {
      SDL_AUDIODRIVER: "dummy",
      ...(NV12 ? { HW_TAP_FORMAT: "nv12" } : {}),
      ...(process.platform === "win32" ? {} : { SDL_VIDEODRIVER: "offscreen" }),
    },
  };
}

/**
 * Starts the encoder for one game; null when the tap is off. With FEED_MODE=composite there is
 * no encoder per game: composite.mjs owns the ports for the whole session and only the engine's
 * arguments are handed out (it needs NV12, which is the default).
 */
export function tapStart() {
  if (!ENABLED) return null;
  if (process.env.FEED_MODE === "composite") return { ...engineSide(), stop() {} };
  const args = ffmpegArgs();
  log(`encoder ${ENCODER} ${W}x${H}@${FPS} ${KBPS}k -> ${FEED_URL}`);
  let proc;
  try {
    proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    log(`spawn failed: ${e.message}`);
    return null;
  }
  proc.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) process.stderr.write(`[ffmpeg] ${s}\n`);
  });
  proc.on("exit", (code, sig) => log(`ffmpeg exited code=${code} sig=${sig}`));
  return {
    ...engineSide(),
    // the engine closing its sockets ends ffmpeg; this only mops up after a crash
    stop() {
      setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) proc.kill("SIGTERM");
      }, 3000);
    },
  };
}
