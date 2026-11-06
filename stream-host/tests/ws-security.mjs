// ws-security.mjs — cross-user injection checks for the stream worker's
// websockets. No engine needed: this script plays the HOST itself (it creates
// a managed room with the queue secret and connects the host socket), then
// attacks as queued / admitted-but-not-on-turn players and asserts nothing
// reaches the host and nobody else's private messages leak.
//
// usage: node tests/ws-security.mjs     (worker already up on BASE)
// env: BASE (default http://127.0.0.1:8790), STREAM_HOST_SECRET (or read from
//      worker/.dev.vars)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

const ctl = (path, body) => fetch(`${BASE}/api/queue/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-stream-secret": SECRET },
  body: JSON.stringify(body),
});

// a client with its own cookie jar (one hw_session at a time, like a browser)
class Client {
  constructor(label) { this.label = label; this.cookie = ""; this.msgs = []; }
  async req(path, init = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) } });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return res;
  }
  open(path) {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS + path, { headers: { cookie: this.cookie } });
      const sock = { ws, msgs: [], status: null };
      ws.on("message", (d) => { try { sock.msgs.push(JSON.parse(d.toString())); } catch {} });
      ws.on("open", () => { sock.status = 101; resolve(sock); });
      ws.on("unexpected-response", (_req, res) => { sock.status = res.statusCode; resolve(sock); });
      ws.on("error", () => {});
      ws.on("close", (code) => { sock.closed = code; });
    });
  }
}
const send = (sock, obj) => sock.ws.send(JSON.stringify(obj));
const got = (sock, pred) => sock.msgs.some(pred);

// a previous run's socketless "phantom" join (the 500 KB-name probe below) is
// still inside the queue's 3 s just-joined grace; let it lapse so it cannot
// act as this run's first pair partner
await sleep(3500);

// ------------------------------------------------------------- setup ------
// the host: creates a MANAGED room (queue secret) and listens as host
const host = new Client("host");
const created = await host.req("/api/rooms", {
  method: "POST",
  headers: { "x-stream-secret": SECRET },
  body: JSON.stringify({ mode: "imposter", slots: 4 }),
});
const { room } = await created.json();
const hostSock = await host.open(`/api/rooms/${room}/ws`);
check("host socket opens", hostSock.status === 101);

// the queue: round open, pairs only
await ctl("phase", { phase: "lobby", room, count: 6, openSeats: 8, pairs: true });

const mk = async (label) => {
  const c = new Client(label);
  const r = await c.req("/api/queue/join", { method: "POST" });
  c.join = await r.json();
  c.q = await c.open("/api/queue/ws");
  return c;
};

// Q1 + Q2 arrive: pair admitted; Q3 arrives alone and must wait
const q1 = await mk("Q1");
const q2 = await mk("Q2");
await sleep(500);
const q3 = await mk("Q3");
await sleep(800);

// --- 1. admission is private ------------------------------------------------
const admitted = (c) => got(c.q, (m) => m.type === "admitted" && m.room === room)
  || got(c.q, (m) => m.type === "queue" && m.admitted && m.room === room);
check("admitted pair is told its room", admitted(q1) || q1.join.admitted, `q1 join=${JSON.stringify(q1.join)}`);
check("admitted partner is told its room", admitted(q2) || q2.join.admitted);
check("the waiting player never receives the admission (room code stays private)",
  !got(q3.q, (m) => JSON.stringify(m).includes(room)), JSON.stringify(q3.q.msgs.slice(-2)));

// --- 2. room join is bound to admission ------------------------------------------
let r = await q3.req(`/api/rooms/${room}/join`, { method: "POST" });
check("queued (not admitted) player cannot join the live room", r.status === 403, `status=${r.status}`);
const anon = new Client("anon");
r = await anon.req(`/api/rooms/${room}/join`, { method: "POST" });
check("anonymous client cannot join the live room (room code is in public /state)", r.status === 403, `status=${r.status}`);
const st = await (await fetch(`${BASE}/api/queue/state`)).json();
check("(info) /api/queue/state still publishes the room code", st.roundRoom === room, "harmless now that join is gated");

// the queue session cannot open a room socket directly either
const q3room = await q3.open(`/api/rooms/${room}/ws`);
check("queue session cannot open the room websocket", q3room.status === 401, `status=${q3room.status}`);

// admitted players join with their queue identity
r = await q1.req(`/api/rooms/${room}/join`, { method: "POST" });
check("admitted player joins the room", r.status === 200, `status=${r.status}`);
r = await q2.req(`/api/rooms/${room}/join`, { method: "POST" });
check("admitted partner joins the room", r.status === 200);
const s1 = await q1.open(`/api/rooms/${room}/ws`);
const s2 = await q2.open(`/api/rooms/${room}/ws`);
await sleep(500);
const sid1 = s1.msgs.find((m) => m.type === "hello")?.sid;
const sid2 = s2.msgs.find((m) => m.type === "hello")?.sid;
check("room sockets open and report each player's own sid", s1.status === 101 && s2.status === 101 && sid1 && sid2 && sid1 !== sid2);

// --- 3. only the player on turn reaches the host ----------------------------------
const hostSees = (pred) => got(hostSock, pred);
const clear = () => { hostSock.msgs.length = 0; };

// before any turn nobody drives
send(s1, { type: "input", action: "+left" });
send(s2, { type: "input", action: "+left" });
await sleep(400);
check("no live turn: inputs from everyone are dropped", !hostSees((m) => m.type === "input"));

// host announces: it is Q1's turn
send(hostSock, { type: "turn", team: "Ada", sid: sid1 });
await sleep(300);
clear();
send(s2, { type: "input", action: "+attack" });
send(s2, { type: "input", action: "J" });
send(s2, { type: "input", action: "setweap \u0007" });
send(s2, { type: "cursor", x: 5, y: 5 });
send(s2, { type: "put", x: 1, y: 1 });
await sleep(500);
check("non-turn player's input/cursor/put never reach the host", !hostSees((m) => ["input", "cursor", "put"].includes(m.type)),
  JSON.stringify(hostSock.msgs));
send(s1, { type: "input", action: "+right" });
await sleep(400);
check("the player on turn does reach the host (tagged with the server-side sid)",
  hostSees((m) => m.type === "input" && m.action === "+right" && m.sid === sid1));

// spoofed identity fields in the payload are ignored
clear();
send(s2, { type: "input", action: "+up", sid: sid1, team: "Ada" });
send(s2, { type: "turn", team: "Ada", sid: sid2 });
send(s2, { type: "state", state: "ended" });
await sleep(500);
check("spoofed sid/team fields do not make a non-turn input pass", !hostSees((m) => m.type === "input"));
check("host-only message types from a controller are not relayed to anyone",
  !got(s1, (m) => m.type === "turn" && m.sid === sid2) && !got(s1, (m) => m.type === "state" && m.state === "ended"));

// the switch-hedgehog ammo stays blocked in imposter rooms, whitespace or not
clear();
send(s1, { type: "input", action: "setweap \u0015" });
send(s1, { type: "input", action: "setweap  \u0015" });
send(s1, { type: "input", action: "setweap\t\u0015" });
await sleep(400);
check("Switch Hedgehog ammo cannot be selected (exact or padded with whitespace)", !hostSees((m) => m.type === "input" && /setweap/.test(m.action)),
  JSON.stringify(hostSock.msgs));

// malformed/hostile payloads
clear();
send(s1, { type: "input", action: "+attack; quit" });
send(s1, { type: "input", action: "x".repeat(300) });
send(s1, { type: "cursor", x: "1", y: 2 });
send(s1, { type: "cursor", x: null, y: 2 });
s1.ws.send("not json");
await sleep(400);
check("malformed input is dropped", !hostSees((m) => m.type === "input" || m.type === "cursor"), JSON.stringify(hostSock.msgs));

// --- 4. private notices -----------------------------------------------------------
send(hostSock, { type: "notify", sid: sid1, text: "secret" });
send(s2, { type: "notify", sid: sid1, text: "forged" });
await sleep(500);
check("host notify reaches only its target", got(s1, (m) => m.type === "notify" && m.text === "secret") && !got(s2, (m) => m.type === "notify" && m.text === "secret"));
check("a controller cannot forge a notify to someone else", !got(s1, (m) => m.type === "notify" && m.text === "forged"));

// --- 5. one socket per player -----------------------------------------------------
clear();
const dup = [];
for (let i = 0; i < 9; i++) dup.push(await q2.open(`/api/rooms/${room}/ws`));
await sleep(600);
const open = dup.filter((d) => d.ws.readyState === 1).length;
check("a player opening 9 tabs keeps exactly one live socket", open === 1, `open=${open}`);
check("replaced sockets do not read as the player leaving", !hostSees((m) => m.type === "left" && m.sid === sid2), JSON.stringify(hostSock.msgs.filter((m) => m.type === "left")));
// the original Q1 socket still works and was never counted against capacity
check("other players are not locked out by the duplicates", s1.ws.readyState === 1);
dup.forEach((d) => d.ws.close());
await sleep(500);
check("the last socket closing is reported as the player leaving", hostSees((m) => m.type === "left" && m.sid === sid2));

// --- 7. sending players back to the front of the queue ----------------------------------
// the host starts a round without players still unseated: they go to the FRONT
// of the queue and keep their identity; only the host can do that, and only the
// requeued session can reuse its place
try { q3.q.ws.close(); } catch {} // earlier sections left a waiting player: the longest-waiting is admitted first
await sleep(600);
// (phantom joins from earlier runs may still sit in the queue for up to a minute: positions are relative to this baseline)
const base = (await (await fetch(`${BASE}/api/queue/state`)).json()).queue;
await ctl("phase", { phase: "lobby", room, count: 12, openSeats: 12, capacity: 12 });
const rp1 = await mk("R1");
const rp2 = await mk("R2");
check("a lone arrival is let straight into the open lobby (no pair needed)", rp1.join.admitted === true, JSON.stringify(rp1.join));
for (const c of [rp1, rp2]) {
  const jr = await c.req(`/api/rooms/${room}/join`, { method: "POST" });
  c.room = await c.open(`/api/rooms/${room}/ws`);
  await sleep(200);
  c.sid = c.room.msgs.find((m) => m.type === "hello")?.sid;
  check(`${c.label} is in the room`, jr.status === 200 && !!c.sid);
}
const name1 = rp1.join.name, name2 = rp2.join.name;
await ctl("phase", { phase: "ingame", room });
const late = await mk("Late"); // arrives while the game runs: queued
await sleep(300);
check("a late arrival is queued behind the running game", late.join.position === base + 1 && !late.join.admitted, JSON.stringify(late.join));

const noKey = await fetch(`${BASE}/api/queue/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room, sids: [rp1.sid] }) });
check("a player cannot requeue anyone (host secret required)", noKey.status === 401, `status=${noKey.status}`);
const forged = await rp2.req("/api/queue/requeue", { method: "POST", body: JSON.stringify({ room, sids: [rp1.sid] }) });
check("...not even with a session cookie", forged.status === 401, `status=${forged.status}`);

const rq = await ctl("requeue", { room, sids: [rp1.sid] });
check("the host requeues an unseated player", rq.status === 200);
const stq = await (await fetch(`${BASE}/api/queue/state`)).json();
check("the queue now holds the requeued player and the late arrival", stq.queue === base + 2, `queue=${stq.queue} base=${base}`);
const again1 = await (await rp1.req("/api/queue/join", { method: "POST" })).json();
check("the requeued player rejoins with the same name, FIRST in line", again1.name === name1 && again1.position === 1, JSON.stringify(again1));
const lateState = await (await fetch(`${BASE}/api/queue/state`)).json();
check("the late arrival is still queued (behind the requeued player)", lateState.queue === base + 2, `queue=${lateState.queue}`);
const again2 = await (await rp2.req("/api/queue/join", { method: "POST" })).json();
check("a player who was NOT requeued gets a new identity at the back", again2.name !== name2 && again2.position === base + 3, JSON.stringify(again2));

// host-only routes to one phone: seat notices and release
const sidA = rp1.sid;
send(hostSock, { type: "seat", sid: sidA, seated: true, team: "Red" });
send(rp2.room, { type: "seat", sid: sidA, seated: false, team: null });
send(rp2.room, { type: "release", sid: sidA });
await sleep(400);
check("the host's seat notice reaches only its target", got(rp1.room, (m) => m.type === "seat" && m.seated === true && m.team === "Red") && !got(rp2.room, (m) => m.type === "seat"));
check("a controller cannot forge a seat notice or a release for someone else",
  !got(rp1.room, (m) => m.type === "seat" && m.seated === false) && !got(rp1.room, (m) => m.type === "state" && m.state === "released") && rp1.room.ws.readyState === 1);
send(hostSock, { type: "release", sid: sidA });
await sleep(500);
check("the host can send one player back to the queue (they get 'released' and are closed)",
  got(rp1.room, (m) => m.type === "state" && m.state === "released") && rp1.room.ws.readyState !== 1);
check("...and nobody else is released", rp2.room.ws.readyState === 1 && !got(rp2.room, (m) => m.type === "state" && m.state === "released"));
for (const c of [rp1, rp2, late]) { try { c.q?.ws.close(); } catch {} try { c.room?.ws.close(); } catch {} }

// --- 8. the turn gate under hostile conditions --------------------------------------------
// Presume every client is hostile: the worker alone decides who may act, and only
// the player whose turn it is. Two fresh players in a new lobby, a fake host.
await sleep(3500); // entries left by the previous section lapse (a just-joined entry is eligible for 3 s)
await ctl("phase", { phase: "lobby", room, count: 12, openSeats: 12, capacity: 12 });
const ga = await mk("GA");
const gb = await mk("GB");
check("(setup) both players are admitted into the lobby", ga.join.admitted === true && gb.join.admitted === true, `${JSON.stringify(ga.join)} ${JSON.stringify(gb.join)}`);
for (const c of [ga, gb]) {
  await c.req(`/api/rooms/${room}/join`, { method: "POST" });
  c.room = await c.open(`/api/rooms/${room}/ws`);
  await sleep(200);
  c.sid = c.room.msgs.find((m) => m.type === "hello")?.sid;
}
await ctl("phase", { phase: "ingame", room });
const inputsFor = (sid) => hostSock.msgs.filter((m) => m.type === "input" && m.sid === sid).length;
const sendIn = (c, action) => send(c.room, { type: "input", action });

// a. only the player on turn gets through
send(hostSock, { type: "turn", team: "GA hog", sid: ga.sid });
await sleep(300);
clear();
sendIn(gb, "+left"); sendIn(ga, "+left");
await sleep(400);
check("GA on turn: GA's input reaches the host, GB's does not", inputsFor(ga.sid) === 1 && inputsFor(gb.sid) === 0, `ga=${inputsFor(ga.sid)} gb=${inputsFor(gb.sid)}`);

// b. a turn handed to the engine (a CPU hog) belongs to nobody
send(hostSock, { type: "turn", team: "CPU hog" });
await sleep(300);
clear();
sendIn(ga, "+left"); sendIn(gb, "+left");
send(ga.room, { type: "cursor", x: 1, y: 1 }); send(gb.room, { type: "put", x: 0, y: 0 });
await sleep(400);
check("a CPU/engine turn: nobody's input, cursor or put reaches the host", !hostSees((m) => ["input", "cursor", "put"].includes(m.type)), JSON.stringify(hostSock.msgs));

// c. the turn does not outlive the game
send(hostSock, { type: "turn", team: "GA hog", sid: ga.sid });
await sleep(300);
send(hostSock, { type: "state", state: "ended" });
await sleep(300);
clear();
sendIn(ga, "+left");
await sleep(400);
check("once the game is over the last turn holder can no longer send input", !hostSees((m) => m.type === "input"), JSON.stringify(hostSock.msgs));

// d. values are bounded and typed
send(hostSock, { type: "state", state: "ingame" });
send(hostSock, { type: "turn", team: "GA hog", sid: ga.sid });
await sleep(300);
clear();
send(ga.room, { type: "cursor", x: 5, y: -3 });
send(ga.room, { type: "cursor", x: 1e9, y: 0 });
send(ga.room, { type: "cursor", x: 0, y: -1e9 });
send(ga.room, { type: "put", x: Infinity, y: 0 });
send(ga.room, { type: "put", x: "1", y: 2 });
await sleep(400);
const cur = hostSock.msgs.filter((m) => m.type === "cursor" || m.type === "put");
check("a normal cursor delta passes; huge, infinite and non-numeric values are dropped", cur.length === 1 && cur[0].x === 5 && cur[0].y === -3, JSON.stringify(cur));

// e. the Switch Hedgehog ammo cannot be selected, however it is spelled
clear();
for (const a of ["setweap \u0015", "setweap  \u0015", "setweap\t\u0015", "setweap \u0015", "setweap \u0015"]) sendIn(ga, a);
await sleep(400);
check("Switch Hedgehog cannot be selected (spaces, tabs, NBSP, em-space)", !hostSees((m) => m.type === "input" && /setweap/.test(m.action)), JSON.stringify(hostSock.msgs));
sendIn(ga, "setweap \u0017"); // Kamikaze: an ordinary weapon is fine
await sleep(300);
check("an ordinary weapon selection still passes", hostSees((m) => m.type === "input" && m.sid === ga.sid && /setweap/.test(m.action)));

// f. a flood cannot take the room: it is cut, and play resumes afterwards
clear();
const flood = JSON.stringify({ type: "input", action: "+left" });
for (let i = 0; i < 3000; i++) ga.room.ws.send(flood);
await sleep(4000);
const relayed = hostSock.msgs.filter((m) => m.type === "input" && m.sid === ga.sid).length;
check("3000 messages in a burst: only a bounded number reach the host", relayed >= 50 && relayed <= 450, `relayed=${relayed}`);
await sleep(2500); // the bucket refills
clear();
sendIn(ga, "+right");
await sleep(400);
check("after the flood stops, the player's input works again", hostSees((m) => m.type === "input" && m.action === "+right" && m.sid === ga.sid));
clear();
sendIn(gb, "+right");
await sleep(300);
check("the flood did not hand GB the turn", !hostSees((m) => m.type === "input"));

// g. party room: a different connection typing a seated player's name cannot take the seat
{
  const phost = new Client("phost");
  const pc = await phost.req("/api/rooms", { method: "POST", body: JSON.stringify({ mode: "teams", slots: 4 }) });
  const { room: proom } = await pc.json();
  const phostSock = await phost.open(`/api/rooms/${proom}/ws`);
  const victim = new Client("victim"), thief = new Client("thief");
  for (const c of [victim, thief]) {
    await c.req(`/api/rooms/${proom}/join`, { method: "POST" });
    c.room = await c.open(`/api/rooms/${proom}/ws`);
  }
  await sleep(300);
  send(victim.room, { type: "team", config: { name: "Seated Player" } });
  await sleep(400);
  send(thief.room, { type: "team", config: { name: "Seated Player" } });
  await sleep(400);
  const claims = phostSock.msgs.filter((m) => m.type === "team");
  const vSid = victim.room.msgs.find((m) => m.type === "hello")?.sid;
  const tSid = thief.room.msgs.find((m) => m.type === "hello")?.sid;
  const vSeat = claims.find((m) => m.sid === vSid)?.seat;
  const tSeat = claims.find((m) => m.sid === tSid)?.seat;
  check("party room: the rightful player gets the seat", !!vSeat, JSON.stringify(vSeat));
  check("party room: someone typing the same name cannot take it while its owner is connected", !tSeat, JSON.stringify(tSeat));
  victim.room.ws.close();
  await sleep(500);
  send(thief.room, { type: "team", config: { name: "Seated Player" } });
  await sleep(400);
  const later = phostSock.msgs.filter((m) => m.type === "team" && m.sid === tSid).pop();
  check("...but once the owner is gone the seat can be reclaimed (a lost cookie is not a lost seat)", !!later?.seat, JSON.stringify(later?.seat));
  for (const sk of [phostSock, thief.room]) try { sk.ws.close(); } catch {}
}
// --- 9. cross-site sockets ---------------------------------------------------------------
// A page on another site must not be able to open a player's socket with the
// player's cookies. Browsers always send Origin on a WebSocket upgrade; the
// host agent and other non-browser clients send none.
{
  const attempt = (client, path, origin) => new Promise((resolve) => {
    const headers = { cookie: client.cookie, ...(origin ? { origin } : {}) };
    const w = new WebSocket(WS + path, { headers });
    w.on("open", () => { w.close(); resolve(101); });
    w.on("unexpected-response", (_r, res) => resolve(res.statusCode));
    w.on("error", () => {});
    setTimeout(() => resolve(null), 4000);
  });
  const roomPath = `/api/rooms/${room}/ws`;
  check("a room socket opened from another site's page is refused", (await attempt(ga, roomPath, "https://evil.example")) === 403);
  check("...also from a look-alike origin (same host name, other port)", (await attempt(ga, roomPath, "http://127.0.0.1:9999")) === 403);
  check("the player's own page (same origin) is accepted", (await attempt(ga, roomPath, BASE)) === 101);
  check("a non-browser client (no Origin) is accepted", (await attempt(ga, roomPath, null)) === 101);
  const qc = await mk("OriginQ");
  check("a queue socket opened from another site's page is refused", (await attempt(qc, "/api/queue/ws", "https://evil.example")) === 403);
  check("the queue's own page is accepted", (await attempt(qc, "/api/queue/ws", BASE)) === 101);
  try { qc.q.ws.close(); } catch {}
}
for (const c of [ga, gb]) { try { c.q.ws.close(); } catch {} try { c.room.ws.close(); } catch {} }

// --- 6. queue abuse bounds ----------------------------------------------------------
const big = await mk("big");
big.q.ws.send(JSON.stringify({ type: "team", config: { name: "x".repeat(20000) } }));
await sleep(300);
const before = await (await fetch(`${BASE}/api/queue/state`)).json();
check("oversized queue team config is ignored and the queue stays healthy", typeof before.queue === "number");
const huge = await fetch(`${BASE}/api/queue/join`, { method: "POST", body: JSON.stringify({ name: "n".repeat(500_000) }) });
check("a huge queue-join name does not wedge the queue", huge.status === 200 || huge.status === 503, `status=${huge.status}`);
const after = await (await fetch(`${BASE}/api/queue/state`)).json();
check("queue still answers after the abuse", typeof after.queue === "number");

// ------------------------------------------------------------------------------------
for (const c of [q1, q2, q3, big]) try { c.q.ws.close(); } catch {}
for (const s of [s1, s2, hostSock]) try { s.ws.close(); } catch {}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
