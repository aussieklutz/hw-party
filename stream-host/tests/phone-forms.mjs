// phone-forms.mjs - who names what, in a real browser, per game mode.
//
//   node tests/phone-forms.mjs            (worker on BASE, headless Chrome)
//
// Joining through the stream queue the screen name is BOUND to the player (an
// AnonX name here; an account's name when signed in) and cannot be typed:
//   classic / fixed / dynamic   the screen name is the TEAM name; the player still
//                               names their hogs
//   teams / imposter            the screen name is the HOG's name (one player, one
//                               hog): no hog inputs, and the seat is claimed
//                               for them
// A party room (joined by code) is untouched: names are typed.
//
// The host agent runs lobby-only (the engine is a stand-in that exits at once).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
void require;
const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SECRET = process.env.STREAM_HOST_SECRET
  ?? readFileSync(join(here, "..", "worker", ".dev.vars"), "utf8").match(/STREAM_HOST_SECRET=(.+)/)[1].trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};
const qstate = async () => (await fetch(`${BASE}/api/queue/state`)).json();
const until = async (what, pred, ms, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};

// ---- the host agent (lobby only) --------------------------------------------
async function startAgent(mode) {
  const prev = (await qstate()).roundRoom;
  const a = { log: "" };
  a.proc = spawn(process.execPath, [join(here, "..", "agent", "host-agent.mjs")], {
    env: {
      ...process.env, WORKER_URL: BASE, ROOM_MODE: mode, STREAM_HOST_SECRET: SECRET, ENGINE_BIN: process.execPath,
      LOBBY_WAIT_MS: "600000", ROUND_WAIT_MS: "600000", SLATE_MS: "1000", POP_COUNT: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  a.proc.stdout.on("data", (d) => (a.log += d));
  a.proc.stderr.on("data", (d) => (a.log += d));
  a.stop = async () => { a.proc.kill(); await sleep(500); };
  await until(`${mode} lobby`, async () => { const s = await qstate(); return s.roundRoom && s.roundRoom !== prev && s.mode === mode && (s.phase === "lobby" || s.phase === "countdown"); }, 30000);
  return a;
}

// ---- a minimal CDP browser ---------------------------------------------------
class Browser {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwforms-"));
    this.proc = spawn(CHROME, [
      "--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`,
      "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=430,900", "about:blank",
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
  async click(sel) {
    const r = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    if (!r) throw new Error(`no ${sel}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  async close() {
    try { this.ws.close(); } catch {}
    if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

// what the form shows right now
const FORM = `(()=>{
  const v = (id) => { const e = document.getElementById(id); return e ? { hidden: !!e.hidden || e.offsetParent === null, disabled: !!e.disabled, value: e.value, placeholder: e.placeholder } : null; };
  return { tname: v("tname"), hog0: v("hog0"), hog3: v("hog3"), teamform: v("teamform"), title: document.getElementById("tfTitle")?.textContent,
           game: !document.getElementById("game").hidden, who: document.getElementById("whoami")?.textContent };
})()`;

let port = 9500;
async function joinInBrowser() {
  const b = new Browser(port++);
  await b.launch();
  await b.send("Page.navigate", { url: BASE + "/" });
  await until("queue button", () => b.eval(`!!document.getElementById("queueBtn")&&!document.getElementById("queueui").hidden`), 15000);
  await sleep(600); // mode fetched from the queue
  await b.click("#queueBtn");
  await until("in the room", () => b.eval(`!document.getElementById("game").hidden`), 20000);
  await sleep(1200); // hello -> mode -> (auto claim)
  return b;
}

const MODES = [
  { mode: "dynamic", seat: false },
  { mode: "teams", seat: true },
  { mode: "imposter", seat: true },
];
for (const { mode, seat } of MODES) {
  console.log(`\n-- ${mode} (${seat ? "screen name = the hog" : "screen name = the team; hogs are typed"})`);
  const agent = await startAgent(mode);
  let b;
  try {
    b = await joinInBrowser();
    let f = await b.eval(FORM);
    const anon = /^Anon[A-Z][a-z]+\d*$/.test(f.tname.value);
    check("the name box holds the name the stream bound (AnonX) and is locked", anon && f.tname.disabled, JSON.stringify(f.tname));
    if (seat) {
      check("no hog-name inputs: the screen name IS the hog", f.hog0.hidden && f.hog3.hidden, JSON.stringify({ hog0: f.hog0.hidden, hog3: f.hog3.hidden }));
      check("nothing to fill in: the registration form is not shown", f.teamform.hidden);
      await until("claimed for them", async () => new RegExp(`joined lobby: "${f.tname.value}"`).test(agent.log), 8000);
      check("the seat is claimed for them under the bound name", true);
    } else {
      check("hog-name inputs are there (standard modes name hogs)", !f.hog0.hidden && !f.hog3.hidden, JSON.stringify({ hog0: f.hog0.hidden, hog3: f.hog3.hidden }));
      check("the form is titled for hogs, not for a team name", /hedgehog/i.test(f.title), f.title);
      // an attempt to type a different team name anyway, then save with hog names
      await b.eval(`(()=>{const t=document.getElementById("tname");t.disabled=false;t.value="Evil Team";t.disabled=true;
        for (const [i,n] of ["Zippy","Whisker","Bramble","Nettle"].entries()) document.getElementById("hog"+i).value=n;})()`);
      await b.click("#teamBtn");
      await until("team registered", async () => /registered team "/.test(agent.log), 8000);
      const reg = agent.log.match(/registered team "([^"]+)"/)?.[1];
      check("the team is registered under the bound screen name, not what was typed", reg === f.tname.value && reg !== "Evil Team", `team="${reg}" bound="${f.tname.value}"`);
    }
  } catch (e) { check(`${mode} completed`, false, e.message); }
  finally { await b?.close(); await agent.stop(); }
}

// ---- a party room: joined by code, typed names ---------------------------------
console.log("\n-- party room (joined by code): names are typed");
{
  const host = await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "classic" }) });
  const { room } = await host.json();
  const b = new Browser(port++);
  try {
    await b.launch();
    await b.send("Page.navigate", { url: `${BASE}/?r=${room}` });
    await until("join button", () => b.eval(`!!document.getElementById("joinBtn")`), 15000);
    await b.click("#joinBtn");
    await until("in the room", () => b.eval(`!document.getElementById("game").hidden`), 15000);
    await sleep(800);
    const f = await b.eval(FORM);
    check("a party room's name box is editable and empty", f.tname.disabled === false && f.tname.value === "", JSON.stringify(f.tname));
    // (no host here, so the whole form may be collapsed: look at the inputs themselves)
    const own = await b.eval(`({ hog0: document.getElementById("hog0").hidden, hog3: document.getElementById("hog3").hidden })`);
    check("a party room still asks for hog names", own.hog0 === false && own.hog3 === false, JSON.stringify(own));
  } catch (e) { check("party room completed", false, e.message); }
  finally { await b.close(); }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
