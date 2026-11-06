// imposter-ws.mjs - a full imposter game through the REAL engine (in the stream
// container), played by ws phones instead of browsers.
//
//   tests/imposter-stack.sh start          (ROOM_MODE=imposter, worker on all interfaces)
//   node tests/imposter-ws.mjs [N] [Red|Blue]
//
// N players (default 12 = the cap, so the lobby starts at once). Checks:
//   - every team gets exactly ONE secret traitor, told privately which team
//   - the engine seats everyone (6 hogs a team at 12) and every player gets turns
//   - the TARGET team's non-imposters self-destruct (Kamikaze), so that team's
//     imposter becomes its last hog and the engine swaps them to the other team
//   - the other team wins, and the reveal names both imposters
//
// env: BASE (worker, default http://127.0.0.1:8790), CONTAINER (default hwstream-agent),
//      STREAM_HOST_SECRET (or read from worker/.dev.vars)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const N = Number(process.argv[2] ?? 12);
const TARGET = process.argv[3] ?? "Red"; // the team whose imposter will defect
const W = Object.fromEntries(HW_WEAPONS.map((x) => [x.name, x.w]));

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
// PODMAN: the container CLI as a command line (default "podman"); on Windows
// Chrome/WSL-podman splits use e.g. PODMAN="wsl -e podman"
const PODMAN = (process.env.PODMAN ?? "podman").split(" ");
const agentLog = () => spawnSync(PODMAN[0], [...PODMAN.slice(1), "logs", CONTAINER], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "";

class Phone {
  constructor() {
    this.cookie = ""; this.msgs = []; this.sid = null; this.name = null;
    this.role = null; this.team = null; this.turns = 0; this.acted = 0; this.policy = "skip";
  }
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
    const r = await this.req(`/api/rooms/${j.room}/join`, { method: "POST" });
    if (r.status !== 200) throw new Error(`${this.name}: room join ${r.status}`);
    this.r = await this.sock(`/api/rooms/${j.room}/ws`, (m) => this.onMsg(m));
    this.r.send(JSON.stringify({ type: "team", config: { name: this.name } }));
  }
  send(action) { try { this.r.send(JSON.stringify({ type: "input", action })); } catch {} }
  onMsg(m) {
    this.msgs.push(m);
    if (m.type === "hello" && m.sid) this.sid = m.sid;
    if (m.type === "seat" && m.team) this.team = m.team;
    if (m.type === "notify") this.role = m.text;
    if (m.type === "turn" && m.sid && m.sid === this.sid) this.myTurn(m);
  }
  // one action per turn: pick the weapon, hold fire; retry if the turn did not end
  async myTurn() {
    this.turns++;
    const at = Date.now();
    this.turnAt = at;
    const weapon = this.policy === "kamikaze" ? "Kamikaze" : "Skip";
    this.acted++;
    this.send("setweap " + String.fromCharCode(W[weapon]));
    await sleep(500);
    this.send("+attack");
    await sleep(400);
    this.send("-attack");
    // not over after 12 s (hog still falling / weapon refused): try again
    for (let i = 0; i < 3; i++) {
      await sleep(12000);
      if (this.turnAt !== at) return; // a later turn started: this one ended
      this.send("setweap " + String.fromCharCode(W[weapon]));
      await sleep(500);
      this.send("+attack");
      await sleep(400);
      this.send("-attack");
    }
  }
  drop() { try { this.r?.close(); this.q?.close(); } catch {} }
}

const players = Array.from({ length: N }, () => new Phone());
let code = 0;
try {
  log(`${N} players, ${TARGET} imposter will defect; waiting for the agent's lobby`);
  // the container agent's current room (the queue may still show an older one)
  const agentRoom = () => [...agentLog().matchAll(/\[agent\] room: (\w+)/g)].map((m) => m[1]).pop();
  await until("lobby open", async () => {
    const room = agentRoom();
    const s = await qstate();
    return room && s.roundRoom === room && (s.phase === "lobby" || s.phase === "countdown");
  }, 240000, 1000);
  for (const p of players) { await p.arrive(); await sleep(200); }
  log("all players in; waiting for the game to start");
  await until("game start", async () => (await qstate()).phase === "ingame", 120000, 1000);
  log("game started");

  // --- the reveal: one traitor per team, told privately which team -----------
  await until("both reveals", async () => players.filter((p) => p.role).length >= 2, 60000, 500);
  await sleep(1500);
  const imps = players.filter((p) => p.role);
  const impTeams = imps.map((p) => /on the (\w+) team/.exec(p.role)?.[1]);
  check("exactly two phones got the private reveal", imps.length === 2, `phones=${imps.map((p) => p.name)}`);
  check("one imposter on each team", new Set(impTeams).size === 2 && impTeams.includes("Red") && impTeams.includes("Blue"), JSON.stringify(impTeams));
  let txt = agentLog();
  const teamLine = txt.match(/seat teams: (.*)/)?.[1] ?? "";
  if (N === 12) check("12 players field two teams of 6 hogs", /Red 6 hogs, Blue 6 hogs/.test(teamLine), teamLine);
  const seatTeam = {};
  for (const m of txt.matchAll(/seat claimed: (Red|Blue) hog \d+ <- "(\w+)"/g)) seatTeam[m[2]] = m[1];
  const counts = { Red: 0, Blue: 0 };
  for (const t of Object.values(seatTeam)) counts[t]++;
  check("the sides are even", counts.Red === counts.Blue && counts.Red + counts.Blue === N, JSON.stringify(counts));
  const grid = players[0].msgs.find((m) => m.type === "weapons");
  check("the weapon grid offered to phones has no Switch Hedgehog (one player, one hog)", !!grid && grid.ammo[20] === "0", grid ? `ammo[20]=${grid.ammo[20]}` : "no weapons message");
  const logged = [...txt.matchAll(/imposter: (\w+) \((Red|Blue) hog/g)].map((m) => ({ name: m[1], team: m[2] }));
  check("the agent's two imposters match the two phones that were told",
    logged.length === 2 && logged.every((l) => imps.some((p) => p.name === l.name && seatTeam[p.name] === l.team)), JSON.stringify(logged));

  // --- play: TARGET's teammates (not its imposter) self-destruct; others skip --
  const targetImp = imps.find((p) => seatTeam[p.name] === TARGET);
  for (const p of players) p.policy = seatTeam[p.name] === TARGET && p !== targetImp ? "kamikaze" : "skip";
  log(`${TARGET} imposter is ${targetImp.name}; ${players.filter((p) => p.policy === "kamikaze").length} teammates will Kamikaze`);

  const end = await until("game end", async () => {
    const s = await qstate();
    return s.lastgame?.lines?.length && s.phase !== "ingame" ? s : null;
  }, 900000, 3000);
  log("game over");
  txt = agentLog();
  check("every player got turns through the real engine", players.every((p) => p.turns >= 1), players.map((p) => p.turns).join(","));
  check(`the ${TARGET} imposter defected when last on ${TARGET}`, new RegExp(`imposter ${targetImp.name} defected from ${TARGET}`).test(txt));
  const other = TARGET === "Red" ? "Blue" : "Red";
  check(`${other} wins`, end.lastgame.winner === other, `winner=${end.lastgame.winner}`);
  const lines = end.lastgame.lines;
  check("the results name the defector", lines.some((l) => l.includes(`Imposter revealed: ${targetImp.name} betrayed ${TARGET}`)), JSON.stringify(lines.slice(-3)));
  check("the results name both imposters", lines.some((l) => /The imposters were/.test(l) && imps.every((p) => l.includes(p.name))), JSON.stringify(lines.slice(-2)));
} catch (e) {
  check("run completed", false, e.message);
} finally {
  players.forEach((p) => p.drop());
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
