// M8 adoption scenario: a CPU team (difficulty >= 1) plays alongside a
// human-injected team; `eteamhuman` hands the CPU team to the human mid-game
// and injected inputs are accepted on its turns afterwards.
//
// usage: HWENGINE=<hwengine> HWPREFIX=<Data dir> node scripts/engine-party-adoption.mjs
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINE = process.env.HWENGINE;
const PREFIX = process.env.HWPREFIX;
const PORT = Number(process.env.PORT || 18667);

if (!ENGINE || !PREFIX) {
  console.error("usage: HWENGINE=<path to hwengine> HWPREFIX=<Data dir> node scripts/engine-party-adoption.mjs");
  process.exit(2);
}

const AMMO_QT = "939192942219912103223511100120000000021110010101111100010001";
const AMMO_PROB = "040504054160065554655446477657666666615551010111541111111073";
const AMMO_DELAY = "000000000000020550000004000700400000000022000000060002000000";
const AMMO_CRATE = "131111031211111112311411111111111111121111111111111111111111";

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

function frame(text) {
  const b = Buffer.from(text, "utf8");
  if (b.length > 255) throw new Error("frame too long");
  return Buffer.concat([Buffer.from([b.length]), b]);
}

function makeTeam(name, color, hash, difficulty) {
  const lines = [
    `eammloadt ${AMMO_QT}`,
    `eammprob ${AMMO_PROB}`,
    `eammdelay ${AMMO_DELAY}`,
    `eammreinf ${AMMO_CRATE}`,
    "eammstore",
    `eaddteam ${hash} ${color} ${name}`,
    "egrave Statue",
    "efort Plane",
    "evoicepack Default",
    "eflag hedgewars",
  ];
  for (let i = 0; i < 4; i++) {
    lines.push(`eaddhh ${difficulty} 100 ${name}Hog${i + 1}`);
    lines.push("ehat NoHat");
  }
  return lines;
}

const engineMessages = [];
let sock = null;
let configSent = false;

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const existing = engineMessages.find(predicate);
    if (existing !== undefined) return resolve(existing);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      const hit = engineMessages.find(predicate);
      if (hit !== undefined) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(hit);
      }
    }, 50);
  });
}

const server = net.createServer((socket) => {
  sock = socket;
  let buf = Buffer.alloc(0);
  socket.on("data", (data) => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      if (buf.length < 1) break;
      const len = buf[0];
      if (buf.length < len + 1) break;
      const payload = buf.subarray(1, len + 1);
      buf = buf.subarray(len + 1);
      engineMessages.push(payload.toString("utf8"));
      if (payload[0] === 0x43 /* 'C' */ && !configSent) {
        configSent = true;
        // Alpha = human-injected team, CpuBot = placeholder AI team (tier 3)
        const config = [
          frame("TL"),
          frame("e$mapgen 0"),
          frame("e$template_filter 0"),
          frame("e$feature_size 12"),
          frame("eseed adoption"),
          frame("etheme Nature"),
          frame("e$turntime 5000"),
          frame("e$ready 0"),
          frame("e$inithealth 100"),
          frame("eparty 1"),
          ...makeTeam("Alpha", 16711680, "0".repeat(32), 0).map(frame),
          ...makeTeam("CpuBot", 255, "1".repeat(32), 3).map(frame),
          frame("!"),
        ];
        socket.write(Buffer.concat(config));
      }
      if (payload[0] === 0x3f /* '?' */) socket.write(frame("!"));
    }
  });
});

server.listen(PORT, "127.0.0.1");

const userDir = mkdtempSync(join(tmpdir(), "hwuser-"));
const engine = spawn(ENGINE, [
  "--internal", "--port", String(PORT),
  "--stats-only", "--nosound", "--nomusic",
  "--prefix", PREFIX, "--user-prefix", userDir,
], { stdio: ["ignore", "pipe", "pipe"] });
engine.stderr.on("data", (d) => process.stderr.write(`[engine] ${d}`));
engine.on("exit", (code) => console.log(`[engine] exited code=${code}`));

try {
  await waitFor((m) => m.startsWith("eproto"), 30000, "eproto");
  check("engine handshake (eproto)", true);

  // sanity: CpuBot really is AI (difficulty 3) — first Alpha turn works as in M7
  await waitFor((m) => m.startsWith("xAlpha"), 60000, "turn notice Alpha");
  check("human team's first turn starts", true);
  sock.write(frame("e+left"));
  await new Promise((r) => setTimeout(r, 300));
  sock.write(frame("e-left"));
  await new Promise((r) => setTimeout(r, 300));
  sock.write(frame("e-attack"));
  await new Promise((r) => setTimeout(r, 300));

  // CPU turn must self-complete without any injected input
  await waitFor((m) => m.startsWith("xCpuBot"), 60000, "CPU turn notice");
  check("CPU team takes its turn (x notice)", true);
  const cpuTurnStart = engineMessages.length;
  await waitFor((m, idx) => idx > cpuTurnStart && m.startsWith("xAlpha"), 30000, "turn returns to Alpha");
  check("CPU turn self-completes and play rotates on", true);

  // adopt the CPU team mid-game
  sock.write(frame("eteamhuman sCpuBot"));
  await new Promise((r) => setTimeout(r, 500));
  check("eteamhuman accepted (no fatal E)", !engineMessages.some((m) => m.startsWith("E")));

  // unknown team must be a no-op, not a crash
  sock.write(frame("eteamhuman sNoSuchTeam"));
  await new Promise((r) => setTimeout(r, 500));
  check("eteamhuman on unknown team is a no-op", !engineMessages.some((m) => m.startsWith("E")));

  // wait for CpuBot's next turn; inputs on the adopted team must be accepted
  await waitFor((m) => m.startsWith("xCpuBot"), 60000, "adopted team turn");
  check("adopted team takes its turn (x notice)", true);
  sock.write(frame("e+left"));
  await new Promise((r) => setTimeout(r, 400));
  sock.write(frame("e-left"));
  sock.write(frame("etimer 3"));
  sock.write(frame("eljump"));
  await new Promise((r) => setTimeout(r, 400));
  check("inputs accepted on adopted team (no fatal E)", !engineMessages.some((m) => m.startsWith("E")));
  check(
    "no unknown-command warnings",
    !engineMessages.some((m) => /unknown (command|variable)/i.test(m)),
  );

  await waitFor((m) => m.startsWith("xAlpha"), 30000, "turn returns to Alpha");
  check("adopted turn completes and play rotates on", true);
  check("no fatal 'E' overall", !engineMessages.some((m) => m.startsWith("E")));
} catch (e) {
  console.error(e.message);
  failures++;
}

sock?.end();
server.close();
engine.kill();
await new Promise((r) => setTimeout(r, 200));

console.log(failures === 0 ? "\nENGINE ADOPTION TEST: ALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
