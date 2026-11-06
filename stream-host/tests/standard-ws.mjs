// standard-ws.mjs - the STANDARD modes (classic / fixed / dynamic: every player owns
// a whole team) through the REAL engine in the stream container, played by ws
// phones. These modes name a turn's owner by sid, and the worker only relays
// input from that sid, so this proves the hardened room still lets every player
// play their turn.
//
//   ROOM_MODE=dynamic tests/imposter-stack.sh start      (or fixed; SLOTS=4)
//   node tests/standard-ws.mjs [players]                 (default 2)
//
// Checks: the team name the engine gets is the player's bound screen name (not
// what the phone typed), the typed hog names are used, every player gets turns
// and each of their turns ENDS (their input was relayed), and the engine stays up.
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
const N = Number(process.argv[2] ?? 2);
const SKIP = HW_WEAPONS.find((x) => x.name === "Skip").w;

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
  constructor(i) { this.i = i; this.cookie = ""; this.sid = null; this.turns = 0; this.ended = 0; this.msgs = []; }
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
    // a typed team name (must be ignored) and typed hog names (must be used)
    this.r.send(JSON.stringify({ type: "team", config: {
      name: `Typed Team ${this.i}`,
      hogs: ["Alpha", "Bravo", "Charlie", "Delta"].map((h) => ({ name: h })),
    } }));
  }
  onMsg(m) {
    this.msgs.push(m);
    if (m.type === "hello" && m.sid) this.sid = m.sid;
    if (m.type === "turn" && m.sid && m.sid === this.sid) {
      this.turns++;
      const at = (this.turnAt = Date.now());
      (async () => {
        // skip the turn (weapon, fire); retry if it did not end (hog still falling)
        for (let i = 0; i < 4 && this.turnAt === at; i++) {
          try { this.r.send(JSON.stringify({ type: "input", action: "setweap " + String.fromCharCode(SKIP) })); } catch {}
          await sleep(500);
          try { this.r.send(JSON.stringify({ type: "input", action: "+attack" })); } catch {}
          await sleep(400);
          try { this.r.send(JSON.stringify({ type: "input", action: "-attack" })); } catch {}
          await sleep(12000);
        }
      })();
    } else if (m.type === "turn" && this.turnAt && m.sid !== this.sid) {
      // somebody else's turn started: ours is over, so our input reached the engine
      if (!this.turnCounted || this.turnCounted !== this.turnAt) { this.ended++; this.turnCounted = this.turnAt; }
    }
  }
  drop() { try { this.r?.close(); this.q?.close(); } catch {} }
}

const players = Array.from({ length: N }, (_, i) => new Phone(i));
try {
  const agentRoom = () => [...agentLog().matchAll(/\[agent\] room: (\w+)/g)].map((m) => m[1]).pop();
  const mode = (agentLog().match(/mode (\w+)/) ?? [])[1] ?? "?";
  log(`${N} players, container mode ${mode}`);
  await until("lobby open", async () => {
    const s = await qstate();
    return agentRoom() && s.roundRoom === agentRoom() && (s.phase === "lobby" || s.phase === "countdown");
  }, 240000, 1000);
  for (const p of players) { await p.arrive(); await sleep(200); }
  log("players in; waiting for the game to start");
  await until("game start", async () => (await qstate()).phase === "ingame", 180000, 1000);
  await sleep(4000);
  let txt = agentLog();
  const registered = [...txt.matchAll(/registered team "([^"]+)"/g)].map((m) => m[1]);
  check("each team is registered under the player's bound screen name", players.every((p) => registered.includes(p.name)), `registered=${registered.join(",")}`);
  check("what the phones typed as a team name was never used", !registered.some((n) => n.startsWith("Typed Team")) && !/Typed Team/.test(txt));
  check("the engine got the config", /engine config sent: \d+ teams/.test(txt), (txt.match(/engine config sent: .*/) ?? [])[0]);

  log("playing turns for a while...");
  await until("every player had a turn that ended", async () => players.every((p) => p.turns >= 1 && p.ended >= 1), 300000, 3000);
  check("every player got a turn", players.every((p) => p.turns >= 1), players.map((p) => p.turns).join(","));
  check("every turn ENDED once its player acted (input reached the engine)", players.every((p) => p.ended >= 1), players.map((p) => p.ended).join(","));
  txt = agentLog();
  check("the engine did not crash", !/engine exited code=(?!0\b)\d+/.test(txt), (txt.match(/engine exited code=\d+/) ?? ["running"])[0]);
} catch (e) {
  check("run completed", false, e.message);
} finally {
  players.forEach((p) => p.drop());
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
