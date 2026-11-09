// hogview-real.mjs - the close-up through a REAL engine: a host agent in composite mode (the engine plays a
// game, the new --stream-hint-port reports where the hog is) and the real phone page in headless Chrome,
// which joins the queue, saves a team and, when its turn comes, samples what the close-up shows.
//
//   node tests/hogview-real.mjs      (worker on BASE, default http://127.0.0.1:8794, with a clean state)
// env: BASE  CHROME  STREAM_HOST_SECRET (or worker/.dev.vars)  ENGINE_BIN (the new engine)  ENGINE_PREFIX (its Data dir)
//      FFMPEG_BIN  OUT_DIR  W H (stream size, default 1920x1080)
// Writes OUT_DIR/shot-NN.png (the canvas on the phone), OUT_DIR/agent.log and OUT_DIR/dbg/ (JPEGs + hints.json).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://127.0.0.1:8794";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.OUT_DIR ?? "C:/Users/clint/.t3/scratch/hv-real";
const W = process.env.W ?? "1920", H = process.env.H ?? "1080";
const SECRET = process.env.STREAM_HOST_SECRET
  ?? readFileSync(join(here, "..", "worker", ".dev.vars"), "utf8").match(/STREAM_HOST_SECRET=(.+)/)[1].trim();
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };
const until = async (what, pred, ms, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};

class Browser {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwreal-"));
    this.proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`,
      "--no-first-run", "--mute-audio", "--window-size=430,900", "about:blank"], { stdio: "ignore" });
    const t = await until("chrome", async () => { try { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((x) => x.type === "page"); } catch { return null; } }, 20000, 300);
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === "Page.javascriptDialogOpening") this.send("Page.handleJavaScriptDialog", { accept: true });
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
  // hold a button down (the pointer pad moves the cursor while a direction is held)
  async hold(sel, ms) {
    const r = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    if (!r) throw new Error(`no ${sel}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y, button: "none" });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(ms);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  close() { try { this.ws.close(); } catch {} if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" }); }
}

const b = new Browser(9742);
let agent = null;
try {
  const st = await (await fetch(`${BASE}/api/queue/state`)).json();
  if (st.phase === "lobby" || st.phase === "countdown") throw new Error(`a round is already open (phase ${st.phase}): restart the worker`);
  await b.launch();
  await b.send("Page.navigate", { url: BASE + "/" });
  await until("queue button", () => b.eval(`!!document.getElementById("queueBtn")&&!document.getElementById("queueui").hidden`), 20000);
  await sleep(600);
  await b.click("#queueBtn");
  await until("a place in the queue", () => b.eval(`!document.getElementById("queuePos").hidden && document.getElementById("game").hidden`), 15000);

  const agentLog = join(OUT, "agent.log");
  writeFileSync(agentLog, "");
  agent = { log: "" };
  agent.proc = spawn(process.execPath, [join(here, "..", "agent", "host-agent.mjs")], {
    env: {
      ...process.env, WORKER_URL: BASE, ROOM_MODE: "dynamic", STREAM_HOST_SECRET: SECRET,
      ENGINE_BIN: process.env.ENGINE_BIN, ENGINE_PREFIX: process.env.ENGINE_PREFIX,
      ENGINE_USERPREFIX: join(tmpdir(), "hw-hogview"),
      STREAM_TAP: "1", FEED_MODE: "composite", FEED_URL: join(OUT, "feed.flv").replace(/\\/g, "/"), ENCODER: process.env.ENCODER ?? "qsv",
      STREAM_WIDTH: W, STREAM_HEIGHT: H, STREAM_FPS: "60", FFMPEG_BIN: process.env.FFMPEG_BIN, OVERLAY: "0",
      HOG_VIEW_DEBUG: join(OUT, "dbg"), HOG_HEALTH: "500", SD_TURNS: "500", ...(process.env.CURSOR === "1" ? { AMMO_ALL: "1" } : {}),
      LOBBY_WAIT_MS: "600000", ROUND_WAIT_MS: "15000", SLATE_MS: "1000", POP_COUNT: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = (d) => { agent.log += d; try { writeFileSync(agentLog, agent.log); } catch {} };
  agent.proc.stdout.on("data", sink); agent.proc.stderr.on("data", sink);
  await until("admitted to the room", () => b.eval(`!document.getElementById("game").hidden`), 90000);
  log("in the room");
  await until("the team form", () => b.eval(`(()=>{const f=document.getElementById("teamform");return !!f && !f.hidden && f.offsetParent!==null})()`), 15000);
  await b.eval(`(()=>{for (const [i,n] of ["Zippy","Whisker","Bramble","Nettle"].entries()) document.getElementById("hog"+i).value=n;})()`);
  await b.click("#teamBtn");

  // a real game starts after the countdown; wait for this phone's turn
  await until("the game", () => /engine video connected/.test(agent.log), 120000);
  log("engine connected");
  await until("my turn", () => b.eval(`document.getElementById("active").textContent==="YOUR TURN"`), 240000, 500);
  log("my turn");

  // sample the close-up while the hog stands, then walks right, then walks left
  const canvasPng = () => b.eval(`(()=>{const c=document.getElementById("hogcanvas");return c.width?c.toDataURL("image/png").split(",")[1]:null})()`);
  const shots = [];
  const snap = async (label) => {
    const d = await canvasPng();
    if (!d) return;
    const f = join(OUT, `shot-${String(shots.length).padStart(2, "0")}.png`);
    writeFileSync(f, Buffer.from(d, "base64")); shots.push({ f, label });
  };
  await until("the close-up to show", () => b.eval(`!document.getElementById("hogview").hidden`), 15000);
  check("the real game's close-up reached the phone", true);
  for (let i = 0; i < 3; i++) { await snap("standing"); await sleep(700); }
  for (let i = 0; i < 4; i++) { await b.click('[data-act="+right"]'); await sleep(500); await snap("walking right"); }
  await b.click('[data-act="J"]'); await sleep(250); await snap("jump"); await sleep(600); await snap("jump landing");
  for (let i = 0; i < 4; i++) { await b.click('[data-act="+left"]'); await sleep(500); await snap("walking left"); }
  log(`${shots.length} snapshots`);

  // the pointer pad: in party mode the phone streams cursor deltas, applied like a mouse (the camera follows them)
  if (process.env.POINTER === "1") {
    log("phase: pointer start");
    for (let i = 0; i < 8; i++) { await b.click('[data-cur="left"]'); await sleep(150); }
    for (let i = 0; i < 6; i++) { await b.click('[data-cur="up"]'); await sleep(150); }
    log("phase: pointer moved");
    await sleep(4000);
    log("phase: pointer idle 4s");
    await b.click("#cclick"); await sleep(1500);
    log("phase: clicked");
    await sleep(6000);
    log("phase: idle 6s after click");
  }

  // a weapon that is aimed with the cursor (Air Attack): the cutout must follow the cursor, not the hog
  if (process.env.CURSOR === "1") {
    log("phase: cursor weapon");
    await b.click("#weaponsBtn");
    await until("weapons panel", () => b.eval(`document.getElementById("weaponspanel").classList.contains("open")`), 4000, 100);
    const idx = await b.eval(`(()=>{const cells=[...document.querySelectorAll("#wgridwrap .wcell")];
      const i=cells.findIndex(c=>c.querySelector(".wname")?.textContent==="Air Attack");
      cells.forEach((c,j)=>c.dataset.pick=j===i?"1":"");return i})()`);
    if (idx < 0) throw new Error("no Air Attack in the weapons panel");
    await b.click('#wgridwrap .wcell[data-pick="1"]');
    await sleep(250); await b.click("#wclose"); await sleep(1500);
    await snap("air attack selected");
    for (let r = 0; r < 4; r++) { await b.hold('[data-cur="left"]', 700); await sleep(500); await snap("cursor moved left"); }
    for (let r = 0; r < 3; r++) { await b.hold('[data-cur="up"]', 500); await sleep(500); await snap("cursor moved up"); }
    for (let r = 0; r < 3; r++) { await b.hold('[data-cur="right"]', 900); await sleep(500); await snap("cursor moved right"); }
    log("phase: cursor done");
  }

  // the weapons panel from the engine's own ammo view: counts, and weapons that are not available yet
  if (process.env.WEAPONS === "1") {
    log("phase: weapons view");
    const read = () => b.eval(`[...document.querySelectorAll("#wgridwrap .wcell")].filter(c=>c.querySelector(".wcount")).map(c=>c.querySelector(".wname").textContent+"="+(c.classList.contains("dim")?"x":"")+c.querySelector(".wcount").textContent).join("  ")`);
    const openPanel = async () => { await b.click("#weaponsBtn"); await until("weapons panel", () => b.eval(`document.getElementById("weaponspanel").classList.contains("open")`), 4000, 100); };
    const pick = async (name) => {
      await openPanel();
      await b.eval(`(()=>{const cells=[...document.querySelectorAll("#wgridwrap .wcell")];const i=cells.findIndex(c=>c.querySelector(".wname")?.textContent===${JSON.stringify(name)});cells.forEach((c,j)=>c.dataset.pick=j===i?"1":"");})()`);
      await b.click('#wgridwrap .wcell[data-pick="1"]'); await sleep(250); await b.click("#wclose"); await sleep(300);
    };
    await openPanel();
    const r1 = await read();
    console.log(`   at the start of the turn: ${r1}`);
    check("the engine's ammo view reached the weapons panel (counts shown)", /Grenade=\d/.test(r1) || /Grenade=∞/.test(r1), r1.slice(0, 80));
    check("some weapons are shown as not yet available", /=x?in \d/.test(r1), "");
    const count = (r, n) => { const m = r.split("  ").find((x) => x.startsWith(n + "=")); return m ? m.slice(n.length + 1).replace(/^x/, "") : null; };
    await b.click("#wclose"); await sleep(300);
    await pick("Cluster Bomb");
    await b.hold("#fire", 400);
    await sleep(3500);
    await openPanel();
    const r2 = await read();
    console.log(`   after throwing a cluster bomb: ${r2}`);
    const g1 = count(r1, "Cluster Bomb"), g2 = count(r2, "Cluster Bomb");
    check("using a weapon takes one off the count", g1 !== null && g2 !== null && (g1 === g2 ? g1 === "∞" : Number(g2) === Number(g1) - 1), `cluster bombs ${g1} -> ${g2}`);
    await b.click("#wclose");
  }

  // where did the engine say the hog was, relative to the middle of the frame?
  await sleep(1500);
  const hf = join(OUT, "dbg", "hints.json");
  const hints = existsSync(hf) ? JSON.parse(readFileSync(hf, "utf8")).map((x) => x.hint).filter(Boolean) : [];
  check("the engine reports the hog's position (--stream-hint-port)", hints.length > 20, `${hints.length} hints`);
  if (hints.length) {
    const dx = hints.map((h) => h.x - Number(W) / 2), dy = hints.map((h) => h.y - Number(H) / 2);
    const rng = (a) => `${Math.min(...a)}..${Math.max(...a)}`;
    console.log(`   hog offset from the middle of the frame: x ${rng(dx)}, y ${rng(dy)} px; cursor reported in ${hints.filter((h) => h.target).length} of ${hints.length}`);
    const cur = hints.filter((h) => h.target);
    if (cur.length) console.log(`   cursor hint positions (frame px): ${[0, .25, .5, .75, 1].map((f) => cur[Math.min(cur.length - 1, Math.floor(f * cur.length))]).map((h) => `(${h.x},${h.y})`).join(" ")}`);
  }
  if (process.env.HOLD_MS) { log(`holding ${process.env.HOLD_MS} ms for audio statistics`); await sleep(Number(process.env.HOLD_MS)); }
  writeFileSync(join(OUT, "shots.json"), JSON.stringify(shots, null, 1));
} catch (e) {
  check("hogview-real completed", false, e.message);
  console.log("--- agent log tail:\n" + (agent?.log ?? "").split("\n").slice(-15).join("\n"));
} finally {
  b.close();
  agent?.proc.kill();
  spawnSync("taskkill", ["/IM", "hwengine.exe", "/F"], { stdio: "ignore" });
  await sleep(500);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
