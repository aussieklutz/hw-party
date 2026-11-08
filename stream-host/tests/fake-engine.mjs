// fake-engine.mjs - stands in for hwengine's frame tap: connects to the agent's two tap
// ports (audio first, as the engine does) and writes NV12 frames and s16le audio at the
// engine's own pace (default 62.5 fps, the engine's --frame-interval 16 ms), nothing else.
// A "game" is one connect/disconnect pair, so start() and stop() can be called repeatedly.
//
//   const e = new FakeEngine({ videoPort, audioPort, width, height });
//   await e.start(); ... ; e.stop();
//
// The picture is a green field with a bar sweeping across and a frame counter in binary along
// the top; every `flashEvery` ms the whole frame is white for one frame (the time of the write
// is logged in `flashes` for latency measurements). The audio is a 440 Hz sine; with
// `audioFlash` a 1 kHz burst is played at every flash.
import net from "node:net";

export class FakeEngine {
  constructor({ videoPort, audioPort, width = 1920, height = 1080, fps = 62.5, flashEvery = 0, audioFlash = false, hue = [150, 60, 70] }) {
    Object.assign(this, { videoPort, audioPort, width, height, fps, flashEvery, audioFlash, hue });
    this.flashes = [];       // performance.now() + Date.now() of each flash frame's write
    this.framesWritten = 0;
    this.running = false;
  }

  frameBuf(kind, k) {
    const { width: W, height: H } = this;
    const f = Buffer.alloc((W * H * 3) / 2);
    if (kind === "white") { f.fill(235, 0, W * H); f.fill(128, W * H); return f; }
    f.fill(this.hue[0], 0, W * H);
    for (let i = W * H; i < f.length; i += 2) { f[i] = this.hue[1]; f[i + 1] = this.hue[2]; }
    const bw = 160, x0 = (k * 240) % (W - bw);
    for (let r = H / 4; r < (3 * H) / 4; r++) f.fill(210, r * W + x0, r * W + x0 + bw);
    return f;
  }

  async start() {
    const connect = (port) => new Promise((res, rej) => {
      const s = net.connect(port, "127.0.0.1", () => res(s));
      s.once("error", rej);
      s.on("error", () => {});
    });
    this.audio = await connect(this.audioPort);
    this.audio.write(Buffer.alloc(32768));                  // the probe silence the engine sends first
    this.video = await connect(this.videoPort);
    this.frames = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => this.frameBuf("bar", k));
    this.white = this.frameBuf("white");
    this.running = true;
    const t0 = performance.now();
    this.t0 = t0;
    const step = 1000 / this.fps, audioStep = 10;
    let n = 0, a = 0, nextFlash = this.flashEvery ? 500 : Infinity, burst = 0;
    const tick = () => {
      if (!this.running) return;
      const now = performance.now() - t0;
      while (a * audioStep <= now) {                        // audio: 10 ms chunks
        const samples = 441, buf = Buffer.alloc(samples * 4);
        for (let i = 0; i < samples; i++) {
          const t = (a * samples + i) / 44100;
          let v = 0.25 * Math.sin(2 * Math.PI * 440 * t);
          if (burst > 0) v += 0.4 * Math.sin(2 * Math.PI * 1000 * t);
          const s = Math.round(v * 32767);
          buf.writeInt16LE(s, i * 4); buf.writeInt16LE(s, i * 4 + 2);
        }
        if (burst > 0) burst--;
        this.audio.write(buf);
        a++;
      }
      while (n * step <= now) {                             // video: at the engine's rate
        let buf = this.frames[(n >> 3) & 7];
        if (now >= nextFlash) {
          buf = this.white; nextFlash += this.flashEvery;
          this.flashes.push({ perf: performance.now(), wall: Date.now(), frame: n });
          if (this.audioFlash) burst = 5;
        }
        if (this.video.writableLength < 4 * buf.length) this.video.write(buf);   // like the engine: drop when the consumer lags
        this.framesWritten++;
        n++;
      }
      this.timer = setTimeout(tick, 2);
    };
    tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.video?.destroy(); this.audio?.destroy();
  }
}
