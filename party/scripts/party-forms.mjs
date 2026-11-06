// party-forms.mjs - the party phone webapp in a real browser, per game mode.
//
//   (party worker running: npm run dev)   node scripts/party-forms.mjs
//   env: BASE (default http://127.0.0.1:8787), CHROME
//
// A fake host drives each room. For every mode the phone must show the right
// form (one player, one hog in the team/imposter modes: no hog names, no flag /
// grave / voice), react to a seat note and to a private notice from the host,
// and show the AFK banner (that handler used to throw a ReferenceError).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};
const until = async (what, pred, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(150); }
  throw new Error(`timed out: ${what}`);
};

// a fake host
async function makeRoom(mode) {
  const r = await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode, slots: 4 }) });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const { room } = await r.json();
  const host = { msgs: [], room };
  host.ws = new WebSocket(`${WS}/api/rooms/${room}/ws`, { headers: { cookie } });
  host.ws.on("message", (d) => { try { host.msgs.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res) => host.ws.on("open", res));
  host.send = (o) => host.ws.send(JSON.stringify(o));
  return host;
}

// a minimal CDP browser
class Browser {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.errors = []; }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwparty-"));
    this.proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`,
      "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=430,900", "about:blank"], { stdio: "ignore" });
    const target = await until("chrome", async () => {
      try { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((t) => t.type === "page"); } catch { return null; }
    }, 20000);
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res) => this.ws.on("open", res));
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
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

const FORM = `(()=>{
  const el = (id) => document.getElementById(id);
  return { tname: el("tname").placeholder, hog0Hidden: el("hog0").hidden, hog3Hidden: el("hog3").hidden,
           pickersHidden: [...document.querySelectorAll("#teamform .pickers")].every((e) => e.hidden),
           title: document.querySelector("#teamform h3")?.textContent, button: el("teamBtn").textContent,
           seat: { text: el("seatnote").textContent, hidden: el("seatnote").hidden },
           role: { text: el("rolenote").textContent, hidden: el("rolenote").hidden } };
})()`;

let port = 9600;
for (const [mode, seatMode] of [["classic", false], ["teams", true], ["imposter", true]]) {
  console.log(`\n-- ${mode}`);
  const host = await makeRoom(mode);
  const b = new Browser(port++);
  try {
    await b.launch();
    await b.send("Page.navigate", { url: `${BASE}/?r=${host.room}` });
    await until("join button", () => b.eval(`!!document.getElementById("joinBtn")`));
    await b.click("#joinBtn");
    await until("joined", () => b.eval(`!document.getElementById("game").hidden`));
    await sleep(600);
    host.send({ type: "state", state: "lobby" });
    await sleep(500);
    const f = await b.eval(FORM);
    if (seatMode) {
      check("no hog-name inputs: your screen name IS your hedgehog", f.hog0Hidden && f.hog3Hidden, JSON.stringify({ hog0: f.hog0Hidden, hog3: f.hog3Hidden }));
      check("no flag / grave / voice pickers for a one-hog seat", f.pickersHidden);
      check("the form asks for a seat, not a team", /seat/i.test(f.title) && /seat/i.test(f.button), `${f.title} / ${f.button}`);
      check("the name box asks for a screen name", /screen name/i.test(f.tname), f.tname);
    } else {
      check("classic: hog names and pickers stay", !f.hog0Hidden && !f.hog3Hidden && !f.pickersHidden);
      check("classic: it is a team form", /team/i.test(f.title) && /callsign/i.test(f.tname), `${f.title} / ${f.tname}`);
    }
    // the registration arrives at the host
    await b.eval(`(()=>{document.getElementById("tname").value="Zippy Hog";})()`);
    await b.click("#teamBtn");
    await until("registration at the host", () => host.msgs.some((m) => m.type === "team" && m.config?.name === "Zippy Hog"));
    check("the typed name reaches the host as the registration", true);
    const sid = host.msgs.find((m) => m.type === "team")?.sid;

    // host -> this phone: a seat note and a private notice
    host.send({ type: "seat", sid, seated: true, team: "Red" });
    host.send({ type: "notify", sid, text: "You are the IMPOSTER on the Red team." });
    await sleep(500);
    const g = await b.eval(FORM);
    check("the seat note shows where the lobby put the player", !g.seat.hidden && /Red/.test(g.seat.text), JSON.stringify(g.seat));
    check("the private notice is shown", !g.role.hidden && /IMPOSTER/.test(g.role.text), JSON.stringify(g.role));
    host.send({ type: "seat", sid, seated: false });
    await sleep(300);
    check("an unseated player is told to wait for a partner", /Waiting for one more/.test((await b.eval(FORM)).seat.text));

    // a game: the turn reaches the phone, the AFK banner shows without throwing
    host.send({ type: "state", state: "ingame" });
    host.send({ type: "turn", team: "Zippy Hog", sid });
    await sleep(400);
    check("the phone knows it is its turn", /YOUR TURN/.test(await b.eval(`document.getElementById("active").textContent`)));
    host.send({ type: "afk", team: "Zippy Hog", seconds: 10, endsAt: Date.now() + 10000 });
    await sleep(500);
    check("the AFK banner shows (the handler no longer throws)", b.errors.length === 0 && /YOUR TURN - respond now/.test(await b.eval(`document.body.innerText`)), JSON.stringify(b.errors));
    host.send({ type: "state", state: "lobby" });
    await sleep(300);
    check("the private role is cleared when the game ends", (await b.eval(FORM)).role.hidden);
  } catch (e) { check(`${mode} completed`, false, e.message); }
  finally { await b.close(); host.ws.close(); }
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
