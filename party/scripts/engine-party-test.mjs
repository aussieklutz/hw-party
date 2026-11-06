import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINE = process.env.HWENGINE;
const PREFIX = process.env.HWPREFIX;
const PORT = Number(process.env.PORT || 18666);

if (!ENGINE || !PREFIX) {
  console.error("usage: HWENGINE=<path to hwengine> HWPREFIX=<Data dir> node scripts/engine-party-test.mjs");
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

function makeTeam(name, color, hash) {
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
    lines.push(`eaddhh 0 100 ${name}Hog${i + 1}`);
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
        const config = [
          frame("TL"),
          frame("e$mapgen 0"),
          frame("e$template_filter 0"),
          frame("e$feature_size 12"),
          frame("eseed partytest"),
          frame("etheme Nature"),
          frame("e$turntime 5000"),
          frame("e$ready 0"),
          frame("e$inithealth 100"),
          frame("eparty 1"),
          ...makeTeam("Alpha", 16711680, "0".repeat(32)).map(frame),
          ...makeTeam("Bravo", 255, "1".repeat(32)).map(frame),
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

  await waitFor((m) => m.startsWith("xAlpha"), 60000, "turn notice Alpha");
  check("turn-start notice 'xAlpha'", true);

  const yFrame = await waitFor(
    (m) => /^y[0-9a-f]/.test(m),
    60000,
    "hog index notice",
  );
  check("hog-index companion notice 'y' follows turn start", true);
  const yIdx = engineMessages.findIndex((m) => /^y[0-9a-f]/.test(m));
  const xIdx = engineMessages.findIndex((m) => m.startsWith("x"));
  check(
    "y notice is paired after its x notice",
    xIdx !== -1 && yIdx > xIdx && /^[0-3]/.test(yFrame.slice(1)),
  );

  sock.write(frame("e+left"));
  await new Promise((r) => setTimeout(r, 400));
  sock.write(frame("e-left"));
  sock.write(frame("esetweap 3"));
  // M7.1: the frontend now translates phone headcmd letters to engine
  // variables; drive the translated forms end-to-end
  sock.write(frame("eljump"));
  sock.write(frame("ehjump"));
  sock.write(frame("eswitch"));
  sock.write(frame("e+precise"));
  sock.write(frame("e-precise"));
  sock.write(frame("etimer 3"));
  await new Promise((r) => setTimeout(r, 500));
  check("no fatal 'E' after inputs", !engineMessages.some((m) => m.startsWith("E")));
  const unknownCmds = engineMessages.filter((m) => m.startsWith("unknown command") || m.startsWith("Unknown"));
  check("translated commands are engine variables", unknownCmds.length === 0);

  await waitFor((m) => m.startsWith("xBravo"), 60000, "turn notice Bravo");
  check("turn rotated to 'xBravo'", true);
  check("no fatal 'E' overall", !engineMessages.some((m) => m.startsWith("E")));
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failures++;
} finally {
  try { if (sock) sock.write(frame("eforcequit")); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  engine.kill("SIGKILL");
  server.close();
}

console.log(failures === 0 ? "\nENGINE PARTY TEST: ALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
