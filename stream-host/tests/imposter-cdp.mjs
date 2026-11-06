// imposter-cdp.mjs — end-to-end proof of imposter mode with REAL Chrome
// instances driven over CDP (no fake sockets: every player is a browser page
// clicking the actual phone UI). The stream host (agent + engine, stream
// mode with a recording) runs in a container and talks to a local
// `wrangler dev` worker; this script only plays the phones and asserts.
//
// Covers: the 6-player minimum, pairs-only queue admission, the private
// imposter reveal, and the defection — every non-imposter on the imposter's
// team self-destructs with Kamikaze (everyone else just takes Skip) until the
// imposter is their team's last hog; the engine then swaps them onto the
// survivors, the round ends, and the worker counts the imposter as a winner.
//
// usage (worker + stream container already up):
//   node tests/imposter-cdp.mjs
// env: BASE (worker, default http://127.0.0.1:8790), CHROME, OUT_DIR,
//      AGENT_CONTAINER (podman container name for agent logs, default hwstream-agent),
//      PLAYERS (8 = default; 4v4 teams, ROOM_SLOTS=4 on the host)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.OUT_DIR ?? "recordings/imposter-test";
const CONTAINER = process.env.AGENT_CONTAINER ?? "hwstream-agent";
// names must be safewords (data/safewords.txt): the agent replaces any other word, which would collapse
// every test player into the same random name
const NAMES = ["Teapot", "Banana", "Tuxedo", "Waffle", "Noodle", "Turnip", "Hippos", "Sprout"];
const N = Math.min(8, Number(process.env.PLAYERS ?? 8));
const PORT0 = 9300;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}
async function until(what, fn, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${what}`);
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------- worker ----
async function qstate() {
  const r = await fetch(`${BASE}/api/queue/state`);
  return r.json();
}
// PODMAN: the container CLI as a command line (default "podman"); on Windows
// Chrome/WSL-podman splits use e.g. PODMAN="wsl -e podman"
const PODMAN = (process.env.PODMAN ?? "podman").split(" ");
function agentLog() {
  const r = spawnSync(PODMAN[0], [...PODMAN.slice(1), "logs", CONTAINER], { encoding: "utf8", maxBuffer: 64 << 20 });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

// ---------------------------------------------------------------- CDP ----
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

class Player {
  constructor(i) {
    this.i = i;
    // the stream binds the screen name server-side (AnonX): `wanted` is only
    // the local label for screenshots; `name` stays null until the page shows
    // the bound one
    this.wanted = NAMES[i];
    this.name = null;
    this.port = PORT0 + i;
    this.dir = mkdtempSync(join(tmpdir(), `hwchrome-${i}-`));
    this.acted = "";
    this.policy = "skip";
    this.turns = 0;
  }
  async launch() {
    this.proc = spawn(CHROME, [
      "--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*",
      `--user-data-dir=${this.dir}`, "--no-first-run", "--no-default-browser-check",
      "--mute-audio", "--window-size=430,900", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "about:blank",
    ], { stdio: "ignore" });
    const target = await until(`chrome ${this.i} up`, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        return (await r.json()).find((t) => t.type === "page");
      } catch { return null; }
    }, 20000, 300);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    this.cdp = new Cdp(ws);
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    this.errors = [];
    this.cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    });
    // keep a handle on every WebSocket the page opens (queue + room): hostile
    // traffic below is sent through the page's genuine, authenticated sockets
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const W = window.WebSocket;
      window.__socks = [];
      window.WebSocket = function (...a) { const s = new W(...a); window.__socks.push(s); return s; };
      window.WebSocket.prototype = W.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = W[k];
    })();` });
    // alert() would block the page
    this.cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Page.javascriptDialogOpening") this.cdp.send("Page.handleJavaScriptDialog", { accept: true });
    });
  }
  async eval(expr) {
    const r = await this.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  }
  // a real mouse click at the element's centre (pointer events included)
  async mouse(sel, type) {
    const rect = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:!!e.disabled}})()`);
    if (!rect) throw new Error(`no element ${sel}`);
    if (rect.disabled) throw new Error(`disabled ${sel}`);
    await this.cdp.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
  async click(sel) {
    await this.mouse(sel, "mouseMoved");
    await this.mouse(sel, "mousePressed");
    await this.mouse(sel, "mouseReleased");
  }
  async hold(sel, ms) {
    await this.mouse(sel, "mouseMoved");
    await this.mouse(sel, "mousePressed");
    await sleep(ms);
    await this.mouse(sel, "mouseReleased");
  }
  // attacker toolkit: fire raw messages down one of the page's own sockets
  async sock(kind, obj) {
    return this.eval(`(()=>{const s=(window.__socks||[]).filter(s=>s.readyState===1&&s.url.includes(${JSON.stringify(kind)})).pop();if(!s)return false;s.send(${JSON.stringify(JSON.stringify(obj))});return true})()`);
  }
  async hostile() {
    // everything a malicious phone might try while it is NOT its turn
    const sent = [];
    for (const m of [
      { type: "input", action: "+attack" }, { type: "input", action: "J" },
      { type: "input", action: "+left" }, { type: "input", action: "setweap \u0017" },
      { type: "input", action: "setweap \u0007" }, { type: "cursor", x: 40, y: 40 },
      { type: "put", x: 0, y: 0 }, { type: "turn", team: "evil", sid: "x" },
      { type: "notify", sid: "x", text: "forged" },
    ]) sent.push(await this.sock("/rooms/", m).catch(() => false));
    this.hostileSent = (this.hostileSent ?? 0) + sent.filter(Boolean).length;
  }
  snap() {
    return this.eval(`(()=>{const q=(s)=>document.querySelector(s);const v=(e)=>e&&!e.hidden&&e.offsetParent!==null;
      return {active:q("#active")?.textContent??"",status:q("#status")?.textContent??"",
        role:v(q("#rolenote"))?q("#rolenote").textContent:"",
        game:v(q("#game")),queue:q("#queuePos")?.hidden?"":q("#queuePos")?.textContent??"",
        teamform:v(q("#teamform")),ingame:document.body.classList.contains("ingame"),
        fireOff:q("#fire")?.disabled??true,weapOff:q("#weaponsBtn")?.disabled??true}})()`);
  }
  async shot(label) {
    const r = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${label}-${this.wanted}.png`), Buffer.from(r.data, "base64"));
  }
  // join the stream queue. The stream binds the screen name (AnonX for a guest):
  // read it off the page. In the imposter mode the page claims the seat itself.
  async join() {
    await this.cdp.send("Page.navigate", { url: BASE + "/" });
    await until(`queue button (${this.i})`, async () => this.eval(`!!document.getElementById("queueBtn")&&!document.getElementById("queueui").hidden`), 15000, 200);
    this.joined = true;
    try {
      // a page that is slow to attach its handlers (eight browsers at once) can
      // swallow the first click: click again if no name has been bound
      for (let attempt = 0; attempt < 3 && !this.name; attempt++) {
        await this.click("#queueBtn");
        this.name = await until(`bound name (${this.i})`, async () => (await this.eval(`document.getElementById("tname").value`)) || null, attempt < 2 ? 6000 : 15000, 200).catch(() => null);
      }
      if (!this.name) throw new Error(`no bound name for player ${this.i}`);
    } catch (e) {
      const state = await this.eval(`JSON.stringify({href:location.href,ready:document.readyState,queueHidden:document.getElementById("queueui").hidden,btn:!!document.getElementById("queueBtn"),pos:document.getElementById("queuePos").textContent,who:document.getElementById("whoami").textContent})`).catch((x) => String(x));
      log(`player ${this.i} page state: ${state}; script errors: ${JSON.stringify(this.errors ?? [])}`);
      throw e;
    }
  }
  // turn loop: act once per "YOUR TURN" using the real weapon grid + fire button
  startTurns() {
    this.turnLoop = (async () => {
      while (!this.stopped) {
        try {
          const s = await this.snap();
          // an action that did not end the turn within 12s (hog still falling,
          // weapon not yet accepted) is retried rather than idled to the timeout
          if (this.acted === "turn" && s.active === "YOUR TURN" && Date.now() - this.actedAt > 12000) this.acted = "";
          if (s.active === "YOUR TURN" && !s.weapOff && !s.fireOff && this.acted !== "turn") {
            this.acted = "turn";
            this.actedAt = Date.now();
            this.turns++;
            const weapon = this.policy === "kamikaze" ? "Kamikaze" : "Skip";
            log(`${this.name}: my turn -> ${weapon}`);
            await this.click("#weaponsBtn");
            await sleep(300);
            const picked = await this.eval(`(()=>{const c=[...document.querySelectorAll(".wcell")].find(c=>c.querySelector(".wname")?.textContent===${JSON.stringify(weapon)}&&c.offsetParent!==null);if(!c||c.classList.contains("dim"))return false;c.scrollIntoView({block:"center"});const r=c.getBoundingClientRect();window.__cell={x:r.x+r.width/2,y:r.y+r.height/2};return true})()`);
            if (picked) {
              const { x, y } = await this.eval("window.__cell");
              for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
                await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
            } else log(`${this.name}: ${weapon} unavailable in the grid`);
            await sleep(300);
            await this.click("#wclose");
            await sleep(300);
            await this.hold("#fire", 400);
          } else if (s.active !== "YOUR TURN") {
            this.acted = "";
            if (this.attack && s.game) await this.hostile();
          }
        } catch (e) {
          // a transient (page navigating, controls disabled) — retry next tick
        }
        await sleep(400);
      }
    })();
  }
  async stop() {
    this.stopped = true;
    try { this.cdp?.ws.close(); } catch {}
    if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

// --------------------------------------------------------------- the run ---
const players = NAMES.slice(0, N).map((_, i) => new Player(i));
let exitCode = 0;
try {
  log(`worker ${BASE}, ${N} chrome instances, agent container "${CONTAINER}"`);
  const st0 = await until("worker reachable", async () => { try { return await qstate(); } catch { return null; } }, 30000, 1000);
  log("queue state at start:", st0.phase);

  // the host opens a round (slate -> lobby); players only join once it is open
  // the container agent's CURRENT room (the queue may still show an older one)
  await until("lobby open", async () => {
    const room = [...agentLog().matchAll(/\[agent\] room: (\w+)/g)].map((m) => m[1]).pop();
    const s = await qstate();
    return room && s.roundRoom === room && s.phase === "lobby";
  }, 360000, 1000);
  log("lobby open");
  await Promise.all(players.map((p) => p.launch()));
  log("chrome instances up");

  // --- singles are let in as they arrive, seated two at a time ---------------
  const seatedOf = (r) => (r.teams ?? []).reduce((n, t) => n + t.seats.filter(Boolean).length, 0);
  for (let i = 0; i < 5; i++) { await players[i].join(); await sleep(1500); }
  await sleep(4000);
  let st = await qstate();
  check("5 joined: all five are in the lobby", st.roster.joined === 5, `joined=${st.roster.joined}`);
  check("5 joined: four seated (in pairs), one waiting", seatedOf(st.roster) === 4 && st.roster.waiting.length === 1, `seated=${seatedOf(st.roster)} waiting=${st.roster.waiting.length}`);
  check("5 joined: no countdown below 6 seated", st.phase === "lobby" && !st.countdownEndsAt, `phase=${st.phase}`);
  check("every player was given an AnonX screen name", players.slice(0, 5).every((p) => /^Anon[A-Z][a-z]+\d*$/.test(p.name)), players.slice(0, 5).map((p) => p.name).join(","));
  await players[4].shot("5-players-one-waiting");

  // --- 6th player: a pair seats, the countdown starts -----------------------
  await players[5].join();
  st = await until("countdown", async () => { const s = await qstate(); return s.phase === "countdown" ? s : null; }, 30000, 500);
  check("6 players: countdown starts", !!st.countdownEndsAt);
  check("6 players: all six seated", seatedOf(st.roster) === 6 && st.roster.waiting.length === 0, `seated=${seatedOf(st.roster)}`);

  if (N >= 8) {
    await players[6].join();
    await sleep(3000);
    st = await qstate();
    check("7th player is in the lobby, waiting for a partner", st.roster.joined === 7 && seatedOf(st.roster) === 6 && st.roster.waiting.length === 1, `joined=${st.roster.joined} seated=${seatedOf(st.roster)}`);
    await players[7].join();
    await sleep(3000);
    st = await qstate();
    check("8th joins: the pair is seated, 4v4", seatedOf(st.roster) === 8 && st.roster.waiting.length === 0, `seated=${seatedOf(st.roster)}`);
    check("each team is drawn with its 4 seated players", st.roster.teams.every((t) => t.seats.length === 4), JSON.stringify(st.roster.teams.map((t) => t.seats.length)));
  }

  // --- game start + the private reveal: one traitor on each team ------------
  await until("game start", async () => (await qstate()).phase === "ingame", 90000, 1000);
  log("game started");
  const roles = await until("imposter whispers", async () => {
    const snaps = await Promise.all(players.map((p) => p.snap()));
    const have = snaps.map((s, i) => (s.role ? i : -1)).filter((i) => i >= 0);
    return have.length >= 2 ? { have, snaps } : null;
  }, 60000, 1000);
  check("exactly two phones got the private imposter reveal", roles.have.length === 2, `phones=${roles.have.map((i) => players[i].name)}`);
  const imps = roles.have.map((i) => players[i]);
  const impTeams = roles.have.map((i) => /on the (\w+) team/.exec(roles.snaps[i].role)?.[1]);
  check("one imposter on each team", new Set(impTeams).size === 2, JSON.stringify(impTeams));
  const imp = imps[0];
  log(`imposters: ${imps.map((p, k) => `${p.name} (${impTeams[k]})`).join(" and ")}`);
  await Promise.all(players.map((p) => p.shot("reveal")));

  // --- teams from the agent log -------------------------------------------
  await sleep(1000);
  const txt = agentLog();
  const seatTeam = {};
  for (const m of txt.matchAll(/seat claimed: (Red|Blue) hog \d+ <- "(\w+)"/g)) seatTeam[m[2]] = m[1];
  const impTeam = seatTeam[imp.name];
  log("seats:", JSON.stringify(seatTeam));
  const evenTeams = Object.values(seatTeam).filter((t) => t === "Red").length === Object.values(seatTeam).filter((t) => t === "Blue").length;
  check("teams are even", evenTeams, JSON.stringify(seatTeam));
  check("agent log names both imposters", imps.every((p) => new RegExp(`imposter: ${p.name} \\(${seatTeam[p.name]} hog`).test(txt)));

  // --- play: the imposter's teammates Kamikaze, everyone else Skips --------
  for (const p of players) p.policy = (seatTeam[p.name] === impTeam && p !== imp) ? "kamikaze" : "skip";
  log("policies:", players.map((p) => `${p.name}:${seatTeam[p.name]}:${imps.includes(p) ? "IMPOSTER-skip" : p.policy}`).join(" "));
  const before = (await qstate()).lastgame;
  // every player also attacks while it is NOT their turn (input spam, forged
  // turn/notify, cursor/put) through the page's own authenticated socket
  players.forEach((p) => { p.attack = true; });
  players.forEach((p) => p.startTurns());

  const end = await until("round end", async () => {
    const s = await qstate();
    return s.lastgame && JSON.stringify(s.lastgame) !== JSON.stringify(before) ? s : null;
  }, 12 * 60 * 1000, 3000).catch((e) => { check("round ends", false, e.message); return null; });
  await sleep(1500);
  const finalLog = agentLog();
  await Promise.all(players.map((p) => p.shot("end").catch(() => {})));
  if (end) {
    const lines = end.lastgame.lines ?? [];
    log("lastgame:", JSON.stringify(end.lastgame));
    const defected = new RegExp(`imposter ${imp.name} defected from ${impTeam}`).test(finalLog);
    check("engine swapped the lone imposter (agent saw the defection notice)", defected);
    const otherTeam = impTeam === "Red" ? "Blue" : "Red";
    check("the surviving team won", end.lastgame.winner === otherTeam, `winner=${end.lastgame.winner}`);
    check("results reveal the traitor", lines.some((l) => l.includes(`Imposter revealed: ${imp.name} betrayed ${impTeam}`)));
    check("results name both imposters", lines.some((l) => /The imposters were/.test(l) && imps.every((p) => l.includes(p.name))));
    // guests (AnonX) are deliberately not on the ladder: who counts as a winner
    // is covered by tests/result.mjs, and ladder credit for signed-in players
    // by tests/auth-flow.mjs
    log("ladder:", JSON.stringify(end.ladder));
    check("guests never reach the ladder", !(end.ladder ?? []).some((e) => /^Anon[A-Z]/.test(e.name)), JSON.stringify(end.ladder));
  }
  writeFileSync(join(OUT, "agent.log"), finalLog);

  // --- cross-user injection audit: every command the agent relayed to the
  // engine must come from the player whose turn it was ------------------------
  let cur = null, relays = 0, bad = [];
  for (const line of finalLog.split(/\r?\n/)) {
    let m = line.match(/turn: .*\(sid ([0-9a-f]{8})\)/);
    if (m) { cur = m[1]; continue; }
    if (/turn: .*\((engine cpu|cpu)\)/.test(line)) { cur = null; continue; }
    m = line.match(/relay ([0-9a-f]{8}) (\S.*)/);
    if (m) { relays++; if (m[1] !== cur) bad.push(`${m[1]} (turn=${cur}): ${m[2]}`); }
  }
  const hostile = players.reduce((n, p) => n + (p.hostileSent ?? 0), 0);
  check("hostile non-turn traffic was actually sent", hostile > 50, `${hostile} messages`);
  check("legitimate turn commands were relayed", relays > 0, `${relays} relayed`);
  check("no relayed command came from anyone but the active player", bad.length === 0, bad.slice(0, 3).join(" | "));
  check("no forged turn/notify reached the phones", !/forged|evil/.test(finalLog));
} catch (e) {
  check("run completed", false, e.message);
} finally {
  for (const p of players) await p.stop();
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
