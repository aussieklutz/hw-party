// overlay.mjs - renders a worker /stream/ page (scoreboard, stats, splash, slate)
// with headless Chrome or Edge, transparently, about once a second, and hands the
// part of the picture that is not transparent to the caller as a blendable layer
// (see layer.mjs).
//
// One browser for the whole session. It is driven over the DevTools protocol
// (Node's own WebSocket): a transparent default background, a fixed viewport of the
// stream's size, Page.captureScreenshot. To keep the work small it first takes a
// quarter size screenshot to find where the page paints anything, then a full size
// screenshot of just that box.
//
// env:
//   OVERLAY_BROWSER   path to chrome.exe / msedge.exe (default: look in the usual places)
//   OVERLAY_MS        capture interval (default 1000)
//   OVERLAY_CDP_PORT  DevTools port (default: any free port)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { decodePng } from "./pngdec.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  const env = process.env.OVERLAY_BROWSER;
  if (env && existsSync(env)) return env;
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const cands = process.platform === "win32"
    ? [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return cands.find((c) => c && existsSync(c)) ?? null;
}

/**
 * Starts the renderer. `onLayer(layer | null)` is called whenever the picture
 * changed (null: nothing visible). Returns { setUrl(url), stop(), stats }.
 */
export async function startOverlay({ url, width, height, onLayer, log = () => {} }) {
  const bin = findBrowser();
  if (!bin) throw new Error("no Chrome or Edge found for the overlay (set OVERLAY_BROWSER)");
  const dir = mkdtempSync(join(tmpdir(), "hw-overlay-"));
  const proc = spawn(bin, [
    "--headless=new", `--remote-debugging-port=${process.env.OVERLAY_CDP_PORT ?? 0}`,
    "--remote-allow-origins=*", `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--mute-audio", "--hide-scrollbars",
    "--disable-gpu", "--disable-extensions", "--disable-background-networking",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", `--window-size=${width},${height}`,
    "about:blank",
  ], { stdio: "ignore" });
  let stopped = false;
  const kill = () => {
    if (stopped) return;
    stopped = true;
    try { proc.kill(); } catch {}
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", kill);

  // the port Chrome picked is written to DevToolsActivePort
  let port = 0;
  for (let i = 0; i < 120 && !port; i++) {
    try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
    if (!port) await sleep(250);
  }
  if (!port) { kill(); throw new Error("the overlay browser did not start"); }
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    if (!target) await sleep(250);
  }
  if (!target) { kill(); throw new Error("the overlay browser has no page"); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("DevTools socket failed")); });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const [res, rej] = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  ws.onclose = () => { for (const [, [, rej]] of pending) rej(new Error("DevTools socket closed")); };
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, [res, rej]);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

  const stats = { shots: 0, decodeMs: 0, layers: 0, maxDecodeMs: 0 };
  let currentUrl = "";
  let navigating = false;
  const shot = async (clip) => Buffer.from((await cdp("Page.captureScreenshot", {
    format: "png", optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false, clip,
  })).data, "base64");

  // the box that holds everything the page paints, from a quarter size look
  async function findBox() {
    const S = 4;
    const small = decodePng(await shot({ x: 0, y: 0, width, height, scale: 1 / S }));
    let x0 = small.width, y0 = small.height, x1 = -1, y1 = -1;
    for (let j = 0; j < small.height; j++) {
      for (let i = 0; i < small.width; i++) {
        if (small.rgba[(j * small.width + i) * 4 + 3]) {
          if (i < x0) x0 = i; if (i > x1) x1 = i;
          if (j < y0) y0 = j; if (j > y1) y1 = j;
        }
      }
    }
    if (x1 < 0) return null;
    const m = 6; // a little margin for the text shadow and the rounding
    let x = Math.max(0, x0 * S - m) & ~1, y = Math.max(0, y0 * S - m) & ~1;
    let w = Math.min(width, (x1 + 1) * S + m) - x, h = Math.min(height, (y1 + 1) * S + m) - y;
    return { x, y, w: (w + 1) & ~1, h: (h + 1) & ~1 };
  }

  // screenshots become layers in a worker thread
  const worker = new Worker(new URL("./layer-worker.mjs", import.meta.url));
  const jobs = new Map(); let jobId = 0;
  worker.on("message", (m) => { const j = jobs.get(m.id); jobs.delete(m.id); if (j) m.error ? j.rej(new Error(m.error)) : j.res(m); });
  worker.on("error", (e) => log("overlay worker failed:", e.message));
  const toLayer = (png, x, y) => new Promise((res, rej) => { const id = ++jobId; jobs.set(id, { res, rej }); worker.postMessage({ id, png, x, y }); });

  let lastPng = null, lastBox = "", gone = false, gen = 0;
  async function capture() {
    if (navigating || !currentUrl) return;
    const myGen = gen;
    const box = await findBox();
    if (myGen !== gen) return;   // the page changed under us
    if (!box) {
      if (lastBox !== "none") { lastBox = "none"; lastPng = null; onLayer(null); }
      return;
    }
    const png = await shot({ x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 });
    if (myGen !== gen) return;
    stats.shots++;
    const key = `${box.x},${box.y},${box.w},${box.h}`;
    if (key === lastBox && lastPng && png.equals(lastPng)) return;
    lastBox = key; lastPng = png;
    const { layer, ms } = await toLayer(png, box.x, box.y);
    if (myGen !== gen) return;
    stats.decodeMs += ms; stats.layers++; stats.maxDecodeMs = Math.max(stats.maxDecodeMs, ms);
    onLayer(layer);
  }

  const interval = Number(process.env.OVERLAY_MS ?? 1000);
  const loop = (async () => {
    while (!gone) {
      const t0 = Date.now();
      try { await capture(); } catch (e) { if (!gone) log("overlay capture failed:", e.message); }
      await sleep(Math.max(50, interval - (Date.now() - t0)));
    }
  })();

  async function setUrl(u) {
    if (u === currentUrl) return;
    currentUrl = u;
    gen++;
    navigating = true;
    try {
      await cdp("Page.navigate", { url: u });
      await sleep(900); // load and the page's first poll
    } catch (e) {
      log("overlay navigate failed:", e.message);
    }
    lastPng = null; lastBox = "";
    navigating = false;
  }
  await setUrl(url);
  return {
    setUrl, stats,
    async stop() { gone = true; try { ws.close(); } catch {} kill(); worker.terminate(); await loop.catch(() => {}); },
  };
}
