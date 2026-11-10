// hogview-e2e.mjs - the close-up through the real room and the real phone page. A scripted host (the
// agent's side of the socket) creates a party room; the page runs in headless Chrome (portrait) and a
// second phone is a plain WebSocket. The host sends close-up JPEGs addressed by sid:
//   * the player whose turn it is sees them, drawn above the cursor keys, and nobody else gets a byte
//   * frames for a player who does not hold the turn are dropped by the room
//   * the turn moving on takes the picture away from the first player and gives it to the next
//   * the page's Close-up toggle turns it off (and keeps it off)
//
//   node tests/hogview-e2e.mjs      (worker on BASE, default http://127.0.0.1:8794)   env: BASE CHROME FFMPEG_BIN
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
const WebSocket = require("ws");
const BASE = process.env.BASE ?? "http://127.0.0.1:8794";
const WS = BASE.replace(/^http/, "ws");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };
const until = async (what, pred, ms, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};

// two solid-colour JPEGs the page can tell apart
const jpeg = (color) => spawnSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x216`, "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { maxBuffer: 1 << 22 }).stdout;
const RED = jpeg("red"), GREEN = jpeg("green");
const frameFor = (sid, j) => { const id = Buffer.from(sid); return Buffer.concat([Buffer.from([id.length]), id, j]); };

class Chrome {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwview-"));
    this.proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`,
      "--no-first-run", "--mute-audio", "--window-size=430,900", "about:blank"], { stdio: "ignore" });
    const t = await until("chrome", async () => { try { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((x) => x.type === "page"); } catch { return null; } }, 20000, 300);
    this.ws = new globalThis.WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    await this.send("Page.enable"); await this.send("Runtime.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: 430, height: 900, deviceScaleFactor: 1, mobile: true });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
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
  close() { try { this.ws.close(); } catch {} if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" }); }
}

const chrome = new Chrome(9741);
let host = null, bob = null;
try {
  // the host creates a party room and listens for who joins
  const res = await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "classic", slots: 2 }) });
  const room = (await res.json()).room;
  const hostCookie = res.headers.get("set-cookie").split(";")[0];
  const sids = [];
  host = new WebSocket(`${WS}/api/rooms/${room}/ws`, { headers: { cookie: hostCookie } });
  host.on("message", (d, bin) => { if (bin) return; try { const m = JSON.parse(d.toString()); if (m.type === "joined" && m.sid && !sids.includes(m.sid)) sids.push(m.sid); } catch {} });
  await new Promise((r) => host.on("open", r));

  // bob: a plain WebSocket phone; he must never receive a binary frame
  const jr = await fetch(`${BASE}/api/rooms/${room}/join`, { method: "POST" });
  const bobCookie = jr.headers.get("set-cookie").split(";")[0];
  let bobBinary = 0, bobSid = null;
  bob = new WebSocket(`${WS}/api/rooms/${room}/ws`, { headers: { cookie: bobCookie } });
  bob.on("message", (d, bin) => { if (bin) { bobBinary++; return; } try { const m = JSON.parse(d.toString()); if (m.type === "hello") bobSid = m.sid; } catch {} });
  await new Promise((r) => bob.on("open", r));
  await until("bob's hello", () => bobSid, 5000);

  // alice: the real page
  await chrome.launch();
  await chrome.send("Page.navigate", { url: `${BASE}/?r=${room}` });
  await until("the join button", () => chrome.eval(`!!document.getElementById("joinBtn")&&document.getElementById("code").value==="${room}"`), 15000);
  await sleep(500);
  await chrome.click("#joinBtn");
  await until("the page joined", () => sids.find((s) => s !== bobSid), 20000);
  const aliceSid = sids.find((s) => s !== bobSid);
  host.send(JSON.stringify({ type: "state", state: "ingame" }));
  await until("the controls", () => chrome.eval(`!document.getElementById("controls").hidden`), 10000);

  const viewShown = () => chrome.eval(`!document.getElementById("hogview").hidden`);
  const pixel = () => chrome.eval(`(()=>{const c=document.getElementById("hogcanvas");if(!c.width)return null;return Array.from(c.getContext("2d").getImageData(c.width/2|0,c.height/2|0,1,1).data)})()`);
  const pump = async (sid, j, n = 6) => { for (let i = 0; i < n; i++) { host.send(frameFor(sid, j)); await sleep(60); } };

  // nobody has the turn yet: a frame is dropped by the room
  await pump(aliceSid, RED);
  check("no frame is shown before it is the player's turn", !(await viewShown()));

  // alice's turn
  host.send(JSON.stringify({ type: "turn", team: "Alice", sid: aliceSid }));
  await until("her turn", () => chrome.eval(`document.getElementById("active").textContent==="YOUR TURN"`), 5000);
  await pump(aliceSid, RED);
  await until("the close-up", viewShown, 3000);
  const px = await pixel();
  check("the active player sees the close-up", px && px[0] > 200 && px[1] < 60 && px[2] < 60, `centre pixel ${px}`);
  if (process.env.SHOT) require("node:fs").writeFileSync(process.env.SHOT, Buffer.from((await chrome.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const lay = await chrome.eval(`(()=>{const v=document.getElementById("hogview").getBoundingClientRect(),p=document.getElementById("cpad").getBoundingClientRect();return {vBottom:v.bottom,pTop:p.top,vTop:v.top,w:v.width}})()`);
  check("in portrait it sits above the cursor keys", lay.vBottom <= lay.pTop + 1 && lay.w > 200, `close-up ${Math.round(lay.vTop)}..${Math.round(lay.vBottom)}, cursor pad from ${Math.round(lay.pTop)}`);
  check("the other player received nothing", bobBinary === 0, `${bobBinary} binary frames`);

  // a frame addressed to bob while it is alice's turn is dropped by the room
  await pump(bobSid, GREEN);
  check("frames for a player without the turn are dropped", bobBinary === 0 && (await pixel())[0] > 200);

  // the turn moves to bob: alice loses the picture, bob gets it
  host.send(JSON.stringify({ type: "turn", team: "Bob", sid: bobSid }));
  await until("alice's close-up gone", async () => !(await viewShown()), 3000);
  check("the picture leaves the player whose turn is over", true);
  await pump(aliceSid, RED);
  check("a late frame for her is dropped", !(await viewShown()));
  const before = bobBinary;
  await pump(bobSid, GREEN);
  await until("bob's frames", () => bobBinary > before, 3000);
  check("the new active player gets the frames", bobBinary - before >= 3, `${bobBinary - before} of 6`);

  // alice again, with the toggle off
  host.send(JSON.stringify({ type: "turn", team: "Alice", sid: aliceSid }));
  await until("her turn again", () => chrome.eval(`document.getElementById("active").textContent==="YOUR TURN"`), 5000);
  await chrome.click("#viewBtn");
  check("the toggle says off", (await chrome.eval(`document.getElementById("viewBtn").textContent`)) === "Close-up: off");
  await pump(aliceSid, RED);
  check("with the toggle off nothing is drawn", !(await viewShown()));
  await chrome.click("#viewBtn");
  await pump(aliceSid, RED);
  await until("back on", viewShown, 3000);
  check("the toggle turns it back on", true);
} catch (e) {
  check("hogview-e2e completed", false, e.message);
  try { console.log("--- page: " + (await chrome.eval(`document.body.innerText.split("\\n").join(" | ")`)).slice(0, 400)); } catch {}
} finally {
  chrome.close();
  try { host?.close(); bob?.close(); } catch {}
  await sleep(300);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
