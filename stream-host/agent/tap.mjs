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
//   TAP_FILTER        gpu | sw: where qsv converts and flips the frames (default gpu)
//   TAP_VIDEO_PORT/TAP_AUDIO_PORT  local ports (default 19001/19002)
//   FFMPEG_BIN        default ffmpeg

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
const TAP_FILTER = process.env.TAP_FILTER ?? "gpu";
const VIDEO_PORT = Number(process.env.TAP_VIDEO_PORT ?? 19001);
const AUDIO_PORT = Number(process.env.TAP_AUDIO_PORT ?? 19002);
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[tap]", ...a);

// the frames arrive bottom row first; every encoder needs them flipped and in
// its own pixel format. Constant bitrate with a keyframe every two seconds
// is what the streaming services ask for.
function encoderArgs() {
  const rate = `${KBPS}k`;
  const gop = String(FPS * 2);
  switch (ENCODER) {
    case "qsv":
      return [
        ...(TAP_FILTER === "gpu"
          ? ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
             "-vf", "hwupload=extra_hw_frames=32,vpp_qsv=format=nv12:transpose=vflip"]
          : ["-vf", "vflip,format=nv12"]),
        "-c:v", "h264_qsv", "-preset", PRESET,
        "-b:v", rate, "-maxrate", rate, "-bufsize", rate,
        "-g", gop, "-bf", "0", "-look_ahead", "0",
      ];
    case "nvenc":
      return [
        "-vf", "vflip,format=nv12",
        "-c:v", "h264_nvenc", "-preset", PRESET, "-tune", "ll", "-rc", "cbr",
        "-b:v", rate, "-maxrate", rate, "-bufsize", rate, "-g", gop, "-bf", "0",
      ];
    default:
      return [
        "-vf", "vflip,format=yuv420p",
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
    // audio first: the engine connects its audio when it starts up and its video
    // with the first frame, and ffmpeg opens its inputs in this order
    "-use_wallclock_as_timestamps", "1",
    "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", `tcp://127.0.0.1:${AUDIO_PORT}?listen`,
    "-use_wallclock_as_timestamps", "1",
    "-f", "rawvideo", "-pix_fmt", "bgra", "-video_size", `${W}x${H}`, "-i", `tcp://127.0.0.1:${VIDEO_PORT}?listen`,
    ...encoderArgs(),
    "-fps_mode", "cfr", "-r", String(FPS),
    "-af", "aresample=async=1000",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-flush_packets", "1", "-muxdelay", "0",
    "-f", "flv", FEED_URL,
  ];
}

/** Starts the encoder for one game; null when the tap is off. */
export function tapStart() {
  if (!ENABLED) return null;
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
    engineArgs: [
      "--stream-video-port", String(VIDEO_PORT),
      "--stream-audio-port", String(AUDIO_PORT),
      "--hidden", "--nodampen",
      "--width", String(W), "--height", String(H),
      "--frame-interval", String(Math.max(1, Math.floor(1000 / FPS))),
    ],
    // no real sound device and, off Windows, no display server either
    env: {
      SDL_AUDIODRIVER: "dummy",
      ...(process.platform === "win32" ? {} : { SDL_VIDEODRIVER: "offscreen" }),
    },
    // the engine closing its sockets ends ffmpeg; this only mops up after a crash
    stop() {
      setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) proc.kill("SIGTERM");
      }, 3000);
    },
  };
}
