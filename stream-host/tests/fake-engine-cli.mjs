// fake-engine-cli.mjs - runs one FakeEngine game in its own process (so its cost does not count towards
// the agent's). Prints one JSON line per flash with the high resolution wall clock time of the write.
// env: VIDEO_PORT AUDIO_PORT W H FPS FLASH_EVERY (ms) SECONDS HUE (y,u,v)
import os from "node:os";
if (process.env.ENGINE_PRIORITY !== "normal") os.setPriority(0, os.constants.priority.PRIORITY_HIGH);
import { FakeEngine } from "./fake-engine.mjs";
const e = process.env;
const eng = new FakeEngine({
  videoPort: Number(e.VIDEO_PORT), audioPort: Number(e.AUDIO_PORT), width: Number(e.W ?? 1920), height: Number(e.H ?? 1080),
  fps: Number(e.FPS ?? 62.5), flashEvery: Number(e.FLASH_EVERY ?? 0),
});
const origPush = eng.flashes.push.bind(eng.flashes);
eng.flashes.push = (f) => { console.log(JSON.stringify({ flash: performance.timeOrigin + f.perf })); return origPush(f); };
await eng.start();
console.log(JSON.stringify({ started: performance.timeOrigin + performance.now() }));
setTimeout(() => { eng.stop(); console.log(JSON.stringify({ stopped: eng.framesWritten })); process.exit(0); }, Number(e.SECONDS ?? 20) * 1000);
