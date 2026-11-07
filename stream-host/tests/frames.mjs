// frames.mjs — the engine IPC frames the agent builds for cursor moves and puts.
// A cursor delta ('P') or a put ('p', where an airstrike or a teleport lands) is a
// length byte, the command and two int32s. Run: node stream-host/tests/frames.mjs
import { frame, xyFrame } from "../agent/frames.mjs";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (e) {
    failed++;
    console.log("FAIL", name, "-", e.message);
  }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

// the engine reads a frame as: str[1] = command, str[2..5] = x, str[6..9] = y
function decode(buf) {
  eq(buf.length, buf[0] + 1, "frame length matches its length byte");
  const p = buf.subarray(1);
  return { cmd: String.fromCharCode(p[0]), x: p.readInt32BE(1), y: p.readInt32BE(5) };
}

check("cursor delta frame is 10 bytes with a payload of 9", () => {
  const f = xyFrame("P", 3, -4);
  eq(f.length, 10, "bytes");
  eq(f[0], 9, "length byte");
});

check("cursor delta carries both axes", () => {
  const d = decode(xyFrame("P", 12, -7));
  eq(d.cmd, "P", "command");
  eq(d.x, 12, "x");
  eq(d.y, -7, "y");
});

check("put carries a map position", () => {
  const d = decode(xyFrame("p", 1500, 600));
  eq(d.cmd, "p", "command");
  eq(d.x, 1500, "x");
  eq(d.y, 600, "y");
});

check("fractional, missing and extreme values do not throw", () => {
  eq(decode(xyFrame("P", 2.9, -2.9)).x, 2, "x truncates");
  eq(decode(xyFrame("p", undefined, null)).y, 0, "missing y is 0");
  const d = decode(xyFrame("P", 2147483647, -2147483648));
  eq(d.x, 2147483647, "max");
  eq(d.y, -2147483648, "min");
});

check("text frames are length-prefixed", () => {
  const f = frame("eskip");
  eq(f[0], 5, "length byte");
  eq(f.subarray(1).toString(), "eskip", "text");
});

if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all passed");
