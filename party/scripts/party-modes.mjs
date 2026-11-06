// party-modes.mjs - the party worker's game modes and its treatment of untrusted
// phones (the same room logic as the stream worker's, synchronised).
//
//   (party worker running: npm run dev)   node scripts/party-modes.mjs
//   env: BASE (default http://127.0.0.1:8787)
//
// A fake host plays the room's host; players are raw sockets. Every phone is
// presumed hostile: only the player whose turn it is may act.
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

class Peer {
  constructor(label) { this.label = label; this.cookie = ""; this.msgs = []; this.ws = null; this.status = null; }
  async http(path, init = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) } });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    return res;
  }
  open(path, origin) {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS + path, { headers: { cookie: this.cookie, ...(origin ? { origin } : {}) } });
      this.ws = ws;
      ws.on("message", (d) => { try { this.msgs.push(JSON.parse(d.toString())); } catch {} });
      ws.on("open", () => { this.status = 101; resolve(this); });
      ws.on("unexpected-response", (_r, res) => { this.status = res.statusCode; resolve(this); });
      ws.on("error", () => {});
    });
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); } catch {} }
  get sid() { return this.msgs.find((m) => m.type === "hello")?.sid; }
  has(pred) { return this.msgs.some(pred); }
}

async function makeRoom(body) {
  const host = new Peer("host");
  const r = await host.http("/api/rooms", { method: "POST", body: JSON.stringify(body) });
  const { room } = r.status === 201 ? await r.json() : {};
  if (room) { await host.open(`/api/rooms/${room}/ws`); await sleep(200); }
  return { host, room, status: r.status };
}
async function player(room, label) {
  const p = new Peer(label);
  const j = await p.http(`/api/rooms/${room}/join`, { method: "POST" });
  if (j.status !== 200) { p.joinStatus = j.status; return p; }
  await p.open(`/api/rooms/${room}/ws`);
  await sleep(150);
  return p;
}
const inputsFrom = (host, sid) => host.msgs.filter((m) => m.type === "input" && m.sid === sid).length;

// -------------------------------------------------------------- room modes ---
console.log("\n-- modes and caps");
{
  const imp = await makeRoom({ mode: "imposter", slots: 6, maxPlayers: 12 });
  check("an imposter room can be created", imp.status === 201);
  check("its host is told the mode", imp.host.has((m) => m.type === "hello" && m.mode === "imposter"));
  const bad = [
    await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "teams", maxPlayers: 1 }) }),
    await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "teams", maxPlayers: 25 }) }),
    await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "teams", maxPlayers: 3.5 }) }),
  ];
  check("a nonsensical player cap is refused (1, 25, 3.5)", bad.every((r) => r.status === 400), bad.map((r) => r.status).join());

  // a teams room taking 14 players (three teams' worth): the cap is the host's number, not 2 x slots
  const big = await makeRoom({ mode: "teams", slots: 6, maxPlayers: 14 });
  const joined = [];
  for (let i = 0; i < 14; i++) joined.push(await player(big.room, `p${i}`));
  check("a teams room with maxPlayers 14 seats 14 players", joined.every((p) => p.status === 101), joined.map((p) => p.joinStatus ?? p.status).join());
  const fifteenth = await player(big.room, "p14");
  check("the 15th is refused (409)", fifteenth.joinStatus === 409 || fifteenth.status === 409, `join=${fifteenth.joinStatus} ws=${fifteenth.status}`);
  // seats are assigned in arrival order for every one of them
  for (const [i, p] of joined.entries()) p.send({ type: "team", config: { name: `Seat ${i}` } });
  await sleep(1200);
  const slots = big.host.msgs.filter((m) => m.type === "team" && m.seat).map((m) => m.seat.slot).sort((a, b) => a - b);
  check("all 14 get a seat slot (0..13)", slots.length === 14 && slots[0] === 0 && slots[13] === 13, slots.join());
  for (const p of joined) p.ws?.close();
  big.host.ws.close();
  imp.host.ws.close();
}

// --------------------------------------------------------------- turn gate ---
console.log("\n-- the turn gate (nobody acts out of turn)");
const room = await makeRoom({ mode: "imposter", slots: 6, maxPlayers: 12 });
const { host } = room;
const a = await player(room.room, "A");
const b = await player(room.room, "B");
const clear = () => { host.msgs.length = 0; };

host.send({ type: "turn", team: "A hog", sid: a.sid });
await sleep(250);
clear();
b.send({ type: "input", action: "+left" }); a.send({ type: "input", action: "+left" });
await sleep(350);
check("only the player on turn reaches the host", inputsFrom(host, a.sid) === 1 && inputsFrom(host, b.sid) === 0);

host.send({ type: "turn", team: "CPU hog" });
await sleep(250);
clear();
a.send({ type: "input", action: "+left" }); b.send({ type: "cursor", x: 1, y: 1 });
await sleep(350);
check("a CPU turn belongs to nobody", !host.has((m) => ["input", "cursor", "put"].includes(m.type)));

host.send({ type: "turn", team: "A hog", sid: a.sid });
await sleep(200);
host.send({ type: "state", state: "ended" });
await sleep(250);
clear();
a.send({ type: "input", action: "+left" });
await sleep(350);
check("a turn does not outlive the game", !host.has((m) => m.type === "input"));

host.send({ type: "state", state: "ingame" });
host.send({ type: "turn", team: "A hog", sid: a.sid });
await sleep(250);
clear();
a.send({ type: "cursor", x: 5, y: -3 });
a.send({ type: "cursor", x: 1e9, y: 0 });
a.send({ type: "put", x: Infinity, y: 0 });
a.send({ type: "put", x: "1", y: 2 });
await sleep(350);
const cur = host.msgs.filter((m) => m.type === "cursor" || m.type === "put");
check("cursor values are bounded and typed", cur.length === 1 && cur[0].x === 5, JSON.stringify(cur));

clear();
for (const act of ["setweap \u0015", "setweap  \u0015", "setweap\t\u0015", "setweap \u0015"]) a.send({ type: "input", action: act });
await sleep(350);
check("Switch Hedgehog cannot be selected in an imposter room (any spacing)", !host.has((m) => m.type === "input" && /setweap/.test(m.action)));
a.send({ type: "input", action: "setweap \u0017" });
await sleep(250);
check("an ordinary weapon still passes", host.has((m) => m.type === "input" && /setweap/.test(m.action)));

// a controller cannot speak as the host
clear();
b.send({ type: "turn", team: "B hog", sid: b.sid });
b.send({ type: "state", state: "ended" });
b.send({ type: "notify", sid: a.sid, text: "forged" });
b.send({ type: "seat", sid: a.sid, seated: false });
b.send({ type: "release", sid: a.sid });
await sleep(400);
b.send({ type: "input", action: "+right" });
a.send({ type: "input", action: "+right" });
await sleep(350);
check("forged host messages change nothing: A still holds the turn, B does not", inputsFrom(host, a.sid) === 1 && inputsFrom(host, b.sid) === 0);
check("...and A received no forged notice, seat note or release", !a.has((m) => m.type === "notify" || m.type === "seat" || (m.type === "state" && m.state === "released")) && a.ws.readyState === 1);

// the AFK countdown is host -> phones; a phone cannot raise one
host.send({ type: "afk", team: "A hog", seconds: 10, endsAt: Date.now() + 10000 });
b.send({ type: "afk", team: "forged", seconds: 1 });
await sleep(350);
check("the host's AFK countdown reaches the phones", a.has((m) => m.type === "afk" && m.team === "A hog"));
check("...and a phone cannot send one", !a.has((m) => m.type === "afk" && m.team === "forged") && !host.has((m) => m.type === "afk"));

// the host's private messages reach exactly one phone
host.send({ type: "notify", sid: a.sid, text: "You are the IMPOSTER on the Red team." });
host.send({ type: "seat", sid: b.sid, seated: true, team: "Blue" });
await sleep(350);
check("the host's notify reaches only its target", a.has((m) => m.type === "notify" && /IMPOSTER/.test(m.text)) && !b.has((m) => m.type === "notify"));
check("the host's seat notice reaches only its target", b.has((m) => m.type === "seat" && m.team === "Blue") && !a.has((m) => m.type === "seat"));
host.send({ type: "release", sid: b.sid });
await sleep(400);
check("a release sends one player back (state released, socket closed)", b.has((m) => m.type === "state" && m.state === "released") && b.ws.readyState !== 1 && a.ws.readyState === 1);

// ------------------------------------------------------------------ flood ---
console.log("\n-- floods");
host.send({ type: "turn", team: "A hog", sid: a.sid });
await sleep(250);
clear();
const burst = JSON.stringify({ type: "input", action: "+left" });
for (let i = 0; i < 3000; i++) a.ws.send(burst);
await sleep(4000);
const got = inputsFrom(host, a.sid);
check("3000 messages in a burst: a bounded number reach the host", got >= 50 && got <= 450, `relayed=${got}`);
await sleep(2500);
clear();
a.send({ type: "input", action: "+right" });
await sleep(350);
check("after the flood the player can play again", host.has((m) => m.type === "input" && m.action === "+right"));

// ------------------------------------------------------------ seat takeover ---
console.log("\n-- seats");
{
  const t = await makeRoom({ mode: "teams", slots: 4 });
  const victim = await player(t.room, "victim");
  const thief = await player(t.room, "thief");
  victim.send({ type: "team", config: { name: "Seated Player" } });
  await sleep(400);
  thief.send({ type: "team", config: { name: "Seated Player" } });
  await sleep(400);
  const claims = t.host.msgs.filter((m) => m.type === "team");
  check("the rightful player has the seat", !!claims.find((m) => m.sid === victim.sid)?.seat);
  check("another connection typing that name cannot take it while its owner is connected", !claims.find((m) => m.sid === thief.sid)?.seat);
  victim.ws.close();
  await sleep(500);
  thief.send({ type: "team", config: { name: "Seated Player" } });
  await sleep(400);
  check("once the owner is gone the seat can be reclaimed", !!t.host.msgs.filter((m) => m.type === "team" && m.sid === thief.sid).pop()?.seat);
  thief.ws.close(); t.host.ws.close();
}

// ----------------------------------------------------------- cross-site sockets ---
console.log("\n-- cross-site sockets");
{
  const probe = async (origin) => { const q = new Peer("q"); q.cookie = a.cookie; await q.open(`/api/rooms/${room.room}/ws`, origin); const st = q.status; try { q.ws.close(); } catch {} return st; };
  check("a socket opened from another site's page is refused (403)", (await probe("https://evil.example")) === 403);
  check("the page's own origin is accepted", (await probe(BASE)) === 101);
  check("a non-browser client (the Qt host: no Origin) is accepted", (await probe(null)) === 101);
}

for (const p of [a, b]) try { p.ws.close(); } catch {}
host.ws.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
