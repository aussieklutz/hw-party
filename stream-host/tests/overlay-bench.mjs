// overlay-bench.mjs - what does it cost to composite a 1080p60 overlay inside ffmpeg?
//
// Synthetic sources (lavfi, so the engine and Node are not involved), no -re: the speed ffmpeg reaches is its
// capacity (1.0x = exactly real time at 60 fps, below that the stream could not keep up). `-benchmark` gives the
// user CPU seconds. Then the 1 fps overlay problem: with -re on both inputs, how late do frames leave an
// `overlay` whose second input only produces one frame a second (framesync waits for the next overlay frame)?
//
//   node tests/overlay-bench.mjs
// env: HW_STAGE (folder with ffmpeg\), SECONDS (10), SKIP_QSV=1
import { spawn } from "node:child_process";
import { tools, withGpuLock } from "./composite-lib.mjs";

const SECONDS = Number(process.env.SECONDS ?? 10);
const ff = tools().ffmpeg;
const base = ["-hide_banner", "-nostdin", "-benchmark", "-stats", "-loglevel", "info"];
const main = ["-f", "lavfi", "-i", "color=c=0x305030:s=1920x1080:r=60,format=nv12"];
const ovFull = ["-f", "lavfi", "-i", "color=c=0x101030@0.6:s=1920x1080:r=60,format=yuva420p"];
const ovBox = ["-f", "lavfi", "-i", "color=c=0x101030@0.6:s=1200x180:r=60,format=yuva420p"];
const qsvInit = ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw"];
const enc = ["-c:v", "h264_qsv", "-async_depth", "1", "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "6000k", "-g", "120", "-bf", "0", "-look_ahead", "0"];
const t = String(SECONDS);

const variants = [
  { name: "no overlay, null output (generator only)", qsv: false, args: [...main, "-t", t, "-f", "null", "-"] },
  { name: "CPU overlay, full frame 1920x1080 yuva420p, null output", qsv: false,
    args: [...main, ...ovFull, "-t", t, "-filter_complex", "[0:v]format=yuv420p[b];[b][1:v]overlay=0:0:format=yuv420,format=nv12", "-f", "null", "-"] },
  { name: "CPU overlay, box 1200x180, null output", qsv: false,
    args: [...main, ...ovBox, "-t", t, "-filter_complex", "[0:v]format=yuv420p[b];[b][1:v]overlay=40:300:format=yuv420,format=nv12", "-f", "null", "-"] },
  { name: "QSV encode only (no overlay)", qsv: true,
    args: [...qsvInit, ...main, "-t", t, "-vf", "hwupload=extra_hw_frames=32", ...enc, "-f", "null", "-"] },
  { name: "CPU overlay full frame + QSV encode", qsv: true,
    args: [...qsvInit, ...main, ...ovFull, "-t", t, "-filter_complex", "[0:v]format=yuv420p[b];[b][1:v]overlay=0:0:format=yuv420,format=nv12,hwupload=extra_hw_frames=32", ...enc, "-f", "null", "-"] },
  { name: "CPU overlay box 1200x180 + QSV encode", qsv: true,
    args: [...qsvInit, ...main, ...ovBox, "-t", t, "-filter_complex", "[0:v]format=yuv420p[b];[b][1:v]overlay=40:300:format=yuv420,format=nv12,hwupload=extra_hw_frames=32", ...enc, "-f", "null", "-"] },
  { name: "overlay_qsv full frame (bgra uploaded) + QSV encode", qsv: true,
    args: [...qsvInit, ...main, "-f", "lavfi", "-i", "color=c=0x101030@0.6:s=1920x1080:r=60,format=bgra", "-t", t, "-filter_complex",
      "[0:v]hwupload=extra_hw_frames=32[b];[1:v]hwupload=extra_hw_frames=32[o];[b][o]overlay_qsv=0:0", ...enc, "-f", "null", "-"] },
  { name: "overlay_qsv box 1200x180 + QSV encode", qsv: true,
    args: [...qsvInit, ...main, "-f", "lavfi", "-i", "color=c=0x101030@0.6:s=1200x180:r=60,format=bgra", "-t", t, "-filter_complex",
      "[0:v]hwupload=extra_hw_frames=32[b];[1:v]hwupload=extra_hw_frames=32[o];[b][o]overlay_qsv=40:300", ...enc, "-f", "null", "-"] },
];

function run(args) {
  return new Promise((res) => {
    const p = spawn(ff, [...base, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => {
      const speeds = [...err.matchAll(/speed=\s*([\d.]+)x/g)].map((m) => Number(m[1]));
      const fps = [...err.matchAll(/fps=\s*([\d.]+)/g)].map((m) => Number(m[1]));
      const b = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(err);
      const failed = /Error|Invalid|Cannot|not supported|Failed/i.test(err.split("\n").filter((l) => !l.includes("frame=")).join("\n"));
      res({ speed: speeds.at(-1), fps: fps.at(-1), utime: b && Number(b[1]), stime: b && Number(b[2]), rtime: b && Number(b[3]), failed, tail: failed ? err.split("\n").filter((l) => l && !l.includes("frame=")).slice(-3).join(" | ") : "" });
    });
  });
}

console.log("variant | speed (1.0x = real time) | ffmpeg CPU (user+sys s per s of video) ");
for (const v of variants) {
  if (v.qsv && process.env.SKIP_QSV) continue;
  const r = await (v.qsv ? withGpuLock(() => run(v.args)) : run(v.args));
  const cpu = r.utime != null ? ((r.utime + r.stime) / SECONDS).toFixed(2) : "?";
  console.log(`${v.name} | ${r.speed ?? "?"}x (${r.fps ?? "?"} fps) | ${cpu} cores${r.failed ? " | FAILED: " + r.tail : ""}`);
}

// the 1 fps overlay: with -re, when does each output frame leave overlay?
console.log("\n1 fps overlay input, -re on both: output frame delay (arrival - pts), seconds");
await new Promise((res) => {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error",
    "-re", "-f", "lavfi", "-i", "color=c=0x305030:s=320x180:r=30,format=yuv420p",
    "-re", "-f", "lavfi", "-i", "color=c=0x101030@0.6:s=160x90:r=1,format=yuva420p",
    "-t", "8", "-filter_complex", "[0:v][1:v]overlay=10:10:format=yuv420,format=gray", "-f", "rawvideo", "pipe:1"];
  const p = spawn(ff, args, { stdio: ["ignore", "pipe", "inherit"] });
  const FR = 320 * 180;
  let buf = 0, n = 0;
  const t0 = performance.now();
  const delays = [];
  p.stdout.on("data", (d) => {
    buf += d.length;
    while (buf >= FR) { buf -= FR; delays.push((performance.now() - t0) / 1000 - n / 30); n++; }
  });
  p.on("exit", () => {
    const d = delays.slice(30);   // after the first second
    console.log(`frames ${delays.length}; delay min ${Math.min(...d).toFixed(2)} max ${Math.max(...d).toFixed(2)} s (first frame left after ${delays[0].toFixed(2)} s)`);
    res();
  });
});
