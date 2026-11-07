// queued-admit.mjs - a player who waits in the queue and is let into a room BEFORE saving a
// team can still save one there.
//
// The page treated "queued" as true for good once it had seen a queue position, so after the
// admission "Save team" still sent the team down the (already closed) queue socket and nothing
// happened: no team, no seat. This joins the queue while no round is open, starts the host
// agent (lobby only: its engine is a stand-in that exits at once) so the queue admits the
// browser, and then saves a team in the room.
//
//   node tests/queued-admit.mjs     (worker already up on BASE, no host agent running)
// (it needs a worker with no round open: after a host agent has run, restart `wrangler dev` with a clean state)
// env: BASE (default http://127.0.0.1:8790)  CHROME  STREAM_HOST_SECRET (or worker/.dev.vars)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
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
const until = async (what, pred, ms, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};

class Browser {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwqueued-"));
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

const b = new Browser(9700);
let agent = null;
try {
  const st = await (await fetch(`${BASE}/api/queue/state`)).json();
  if (st.phase === "lobby" || st.phase === "countdown") throw new Error(`a round is already open (phase ${st.phase}): restart the worker so none is`);
  await b.launch();
  await b.send("Page.navigate", { url: BASE + "/" });
  await until("queue button", () => b.eval(`!!document.getElementById("queueBtn")&&!document.getElementById("queueui").hidden`), 20000);
  await sleep(600);
  await b.click("#queueBtn");
  // no round is open, so the page shows a place in line instead of a room
  await until("a place in the queue", () => b.eval(`!document.getElementById("queuePos").hidden && document.getElementById("game").hidden`), 15000);
  check("the browser is waiting in the queue, not in a room", true);

  // a round opens: the queue admits the waiting browser
  agent = { log: "" };
  agent.proc = spawn(process.execPath, [join(here, "..", "agent", "host-agent.mjs")], {
    env: {
      ...process.env, WORKER_URL: BASE, ROOM_MODE: "dynamic", STREAM_HOST_SECRET: SECRET, ENGINE_BIN: process.execPath,
      LOBBY_WAIT_MS: "600000", ROUND_WAIT_MS: "600000", SLATE_MS: "1000", POP_COUNT: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.proc.stdout.on("data", (d) => (agent.log += d));
  agent.proc.stderr.on("data", (d) => (agent.log += d));
  await until("admitted to the room", () => b.eval(`!document.getElementById("game").hidden`), 60000);
  check("the queue admitted the browser into the round's room", true);

  // saving a team in the room must register it with the host
  await until("the team form", () => b.eval(`(()=>{const f=document.getElementById("teamform");return !!f && !f.hidden && f.offsetParent!==null})()`), 15000);
  const name = await b.eval(`document.getElementById("tname").value`);
  await b.eval(`(()=>{for (const [i,n] of ["Zippy","Whisker","Bramble","Nettle"].entries()) document.getElementById("hog"+i).value=n;})()`);
  await b.click("#teamBtn");
  const registered = await until("the host to register the team", async () => /registered team "/.test(agent.log), 8000).then(() => true, () => false);
  check("Save team in the room registers the team with the host", registered, `bound name ${name}; ${registered ? "" : "the host never saw a team"}`);
  check("the team form goes away once the team is saved", await b.eval(`document.getElementById("teamform").hidden`));
} catch (e) {
  check("queued-admit completed", false, e.message);
} finally {
  await b.close();
  agent?.proc.kill();
  await sleep(500);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
