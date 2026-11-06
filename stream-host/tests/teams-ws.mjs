// teams-ws.mjs - party-style teams mode through the REAL engine (stream container
// started with ROOM_MODE=teams), played by ws phones.
//
//   ROOM_MODE=teams MAX_PLAYERS=24 tests/imposter-stack.sh start
//   node tests/teams-ws.mjs [N]        (default 19: four teams)
//
// Checks that the lobby rebalances to 2/3/4 teams (Red, Blue, Yellow, Green),
// that the engine accepts the config (a team fields at least 3 hogs and grows
// with its players) and that turns reach every team.
//
// env: BASE (default http://127.0.0.1:8790), CONTAINER (default hwstream-agent)
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HW_WEAPONS } from "../worker/public/weapons.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
const WebSocket = require("ws");

const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const WS = BASE.replace(/^http/, "ws");
const CONTAINER = process.env.CONTAINER ?? "hwstream-agent";
const N = Number(process.argv[2] ?? 19);
const SKIP = HW_WEAPONS.find((x) => x.name === "Skip").w;
const wantTeams = N <= 12 ? 2 : N <= 18 ? 3 : 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};
const qstate = async () => (await fetch(`${BASE}/api/queue/state`)).json();
const until = async (what, pred, ms, step = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};
const agentLog = () => spawnSync("podman", ["logs", CONTAINER], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "";

class Phone {
  constructor() { this.cookie = ""; this.sid = null; this.turns = 0; this.team = null; }
  async req(path, init = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) } });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return res;
  }
  sock(path, onmsg) {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS + path, { headers: { cookie: this.cookie } });
      ws.on("message", (d) => { try { onmsg?.(JSON.parse(d.toString())); } catch {} });
      ws.on("open", () => resolve(ws));
      ws.on("unexpected-response", () => resolve(null));
      ws.on("error", () => {});
    });
  }
  async arrive() {
    const j = await (await this.req("/api/queue/join", { method: "POST" })).json();
    this.name = j.name;
    this.q = await this.sock("/api/queue/ws");
    await sleep(150);
    await this.req(`/api/rooms/${j.room}/join`, { method: "POST" });
    this.r = await this.sock(`/api/rooms/${j.room}/ws`, (m) => this.onMsg(m));
    this.r.send(JSON.stringify({ type: "team", config: { name: this.name } }));
  }
  onMsg(m) {
    if (m.type === "hello" && m.sid) this.sid = m.sid;
    if (m.type === "seat" && m.team) this.team = m.team;
    if (m.type === "turn" && m.sid && m.sid === this.sid) {
      this.turns++;
      const at = (this.turnAt = Date.now());
      (async () => {
        // skip the turn; retry if it did not end (hog still falling)
        for (let i = 0; i < 4 && this.turnAt === at; i++) {
          try { this.r.send(JSON.stringify({ type: "input", action: "setweap " + String.fromCharCode(SKIP) })); } catch {}
          await sleep(500);
          try { this.r.send(JSON.stringify({ type: "input", action: "+attack" })); } catch {}
          await sleep(400);
          try { this.r.send(JSON.stringify({ type: "input", action: "-attack" })); } catch {}
          await sleep(12000);
        }
      })();
    }
  }
  drop() { try { this.r?.close(); this.q?.close(); } catch {} }
}

const players = Array.from({ length: N }, () => new Phone());
try {
  log(`${N} players -> expect ${wantTeams} teams`);
  const agentRoom = () => [...agentLog().matchAll(/\[agent\] room: (\w+)/g)].map((m) => m[1]).pop();
  await until("lobby open", async () => {
    const s = await qstate();
    return agentRoom() && s.roundRoom === agentRoom() && (s.phase === "lobby" || s.phase === "countdown");
  }, 240000, 1000);
  for (const p of players) { await p.arrive(); await sleep(150); }
  await until("all in", async () => ((await qstate()).roster?.joined ?? 0) >= N, 30000, 500);
  const roster = (await qstate()).roster;
  const sizes = roster.teams.map((t) => t.seats.filter(Boolean).length);
  check(`${N} players rebalance into ${wantTeams} teams`, roster.teams.length === wantTeams, roster.teams.map((t) => t.name).join(","));
  check("within one player of even", Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join("/"));
  if (wantTeams >= 3) check("the extra teams are Yellow, then Green", roster.teams[2].name === "Yellow" && (wantTeams < 4 || roster.teams[3].name === "Green"), roster.teams.map((t) => t.name).join(","));
  check("each team is drawn with at least 3 hogs", roster.teams.every((t) => t.seats.length >= 3), roster.teams.map((t) => t.seats.length).join("/"));

  log("waiting for the countdown to run out and the engine to start");
  await until("game start", async () => (await qstate()).phase === "ingame", 120000, 1000);
  await sleep(4000);
  let txt = agentLog();
  const teamLine = txt.match(/seat teams: (.*)/)?.[1] ?? "";
  log(teamLine);
  check("the engine config carries every team", new RegExp(`engine config sent: ${wantTeams} teams`).test(txt), (txt.match(/engine config sent: .*/) ?? [])[0]);
  check("the agent built each team with its players' hogs", teamLine.split(", ").length === wantTeams, teamLine);

  // let turns rotate a while: every team should get play
  log("playing turns for a while...");
  await until("turns reach every team", async () => {
    txt = agentLog();
    const turned = new Set([...txt.matchAll(/\[agent\] turn: (\w+) \(sid/g)].map((m) => m[1]));
    const teamsTurned = new Set(players.filter((p) => turned.has(p.name)).map((p) => p.team));
    return teamsTurned.size >= wantTeams;
  }, 360000, 3000);
  check("turns reached players on every team", true);
  check("the engine did not crash", !/engine exited code=(?!0\b)\d+/.test(txt) || /engine exited code=0/.test(txt), (txt.match(/engine exited code=\d+/) ?? ["running"])[0]);
} catch (e) {
  check("run completed", false, e.message);
} finally {
  players.forEach((p) => p.drop());
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
