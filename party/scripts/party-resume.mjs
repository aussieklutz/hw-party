// party-resume.mjs - the party controller in a real browser: a closed tab comes back to its seat, a newer tab
// takes the seat over, and the weapons panel shows the engine's counts (greying what cannot be used).
//
//   npx wrangler dev --port 8787      (party/, a clean local state)
//   node scripts/party-resume.mjs
// env: BASE (default http://127.0.0.1:8787)  CHROME
//
//   1  a registered team: the tab is closed, a new tab (no room code typed) goes back to the room by itself and
//      the team is still registered with the host
//   2  a second tab takes the seat; the first says so and does not fight for it; "Take control here" gives it back
//   3  in a game: a new tab gets the turn and the weapons, and the panel greys what is none left / not yet available
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WebSocket = createRequire(import.meta.url)("ws");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };
const until = async (what, pred, ms, step = 150) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  throw new Error(`timed out waiting for ${what}`);
};

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
  async clickAt(p) { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 }); }
  async click(sel) {
    const r = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:"center"});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    if (!r) throw new Error(`no ${sel}`);
    await this.clickAt(r);
  }
  visible(sel) { return this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return !!e && !e.hidden && e.offsetParent!==null})()`); }
  text(sel) { return this.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`); }
  value(sel) { return this.eval(`document.querySelector(${JSON.stringify(sel)})?.value ?? ""`); }
  async close() { try { this.ws.close(); } catch {} try { await fetch(`http://127.0.0.1:${this.chrome.port}/json/close/${this.target.id}`); } catch {} }
}
class Chrome {
  constructor(port) { this.port = port; }
  async launch() {
    this.dir = mkdtempSync(join(tmpdir(), "hwparty-"));
    this.proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*", `--user-data-dir=${this.dir}`, "--no-first-run", "--mute-audio", "about:blank"], { stdio: "ignore" });
    await until("chrome", async () => { try { return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).length > 0; } catch { return false; } }, 20000, 300);
  }
  async tab(url) {
    const target = await (await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
    const t = new Tab(this, target); await t.attach(); return t;
  }
  stop() { if (this.proc?.pid) spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" }); }
}
// the engine's ammo view: 60 x (count, turns to wait)
const ammoView = (set) => { const a = Array.from({ length: 60 }, () => "00"); for (const [w, v] of Object.entries(set)) a[Number(w) - 1] = v; return a.join(""); };
const STORE = "9".repeat(60);

const chrome = new Chrome(9771);
let host = null;
try {
  await chrome.launch();
  const made = await fetch(`${BASE}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "classic" }) });
  const room = (await made.json()).room;
  const hostCookie = made.headers.get("set-cookie").split(";")[0];
  const hostMsgs = [];
  host = new WebSocket(`${WS}/api/rooms/${room}/ws`, { headers: { cookie: hostCookie } });
  host.on("message", (d) => { try { hostMsgs.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((r) => host.on("open", r));
  const teamMsgs = () => hostMsgs.filter((m) => m.type === "team");

  console.log("\n-- 1  a closed tab comes back");
  const a = await chrome.tab(`${BASE}/?r=${room}`);
  await until("the join button", () => a.visible("#joinBtn"), 15000);
  await a.click("#joinBtn");
  await until("the team form", () => a.visible("#teamform"), 10000);
  await a.eval(`(()=>{document.getElementById("tname").value="Zippers";for (const [i,n] of ["Zippy","Whisker","Bramble","Nettle"].entries()) document.getElementById("hog"+i).value=n;})()`);
  await a.click("#teamBtn");
  await until("the host to get the team", () => teamMsgs().length === 1, 5000);
  const sid = teamMsgs()[0].sid;
  check("a registered team reaches the host", teamMsgs()[0].config.name === "Zippers");
  await a.close();
  await until("the host to see the player leave", () => hostMsgs.some((m) => m.type === "left" && m.sid === sid), 5000);
  const b = await chrome.tab(`${BASE}/`);   // no room code typed
  await until("the new tab to be in the room by itself", () => b.visible("#game"), 15000);
  check("a new tab goes back to the room without typing the code", true);
  await until("the team to be registered again", () => teamMsgs().length >= 2, 8000);
  check("...and the team is registered with the host again, with the same player", teamMsgs()[1].sid === sid && teamMsgs()[1].config.name === "Zippers");
  check("...and does not ask for the team again", !(await b.visible("#teamform")));
  check("...and says it is registered", /registered/.test(await b.text("#active")), await b.text("#active"));

  console.log("\n-- 2  a newer tab takes the seat");
  const c = await chrome.tab(`${BASE}/`);
  await until("C in the room", () => c.visible("#game"), 15000);
  await until("B to be told", () => b.visible("#takenover"), 8000);
  check("the older tab says it was taken over", await b.visible("#takenover"));
  check("the newer tab knows its team (the room handed it back)", /registered/.test(await c.text("#active")) && !(await c.visible("#teamform")), await c.text("#active"));
  const joins = hostMsgs.filter((m) => m.type === "left").length;
  await sleep(4000);
  check("the older tab does not reconnect and fight for the seat", (await b.visible("#takenover")) && !(await b.visible("#game")) && hostMsgs.filter((m) => m.type === "left").length === joins);
  await b.click("#takeBack");
  await until("B back in", () => b.visible("#game"), 8000);
  await until("C to be told", () => c.visible("#takenover"), 8000);
  check("'Take control here' gives the seat back (and tells the other tab)", await c.visible("#takenover"));
  await c.close();

  console.log("\n-- 3  in a game: the turn and the weapons come to the new tab");
  host.send(JSON.stringify({ type: "state", state: "ingame" }));
  host.send(JSON.stringify({ type: "weapons", ammo: STORE }));
  host.send(JSON.stringify({ type: "turn", team: "Zippers", sid }));
  host.send(JSON.stringify({ type: "ammo", sid, ammo: ammoView({ 1: "30", 3: "00", 4: "52", 5: "*0", 8: "90" }) }));
  await until("my turn on B", async () => (await b.text("#active")) === "YOUR TURN", 8000);
  const d = await chrome.tab(`${BASE}/`);
  await until("D in the room", () => d.visible("#game"), 15000);
  await until("B told", () => b.visible("#takenover"), 8000);
  await until("D to know it is its turn", async () => (await d.text("#active")) === "YOUR TURN", 8000);
  check("a tab opened mid-game takes the seat and knows it is its turn straight away", true);
  await until("the weapons button", async () => !(await d.eval(`document.getElementById("weaponsBtn").disabled`)), 5000);
  check("...and has the weapons (the room replayed them)", true);
  await d.click("#weaponsBtn");
  await until("weapons panel", () => d.eval(`document.getElementById("weaponspanel").classList.contains("open")`), 4000, 100);
  const cells = () => d.eval(`[...document.querySelectorAll("#wgridwrap .wcell")].map(c=>({name:c.querySelector(".wname")?.textContent, dim:c.classList.contains("dim"), badge:c.querySelector(".wcount")?.textContent ?? ""}))`).then((l) => Object.fromEntries(l.map((x) => [x.name, x])));
  const w = await cells();
  check("a weapon with ammo shows its count and is usable", w["Grenade"] && !w["Grenade"].dim && w["Grenade"].badge === "3", JSON.stringify(w["Grenade"]));
  check("infinite ammo shows the infinity sign", w["Shotgun"] && !w["Shotgun"].dim && w["Shotgun"].badge === "\u221e", JSON.stringify(w["Shotgun"]));
  check("nine or more shows 9+", w["Rope"] && w["Rope"].badge === "9+" && !w["Rope"].dim, JSON.stringify(w["Rope"]));
  check("a weapon with none left is grey", w["Bazooka"] && w["Bazooka"].dim && w["Bazooka"].badge === "0", JSON.stringify(w["Bazooka"]));
  check("a weapon not available yet is grey and says when", w["Homing Bee"] && w["Homing Bee"].dim && w["Homing Bee"].badge === "in 2", JSON.stringify(w["Homing Bee"]));
  const inputs = () => hostMsgs.filter((m) => m.type === "input" && /^setweap/.test(m.action ?? "")).length;
  const before = inputs();
  const clickCell = async (name) => d.clickAt(await d.eval(`(()=>{const c=[...document.querySelectorAll("#wgridwrap .wcell")].find(x=>x.querySelector(".wname")?.textContent===${JSON.stringify(name)});c.scrollIntoView({block:"center"});const b=c.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`));
  await clickCell("Bazooka"); await clickCell("Homing Bee"); await sleep(400);
  check("tapping a grey weapon does nothing", inputs() === before, `${inputs() - before} weapon commands`);
  await clickCell("Grenade"); await sleep(500);
  check("tapping a usable weapon selects it", inputs() === before + 1, `${inputs() - before} weapon commands`);
  host.send(JSON.stringify({ type: "ammo", sid, ammo: ammoView({ 1: "00", 3: "00", 4: "51", 5: "*0", 8: "90" }) }));
  await sleep(500);
  const w2 = await cells();
  check("the panel follows the ammo as it changes", w2["Grenade"].dim && w2["Homing Bee"].badge === "in 1", `${JSON.stringify(w2["Grenade"])} ${JSON.stringify(w2["Homing Bee"])}`);
} catch (e) {
  console.log("FAIL  " + e.message);
  failures++;
} finally {
  try { host?.close(); } catch {}
  chrome.stop();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
