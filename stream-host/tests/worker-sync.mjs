// worker-sync.mjs - the stream worker and the party worker run the SAME room logic
// (the Durable Object in room.ts: modes, seats, the turn gate, the flood bucket,
// private host messages). The stream worker adds a queue and sign-in on top, but
// the room must never drift: a feature that exists in one and not the other is a
// bug in a game mode. This fails if the two copies differ.
//   node tests/worker-sync.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

const a = read("stream-host/worker/src/room.ts"), b = read("party/src/room.ts");
let at = "";
if (a !== b) {
  const al = a.split("\n"), bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) { at = `first difference at line ${i + 1}: stream "${(al[i] ?? "").trim().slice(0, 50)}" vs party "${(bl[i] ?? "").trim().slice(0, 50)}"`; break; }
}
check("room.ts is identical in the stream worker and the party worker", a === b, at);

// the pieces of the entry points that carry game-mode behaviour must match too
for (const [what, needle] of [
  ["a cross-site socket is refused", "crossSiteSocket(req)"],
  ["room creation passes maxPlayers through", "maxPlayers: body?.maxPlayers"],
]) {
  const s = read("stream-host/worker/src/index.ts"), p = read("party/src/index.ts");
  check(`both entry points: ${what}`, s.includes(needle) && p.includes(needle));
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
