// lobby-drop.mjs - the imposter lobby: how players arrive, get seated and drop.
// Runs the REAL host agent (lobby phase only: the engine binary is an
// executable that exits at once, so "engine exited" in the agent log marks the
// game start) against the local worker, with ws-driven phones that go through
// the queue -> admission -> room -> claim path like a browser does.
//
// The rules under test:
//   - everyone who arrives is let in at once (up to 12) and shown in the lobby
//   - they are SEATED two at a time, one per team; the odd one waits
//   - a seated player dropping unseats the LATEST seated player on the other
//     team, so the sides stay exactly even; waiters are re-seated as pairs
//   - a game that starts with someone still unseated sends them to the FRONT
//     of the queue for the next game
//
// usage: node tests/lobby-drop.mjs     (worker already up on BASE)
// env:   BASE (default http://127.0.0.1:8790), STREAM_HOST_SECRET (or read
//        from worker/.dev.vars)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
const WebSocket = require("ws");

const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const WS = BASE.replace(/^http/, "ws");
const SECRET = process.env.STREAM_HOST_SECRET
  ?? readFileSync(join(here, "..", "worker", ".dev.vars"), "utf8").match(/STREAM_HOST_SECRET=(.+)/)[1].trim();
const ROUND_WAIT_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};
const qstate = async () => (await fetch(`${BASE}/api/queue/state`)).json();
const until = async (pred, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
};

// ---- the host agent ----------------------------------------------------------
let prevRoom = null; // the room the previous (killed) agent left in the queue
async function startAgent() {
  prevRoom = (await qstate()).roundRoom;
  const a = { log: "", proc: null };
  a.proc = spawn(process.execPath, [join(here, "..", "agent", "host-agent.mjs")], {
    env: {
      ...process.env,
      WORKER_URL: BASE, ROOM_MODE: "imposter", STREAM_HOST_SECRET: SECRET,
      ENGINE_BIN: process.execPath, // exists but is no engine: it exits at once, which marks the game start
      LOBBY_WAIT_MS: "300000", ROUND_WAIT_MS: String(ROUND_WAIT_MS), SLATE_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  a.proc.stdout.on("data", (d) => (a.log += d));
  a.proc.stderr.on("data", (d) => (a.log += d));
  a.has = (re) => re.test(a.log);
  a.stop = async () => { a.proc.kill(); await sleep(500); };
  return a;
}

// ---- a phone: own cookie jar, queue socket, room socket -------------------------
class Phone {
  constructor() { this.name = null; this.cookie = ""; this.q = null; this.r = null; this.rmsgs = []; this.room = null; }
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
  async joinQueue() {
    const r = await this.req("/api/queue/join", { method: "POST" });
    this.status = r.status;
    this.join = await r.json();
    this.name = this.join.name ?? this.name; // the stream names players itself (AnonAlpha...)
    this.q = await this.sock("/api/queue/ws", (m) => { if (m.type === "admitted" || m.admitted) this.room = m.room; });
    this.room ??= this.join.room;
    return this;
  }
  async admitted() { await until(() => this.room, 5000, `${this.name} admission`); }
  async sit() {
    await this.admitted();
    const r = await this.req(`/api/rooms/${this.room}/join`, { method: "POST" });
    if (r.status !== 200) throw new Error(`${this.name} room join ${r.status}`);
    this.r = await this.sock(`/api/rooms/${this.room}/ws`, (m) => this.rmsgs.push(m));
    this.r.send(JSON.stringify({ type: "team", config: { name: this.name } }));
  }
  // in the room but never claims a seat (a page that connected and went away)
  async enter() {
    await this.admitted();
    const r = await this.req(`/api/rooms/${this.room}/join`, { method: "POST" });
    if (r.status !== 200) throw new Error(`${this.name} room join ${r.status}`);
    this.r = await this.sock(`/api/rooms/${this.room}/ws`, (m) => this.rmsgs.push(m));
  }
  // arrives like a browser: queue join, admitted on the spot, takes a place in the room
  async arrive() { await this.joinQueue(); await this.sit(); return this; }
  lastSeat() { return [...this.rmsgs].reverse().find((m) => m.type === "seat"); }
  got(pred) { return this.rmsgs.some(pred); }
  drop() { try { this.r?.close(); } catch {} try { this.q?.close(); } catch {} this.r = this.q = null; }
}
const phones = (n) => Array.from({ length: n }, () => new Phone());
const arriveAll = async (ps) => { for (const p of ps) { await p.arrive(); await sleep(150); } };

const lobbyOpen = () => until(async () => { const s = await qstate(); return s.roundRoom && s.roundRoom !== prevRoom && (s.phase === "lobby" || s.phase === "countdown") && s; }, 20000, "lobby open");
const rosterOf = async () => (await qstate()).roster ?? {};
const nameList = (xs) => (xs ?? []).filter(Boolean).map((x) => x.name);
const teamNames = (r, i) => nameList(r.teams?.[i]?.seats);
const joinedIs = (n) => async () => (await rosterOf()).joined === n;
const started = (agent) => agent.has(/starting game|engine exited/);

// ======================================================= A: singles, pairs ====
console.log("\n-- A: everyone is let in as they arrive, but seated two at a time");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(6);
    await p[0].arrive();
    await until(joinedIs(1), 6000, "1 joined");
    let r = await rosterOf();
    check("a lone arrival is admitted at once (no waiting for a partner to be let in)", p[0].join.admitted === true || !!p[0].room, JSON.stringify(p[0].join));
    check("...and is shown in the lobby, unseated", r.joined === 1 && nameList(r.waiting).includes(p[0].name) && !teamNames(r, 0).length, JSON.stringify(r.waiting));
    await sleep(500);
    check("their phone is told they are waiting for a partner", p[0].lastSeat()?.seated === false, JSON.stringify(p[0].lastSeat()));
    await p[1].arrive();
    await until(joinedIs(2), 6000, "2 joined");
    await sleep(400);
    r = await rosterOf();
    check("the second arrival seats both, one on each team", teamNames(r, 0).join() === p[0].name && teamNames(r, 1).join() === p[1].name && !nameList(r.waiting).length,
      `${teamNames(r, 0)} / ${teamNames(r, 1)} wait=${nameList(r.waiting)}`);
    check("both phones are told their team", p[0].lastSeat()?.team === "Red" && p[1].lastSeat()?.team === "Blue", `${JSON.stringify(p[0].lastSeat())} ${JSON.stringify(p[1].lastSeat())}`);
    await arriveAll(p.slice(2, 5));
    await until(joinedIs(5), 6000, "5 joined");
    r = await rosterOf();
    check("5 in: four seated (2v2), one waiting", teamNames(r, 0).length === 2 && teamNames(r, 1).length === 2 && nameList(r.waiting).length === 1, JSON.stringify([teamNames(r, 0), teamNames(r, 1), nameList(r.waiting)]));
    check("teams are drawn with at least 3 hogs each even at 2 players", r.teams.every((t) => t.seats.length === 3), JSON.stringify(r.teams.map((t) => t.seats.length)));
    const s5 = await qstate();
    check("no countdown below 6 seated", !s5.countdownEndsAt, `endsAt=${s5.countdownEndsAt}`);
    await p[5].arrive();
    await until(joinedIs(6), 6000, "6 joined");
    await until(async () => (await qstate()).countdownEndsAt, 6000, "countdown at 6 seated");
    r = await rosterOf();
    check("6 in: 3v3, the countdown starts", teamNames(r, 0).length === 3 && teamNames(r, 1).length === 3, JSON.stringify([teamNames(r, 0), teamNames(r, 1)]));
  } catch (e) { check("scenario A completed", false, e.message); }
  finally { await agent.stop(); }
}

// ============================================== B: the cap, then the queue ====
console.log("\n-- B: up to 12 are let in; the 13th waits in the queue");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(13);
    for (let i = 0; i < 12; i++) { await p[i].joinQueue(); await p[i].sit(); await sleep(100); }
    await until(() => started(agent), 15000, "game start at 12");
    check("a full lobby of 12 starts at once", agent.has(/lobby full, starting/));
    const teams = agent.log.match(/seat teams: (.*)/)?.[1] ?? "";
    check("12 players field two teams of 6 hogs", /Red 6 hogs, Blue 6 hogs/.test(teams), teams);
    await p[12].joinQueue();
    check("the 13th is queued, not admitted into a full round", !p[12].join.admitted && !p[12].room, JSON.stringify(p[12].join));
  } catch (e) { check("scenario B completed", false, e.message); }
  finally { await agent.stop(); }
}

// ================================================== C: the drop rule ==========
console.log("\n-- C: a seated player drops - the last player on the other team is unseated");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(9);
    await arriveAll(p.slice(0, 8)); // 8 in: Red p0 p2 p4 p6 / Blue p1 p3 p5 p7
    await until(joinedIs(8), 8000, "8 joined");
    let r = await rosterOf();
    check("8 in: 4v4", teamNames(r, 0).length === 4 && teamNames(r, 1).length === 4);
    p[2].drop(); // a Red player leaves
    await until(joinedIs(7), 6000, "7 joined after the drop");
    await sleep(500);
    r = await rosterOf();
    check("Red lost one; the latest-seated Blue player is unseated", teamNames(r, 0).join() === [p[0], p[4], p[6]].map((x) => x.name).join()
      && teamNames(r, 1).join() === [p[1], p[3], p[5]].map((x) => x.name).join() && nameList(r.waiting).join() === p[7].name,
      JSON.stringify([teamNames(r, 0), teamNames(r, 1), nameList(r.waiting)]));
    check("the teams are exactly even", teamNames(r, 0).length === teamNames(r, 1).length);
    check("the unseated player's phone is told they are waiting again", p[7].lastSeat()?.seated === false, JSON.stringify(p[7].lastSeat()));
    check("the seat shrinks the team's drawn size back toward the minimum", r.teams.every((t) => t.seats.length === 3));
    await p[8].arrive(); // a newcomer completes a pair with the benched player
    await until(joinedIs(8), 6000, "8 joined again");
    await sleep(500);
    r = await rosterOf();
    check("a new arrival re-seats the benched player in a pair: 4v4 again", teamNames(r, 0).length === 4 && teamNames(r, 1).length === 4 && !nameList(r.waiting).length,
      JSON.stringify([teamNames(r, 0), teamNames(r, 1), nameList(r.waiting)]));
    check("the benched player is told they are seated again", p[7].lastSeat()?.seated === true, JSON.stringify(p[7].lastSeat()));
  } catch (e) { check("scenario C completed", false, e.message); }
  finally { await agent.stop(); }
}

// ================================ D: unseated at the start -> front of queue ====
console.log("\n-- D: the game starts with a player unseated - they go to the front of the queue");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(7);
    await arriveAll(p); // 3v3 seated + p6 waiting
    await until(async () => (await qstate()).countdownEndsAt, 8000, "countdown");
    const lone = p[6];
    await until(() => started(agent), ROUND_WAIT_MS + 20000, "game start");
    check("the game starts with the six seated players", /seat teams: Red 3 hogs, Blue 3 hogs/.test(agent.log), (agent.log.match(/seat teams: (.*)/) ?? [])[1]);
    check("the agent reports sending the unseated player back", agent.has(/1 player\(s\) unseated at start/));
    await until(() => lone.got((m) => m.type === "state" && m.state === "released"), 6000, "release message");
    check("the unseated phone is told to come back to the queue", true);
    const imps = [...agent.log.matchAll(/imposter: (\w+) \((Red|Blue) hog/g)].map((m) => ({ name: m[1], team: m[2] }));
    check("there is one imposter on each team", imps.length === 2 && new Set(imps.map((i) => i.team)).size === 2, JSON.stringify(imps));
    check("neither imposter is the unseated player", imps.length === 2 && imps.every((i) => i.name !== lone.name), `imposters=${imps.map((i) => i.name)} unseated=${lone.name}`);
    const s = await qstate();
    // (the queue may also hold phantom joins from earlier suites for up to a
    // minute, so the count is a floor; the position check below is exact)
    check("they are back in the queue for the next game", s.queue >= 1, `queue=${s.queue}`);
    const again = await lone.req("/api/queue/join", { method: "POST" }); // the page's answer to "released"
    const j = await again.json();
    check("rejoining keeps their name and their place at the front", again.status === 200 && j.name === lone.name && (j.position === 1 || j.admitted), JSON.stringify(j));
  } catch (e) { check("scenario D completed", false, e.message); }
  finally { await agent.stop(); }
}

// ============ E: dropping below 6 seated cancels the countdown; one arrival revives ====
console.log("\n-- E: drop below six seated, then ONE new arrival revives the round");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(7);
    await arriveAll(p.slice(0, 6));
    await until(async () => (await qstate()).countdownEndsAt, 8000, "countdown at 6");
    p[1].drop(); // a Blue player: the latest Red player is benched too -> 4 seated
    await until(async () => (await rosterOf()).joined === 5, 6000, "5 joined");
    await until(() => agent.has(/countdown cancelled/), 6000, "countdown cancelled");
    await sleep(ROUND_WAIT_MS + 2000);
    check("the round does not start with only 4 seated", !started(agent));
    const early = await qstate();
    check("the stream is not left counting down", early.countdownEndsAt === null && early.phase === "lobby", `phase=${early.phase} endsAt=${early.countdownEndsAt}`);
    await p[6].arrive(); // ONE player: pairs with the benched one
    await until(async () => (await rosterOf()).joined === 6, 6000, "6 joined again");
    await until(async () => (await qstate()).countdownEndsAt, 8000, "countdown restarted");
    const r = await rosterOf();
    check("a single arrival is enough: back to 3v3 and counting down", teamNames(r, 0).length === 3 && teamNames(r, 1).length === 3, JSON.stringify([teamNames(r, 0), teamNames(r, 1)]));
    await until(() => started(agent), ROUND_WAIT_MS + 15000, "game start");
    check("the round starts once back at six", true);
  } catch (e) { check("scenario E completed", false, e.message); }
  finally { await agent.stop(); }
}

// ================================ F: a blip - the page reconnects and re-claims ====
console.log("\n-- F: a player's connection blips and the page reconnects");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(6);
    await arriveAll(p);
    await until(joinedIs(6), 8000, "6 joined");
    const back = p[3];
    back.r.close(); // socket only: the room cookie survives
    await until(joinedIs(5), 6000, "5 joined while they are away");
    back.rmsgs.length = 0;
    back.r = await back.sock(`/api/rooms/${back.room}/ws`, (m) => back.rmsgs.push(m));
    check("the room socket reopens with the existing cookie", !!back.r);
    back.r.send(JSON.stringify({ type: "team", config: { name: back.name } }));
    await until(joinedIs(6), 6000, "6 joined again");
    await sleep(500);
    const r = await rosterOf();
    const names = [...teamNames(r, 0), ...teamNames(r, 1), ...nameList(r.waiting)];
    check("they are back in the lobby exactly once", new Set(names).size === names.length && names.includes(back.name), names.join(","));
    check("the teams are even again", teamNames(r, 0).length === 3 && teamNames(r, 1).length === 3, JSON.stringify([teamNames(r, 0), teamNames(r, 1)]));
  } catch (e) { check("scenario F completed", false, e.message); }
  finally { await agent.stop(); }
}

// ============================================ G: admitted but never took a seat ====
console.log("\n-- G: a player is admitted, then vanishes before taking a seat");
{
  const agent = await startAgent();
  try {
    await lobbyOpen();
    const p = phones(7);
    await arriveAll(p.slice(0, 6));
    const ghost = p[6];
    await ghost.joinQueue();
    await ghost.enter(); // admitted and connected, but never asks for a seat
    await sleep(500);
    ghost.drop();
    await until(() => agent.has(/\(never took a seat\)/), 6000, "ghost leave");
    check("the agent notes the player left without a seat", true);
    const r = await rosterOf();
    check("the lobby is unaffected (6 in)", r.joined === 6, `joined=${r.joined}`);
    await until(() => (agent.log.match(/imposter: \w+ \(/g) ?? []).length >= 2, ROUND_WAIT_MS + 20000, "both imposters picked");
    const gimps = [...agent.log.matchAll(/imposter: (\w+) \(/g)].map((m) => m[1]);
    check("neither imposter is the ghost", gimps.length === 2 && !gimps.includes(ghost.name), `imposters=${gimps} ghost=${ghost.name}`);
  } catch (e) { check("scenario G completed", false, e.message); }
  finally { await agent.stop(); }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
