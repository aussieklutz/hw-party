// composite-lib.mjs - helpers shared by the composite feed tests: a local mediamtx, a
// reader that records what a viewer of the RTMP output would get, and an analysis of the
// recording with ffprobe.
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tools() {
  const root = process.env.HW_STAGE ?? "C:/Users/clint/.t3/scratch/exp/ffmpeg-composite";
  return {
    ffmpeg: process.env.FFMPEG_BIN ?? `${root}/ffmpeg/ffmpeg.exe`,
    ffprobe: (process.env.FFMPEG_BIN ?? `${root}/ffmpeg/ffmpeg.exe`).replace(/ffmpeg(\.exe)?$/, "ffprobe$1"),
    mediamtx: process.env.MEDIAMTX_BIN ?? `${root}/mediamtx/mediamtx.exe`,
  };
}

/** mediamtx with only RTMP on the given port. */
export async function startMediamtx(port) {
  const t = tools();
  const dir = t.mediamtx.replace(/[\\/][^\\/]*$/, "");
  const p = spawn(t.mediamtx, [], {
    cwd: dir, stdio: process.env.MTX_VERBOSE ? "inherit" : "ignore",
    env: {
      ...process.env, MTX_RTMPADDRESS: `:${port}`, MTX_RTSP: "no", MTX_HLS: "no", MTX_WEBRTC: "no", MTX_SRT: "no",
      MTX_API: "no", ...(process.env.MTX_VERBOSE ? { MTX_LOGLEVEL: "debug" } : {}), MTX_METRICS: "no", MTX_PPROF: "no", MTX_PLAYBACK: "no", MTX_READTIMEOUT: "60s", MTX_WRITETIMEOUT: "60s",
    },
  });
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise((res) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
    if (ok) return p;
    await sleep(250);
  }
  p.kill();
  throw new Error("mediamtx did not start");
}

/** Records the stream like a plain viewer: ffmpeg copying the RTMP stream into a file; retries until the stream exists. */
export function startRecorder(url, file, { seconds = 0, retryMs = 30000 } = {}) {
  const t = tools();
  const args = ["-hide_banner", "-loglevel", "warning", "-fflags", "nobuffer", "-i", url, "-c", "copy",
    ...(seconds ? ["-t", String(seconds)] : []), "-f", "flv", "-y", file];
  const rec = { proc: null, err: "", startedAt: 0, stopping: false };
  const deadline = Date.now() + retryMs;
  const launch = () => {
    const p = spawn(t.ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
    p.stdin.on("error", () => {});
    rec.proc = p; rec.err = "";
    p.stderr.on("data", (d) => (rec.err += d));
    const t1 = Date.now();
    rec.startedAt = t1;
    p.on("exit", () => { if (!rec.stopping && Date.now() - t1 < 4000 && Date.now() < deadline) setTimeout(launch, 300); });
  };
  launch();
  return {
    get startedAt() { return rec.startedAt; },
    err: () => rec.err,
    stop: () => new Promise((res) => {
      rec.stopping = true;
      const p = rec.proc;
      if (!p || p.exitCode != null) return res();
      p.once("exit", res);
      try { p.stdin.write("q"); } catch {}   // ffmpeg quits cleanly on q
      setTimeout(() => { try { p.kill(); } catch {} res(); }, 5000);
    }),
  };
}

export function probe(file) {
  const t = tools();
  const r = spawnSync(t.ffprobe, ["-v", "error", "-show_entries", "packet=codec_type,pts,dts,duration,flags,size,pts_time,dts_time",
    "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,sample_rate,channels,has_b_frames", "-of", "json", file],
  { encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(r.stdout);
}

/** Checks a recording against what Twitch expects and what the composite feed promises. */
export function analyze(file, { fps = 60, kbps = 6000 } = {}) {
  const j = probe(file);
  const out = { streams: j.streams, problems: [] };
  const v = j.packets.filter((p) => p.codec_type === "video"), a = j.packets.filter((p) => p.codec_type === "audio");
  out.videoPackets = v.length; out.audioPackets = a.length;
  const mono = (arr, key) => {
    let bad = 0, maxGap = 0, minGap = 1e9, prev = null;
    for (const p of arr) {
      const x = Number(p[key]);
      if (prev != null) { if (x < prev) bad++; maxGap = Math.max(maxGap, x - prev); minGap = Math.min(minGap, x - prev); }
      prev = x;
    }
    return { bad, maxGap, minGap };
  };
  out.videoDts = mono(v, "dts_time"); out.audioDts = mono(a, "dts_time");
  out.videoPts = mono(v, "pts_time");
  out.bframes = v.filter((p) => p.pts !== p.dts).length;
  const keys = v.filter((p) => p.flags?.startsWith("K")).map((p) => Number(p.pts_time));
  out.keyframes = keys.length;
  out.keyIntervals = keys.slice(1).map((k, i) => +(k - keys[i]).toFixed(3));
  out.durationV = v.length ? Number(v.at(-1).pts_time) - Number(v[0].pts_time) : 0;
  out.durationA = a.length ? Number(a.at(-1).pts_time) - Number(a[0].pts_time) : 0;
  out.fps = v.length / out.durationV;
  const bytes = v.reduce((s, p) => s + Number(p.size), 0);
  out.videoKbps = Math.round((bytes * 8) / out.durationV / 1000);
  out.audioKbps = Math.round((a.reduce((s, p) => s + Number(p.size), 0) * 8) / out.durationA / 1000);
  // 1 s windows of video bytes: CBR should stay near the target
  const win = new Map();
  for (const p of v) { const k = Math.floor(Number(p.dts_time)); win.set(k, (win.get(k) ?? 0) + Number(p.size) * 8 / 1000); }
  const w = [...win.values()].slice(1, -1);
  out.maxWindowKbps = Math.round(Math.max(...w)); out.minWindowKbps = Math.round(Math.min(...w));
  // audio gaps: consecutive audio packet times should differ by one AAC frame (1024 / rate)
  const frame = 1024 / Number(j.streams.find((s) => s.codec_name === "aac")?.sample_rate ?? 44100);
  out.audioMaxGapMs = Math.round(out.audioDts.maxGap * 1000);
  out.audioFrameMs = +(frame * 1000).toFixed(1);
  if (out.videoDts.bad) out.problems.push(`${out.videoDts.bad} video dts go backwards`);
  if (out.audioDts.bad) out.problems.push(`${out.audioDts.bad} audio dts go backwards`);
  if (out.bframes) out.problems.push(`${out.bframes} packets with pts != dts (B frames)`);
  if (out.audioDts.maxGap > frame * 2.5) out.problems.push(`audio gap of ${out.audioMaxGapMs} ms`);
  if (out.videoDts.maxGap > 3 / fps) out.problems.push(`video gap of ${Math.round(out.videoDts.maxGap * 1000)} ms`);
  // Twitch wants a keyframe at least every 2 s; an encoder may add more (scene changes)
  const badKeys = out.keyIntervals.filter((k) => k > 2.1);
  out.extraKeyframes = out.keyIntervals.filter((k) => k < 1.9).length;
  if (badKeys.length) out.problems.push(`keyframe intervals over 2 s: ${badKeys.join(",")}`);
  return out;
}

/** Runs fn while holding the shared GPU lock (mkdir is atomic); always releases it. */
export async function withGpuLock(fn, { wait = 15 * 60 * 1000 } = {}) {
  const dir = process.env.GPU_LOCK ?? "C:/Users/clint/.t3/scratch/exp/gpu.lock";
  const { mkdirSync, rmdirSync } = await import("node:fs");
  const deadline = Date.now() + wait;
  for (;;) {
    try { mkdirSync(dir); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error("gave up waiting for the GPU lock");
      await sleep(20000);
    }
  }
  const release = () => { try { rmdirSync(dir); } catch {} };
  process.once("exit", release);
  try { return await fn(); } finally { release(); }
}

/** CPU seconds used so far by each pid (PowerShell Get-Process), plus the Chrome pids of an overlay (by its profile dir marker). */
export function cpuSeconds(pids) {
  if (!pids.length) return {};
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds)" }`], { encoding: "utf8" });
  const out = {};
  for (const l of r.stdout.split("\n")) { const [a, b] = l.trim().split(" "); if (a && b) out[a] = Number(b); }
  return out;
}
export function pidsByCommandLine(marker) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
  return r.stdout.split("\n").map((x) => Number(x.trim())).filter(Boolean);
}

/** GPU engine utilisation (Windows counters) summed per engine type for the given pids; one sample. */
export function gpuSample(pids) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { "$($_.InstanceName)|$($_.CookedValue)" }`],
  { encoding: "utf8", maxBuffer: 1 << 24 });
  const per = {}, all = {};
  for (const l of r.stdout.split("\n")) {
    const [inst, v] = l.trim().split("|");
    if (!inst) continue;
    const m = /pid_(\d+).*engtype_(\w+)/.exec(inst);
    if (!m) continue;
    all[m[2]] = (all[m[2]] ?? 0) + Number(v);
    if (pids.includes(Number(m[1]))) per[m[2]] = (per[m[2]] ?? 0) + Number(v);
  }
  return { mine: per, all };
}
