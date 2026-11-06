// lobby-shots.mjs - screenshots of the stream slide while a lobby fills, to SEE
// the teams grow and shrink (at least 3 rows a team, one more per seated
// player; 2 teams, or 3 and 4 in teams mode).
//
//   node tests/lobby-shots.mjs <outdir> [imposter|teams] [stages]
//   stages: comma list of target lobby sizes, e.g. 0,1,3,7,11,9,6  (a smaller
//           number than the current one drops the most recent players)
//
// needs the worker on BASE and headless Chrome (CHROME). The host agent runs
// lobby-only against the worker (no engine).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
const WebSocket = require("ws");
const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const WS = BASE.replace(/^http/, "ws");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SECRET = process.env.STREAM_HOST_SECRET
  ?? readFileSync(join(here, "..", "worker", ".dev.vars"), "utf8").match(/STREAM_HOST_SECRET=(.+)/)[1].trim();
const [outDir = "shots", MODE = "imposter", stagesArg = "0,1,3,7,11,9,6"] = process.argv.slice(2);
const stages = stagesArg.split(",").map(Number);
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qstate = async () => (await fetch(`${BASE}/api/queue/state`)).json();

const prevRoom = (await qstate()).roundRoom;
const agent = spawn(process.execPath, [join(here, "..", "agent", "host-agent.mjs")], {
  env: {
    ...process.env, WORKER_URL: BASE, ROOM_MODE: MODE, STREAM_HOST_SECRET: SECRET, ENGINE_BIN: process.execPath,
    LOBBY_WAIT_MS: "600000", ROUND_WAIT_MS: "600000", SLATE_MS: "1000",
  },
  stdio: "ignore",
});
for (let i = 0; i < 60; i++) {
  const s = await qstate();
  if (s.roundRoom && s.roundRoom !== prevRoom && (s.phase === "lobby" || s.phase === "countdown")) break;
  await sleep(500);
}

class Phone {
  constructor() { this.cookie = ""; }
  async req(path, init = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) } });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return res;
  }
  sock(path) {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS + path, { headers: { cookie: this.cookie } });
      ws.on("open", () => resolve(ws));
      ws.on("error", () => resolve(null));
    });
  }
  async arrive() {
    const j = await (await this.req("/api/queue/join", { method: "POST" })).json();
    this.name = j.name;
    this.q = await this.sock("/api/queue/ws");
    await sleep(200);
    await this.req(`/api/rooms/${j.room}/join`, { method: "POST" });
    this.r = await this.sock(`/api/rooms/${j.room}/ws`);
    this.r.send(JSON.stringify({ type: "team", config: { name: this.name } }));
  }
  drop() { try { this.r.close(); this.q.close(); } catch {} }
}

const live = [];
let step = 0;
for (const target of stages) {
  while (live.length < target) { const p = new Phone(); await p.arrive(); live.push(p); await sleep(250); }
  while (live.length > target) live.pop().drop();
  await sleep(2500); // agent roster post + the page's poll
  const file = resolve(outDir, `${String(step++).padStart(2, "0")}-${MODE}-${target}.png`);
  spawnSync(CHROME, ["--headless=new", `--screenshot=${file}`, "--window-size=1280,720", "--hide-scrollbars", "--virtual-time-budget=5000", `${BASE}/stream/`], { stdio: "ignore" });
  const r = (await qstate()).roster ?? {};
  console.log(`stage ${target}: joined=${r.joined} teams=${(r.teams ?? []).map((t) => `${t.name}:${t.seats.length}rows/${t.seats.filter(Boolean).length}`).join(" ")} waiting=${(r.waiting ?? []).length} -> ${file}`);
}
for (const p of live) p.drop();
agent.kill();
process.exit(0);
