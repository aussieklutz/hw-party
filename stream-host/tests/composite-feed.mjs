// composite-feed.mjs - proves FEED_MODE=composite without Twitch or a real game: a fake
// engine plays games into the agent's tap ports (slate -> game -> slate -> game -> slate)
// while ONE ffmpeg pushes to a local mediamtx, and a plain reader records what a viewer
// gets. Then it checks the recording: one ffmpeg for the whole run, dts monotonic, a
// keyframe every 2 s, no B frames, no audio gap, and it extracts frames of each phase to
// look at (the overlay must be visible in both).
//
//   node tests/composite-feed.mjs
// env: TEST_W/TEST_H/TEST_FPS (default 1280x720@60), ENCODER (qsv | x264 | openh264; default openh264
//      here so that the test needs no GPU), TEST_PORT (19350), TEST_TAP (19101), HW_STAGE (folder
//      with ffmpeg\ and mediamtx\), TEST_OUT (scratch folder), PHASES ("6,8,5,8,5" seconds:
//      slate, game, slate, game, slate), OVERLAY_URL (default tests/fixtures/overlay-stub.html)
import { mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FakeEngine } from "./fake-engine.mjs";
import { startMediamtx, startRecorder, analyze, sleep, tools, acquireGpuLock } from "./composite-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const W = Number(process.env.TEST_W ?? 1280), H = Number(process.env.TEST_H ?? 720), FPS = Number(process.env.TEST_FPS ?? 60);
const PORT = Number(process.env.TEST_PORT ?? 19350), TAP = Number(process.env.TEST_TAP ?? 19101);
const OUT = process.env.TEST_OUT ?? "C:/Users/clint/.t3/scratch/exp/ffmpeg-composite/out";
const phases = (process.env.PHASES ?? "6,8,5,8,5").split(",").map(Number);
mkdirSync(OUT, { recursive: true });

Object.assign(process.env, {
  FEED_MODE: "composite", STREAM_WIDTH: String(W), STREAM_HEIGHT: String(H), STREAM_FPS: String(FPS),
  TAP_VIDEO_PORT: String(TAP), TAP_AUDIO_PORT: String(TAP + 1), FFMPEG_BIN: tools().ffmpeg,
  ENCODER: process.env.ENCODER ?? "openh264", VIDEO_KBPS: process.env.VIDEO_KBPS ?? "6000",
});
const url = `rtmp://127.0.0.1:${PORT}/live/composite`;
process.env.FEED_URL = url;
const overlayUrl = process.env.OVERLAY_URL ?? pathToFileURL(join(here, "fixtures", "overlay-stub.html")).href;

const { compositeStart } = await import("../agent/composite.mjs");

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(ok ? "PASS" : "FAIL", name, detail); };

const releaseLock = process.env.ENCODER === "qsv" ? await acquireGpuLock() : () => {};   // Quick Sync is shared: take the lock
const mtx = await startMediamtx(PORT);
let comp, rec;
try {
  comp = await compositeStart({ overlayGameUrl: overlayUrl });
  const file = join(OUT, "feed.flv");
  // wait for the publisher, then record
  rec = startRecorder(url, file);
  // the timeline starts once the viewer is receiving
  for (let i = 0; i < 300 && !(existsSync(file) && statSync(file).size > 0); i++) await sleep(100);
  await sleep(1000);
  const t0 = Date.now();
  const marks = [];   // [phase name, start s, end s] on the recording's own clock (since the recorder start)
  let t = 0;
  for (const [i, secs] of phases.entries()) {
    const game = i % 2 === 1;
    let eng = null;
    if (game) { eng = new FakeEngine({ videoPort: TAP, audioPort: TAP + 1, width: W, height: H }); await eng.start(); }
    marks.push([game ? "game" : "slate", (Date.now() - t0) / 1000, (Date.now() - t0) / 1000 + secs]);
    await sleep(secs * 1000);
    eng?.stop();
    t += secs;
  }
  await sleep(500);
  const st = comp.stats();
  await rec.stop();
  if (rec.err()) console.log("[recorder]", rec.err().trim());
  console.log("stats", JSON.stringify(st));
  check("one ffmpeg for the whole run", st.ffmpegStarts === 1, `(${st.ffmpegStarts} started)`);
  check("the engine connected once per game", st.games === Math.floor(phases.length / 2), `(${st.games})`);
  check("game frames were used", st.gameSlots > 0 && st.slateSlots > 0, `(game ${st.gameSlots}, slate ${st.slateSlots}, dropped ${st.droppedSlots})`);
  if (!existsSync(file)) { check("recording exists", false); } else {
    const r = analyze(file, { fps: FPS });
    console.log(JSON.stringify({ ...r, streams: undefined }, null, 1));
    console.log("streams", JSON.stringify(r.streams));
    for (const p of r.problems) check("stream property", false, p);
    check("no stream problems", r.problems.length === 0);
    check("about 60 fps out", Math.abs(r.fps - FPS) < 1.5, `(${r.fps.toFixed(2)})`);
    // what a viewer sees, 4 pictures a second at 64x36: game (light green field) or slate (dark), and
    // whether the overlay panel (top left) and badge (bottom right) are drawn over it
    const ff = tools().ffmpeg;
    const g = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "fps=4,scale=64:36:flags=area,format=gray", "-f", "rawvideo", "-"],
      { maxBuffer: 1 << 28 });
    const px = g.stdout, n = Math.floor(px.length / (64 * 36));
    const region = (f, x0, y0, x1, y1) => { const v = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(px[f * 64 * 36 + y * 64 + x]); return v; };
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
    const runs = [];
    for (let f = 0; f < n; f++) {
      const bg = mean(region(f, 0, 30, 8, 36));
      const kind = bg > 90 ? "game" : "slate";
      const panel = sd(region(f, 2, 2, 28, 9)) > 12, badge = sd(region(f, 52, 28, 62, 34)) > 6 || mean(region(f, 52, 28, 62, 34)) > bg + 15 || mean(region(f, 52, 28, 62, 34)) < bg - 15;
      const tag = `${kind}${panel ? "+panel" : ""}${badge ? "+badge" : ""}`;
      if (runs.at(-1)?.tag === tag) runs.at(-1).n++; else runs.push({ tag, n: 1, from: f / 4 });
    }
    console.log("phases seen by the viewer:", runs.map((r) => `${r.tag} ${r.n / 4}s`).join(" | "));
    const kinds = runs.filter((r) => r.n >= 4).map((r) => r.tag.split("+")[0]);
    const collapsed = kinds.filter((k, i) => k !== kinds[i - 1]);
    check("slate -> game -> slate -> game -> slate seen", collapsed.join(",") === phases.map((_, i) => (i % 2 ? "game" : "slate")).join(","), `(${collapsed.join(",")})`);
    const stable = runs.filter((r) => r.n >= 4);
    check("overlay panel visible in game and slate", ["game", "slate"].every((k) => stable.filter((r) => r.tag.startsWith(k)).every((r) => r.tag.includes("panel"))));
    spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", "fps=1,scale=320:-1,tile=6x6", "-frames:v", "1", join(OUT, "sheet.png")]);
    console.log("contact sheet", join(OUT, "sheet.png"));
  }
} finally {
  await comp?.stop().catch(() => {});
  mtx.kill();
  releaseLock();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
