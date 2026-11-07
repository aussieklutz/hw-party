// weapons-cdp.mjs - plays real games through the web controller to use every weapon.
//
// A headless Chrome opens the actual phone page, joins the stream queue, builds a
// team and then, turn by turn, picks each weapon from the Weapons panel, aims with
// the pointer and move pads and fires with the Fire button - every click goes
// through the page's own handlers and socket. The proof does not come from the
// phone: it comes from the engine's own game log (Logs/game0.log), which records
// the weapon change it received, the fire commands and every gear (shell, bomb,
// plane ...) a shot creates.
//
// Needs a worker on BASE and a stream host running against it with the test aids
//   AMMO_ALL=1 HOG_HEALTH=500 SD_TURNS=500   (every weapon, tough hogs, no sudden death)
// (stream-host/tests/weapons-stack.ps1 starts the pair).
//
//   node tests/weapons-cdp.mjs
// env: BASE (default http://127.0.0.1:8790)   CHROME   OUT_DIR
//      ENGINE_LOGS  the engine's Logs directory (default %TEMP%\hw-stream\Logs)
//      AGENT_LOG    the agent's output file, scanned for "bad msg"
//      WEAPONS      only these (numbers or names, comma separated)
//      MAX_MINUTES  give up after this long (default 90)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.OUT_DIR ?? "recordings/weapons-test";
const LOG_DIR = process.env.ENGINE_LOGS ?? join(tmpdir(), "hw-stream", "Logs");
const AGENT_LOG = process.env.AGENT_LOG ?? "";
const MAX_MS = Number(process.env.MAX_MINUTES ?? 90) * 60000;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a);
async function until(what, fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

// the weapon list the phone itself uses (an ES module file in a CommonJS package)
const WEAPONS = (() => {
  const src = readFileSync(join(here, "..", "worker", "public", "weapons.js"), "utf8").replace(/export\s*\{[^}]*\};?/, "");
  return new Function(`${src}; return HW_WEAPONS;`)();
})();

// ---- how each weapon is used --------------------------------------------------
// The properties come from the engine's ammo table (uVariables.pas Ammoz).
const TARGET = new Set([4, 16, 17, 19, 20, 28, 43, 50, 56]); // a map point is picked with the pointer pad
// used without ending the turn: several can be chained before the turn's one real shot
const CHAIN = new Set([8, 15, 19, 21, 32, 33, 34, 35, 36, 37, 39, 42, 49, 51, 53, 56]);
// ... but these leave the hedgehog swinging, flying or falling (or, Land Spray, a tool that stays
// live and takes the next Fire for itself), so each gets a turn of its own
// and the turn is then ended with Skip
const MOVING = new Set([8, 15, 39, 53]);
// what the engine must have created for the weapon to count as used (its log shows
// "AddGear: ... type = gtXxx"; the log prints control characters as "?", so the weapon
// change itself cannot be read back - the gear it produces is the proof)
const EXPECT = {
  1: ["gtGrenade"], 2: ["gtClusterBomb"], 3: ["gtShell"], 4: ["gtBee"], 5: ["gtShotgunShot"], 6: ["gtPickHammer"],
  7: [], 8: ["gtRope"], 9: ["gtMine"], 10: ["gtDEagleShot"], 11: ["gtDynamite"], 12: ["gtFirePunch"], 13: ["gtWhip"],
  14: ["gtShover"], 15: ["gtParachute"], 16: ["gtAirAttack", "gtAirBomb"], 17: ["gtAirAttack", "gtMine"],
  18: ["gtBlowTorch"], 19: ["gtGirder"], 20: ["gtTeleport"], 21: ["gtSwitcher"], 22: ["gtMortar"], 23: ["gtKamikaze"],
  24: ["gtCake"], 25: ["gtSeduction"], 26: ["gtWatermelon"], 27: ["gtHellishBomb"], 28: ["gtAirAttack", "gtNapalmBomb"],
  29: ["gtDrill"], 30: ["gtBallgun"], 31: ["gtRCPlane"], 32: [], 33: [], 34: [], 35: [], 36: [], 37: [],
  38: ["gtSniperRifleShot"], 39: ["gtJetpack"], 40: ["gtMolotov"], 41: ["gtBirdy"], 42: ["gtPortal"], 43: ["gtPiano"],
  44: ["gtGasBomb"], 45: ["gtSineGunShot"], 46: ["gtFlamethrower"], 47: ["gtSMine"], 48: ["gtHammer"],
  49: ["gtResurrector"], 50: ["gtAirAttack", "gtDrill"], 51: ["gtSnowball"], 52: ["gtTardis"], 53: ["gtLandGun"],
  54: ["gtIceGun"], 55: ["gtKnife"], 56: ["gtGirder"], 57: ["gtAirMine"], 58: ["gtCreeper"], 59: ["gtMinigun"], 60: ["gtSentry"],
};
// the engine takes these out of every store on a map with a border (DisableSomeWeapons); the phone
// still lists them, and a click on one of those maps is ignored
const NOT_BORDER = new Set([16, 17, 28, 43, 50]);
// the engine never lets anyone have these ("Always remove creeper because it's unfinished", uAmmos.pas)
const REMOVED = new Set([58]);
const POWER = new Set([1, 2, 3, 4, 26, 27, 29, 40, 44, 47, 51, 55, 57]); // hold Fire to throw harder
const CONTINUOUS = new Set([6, 18, 46, 53, 59]); // hold Fire down while they work

// h: the controller's own buttons
const SPECIAL = {
  8: async (h) => { await h.hold("+up", 250); await h.fire(120); await h.wait(1500); await h.fire(120); await h.wait(2500); }, // rope: shoot, swing, let go (Fire again), land
  15: async (h) => { await h.act("J"); await h.wait(500); await h.fire(120); await h.wait(1500); }, // parachute in mid-air
  24: async (h) => { await h.fire(120); await h.wait(3500); await h.fire(120); }, // cake: walk, then bake
  31: async (h) => { await h.fire(120); await h.wait(1200); await h.hold("+up", 400); await h.fire(120); await h.wait(1500); }, // RC plane: launch, climb, bomb
  39: async (h) => { await h.fire(120); await h.wait(500); await h.hold("+up", 900); await h.wait(1500); }, // flying saucer
  41: async (h) => { await h.fire(120); await h.wait(500); await h.fire(120); await h.wait(500); await h.fire(120); }, // birdy flaps
  42: async (h) => { await h.fire(120); await h.wait(600); await h.act("s"); await h.fire(120); }, // portal gun: a portal, switch colour, the other
  23: async (h) => { await h.hold("+right", 300); await h.fire(120); await h.wait(300); }, // kamikaze
  38: async (h) => { await h.fire(120); await h.wait(1800); await h.fire(120); }, // sniper: the first press raises the rifle, the second takes the shot
  5: async (h) => { await h.fire(120); await h.wait(1200); await h.fire(120); }, // shotgun: two shots a turn
  10: async (h) => { await h.fire(120); await h.wait(1000); await h.fire(120); await h.wait(1000); await h.fire(120); }, // desert eagle: up to three
};

function recipeFor(w) {
  if (SPECIAL[w]) return SPECIAL[w];
  if (TARGET.has(w)) {
    return async (h) => {
      await h.cur("right", 450); await h.cur("up", 250); await h.click();
      if (w === 4) { await h.wait(300); await h.fire(500); } // the bee takes a target, then a throw
    };
  }
  if (POWER.has(w)) return async (h) => { await h.hold("+up", 200); await h.fire(900); };
  if (CONTINUOUS.has(w)) return async (h) => { await h.hold("+up", 150); await h.fire(1800); };
  return async (h) => { await h.fire(150); };
}

// ---- a minimal CDP browser ------------------------------------------------------
class Browser {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwweap-"));
    this.proc = spawn(CHROME, [
      "--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`,
      "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=430,900",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank",
    ], { stdio: "ignore" });
    const target = await until("chrome", async () => {
      try { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((t) => t.type === "page"); } catch { return null; }
    }, 20000, 300);
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === "Page.javascriptDialogOpening") this.send("Page.handleJavaScriptDialog", { accept: true });
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    // record what the page's socket receives and sends
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{
      const W = window.WebSocket; window.__in = []; window.__out = [];
      window.WebSocket = function (...a) {
        const s = new W(...a);
        s.addEventListener("message", (e) => { try { window.__in.push({ t: Date.now(), m: JSON.parse(e.data) }); } catch {} });
        const send = s.send.bind(s);
        s.send = (d) => { try { window.__out.push({ t: Date.now(), m: JSON.parse(d) }); } catch {} return send(d); };
        return s;
      };
      window.WebSocket.prototype = W.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = W[k];
    })()` });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  }
  async center(sel) {
    const r = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    if (!r) throw new Error(`no element ${sel}`);
    return r;
  }
  async down(sel) {
    const p = await this.center(sel);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    return p;
  }
  async up(p) { await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }); }
  async hold(sel, ms) { const p = await this.down(sel); await sleep(ms); await this.up(p); }
  async click(sel) { await this.hold(sel, 60); }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }
  async close() {
    try { this.ws.close(); } catch {}
    if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

// ---- the engine's game log ---------------------------------------------------------
function newestEngineLog() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR).filter((f) => /^game\d*\.log$/.test(f)).map((f) => ({ f, t: statSync(join(LOG_DIR, f)).mtimeMs }));
  files.sort((a, b) => b.t - a.t);
  return files[0] ? join(LOG_DIR, files[0].f) : null;
}
// everything the engine logged since `mark` (a {file, size}); the log restarts with each game
function engineSince(mark) {
  const file = newestEngineLog();
  if (!file) return "";
  const size = statSync(file).size;
  const from = mark && mark.file === file && mark.size <= size ? mark.size : 0;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("latin1");
  } finally { closeSync(fd); }
}
function engineMark() {
  const file = newestEngineLog();
  return { file, size: file ? statSync(file).size : 0 };
}
function agentBad(since) {
  if (!AGENT_LOG || !existsSync(AGENT_LOG)) return [];
  return readFileSync(AGENT_LOG, "utf8").split(/\r?\n/).slice(since).filter((l) => /bad msg|engine socket|exited|Error/.test(l));
}
const agentLines = () => (AGENT_LOG && existsSync(AGENT_LOG) ? readFileSync(AGENT_LOG, "utf8").split(/\r?\n/).length : 0);

function evidence(slice) {
  const gears = [...slice.matchAll(/AddGear: #\d+ \([^)]*\), d\([^)]*\) type = (gt\w+)/g)].map((m) => m[1]);
  return {
    selected: (slice.match(/\[Cmd\] \/?setweap /g) ?? []).length > 0,
    attacks: (slice.match(/\[Cmd\] \+attack/g) ?? []).length,
    cursor: (slice.match(/\[IPC in\] P /g) ?? []).length,
    puts: (slice.match(/\[IPC in\] p /g) ?? []).length,
    putTaken: /^\d+: put: -?\d+, -?\d+/m.test(slice),
    gears: [...new Set(gears)],
    explosions: (slice.match(/^\d+: Explosion:/gm) ?? []).length,
  };
}

// ---- the player -------------------------------------------------------------------------
const b = new Browser(9600);
const results = new Map(); // w -> result
let borderedRoom = ""; // the room whose map has a border (its strike weapons are out)
const tries = new Map();

const roomNow = () => b.eval(`(window.__in.filter((x) => x.m.type === "hello").pop() ?? {m: {}}).m.room ?? ""`);
const ownTurn = () => b.eval(`/YOUR TURN/.test(document.getElementById("active")?.textContent ?? "") && !document.getElementById("controls").hidden && !document.getElementById("weaponsBtn").disabled && !document.getElementById("fire").disabled`);
const inGame = () => b.eval(`!!document.getElementById("controls") && !document.getElementById("controls").hidden`);

const H = {
  wait: sleep,
  hold: (dir, ms) => (dir.startsWith("+") || dir.startsWith("-") ? b.hold(`[data-act="${dir}"]`, ms) : b.hold(`[data-cur="${dir}"]`, ms)),
  cur: (dir, ms) => b.hold(`[data-cur="${dir}"]`, ms),
  act: (a) => b.click(`[data-act="${a}"]`),
  fire: (ms) => b.hold("#fire", ms),
  click: () => b.click("#cclick"),
};

async function selectWeapon(w) {
  const name = WEAPONS.find((x) => x.w === w).name;
  await b.click("#weaponsBtn");
  await until("weapons panel", () => b.eval(`document.getElementById("weaponspanel").classList.contains("open")`), 4000, 100);
  const idx = await b.eval(`(()=>{const cells=[...document.querySelectorAll("#wgridwrap .wcell")];
    const i=cells.findIndex(c=>c.querySelector(".wname")?.textContent===${JSON.stringify(name)});
    cells.forEach((c,j)=>c.dataset.pick=j===i?"1":"");return i})()`);
  if (idx < 0) throw new Error(`no ${name} in the weapons panel`);
  await b.click('#wgridwrap .wcell[data-pick="1"]');
  await sleep(250);
  await b.click("#wclose");
  await sleep(150);
}

async function useWeapon(w, closer) {
  const name = WEAPONS.find((x) => x.w === w).name;
  const mark = engineMark();
  const alines = agentLines();
  const outFrom = await b.eval("window.__out.length");
  const fired = Date.now();
  const rec = { w, name, closer, ok: false, notes: [], fired };
  try {
    await selectWeapon(w);
    await recipeFor(w)(H);
  } catch (e) {
    rec.notes.push(`driver: ${e.message}`);
  }
  // let the shot play out; a closer ends the turn
  const settle = closer ? 60000 : 1800; // a full turn is 45 s: flames, long fuses and multi-shot weapons can keep it open that long
  const end = Date.now() + settle;
  while (Date.now() < end) {
    if (closer && !(await ownTurn())) break;
    await sleep(250);
  }
  rec.turnEnded = closer ? !(await ownTurn()) : null;
  await sleep(400);
  const sent = await b.eval(`window.__out.slice(${outFrom}).map(x=>x.m.type+(x.m.action?":"+x.m.action:""))`);
  rec.sent = { setweap: sent.filter((s) => s.startsWith("input:setweap")).length, cursor: sent.filter((s) => s === "cursor").length, put: sent.filter((s) => s === "put").length, attack: sent.filter((s) => s === "input:+attack").length };
  const ev = evidence(engineSince(mark));
  rec.engine = ev;
  const bad = agentBad(alines).filter((l) => /bad msg/.test(l));
  if (bad.length) rec.notes.push(`${bad.length} bad msg`);
  if (!ev.selected) rec.notes.push("engine did not log the weapon change");
  if (TARGET.has(w) && ev.puts === 0) rec.notes.push("no put reached the engine");
  if (!ev.attacks && !(TARGET.has(w) && !CONTINUOUS.has(w) && ev.puts)) rec.notes.push("no fire reached the engine");
  const got = ev.gears.map((g) => g.toLowerCase()); // Pascal is case-blind: gtBallGun / gtBallgun
  const missing = EXPECT[w].filter((g) => !got.includes(g.toLowerCase()));
  if (NOT_BORDER.has(w) && ev.puts && !ev.putTaken && missing.length) {
    // the engine ignored the click: not an error of the stack
    borderedRoom = await roomNow();
    rec.blocked = true;
    rec.notes = rec.notes.filter((n) => !/no fire reached/.test(n));
    rec.notes.push("blocked: the map has a border, so the engine has taken this weapon out");
    rec.ms = Date.now() - fired;
    return rec;
  }
  if (REMOVED.has(w) && missing.length) {
    rec.blocked = true;
    rec.notes = ["blocked: the engine removes this weapon from every game (unfinished)"];
    rec.ms = Date.now() - fired;
    return rec;
  }
  if (missing.length) rec.notes.push(`engine never created ${missing.join(", ")}`);
  if (closer && !rec.turnEnded) rec.notes.push("turn did not end");
  rec.ok = rec.notes.length === 0;
  rec.ms = Date.now() - fired;
  return rec;
}

function report(partial = false) {
  const rows = WEAPONS.map((x) => results.get(x.w)).filter(Boolean);
  const lines = [`# Weapon test ${partial ? "(partial) " : ""}${new Date().toISOString()}`, "",
    "| # | weapon | result | selected | fire | gears the engine created | notes |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${r.w} | ${r.name} | ${r.ok ? "PASS" : r.blocked ? "BLOCKED" : "FAIL"} | ${r.engine.selected ? "yes" : "NO"} | ${r.engine.attacks || r.engine.puts ? `${r.engine.attacks} atk ${r.engine.puts} put` : "NO"} | ${r.engine.gears.join(", ") || "-"} | ${r.notes.join("; ")} |`);
  }
  const pass = rows.filter((r) => r.ok).length;
  const blocked = rows.filter((r) => r.blocked).length;
  lines.push("", `${pass}/${rows.length} passed, ${blocked} blocked, ${WEAPONS.length - rows.length} not reached`);
  writeFileSync(join(OUT, "weapons-report.md"), lines.join("\n") + "\n");
  writeFileSync(join(OUT, "weapons-report.json"), JSON.stringify(rows, null, 1));
  return { pass, tested: rows.length };
}

async function joinAndBuildTeam() {
  await b.send("Page.navigate", { url: BASE + "/" });
  await until("queue button", () => b.eval(`!!document.getElementById("queueBtn")&&!document.getElementById("queueui").hidden`), 20000);
  await sleep(600);
  await b.click("#queueBtn");
  await until("in the room", () => b.eval(`!document.getElementById("game").hidden`), 12 * 60000);
  // the team form arrives with the room's first state message (or while still queued): fill the
  // hedgehog names and save, again if the click is not taken, until the page shows the team is in
  const saved = () => b.eval(`document.getElementById("teamform").hidden || document.getElementById("teamBtn").textContent === "Update team"`);
  const visible = () => b.eval(`(()=>{const f=document.getElementById("teamform");return !!f && !f.hidden && f.offsetParent!==null})()`);
  await until("team saved", async () => {
    if (await saved()) return true;
    if (await visible()) {
      await b.eval(`(()=>{for (const [i,n] of ["Zippy","Whisker","Bramble","Nettle"].entries()) document.getElementById("hog"+i).value=n;})()`);
      await b.click("#teamBtn");
    }
    return false;
  }, 12 * 60000, 2500);
  log("joined as", await b.eval(`document.getElementById("tname")?.value`));
}

// Waits for our turn. Rounds end (hedgehogs drown, a team is wiped out) and the page is meant to
// rejoin the queue on its own; if it sits there without a turn it is reloaded and the team rebuilt.
async function waitForTurn() {
  const end = Date.now() + 15 * 60000;
  let last = "", same = 0, checked = Date.now();
  while (Date.now() < end) {
    if ((await inGame()) && (await ownTurn())) return true;
    if (Date.now() - checked > 45000) {
      checked = Date.now();
      const txt = await b.eval(`document.body.innerText.slice(0, 200).replace(/\\n+/g, " | ")`);
      same = txt === last ? same + 1 : 0;
      last = txt;
      log("waiting for a turn; the page says:", txt.slice(0, 120));
      if (same >= 3 && !(await inGame())) { log("the page is stuck: reloading"); await joinAndBuildTeam(); same = 0; }
    }
    await sleep(400);
  }
  return false;
}

try {
  let want = WEAPONS.map((x) => x.w);
  if (process.env.WEAPONS) {
    const keys = process.env.WEAPONS.split(",").map((s) => s.trim().toLowerCase());
    want = WEAPONS.filter((x) => keys.includes(String(x.w)) || keys.includes(x.name.toLowerCase())).map((x) => x.w);
  }
  const todo = [...want];
  await b.launch();
  await joinAndBuildTeam();
  log(`playing ${todo.length} weapons`);
  let shotDone = false;

  while (todo.length && Date.now() - t0 < MAX_MS) {
    // wait for our turn (rounds end and restart on their own: the page rejoins the queue)
    const mine = await waitForTurn();
    if (!mine) { log("no turn for 15 minutes"); break; }
    await sleep(700);
    if (!shotDone) { await b.shot(join(OUT, "phone-your-turn.png")); shotDone = true; }
    // a few chained weapons, then one that ends the turn (or one that moves the hedgehog,
    // after which the turn is ended with Skip)
    const chain = todo.filter((w) => CHAIN.has(w) && !MOVING.has(w)).slice(0, 3);
    const last = todo.find((w) => !CHAIN.has(w)) ?? todo.find((w) => MOVING.has(w));
    const plan = last ? [...chain, last] : chain;
    log("turn plan:", plan.map((w) => WEAPONS.find((x) => x.w === w).name).join(" > "));
    for (const w of plan) {
      if (!(await ownTurn())) { log("turn lost before", w); break; }
      const closer = !CHAIN.has(w);
      if (NOT_BORDER.has(w) && borderedRoom && borderedRoom === (await roomNow())) {
        results.set(w, { w, name: WEAPONS.find((x) => x.w === w).name, closer, ok: false, blocked: true, notes: ["blocked: this map has a border (seen on an earlier strike weapon)"], engine: { selected: false, attacks: 0, puts: 0, gears: [] } });
        todo.splice(todo.indexOf(w), 1);
        log(`BLOCKED ${w} ${WEAPONS.find((x) => x.w === w).name} - same bordered map`);
        continue;
      }
      const n = (tries.get(w) ?? 0) + 1;
      tries.set(w, n);
      const rec = await useWeapon(w, closer);
      if (rec.notes.some((x) => x.startsWith("driver:"))) {
        // the page was not usable (the game ended under us?): not the weapon's fault, try it again later
        tries.set(w, n - 1);
        log(`page problem on ${rec.name}: ${rec.notes.find((x) => x.startsWith("driver:"))}; the page says: ${await b.eval(`document.body.innerText.slice(0, 160).replace(/\\n+/g, " | ")`)}`);
        break;
      }
      const prev = results.get(w);
      if (!prev || rec.ok || !prev.ok) results.set(w, { ...rec, tries: n });
      log(`${rec.ok ? "PASS" : rec.blocked ? "BLOCKED" : "FAIL"} ${w} ${rec.name}${rec.notes.length ? " - " + rec.notes.join("; ") : ""} [${rec.engine.gears.join(",") || "no gear"}]`);
      // a failure is tried once more on another turn; a pass is done
      if (rec.ok || rec.blocked || n >= 2) todo.splice(todo.indexOf(w), 1);
      if (closer) break;
    }
    if (await ownTurn()) {
      // still our turn: Skip hands it on
      log("ending the turn with Skip");
      await selectWeapon(7).catch(() => {});
      await H.fire(150).catch(() => {});
      await until("turn over", async () => !(await ownTurn()), 15000, 300).catch(() => log("turn still ours"));
    }
    report(true);
  }
} catch (e) {
  log("ABORTED:", e.message);
} finally {
  const { pass, tested } = report(false);
  const blocked = [...results.values()].filter((r) => r.blocked).length;
  log(`${pass}/${tested} weapons passed (${blocked} blocked)`);
  await b.close();
  process.exit(pass + blocked === tested && tested > 0 ? (blocked ? 2 : 0) : 1);
}
