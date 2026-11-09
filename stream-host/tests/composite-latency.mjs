// composite-latency.mjs - ground truth latency and load of the feed paths, no Twitch involved.
//
// A fake engine (own process) writes NV12 frames that flash white once a second and logs the
// time of each flash write. A reader on a local mediamtx (ffmpeg with nobuffer/low_delay, 32x18
// gray frames to a pipe) timestamps the arrival of each flash. latency = arrival - write. The
// reader's own decode and pipe time is included, and is the same for every path.
//
//   MODE=composite  FEED_MODE=composite: the persistent encoder (agent/composite.mjs)
//   MODE=baseline   the per-game ffmpeg of agent/tap.mjs as it is today
//
// env: MODE, TEST_W/TEST_H/TEST_FPS (1920x1080@60), DURATION (24 s of game), ENCODER (qsv), LOCK=1 (take the GPU
//      lock; default on for qsv), OVERLAY=0 (composite: no overlay), QSV_* (see composite.mjs),
//      LABEL (name in the output), TEST_PORT (19350), TEST_TAP (19101), HW_STAGE, OVERLAY_URL
import { spawn } from "node:child_process";
import os from "node:os";
import { writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startMediamtx, sleep, tools, withGpuLock, cpuSeconds, pidsByCommandLine, gpuSample } from "./composite-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const W = Number(process.env.TEST_W ?? 1920), H = Number(process.env.TEST_H ?? 1080), FPS = Number(process.env.TEST_FPS ?? 60);
const PORT = Number(process.env.TEST_PORT ?? 19350), TAP = Number(process.env.TEST_TAP ?? 19101);
const SECONDS = Number(process.env.DURATION ?? 24);
const MODE = process.env.MODE ?? "composite";
const ENCODER = process.env.ENCODER ?? "qsv";
const LABEL = process.env.LABEL ?? `${MODE}-${ENCODER}`;
const url = `rtmp://127.0.0.1:${PORT}/live/lat`;

Object.assign(process.env, {
  STREAM_TAP: "1", STREAM_WIDTH: String(W), STREAM_HEIGHT: String(H), STREAM_FPS: String(FPS),
  TAP_VIDEO_PORT: String(TAP), TAP_AUDIO_PORT: String(TAP + 1), FFMPEG_BIN: tools().ffmpeg, ENCODER, FEED_URL: url,
  ...(MODE === "composite" ? { FEED_MODE: "composite" } : {}),
});
const overlayUrl = process.env.OVERLAY_URL ?? pathToFileURL(join(here, "fixtures", "overlay-stub.html")).href;

async function run() {
  const mtx = await startMediamtx(PORT);
  let host = null, engine = null, reader = null;
  const flashes = [], arrivals = [];
  let engineInfo = null;
  try {
    host = spawn(process.execPath, [join(here, "composite-host.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, MODE } });
    const hostLines = [];
    let hbuf = "";
    host.stdout.on("data", (d) => {
      hbuf += d;
      let i;
      while ((i = hbuf.indexOf("\n")) >= 0) { const l = hbuf.slice(0, i); hbuf = hbuf.slice(i + 1); hostLines.push(l); if (!l.startsWith("READY") && !l.startsWith("STATS")) console.log(l); }
    });
    const waitLine = async (prefix, from = 0) => { for (let i = 0; i < 600; i++) { const l = hostLines.slice(from).find((x) => x.startsWith(prefix)); if (l) return l; await sleep(100); } throw new Error("no " + prefix); };
    const ready = await waitLine("READY");
    const startEngine = () => { engine = spawn(process.execPath, [join(here, "fake-engine-cli.mjs")], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, VIDEO_PORT: String(TAP), AUDIO_PORT: String(TAP + 1), W: String(W), H: String(H), FPS: "62.5", FLASH_EVERY: "1000", SECONDS: String(SECONDS) },
    });
    let buf = "";
    engine.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.flash) flashes.push(j.flash); if (j.stopped) engineInfo = j; } catch {}
      }
    });
    };
    // the reader: low latency, tiny gray frames
    const FR = 32 * 18;
    let rbuf = Buffer.alloc(0);
    const rstat = { n: 0, min: 255, max: 0 };
    const trace = [];
    const startReader = () => {
      reader = spawn(tools().ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "nobuffer", "-flags", "low_delay",
        "-probesize", "1000000", "-analyzeduration", "1500000", "-i", url, "-an", "-vf", "scale=32:18:flags=neighbor,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"],
      { stdio: ["ignore", "pipe", "inherit"] });
      try { os.setPriority(reader.pid, os.constants.priority.PRIORITY_HIGH); } catch {}
      reader.stdout.on("data", (d) => {
        rbuf = Buffer.concat([rbuf, d]);
        while (rbuf.length >= FR) {
          const t = performance.timeOrigin + performance.now();
          let sum = 0;
          for (let i = 0; i < FR; i++) sum += rbuf[i];
          const mean = sum / FR; rstat.n++; rstat.min = Math.min(rstat.min, mean); rstat.max = Math.max(rstat.max, mean);
          trace.push([Math.round(t), Math.round(mean)]);
          if (mean > 200) arrivals.push(t);
          rbuf = rbuf.subarray(FR);
        }
      });
      reader.on("exit", () => { if (reader && !done) setTimeout(startReader, 500); });
    };
    let done = false;
    if (MODE === "baseline") { startEngine(); await sleep(1500); startReader(); }   // the per-game stream exists only while the engine runs
    else { await sleep(1500); startReader(); await sleep(7000); startEngine(); }      // composite: the slate is already on the air

    // load: CPU seconds and GPU engines over the middle of the run
    await sleep(8000);
    const ffPid = Number(ready.split(" ")[1]);
    const procs = { node: [host.pid], ffmpeg: ffPid ? [ffPid] : pidsByCommandLine(MODE === "baseline" ? `tcp://127.0.0.1:${TAP}?listen` : "never-matches"), chrome: pidsByCommandLine("hw-overlay-"), engine: [engine.pid] };
    const all = Object.values(procs).flat();
    const c0 = cpuSeconds(all), w0 = Date.now();
    const gpus = [];
    for (let i = 0; i < 4; i++) gpus.push(gpuSample([...procs.ffmpeg]));
    const c1 = cpuSeconds(all), w1 = Date.now();
    const secs = (w1 - w0) / 1000;
    const pct = (list) => Math.round(list.reduce((s, p) => s + ((c1[p] ?? 0) - (c0[p] ?? 0)), 0) / secs * 100);
    const load = { ffmpegPctOfCore: pct(procs.ffmpeg), chromePctOfCore: pct(procs.chrome), enginePctOfCore: pct(procs.engine), nodePctOfCore: pct(procs.node) };
    const gmax = {}, gall = {};
    for (const g of gpus) {
      for (const [k, v] of Object.entries(g.mine)) gmax[k] = Math.max(gmax[k] ?? 0, Math.round(v));
      for (const [k, v] of Object.entries(g.all)) gall[k] = Math.max(gall[k] ?? 0, Math.round(v));
    }
    await new Promise((res) => engine.once("exit", res));
    await sleep(1500);
    done = true;
    let fwd = null;
    if (MODE === "composite") { const n = hostLines.length; host.stdin.write("stats\n"); fwd = JSON.parse((await waitLine("STATS", n)).slice(6)); }

    // pair flashes and arrivals
    const lat = [];
    const joined = trace.length ? trace[0][0] + 2000 : Infinity;   // the reader needs a moment to join
    for (const f of flashes.filter((x) => x > joined)) {
      const a = arrivals.find((t) => t > f && t - f < 5000);
      if (a) lat.push(a - f);
    }
    const nearest = flashes.filter((x) => x > joined).slice(0, 6).map((f) => { const d = arrivals.map((t) => t - f).filter((x) => x > -3000); return d.length ? Math.round(Math.min(...d.filter((x) => x > 0), 99999)) : null; });
    lat.sort((x, y) => x - y);
    const q = (p) => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]) : null);
    const result = {
      label: LABEL, engineInfo, readerFrames: rstat, arrivals: arrivals.length, firstNearest: nearest, mode: MODE, encoder: ENCODER, size: `${W}x${H}@${FPS}`, flashes: flashes.length, matched: lat.length,
      latencyMs: { min: q(0), p50: q(0.5), p90: q(0.9), max: q(1) }, load, gpuMyFfmpeg: gmax, gpuAllProcesses: gall,
      ...(fwd ? { forwarder: (({ slots, gameSlots, droppedSlots, lateSlots, maxLateMs, dupSlots, audioUnderflows, blendMsAvg, maxBlendMs, ffmpegStarts, engineFrames, loopDelayMs }) => ({ slots, gameSlots, droppedSlots, lateSlots, maxLateMs, dupSlots, audioUnderflows, blendMsAvg, maxBlendMs, ffmpegStarts, engineFrames, loopDelayMs }))(fwd) } : {}),
    };
    console.log("RESULT " + JSON.stringify(result));
    if (process.env.TRACE) writeFileSync(process.env.TRACE, JSON.stringify({ flashes: flashes.map(Math.round), trace }));
  } finally {
    try { reader?.kill(); } catch {}
    try { engine?.kill(); } catch {}
    try { host?.stdin.write("stop\n"); } catch {}
    await sleep(2500);
    try { host?.kill(); } catch {}
    mtx.kill();
  }
}

if (ENCODER === "qsv" && process.env.LOCK !== "0") await withGpuLock(run); else await run();
process.exit(0);
