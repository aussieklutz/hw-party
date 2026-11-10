// composite-host.mjs - the agent's side of a feed test in a process of its own, so that measuring
// it (PowerShell samples, ffprobe) cannot stall its frame clock. Reads the same env the agent does.
//   MODE=composite  runs agent/composite.mjs;   MODE=baseline  runs tap.mjs as the agent does per game.
// stdin: "stats" prints STATS {json}; "stop" (or EOF) shuts down. stdout: READY <ffmpeg pid>.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const overlayUrl = process.env.OVERLAY_URL ?? pathToFileURL(join(here, "fixtures", "overlay-stub.html")).href;
let comp = null, tap = null;
if (process.env.MODE === "baseline") {
  const { tapStart } = await import("../agent/tap.mjs");
  tap = tapStart();
  console.log("READY 0");
} else {
  const { compositeStart } = await import("../agent/composite.mjs");
  comp = await compositeStart(process.env.OVERLAY === "0" ? {} : { overlayGameUrl: overlayUrl });
  console.log("READY " + comp.ffmpegPid);
}
const stop = async () => { if (comp) await comp.stop().catch(() => {}); if (tap) tap.stop(); process.exit(0); };
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (cmd === "stats" && comp) console.log("STATS " + JSON.stringify({ ...comp.stats(), ffmpegPid: comp.ffmpegPid }));
    if (cmd === "stop") stop();
  }
});
process.stdin.on("end", stop);
