// local-loop.mjs — M11.1/M11.2 end-to-end proof, entirely local (no Windows
// host): wrangler dev serves the hwstream worker, the agent cycles
// slate -> room -> queue admission -> game, and a scripted phone rides the
// queue, gets admitted, registers and plays. The engine is killed mid-game
// to prove the supervisor loops.
// usage: node tests/local-loop.mjs   (from stream-host/, after npm install in party/)
// env: HWENGINE (default build/bin/hwengine), HWPREFIX (default share/hedgewars/Data),
//      STREAM_HOST_SECRET (default: read from worker/.dev.vars)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WR_PORT = 8790;
const BASE = `http://127.0.0.1:${WR_PORT}`;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINE = process.env.HWENGINE ?? join(REPO, "build", "bin", "hwengine");
const PREFIX = process.env.HWPREFIX ?? join(REPO, "share", "hedgewars", "Data");
const devVar = (name) =>
  readFileSync(join(REPO, "stream-host", "worker", ".dev.vars"), "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1].trim();

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wr = spawn("node_modules/.bin/wrangler", ["dev", "--config", "../stream-host/worker/wrangler.toml", "--port", String(WR_PORT)], {
  cwd: `${REPO}/party`,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
wr.stdout.on("data", () => {});
wr.stderr.on("data", () => {});

for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/queue/state`);
    if (r.ok) break;
  } catch {}
  await sleep(1000);
}

const agent = spawn("node", ["agent/host-agent.mjs"], {
  cwd: `${REPO}/stream-host`,
  env: {
    ...process.env,
    WORKER_URL: BASE,
    ROOM_MODE: "dynamic",
    ENGINE_BIN: ENGINE,
    ENGINE_PREFIX: PREFIX,
    ENGINE_ARGS: "--stats-only --nosound --nomusic",
    LOBBY_WAIT_MS: "30000",
    ROUND_WAIT_MS: "12000",
    SLATE_MS: "2000",
    POP_COUNT: "1",
    STREAM_HOST_SECRET: process.env.STREAM_HOST_SECRET ?? devVar("STREAM_HOST_SECRET"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let agentLog = "";
agent.stdout.on("data", (d) => { agentLog += d; process.stdout.write(`[agent] ${d}`); });
agent.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));

const waitFor = async (needle, timeoutMs, label) => {
  const t0 = Date.now();
  for (;;) {
    if (agentLog.includes(needle)) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(500);
  }
};

// the scripted phone rides the queue (code-free join), gets admitted, plays
const phone = spawn("node", ["tests/fake-phone.mjs", BASE, "Streamy"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let phoneLog = "";
phone.stdout.on("data", (d) => { phoneLog += d; process.stdout.write(`[phone] ${d}`); });
phone.stderr.on("data", (d) => process.stderr.write(`[phone] ${d}`));
const phoneWaitFor = async (needle, timeoutMs, label) => {
  const t0 = Date.now();
  for (;;) {
    if (phoneLog.includes(needle)) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(500);
  }
};

try {
  await waitFor("room:", 40000, "agent room creation");
  check("agent created round room on hwstream", true);

  await phoneWaitFor("queue position", 20000, "queue join");
  check("phone joined the stream queue", true);

  await phoneWaitFor("team pre-built", 20000, "team pre-built while queued");
  check("team pre-built while queued", true);

  await phoneWaitFor("admitted to room", 40000, "queue admission");
  check("phone popped from the queue into the round", true);

  await phoneWaitFor("team registered", 20000, "team registration");
  check("phone registered its team", true);

  await waitFor("engine config sent: 2 teams", 20000, "cpu-filled engine config");
  check("cpu team filled the dynamic lobby (2 teams in config)", true);

  await phoneWaitFor("MINE", 150000, "the phone's turn");
  check("turn broadcast reached the admitted player", true);

  await sleep(6000);
  const { execSync } = await import("node:child_process");
  try { execSync("pkill -x hwengine"); } catch {}
  await waitFor("engine exited", 30000, "engine exit");
  check("engine exited (killed mid-game)", true);

  await phoneWaitFor("released", 30000, "release back to the queue");
  check("players released back to the queue", true);

  await sleep(20000);
  const games = (agentLog.match(/starting game with/g) ?? []).length;
  check(`agent cycled to the next round (games started: ${games})`, games >= 2);

  await phoneWaitFor("queue position", 30000, "re-queued position");
  check("player re-queued after the round", true);
} catch (e) {
  check(e.message, false);
} finally {
  try { process.kill(-agent.pid, "SIGKILL"); } catch {}
  try { process.kill(-phone.pid, "SIGKILL"); } catch {}
  try { process.kill(-wr.pid, "SIGKILL"); } catch {}
}
console.log(failures === 0 ? "\nLOCAL LOOP: ALL PASS" : `\nLOCAL LOOP: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
