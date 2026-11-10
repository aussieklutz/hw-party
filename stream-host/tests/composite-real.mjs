// composite-real.mjs - one real game through the real phone page, with the real engine tap and the
// composite feed: the worker (BASE, default http://127.0.0.1:8791, started by you) , the agent with
// FEED_MODE=composite, a local mediamtx, a recorder that plays viewer, and tests/weapons-cdp.mjs as the
// player (it proves from the engine's log that the weapon was used). Afterwards the recording is analysed
// and frames are extracted so the game and the slate can be looked at.
//
//   node tests/composite-real.mjs
// env: HW_STAGE (folder with ffmpeg\, mediamtx\, game\), BASE, TEST_PORT (19350), TEST_TAP (19101),
//      TEST_W/TEST_H/TEST_FPS (1280x720@60), ENCODER (qsv), WEAPON (Bazooka), TEST_OUT, OVERLAY_URL (the worker's scoreboard)
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startMediamtx, startRecorder, analyze, sleep, tools, acquireGpuLock } from "./composite-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.HW_STAGE ?? "C:/Users/clint/.t3/scratch/exp/ffmpeg-composite";
const BASE = process.env.BASE ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.TEST_PORT ?? 19350), TAP = Number(process.env.TEST_TAP ?? 19101);
const W = process.env.TEST_W ?? "1280", H = process.env.TEST_H ?? "720", FPS = process.env.TEST_FPS ?? "60";
const ENCODER = process.env.ENCODER ?? "qsv";
const OUT = process.env.TEST_OUT ?? `${root}/out-real`;
const USERDIR = join(tmpdir(), "hw-exp-ffc");
mkdirSync(OUT, { recursive: true });
rmSync(USERDIR, { recursive: true, force: true });
mkdirSync(USERDIR, { recursive: true });
const url = `rtmp://127.0.0.1:${PORT}/live/real`;

const release = ENCODER === "qsv" ? await acquireGpuLock() : () => {};
const mtx = await startMediamtx(PORT);
const agentLog = join(OUT, "agent.log");
let agent, rec, player;
try {
  const { openSync } = await import("node:fs");
  const fd = openSync(agentLog, "w");
  agent = spawn(process.execPath, [join(here, "..", "agent", "host-agent.mjs")], {
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      WORKER_URL: BASE, STREAM_HOST_SECRET: "test-host-secret-1", ROOM_MODE: "dynamic", POP_COUNT: "1",
      ENGINE_BIN: `${root}/game/hwengine.exe`, ENGINE_PREFIX: `${root}/game/Data`, ENGINE_USERPREFIX: USERDIR,
      FFMPEG_BIN: tools().ffmpeg, STREAM_TAP: "1", FEED_MODE: "composite", FEED_URL: url, ENCODER,
      STREAM_WIDTH: W, STREAM_HEIGHT: H, STREAM_FPS: FPS, TAP_VIDEO_PORT: String(TAP), TAP_AUDIO_PORT: String(TAP + 1),
      OVERLAY_GAME_URL: process.env.OVERLAY_URL ?? `${BASE}/stream/scoreboard.html`, OVERLAY_CDP_PORT: "9712",
      AMMO_ALL: "1", HOG_HEALTH: "500", SD_TURNS: "500", ROUND_WAIT_MS: "4000", LOBBY_WAIT_MS: "60000", SLATE_MS: "6000",
      COMPOSITE_STATS: "1",
    },
  });
  console.log("agent pid", agent.pid);
  const file = join(OUT, "feed.flv");
  rec = startRecorder(url, file, { retryMs: 60000 });
  await sleep(12000);   // the slate is on the air
  player = spawn(process.execPath, [join(here, "weapons-cdp.mjs")], {
    stdio: "inherit",
    env: { ...process.env, BASE, CHROME: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", CDP_PORT: "9711",
      OUT_DIR: join(OUT, "phone"), ENGINE_LOGS: join(USERDIR, "Logs"), AGENT_LOG: agentLog, WEAPONS: process.env.WEAPON ?? "Bazooka", MAX_MINUTES: "4" },
  });
  const code = await new Promise((res) => player.once("exit", res));
  console.log("player exited", code);
  await sleep(14000);   // game over, the slate again
  await rec.stop();
  const log = readFileSync(agentLog, "utf8");
  const count = (re) => (log.match(re) ?? []).length;
  console.log("agent log: engine video connects", count(/engine video connected/g), "| ffmpeg starts: ", count(/encoder connected, clock running/g), "| ffmpeg exited", count(/ffmpeg exited/g));
  const stats = [...log.matchAll(/\[composite\] stats (\{.*\})/g)].map((m) => JSON.parse(m[1])).at(-1);
  console.log("last forwarder stats", JSON.stringify(stats));
  if (existsSync(file) && statSync(file).size > 0) {
    const r = analyze(file, { fps: Number(FPS) });
    console.log(JSON.stringify({ ...r, streams: undefined }));
    console.log("streams", JSON.stringify(r.streams));
    const ff = tools().ffmpeg;
    const { spawnSync } = await import("node:child_process");
    spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", "fps=1/3,scale=320:-1,tile=6x4", "-frames:v", "1", join(OUT, "sheet.png")]);
    console.log("contact sheet", join(OUT, "sheet.png"));
  } else console.log("no recording");
} finally {
  try { player?.kill(); } catch {}
  // the agent's engine and ffmpeg end with it; kill only what this run started
  try { agent?.kill(); } catch {}
  await sleep(3000);
  const { spawnSync } = await import("node:child_process");
  spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' -and ($_.CommandLine -like '*hw-exp-ffc*' -or $_.CommandLine -like '*hw-overlay-*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
  mtx.kill();
  release();
}
process.exit(0);
