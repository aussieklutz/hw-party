// cdp.mjs — minimal Chrome DevTools Protocol driver for the party controllers.
// Runs under Windows node (v24+, native WebSocket); invoke from WSL through
// the \\wsl.localhost UNC path or a copied file.
//
// usage: node cdp.mjs <port> <cmd>...
//   list              — print page targets (url + title + ws path)
//   ev <js>           — Runtime.evaluate, prints JSON-serialised result
//   nav <url>         — navigate the page
//   reload            — reload the page
//   shot <winpath>    — captureScreenshot to a PNG file
//   tap <selector>    — synthetic pointerdown+pointerup on the element
//   down <selector>   — synthetic pointerdown only (hold)
//   up <selector>     — synthetic pointerup only (release)

const port = process.argv[2];
const cmds = process.argv.slice(3);

if (!port || !cmds.length) {
  console.error("usage: node cdp.mjs <port> <cmd>...");
  process.exit(1);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((t) => t.type === "page");
if (cmds[0] === "list") {
  for (const t of pages) console.log(JSON.stringify({ url: t.url, title: t.title }));
  process.exit(0);
}
if (!pages.length) {
  console.error("no page targets");
  process.exit(1);
}
// drive the first page target (each debug port hosts exactly one controller)
const page = pages[0];

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

for (const c of cmds) {
  const [kind, ...rest] = c.split(" ");
  const arg = rest.join(" ");
  if (kind === "ev") {
    console.log(JSON.stringify(await evaluate(arg)));
  } else if (kind === "nav") {
    await send("Page.enable");
    await send("Page.navigate", { url: arg });
    await new Promise((r) => setTimeout(r, 2500));
    console.log("navigated");
  } else if (kind === "reload") {
    await send("Page.enable");
    await send("Page.reload");
    await new Promise((r) => setTimeout(r, 2500));
    console.log("reloaded");
  } else if (kind === "shot") {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(arg, Buffer.from(r.result.data, "base64"));
    console.log("saved " + arg);
  } else if (kind === "tap" || kind === "down" || kind === "up") {
    const type = kind === "tap" ? ["pointerdown", "pointerup"] : [kind === "down" ? "pointerdown" : "pointerup"];
    let out;
    for (const t of type) {
      out = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(arg)});
        if (!el) return "no-el";
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent(${JSON.stringify(t)}, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch",
          isPrimary: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
        return "ok";
      })()`);
    }
    console.log(JSON.stringify(out));
  } else {
    console.error("unknown cmd " + kind);
  }
}
ws.close();
process.exit(0);
