// M10 teams mode scenario: eparty 2 with two teams of mixed human/CPU hogs.
// Asserts the per-hog turn rotation (x + y notices), CPU hogs auto-playing,
// eskip advancing human-hog turns, and that eparty 2 is accepted.
//
// usage: HWENGINE=<hwengine> HWPREFIX=<Data dir> node scripts/engine-party-teams.mjs
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINE = process.env.HWENGINE;
const PREFIX = process.env.HWPREFIX;
const PORT = Number(process.env.PORT || 18668);

if (!ENGINE || !PREFIX) {
  console.error("usage: HWENGINE=<path to hwengine> HWPREFIX=<Data dir> node scripts/engine-party-teams.mjs");
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

function makeTeam(name, color, hash, difficulties) {
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
  difficulties.forEach((difficulty, i) => {
    lines.push(`eaddhh ${difficulty} 100 ${name}Hog${i + 1}`);
    lines.push("ehat NoHat");
  });
  return lines;
}

const engineMessages = [];
let sock = null;
let configSent = false;

function waitFor(predicate, timeoutMs, label) {
  // scans engineMessages from the shared cursor so frames that arrived
  // between two paired waits (x then y) are never missed
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      for (let i = cursor; i < engineMessages.length; i++) {
        if (predicate(engineMessages[i], i)) {
          clearTimeout(timer);
          clearInterval(poll);
          return resolve(engineMessages[i]);
        }
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
        // Red: hog0 human (Alice), hog1 CPU tier 3; Blue: hog0 human (Bob),
        // hog1 CPU tier 3. eparty 2 = teams submode (no gtSwitcher gear).
        const config = [
          frame("TL"),
          frame("e$mapgen 0"),
          frame("e$template_filter 0"),
          frame("e$feature_size 12"),
          frame("eseed teamtest"),
          frame("etheme Nature"),
          frame("e$turntime 5000"),
          frame("e$ready 0"),
          frame("e$inithealth 100"),
          frame("eparty 2"),
          ...makeTeam("Red", 16711680, "0".repeat(32), [0, 3]).map(frame),
          ...makeTeam("Blue", 255, "1".repeat(32), [0, 3]).map(frame),
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

const turns = []; // {team, hog} in order
let cursor = 0; // engineMessages are scanned only past this (x/y pairs repeat)

try {
  await waitFor((m) => m.startsWith("eproto"), 30000, "eproto");
  check("engine handshake (eproto)", true);

  if (process.env.VERBOSE) engine.stdout.on("data", (d) => process.stdout.write(`[out] ${d}`));
for (let round = 0; round < 4; round++) {
    const x1 = await waitFor(
      (m, i) => i >= cursor && /^x(Red|Blue)/.test(m),
      60000,
      `turn notice #${turns.length + 1}`,
    );
    cursor = engineMessages.indexOf(x1) + 1;
    const y1 = await waitFor(
      (m, i) => i >= cursor && /^y[0-9a-f]/.test(m),
      10000,
      `hog index for turn #${turns.length + 1}`,
    );
    cursor = engineMessages.indexOf(y1) + 1;
    // IPC frames carry 2 trailing tick bytes; strip them from the team name
    turns.push({
      team: x1.slice(1, x1.length - 2),
      hog: parseInt(y1[1], 16),
    });
    // The seat model rotates hogs within each team; expected order is
    // Red0, Blue0, Red1, Blue1 for two 2-hog teams.
    const expectedTeam = turns.length % 2 === 1 ? "Red" : "Blue";
    const expectedHog = Math.floor((turns.length - 1) / 2);
    check(
      `turn ${turns.length}: ${expectedTeam} hog ${expectedHog}`,
      turns[turns.length - 1].team === expectedTeam &&
        turns[turns.length - 1].hog === expectedHog,
    );

    if (turns[turns.length - 1].hog === 0) {
      // claimed human hog: inject input then skip the turn
      sock.write(frame("e+left"));
      await new Promise((r) => setTimeout(r, 200));
      sock.write(frame("e-left"));
      sock.write(frame("eskip"));
      await new Promise((r) => setTimeout(r, 200));
      check(`human hog turn ${turns.length}: inputs + skip accepted`, !engineMessages.some((m) => m.startsWith("E")));
    } else {
      // CPU hog: self-completes without any input
      await waitFor(
        (m, i) => /^x(Red|Blue)/.test(m),
        12000,
        "CPU hog self-completes",
      );
      check(`CPU hog turn ${turns.length}: self-completes`, true);
    }
  }

  check("no fatal 'E' overall", !engineMessages.some((m) => m.startsWith("E")));
} catch (e) {
  console.error(e.message);
  failures++;
}

sock?.end();
server.close();
engine.kill();
await new Promise((r) => setTimeout(r, 200));

console.log(failures === 0 ? "\nENGINE TEAMS TEST: ALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
