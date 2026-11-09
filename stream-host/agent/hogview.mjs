// hogview.mjs - a close-up of the active player's hog, cut out of the engine's frame and sent to
// that player's phone only, at a low frame rate, so the controller can show what the hog is doing
// without waiting for the Twitch feed.
//
//   composite.mjs latest NV12 frame --crop (JS row copy)--> ffmpeg (mjpeg, one process) --> JPEG
//   --> onJpeg(sid, jpeg) --> host-agent --> room WebSocket (binary: [sid length][sid][jpeg])
//   --> the room relays it to the controller whose turn it is, nobody else
//
// Nothing is encoded while nobody holds a turn, and nothing is sent to a player who is not the active one.
//
// env: HOG_VIEW=0 turns it off (default on in composite mode)   HOG_VIEW_FPS (15)
//      HOG_VIEW_W / HOG_VIEW_H  size of the window cut out of a 1080 line frame (320x216, scaled with the frame)
//      HOG_VIEW_QUALITY  mjpeg -q:v, 2 (best) .. 31 (default 5)
//      HOG_VIEW_DEBUG    a directory: every 20th JPEG is written there with where the window was centred
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const EOI = Buffer.from([0xff, 0xd9]);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * @param {object} o
 * @param {string} o.ffmpeg                path to ffmpeg
 * @param {number} o.frameW, o.frameH      size of the engine frame (NV12)
 * @param {() => ({buf: Buffer, at: number} | null)} o.getFrame   newest complete frame
 * @param {() => string} o.getTarget       sid of the player whose turn it is ("" for nobody)
 * @param {(sid: string, jpeg: Buffer) => void} o.onJpeg
 * @param {() => ({x: number, y: number} | null)} [o.getHint]   where to centre the window, in frame pixels
 */
export function startHogView({ ffmpeg, frameW, frameH, getFrame, getTarget, onJpeg, getHint = () => null, log = () => {} }) {
  const env = process.env;
  const fps = Number(env.HOG_VIEW_FPS ?? 15);
  const scale = frameH / 1080;
  const cw = even(Number(env.HOG_VIEW_W ?? 320) * scale);
  const ch = even(Number(env.HOG_VIEW_H ?? 216) * scale);
  const quality = String(env.HOG_VIEW_QUALITY ?? 5);
  const debugDir = env.HOG_VIEW_DEBUG;
  if (debugDir) mkdirSync(debugDir, { recursive: true });
  let debugN = 0, hintLog = [];
  const stats = { frames: 0, jpegs: 0, bytes: 0, skipped: 0, ffmpegStarts: 0 };

  let proc = null;
  let sidOfFrame = [];           // the sid each frame in flight belongs to, in order
  let pending = Buffer.alloc(0);
  let cx = frameW / 2, cy = frameH / 2;   // the window centre, smoothed
  let lastSid = "", hadHint = false;      // a new turn or a first hint puts the window on the hog at once
  let stopped = false;
  const out = Buffer.allocUnsafe((cw * ch * 3) / 2);

  function start() {
    if (stopped || proc) return;
    stats.ffmpegStarts++;
    proc = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", "-threads", "1",
      "-f", "rawvideo", "-pix_fmt", "nv12", "-video_size", `${cw}x${ch}`, "-framerate", String(fps), "-i", "pipe:0",
      "-vf", "format=yuvj420p", "-c:v", "mjpeg", "-q:v", quality, "-fps_mode", "passthrough", "-flush_packets", "1",
      "-f", "image2pipe", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const p = proc;
    p.stdin.on("error", () => {});
    p.stderr.on("data", (d) => log("hog view ffmpeg:", d.toString().trim()));
    p.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let from = 0;
      for (;;) {
        // a JPEG ends at FF D9; inside the entropy data every FF is followed by 00, so the first FF D9 is the end
        const end = pending.indexOf(EOI, from);
        if (end < 0) break;
        const jpeg = pending.subarray(0, end + 2);
        pending = pending.subarray(end + 2);
        from = 0;
        const sid = sidOfFrame.shift() ?? "";
        stats.jpegs++; stats.bytes += jpeg.length;
        if (debugDir && stats.jpegs % 20 === 0) { writeFileSync(`${debugDir}/${String(stats.jpegs).padStart(5, "0")}.jpg`, jpeg); writeFileSync(`${debugDir}/hints.json`, JSON.stringify(hintLog)); }
        if (sid) onJpeg(sid, Buffer.from(jpeg));
      }
    });
    p.on("exit", () => { if (proc === p) { proc = null; pending = Buffer.alloc(0); sidOfFrame = []; } });
  }

  // cut the window out of the NV12 frame: the Y plane rows, then the interleaved UV rows (half height)
  function crop(src, x0, y0) {
    for (let r = 0; r < ch; r++) src.copy(out, r * cw, (y0 + r) * frameW + x0, (y0 + r) * frameW + x0 + cw);
    const uv = frameW * frameH, ouv = cw * ch;
    for (let r = 0; r < ch / 2; r++) src.copy(out, ouv + r * cw, uv + (y0 / 2 + r) * frameW + x0, uv + (y0 / 2 + r) * frameW + x0 + cw);
  }

  const timer = setInterval(() => {
    const sid = getTarget();
    if (!sid) return;
    const f = getFrame();
    if (!f || performance.now() - f.at > 500) { stats.skipped++; return; }
    start();
    if (!proc || proc.stdin.writableLength > out.length * 3) { stats.skipped++; return; }
    const hint = getHint();
    if (debugDir) hintLog.push({ n: stats.frames, hint });
    const tx = hint ? hint.x : frameW / 2, ty = hint ? hint.y : frameH / 2;
    const follow = hint?.target ? 0.6 : 0.35;   // a cursor moves fast: follow it more closely
    if (sid !== lastSid || (hint && !hadHint)) { cx = tx; cy = ty; } else { cx += (tx - cx) * follow; cy += (ty - cy) * follow; }
    lastSid = sid; hadHint = !!hint;
    const x0 = Math.min(frameW - cw, Math.max(0, Math.round(cx - cw / 2))) & ~1;
    const y0 = Math.min(frameH - ch, Math.max(0, Math.round(cy - ch / 2))) & ~1;
    crop(f.buf, x0, y0);
    sidOfFrame.push(sid);
    proc.stdin.write(Buffer.from(out));
    stats.frames++;
  }, 1000 / fps);

  return {
    stats, size: { w: cw, h: ch },
    stop() { stopped = true; clearInterval(timer); try { proc?.stdin.end(); proc?.kill(); } catch {} },
  };
}
