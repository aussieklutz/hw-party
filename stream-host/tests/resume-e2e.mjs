// resume-e2e.mjs - coming back to the controller: a closed tab resumes its seat, a newer tab takes the seat over
// (one seat per account), the new tab gets the cutout and the weapon counts, and the weapons panel greys out what
// cannot be used.
//
//   node tests/resume-e2e.mjs      (worker on BASE with a clean state, default http://127.0.0.1:8794)
// env: BASE  CHROME  FFMPEG_BIN  STREAM_HOST_SECRET (or worker/.dev.vars)
//      IDP_PRIVATE_JWK  the private key (JSON) that matches the worker's IDP_PUBLIC_JWK: enables the account part
//
//   1  queue: a tab is closed and a new one resumes the place by itself (no second entry)
//   2  queue: a second tab takes the seat; the first says so and does not fight for it; "take control here" takes it back
//   3  round: the host opens a round, the player is admitted, the host starts a game and gives the turn and the ammo;
//      a new tab takes over: it gets the turn, the weapons (counts, none left, not yet available) and the cutout
//   4  weapons: none left / not yet available cells are grey and do nothing; usable ones send the weapon
//   5  accounts: two browsers signed in as the same account hold ONE seat; the newer takes it
import { createPrivateKey, createSign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WebSocket = createRequire(join(here, "..", "worker", "package.json"))("ws");
const BASE = process.env.BASE ?? "http://127.0.0.1:8794";
const WS = BASE.replace(/^http/, "ws");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const SECRET = process.env.STREAM_HOST_SECRET ?? readFileSync(join(here, "..", "worker", ".dev.vars"), "utf8").match(/STREAM_HOST_SECRET=(.+)/)[1].trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };
const until = async (what, pred, ms, step = 150) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};
const queueCount = async () => (await (await fetch(`${BASE}/api/queue/state`)).json()).queue;
const ctl = (path, body) => fetch(`${BASE}/api/queue/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-stream-secret": SECRET }, body: JSON.stringify(body) });

// ---- a Chrome profile (its tabs share cookies and storage, like tabs of one browser) ----
class Tab {
  constructor(chrome, target) { this.chrome = chrome; this.target = target; this.id = 0; this.pending = new Map(); }
  async attach() {
    this.ws = new globalThis.WebSocket(this.target.webSocketDebuggerUrl);
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
  visible(sel) { return this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return !!e && !e.hidden && e.offsetParent!==null})()`); }
  text(sel) { return this.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`); }
  async close() { try { this.ws.close(); } catch {} try { await fetch(`http://127.0.0.1:${this.chrome.port}/json/close/${this.target.id}`); } catch {} }
}
class Chrome {
  constructor(port) { this.port = port; }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwresume-"));
    this.proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`, "--no-first-run", "--mute-audio", "about:blank"], { stdio: "ignore" });
    await until("chrome", async () => { try { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).length > 0; } catch { return false; } }, 20000, 300);
  }
  async tab(url) {
    const target = await (await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
    const t = new Tab(this, target); await t.attach(); return t;
  }
  stop() { if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" }); }
}

const jpeg = (color) => spawnSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x216`, "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { maxBuffer: 1 << 22 }).stdout;
const RED = jpeg("red");
const frameFor = (sid, j) => { const id = Buffer.from(sid); return Buffer.concat([Buffer.from([id.length]), id, j]); };
// the engine's ammo view: 60 x (count, turns to wait)
const ammoView = (set) => { const a = Array.from({ length: 60 }, () => "00"); for (const [w, v] of Object.entries(set)) a[Number(w) - 1] = v; return a.join(""); };
const STORE = "9".repeat(60);

const chrome1 = new Chrome(9761), chrome2 = new Chrome(9762);
const tabs = [];
let host = null;
try {
  await chrome1.launch();
  const open = async (c, url = BASE + "/") => { const t = await c.tab(url); tabs.push(t); return t; };
  const waitPos = (t, re) => until("the queue position", async () => re.test(await t.text("#queuePos")) && (await t.visible("#queuePos")), 15000);

  console.log("\n-- 1  a closed tab comes back");
  const a = await open(chrome1);
  await until("queue button", () => a.visible("#queueBtn"), 20000); await sleep(500);
  await a.click("#queueBtn");
  await waitPos(a, /NEXT/);
  check("tab A is in the queue", (await queueCount()) === 1);
  // a team built while waiting
  await a.eval(`(()=>{for (const [i,n] of ["Zippy","Whisker","Bramble","Nettle"].entries()) document.getElementById("hog"+i).value=n;})()`);
  await a.click("#teamBtn");
  await until("the team to be saved", () => a.visible("#teamSaved"), 5000);
  await a.close();
  await sleep(1500);
  const b = await open(chrome1);
  await waitPos(b, /NEXT/);
  check("a new tab resumes the place by itself, without pressing Join", true);
  await until("the team to come back", async () => (await b.eval(`document.getElementById("hog0").value`)) === "Zippy", 5000);
  check("...and the team the player built is still in the form", (await b.eval(`document.getElementById("hog3").value`)) === "Nettle");
  await until("the queue to hold the team again", () => b.visible("#teamSaved"), 5000);
  check("...and was handed back to the queue (no need to save it again)", true);
  check("...and it did not take a second place in the line", (await queueCount()) === 1, `${await queueCount()} in the queue`);

  console.log("\n-- 2  a newer tab takes the seat");
  const c = await open(chrome1);
  await waitPos(c, /NEXT/);
  await until("B to be told", () => b.visible("#takenover"), 8000);
  check("the newer tab holds the seat", true);
  check("the older tab says it was taken over", await b.visible("#takenover"));
  await sleep(4000);
  check("the older tab does not reconnect and fight for the seat", (await b.visible("#takenover")) && !(await b.visible("#queuePos")) && (await queueCount()) === 1);
  await b.click("#takeBack");
  await waitPos(b, /NEXT/);
  await until("C to be told", () => c.visible("#takenover"), 8000);
  check("'Take control here' gives the seat back (and tells the other tab)", await c.visible("#takenover"));
  check("still one place in the line", (await queueCount()) === 1);

  console.log("\n-- 3  in a round: the new tab gets the turn, the weapons and the cutout");
  // the host opens a round in a managed room and gives the queue the room
  const made = await fetch(`${BASE}/api/rooms`, { method: "POST", headers: { "x-stream-secret": SECRET }, body: JSON.stringify({ mode: "dynamic" }) });
  const room = (await made.json()).room;
  const hostCookie = made.headers.get("set-cookie").split(";")[0];
  const sids = [];
  const hostMsgs = [];
  host = new WebSocket(`${WS}/api/rooms/${room}/ws`, { headers: { cookie: hostCookie } });
  host.on("message", (d, bin) => { if (bin) return; try { const m = JSON.parse(d.toString()); hostMsgs.push(m); if (m.type === "joined" && m.sid && !sids.includes(m.sid)) sids.push(m.sid); } catch {} });
  await new Promise((r) => host.on("open", r));
  await ctl("phase", { phase: "lobby", room, mode: "dynamic", count: 2, openSeats: 4 });
  await ctl("admit", { room, count: 2 });   // what the host does when the round opens: the waiting players are admitted
  await until("the player to be admitted into the room", () => b.visible("#game"), 20000);
  check("the queue admits the waiting player into the round's room", true);
  await until("the host to see the player", () => sids.length > 0, 8000);
  const sid = sids[0];
  host.send(JSON.stringify({ type: "state", state: "ingame" }));
  host.send(JSON.stringify({ type: "weapons", ammo: STORE }));
  host.send(JSON.stringify({ type: "turn", team: "AnonAlpha", sid }));
  host.send(JSON.stringify({ type: "ammo", sid, ammo: ammoView({ 1: "30", 3: "00", 4: "52", 5: "*0", 8: "90" }) }));
  await until("my turn", async () => (await b.text("#active")) === "YOUR TURN", 8000);
  const pump = async (n = 6) => { for (let i = 0; i < n; i++) { host.send(frameFor(sid, RED)); await sleep(60); } };
  await pump();
  await until("the cutout", () => b.visible("#hogview"), 5000);
  check("the first tab shows the cutout on its turn", true);

  const panel = async (t) => {
    await t.click("#weaponsBtn");
    await until("weapons panel", () => t.eval(`document.getElementById("weaponspanel").classList.contains("open")`), 4000, 100);
    const cells = await t.eval(`[...document.querySelectorAll("#wgridwrap .wcell")].map(c=>({name:c.querySelector(".wname")?.textContent, dim:c.classList.contains("dim"), badge:c.querySelector(".wcount")?.textContent ?? ""}))`);
    return Object.fromEntries(cells.map((x) => [x.name, x]));
  };
  const closePanel = (t) => t.click("#wclose");

  // a new tab takes over
  const d = await open(chrome1);
  await until("the new tab to be in the room", () => d.visible("#game"), 20000);
  await until("the old tab to be told", () => b.visible("#takenover"), 8000);
  check("a tab opened mid-round takes the seat over (the old one is told)", await b.visible("#takenover"));
  await until("D to know it is its turn", async () => (await d.text("#active")) === "YOUR TURN", 8000);
  check("the new tab knows it is its turn straight away", true);
  await pump();
  await until("the cutout on D", () => d.visible("#hogview"), 5000);
  const px = await d.eval(`(()=>{const c=document.getElementById("hogcanvas");return Array.from(c.getContext("2d").getImageData(c.width/2|0,c.height/2|0,1,1).data)})()`);
  check("the new tab receives the cutout", px[0] > 200 && px[1] < 60, `centre pixel ${px}`);

  console.log("\n-- 4  the weapons: counts, none left, not yet available");
  const w = await panel(d);
  check("a weapon with ammo shows its count and is usable", w["Grenade"] && !w["Grenade"].dim && w["Grenade"].badge === "3", JSON.stringify(w["Grenade"]));
  check("infinite ammo shows the infinity sign", w["Shotgun"] && !w["Shotgun"].dim && w["Shotgun"].badge === "\u221e", JSON.stringify(w["Shotgun"]));
  check("nine or more shows 9+", w["Rope"] && w["Rope"].badge === "9+" && !w["Rope"].dim, JSON.stringify(w["Rope"]));
  check("a weapon with none left is grey", w["Bazooka"] && w["Bazooka"].dim && w["Bazooka"].badge === "0", JSON.stringify(w["Bazooka"]));
  check("a weapon that is not available yet is grey and says when", w["Homing Bee"] && w["Homing Bee"].dim && w["Homing Bee"].badge === "in 2", JSON.stringify(w["Homing Bee"]));
  check("a weapon that is not in the store is grey", w["Mine"] && w["Mine"].dim, JSON.stringify(w["Mine"]));
  const inputs = () => hostMsgs.filter((m) => m.type === "input" && /^setweap/.test(m.action ?? "")).length;
  const before = inputs();
  const clickCell = (name) => d.eval(`(()=>{const c=[...document.querySelectorAll("#wgridwrap .wcell")].find(x=>x.querySelector(".wname")?.textContent===${JSON.stringify(name)});c.scrollIntoView({block:"center"});const b=c.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`)
    .then(async (p) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await d.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 }); });
  await clickCell("Bazooka"); await clickCell("Homing Bee"); await sleep(400);
  check("tapping a grey weapon does nothing", inputs() === before, `${inputs() - before} weapon commands`);
  await clickCell("Grenade"); await sleep(500);
  check("tapping a usable weapon selects it", inputs() === before + 1, `${inputs() - before} weapon commands`);
  // the ammo changes mid-turn: the grenade is used up
  host.send(JSON.stringify({ type: "ammo", sid, ammo: ammoView({ 1: "00", 3: "00", 4: "51", 5: "*0", 8: "90" }) }));
  await sleep(500);
  const w2 = await d.eval(`[...document.querySelectorAll("#wgridwrap .wcell")].map(c=>({name:c.querySelector(".wname")?.textContent, dim:c.classList.contains("dim"), badge:c.querySelector(".wcount")?.textContent ?? ""}))`);
  const by = Object.fromEntries(w2.map((x) => [x.name, x]));
  check("the panel follows the ammo as it changes (grenade used up, bee one turn nearer)", by["Grenade"].dim && by["Homing Bee"].badge === "in 1", `${JSON.stringify(by["Grenade"])} ${JSON.stringify(by["Homing Bee"])}`);
  await closePanel(d);

  // a turn that is not mine: no cutout, the weapons button is off
  host.send(JSON.stringify({ type: "turn", team: "Somebody", sid: "someone-else" }));
  await sleep(500);
  check("when it is not their turn the weapons button is off", await d.eval(`document.getElementById("weaponsBtn").disabled`));

  // ---- 5 accounts ----
  console.log("\n-- 5  one account, two browsers, one seat");
  if (!process.env.IDP_PRIVATE_JWK) {
    console.log("SKIP  no IDP_PRIVATE_JWK: the account part needs the key that matches the worker's IDP_PUBLIC_JWK");
  } else {
    // the round is over for this part
    host.send(JSON.stringify({ type: "state", state: "lobby" }));
    await ctl("phase", { phase: "slate" });
    await sleep(500);
    const key = createPrivateKey({ key: JSON.parse(process.env.IDP_PRIVATE_JWK), format: "jwk" });
    const b64 = (x) => Buffer.from(x).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const body = b64(JSON.stringify({ iss: "hwstream-signup", aud: "hwstream", sub: "resume-test-" + iat, name: "Resumer" + (iat % 1000), iat, exp: iat + 3600 }));
    const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key, dsaEncoding: "ieee-p1363" });
    const token = `${head}.${body}.${b64(sig)}`;
    const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const acctCookie = login.headers.get("set-cookie")?.split(";")[0];
    check("(setup) the account token is accepted", login.status === 200 && !!acctCookie, `status ${login.status}`);
    await chrome2.launch();
    const signIn = async (t) => { await t.send("Network.enable"); await t.send("Network.setCookie", { name: "hw_acct", value: acctCookie.split("=").slice(1).join("="), url: BASE + "/" }); };
    const before = await queueCount();
    const p1 = await open(chrome1, "about:blank"); await signIn(p1);
    await p1.send("Page.navigate", { url: BASE + "/" });
    await until("queue button", () => p1.visible("#queueBtn"), 20000); await sleep(500);
    await p1.click("#queueBtn");
    await waitPos(p1, /NEXT|#\d+/);
    check("the account is in the queue from browser 1", (await queueCount()) === before + 1, `${before} -> ${await queueCount()}`);
    const p2 = await open(chrome2, "about:blank"); await signIn(p2);
    await p2.send("Page.navigate", { url: BASE + "/" });
    await waitPos(p2, /NEXT|#\d+/);
    await until("browser 1 to be told", () => p1.visible("#takenover"), 8000);
    check("browser 2 (the same account) takes over the seat, and browser 1 is told", await p1.visible("#takenover"));
    check("...it is still ONE place in the line", (await queueCount()) === before + 1, `${await queueCount()} in the queue`);
  }
} catch (e) {
  check("resume-e2e completed", false, e.message);
  for (const [i, t] of tabs.entries()) {
    const info = await Promise.race([
      t.eval(`(async()=>({text:document.body.innerText.replace(/\s+/g," ").slice(0,220),resume:await (await fetch("/api/queue/resume",{cache:"no-store"})).text()}))()`).then((x) => JSON.stringify(x), (x) => "(error) " + x.message.slice(0, 80)),
      sleep(3000).then(() => "(no answer: tab closed?)"),
    ]);
    console.log(`--- tab ${i}: ${info}`);
  }
} finally {
  for (const t of tabs) { try { t.ws.close(); } catch {} }
  try { host?.close(); } catch {}
  chrome1.stop(); chrome2.stop();
  await sleep(300);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
