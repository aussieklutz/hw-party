// hogview-crop.mjs - the close-up cutter on synthetic frames: a bright square sits at a known place in a
// 1080p NV12 frame; with the hint on it, the JPEGs that come out must show the square in the middle of the
// window, they must arrive at about the frame rate, stay small, and only go to the target sid.
//   node tests/hogview-crop.mjs        env: FFMPEG_BIN
import { spawnSync } from "node:child_process";
import { startHogView } from "../agent/hogview.mjs";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const W = 1920, H = 1080;
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dark frame, a 48x48 white square with its centre at (SX, SY)
const SX = 700, SY = 420;
const frame = Buffer.alloc((W * H * 3) / 2, 0x30);
frame.fill(0x80, W * H);
for (let y = SY - 24; y < SY + 24; y++) frame.fill(0xeb, y * W + SX - 24, y * W + SX + 24);

let target = "";
const got = [];
const hv = startHogView({
  ffmpeg: FFMPEG, frameW: W, frameH: H,
  getFrame: () => ({ buf: frame, at: performance.now() }),
  getTarget: () => target,
  getHint: () => ({ x: SX, y: SY }),
  onJpeg: (sid, jpeg) => got.push({ sid, jpeg, at: performance.now() }),
  log: (...a) => console.log("   ", ...a),
});
console.log(`window ${hv.size.w}x${hv.size.h}`);

await sleep(600);
check("nothing is encoded while nobody has a turn", hv.stats.frames === 0 && got.length === 0);

target = "sid-A";
await sleep(4000);
const a = got.filter((g) => g.sid === "sid-A");
check("frames arrive for the active player", a.length > 30, `${a.length} in about 4 s`);
const span = (a.at(-1).at - a[0].at) / 1000;
check("about 15 per second", Math.abs(a.length / span - 15) < 3, `${(a.length / span).toFixed(1)}/s`);
const kb = a.reduce((s, g) => s + g.jpeg.length, 0) / a.length / 1024;
check("each is small", kb < 40, `${kb.toFixed(1)} KB average`);
check("every output is a whole JPEG", a.every((g) => g.jpeg[0] === 0xff && g.jpeg[1] === 0xd8 && g.jpeg.at(-2) === 0xff && g.jpeg.at(-1) === 0xd9));

// decode the last one to gray and find the white square
const last = a.at(-1).jpeg;
const dec = spawnSync(FFMPEG, ["-v", "error", "-f", "image2pipe", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { input: last, maxBuffer: 1 << 24 });
const g = dec.stdout, cw = hv.size.w, ch = hv.size.h;
let sx = 0, sy = 0, n = 0;
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (g[y * cw + x] > 200) { sx += x; sy += y; n++; }
const mx = sx / n, my = sy / n;
check("the hinted square is in the middle of the window", n > 1500 && Math.abs(mx - cw / 2) < 6 && Math.abs(my - ch / 2) < 6,
  `${n} bright pixels, centre (${mx.toFixed(0)}, ${my.toFixed(0)}) of ${cw}x${ch}`);

target = "";
const before = got.length;
await sleep(800);
check("it stops when the turn ends", got.length - before <= 2, `${got.length - before} after`);
target = "sid-B";
await sleep(1500);
check("the next player gets their own frames", got.some((x) => x.sid === "sid-B") && !got.slice(before + 4).some((x) => x.sid === "sid-A"));

hv.stop();
await sleep(300);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
