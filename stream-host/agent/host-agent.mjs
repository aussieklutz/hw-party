// host-agent.mjs â€” M11.1: the stream host's supervisor. Plays the party
// host role headless (the Qt frontend's job, minus UI): owns a worker room,
// waits for players, spawns hwengine, drives it over IPC, relays phone
// input, and loops games forever. Designed for the Docker stack
// (Xvfb + ffmpeg capture); locally it runs the engine headless.
//
// env:
//   WORKER_URL      stream worker base URL (required)
//   ROOM_MODE       classic | fixed | dynamic | teams | imposter (default dynamic)
//   ROOM_SLOTS      fixed-mode slots (default 4)
//   CPU_TIER        bot difficulty 1..5 for CPU teams (default 5, "very easy")
//   THEME           map theme, or "random"
//   ENGINE_BIN      path to hwengine (default ./bin/hwengine)
//   ENGINE_PREFIX   engine Data prefix
//   ENGINE_USERPREFIX  engine user prefix (tmp dir)
//   ENGINE_ARGS     extra engine args (e.g. "--stats-only --nosound --nomusic" for local proofs)
//   LOBBY_WAIT_MS   how long an unfilled lobby waits before a fresh room (default 180000)
//   SLATE_MS        pause between games (default 15000)

import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterName } from "./safewords.mjs";
import { videoInit, videoSetPhase, videoEngineArgs } from "./video.mjs";
import { setFeedPhase } from "./feed.mjs";
import { tapStart } from "./tap.mjs";
import { Lobby } from "./layout.mjs";

const WORKER_URL = process.env.WORKER_URL;
if (!WORKER_URL) {
  console.error("WORKER_URL is not set: point it at your stream worker, e.g. https://stream.example.com");
  process.exit(2);
}
const ROOM_MODE = process.env.ROOM_MODE ?? "dynamic";
const ROOM_SLOTS = Math.min(8, Math.max(1, Number(process.env.ROOM_SLOTS ?? 4)));
const CPU_TIER = Math.min(5, Math.max(1, Number(process.env.CPU_TIER ?? 5)));
const THEME = process.env.THEME ?? "random";
const ENGINE_BIN = process.env.ENGINE_BIN ?? "./bin/hwengine";
const ENGINE_PREFIX = process.env.ENGINE_PREFIX ?? "";
const ENGINE_USERPREFIX = process.env.ENGINE_USERPREFIX ?? "";
const ENGINE_ARGS = (process.env.ENGINE_ARGS ?? "").split(" ").filter(Boolean);
const LOBBY_WAIT_MS = Number(process.env.LOBBY_WAIT_MS ?? 180000);
const SLATE_MS = Number(process.env.SLATE_MS ?? 15000);
const ROUND_WAIT_MS = Number(process.env.ROUND_WAIT_MS ?? 30000);
// imposter needs at least 6 players (3 a side) to be worth deceiving anyone.
// Seat modes (imposter, teams) seat players through agent/layout.mjs: imposter
// is two teams, seated two at a time, up to 12 players (the engine allows 8 hogs
// a team; one slot stays free for the traitor's clone); teams mode rebalances
// into 2/3/4 teams as the lobby grows, up to 24. Everyone who arrives is let in
// at once (up to the max) - only SEATING is in pairs.
const IMPOSTER_MIN_PLAYERS = 6;
const SEAT_MAX = ROOM_MODE === "imposter"
  ? Math.min(12, Math.max(IMPOSTER_MIN_PLAYERS, Number(process.env.MAX_PLAYERS ?? 12)))
  : Math.min(24, Math.max(2, Number(process.env.MAX_PLAYERS ?? 24)));
const POP_COUNT = (ROOM_MODE === "imposter" || ROOM_MODE === "teams")
  ? SEAT_MAX
  : Math.min(8, Math.max(1, Number(process.env.POP_COUNT ?? 2)));
const MIN_HUMANS = ROOM_MODE === "imposter" ? IMPOSTER_MIN_PLAYERS : 1;
const STREAM_HOST_SECRET = process.env.STREAM_HOST_SECRET ?? "";
// imposter rides the teams seat infrastructure (Red/Blue seats, per-hog
// claiming, eparty 2): everything seat-shaped applies to both
const SEAT_MODE = ROOM_MODE === "teams" || ROOM_MODE === "imposter";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[agent]", ...a);

// ---------------------------------------------------------------- worker --
const jar = { cookie: "" };
async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (jar.cookie) headers.cookie = jar.cookie;
  const res = await fetch(WORKER_URL + path, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  return res;
}

let ws = null;
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ----------------------------------------------------------------- state --
// team bookkeeping mirrors HWForm's party maps
const teamToSid = new Map();   // team name -> controller sid
const sidTeamCount = new Map();
const teams = [];              // { name, hogs:[{name}], flag, grave, voice, sid, cpu }
const placeholders = new Set();
const adopted = new Set();
let started = false;
let engineProc = null;
let engineSock = null;
let ipcServer = null;
let ipcPort = 0;
let activeSid = "";
let roundCode = "";
let pendingTurnTeam = null; // teams mode: the 'x' team name awaiting its 'y' index
let statsFrames = []; // raw 'i' stat payloads from the engine
let teamHealth = {}; // masked colour int -> team total health, from H frames
// imposter mode: this round's secret traitor seat (cloneTeam/cloneIdx: where the
// engine will put the traitor's clone). `defected` flips when the
// engine reports the swap (the traitor was their old team's last hog and was
// cloned onto the survivors); roundPlayers snapshots who sat where at start.
let imposters = []; // one traitor per team: [{ sid, name, team, hogIdx, defected, cloneTeam, cloneIdx }]
let roundPlayers = []; // [{ name, team }]
let statsReset = () => { teamHealth = {}; };

async function postQueueCtl(action, body) {
  const res = await fetch(`${WORKER_URL}/api/queue/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-stream-secret": STREAM_HOST_SECRET },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) log(`queue ${action} failed: ${res.status}`);
  return res;
}

// controller action â†’ engine variable command, mirroring HWForm::PartyInput:
// holds/setweap/slot pass through, the headcmd letters translate. Everything
// goes out as an 'e'-prefixed ParseCommand (no headcmd ticks needed).
function translateAction(a) {
  // two distinct jumps (buglist: the two jump buttons were swapped —
  // "Long Jump" (j) long-jumped nothing and just did the high hop):
  // J = hjump (high jump, vertical hop), j = ljump (long jump, forward leap)
  if (a === "J") return "hjump";
  if (a === "j") return "ljump";
  if (a === "s") return "switch";
  if (a === "Z") return "+precise";
  if (a === "z") return "-precise";
  if (/^[1-5]$/.test(a)) return "timer " + a;
  return a;
}

function frame(text) {
  const b = Buffer.from(text, "utf8");
  if (b.length > 255) throw new Error("frame too long");
  return Buffer.concat([Buffer.from([b.length]), b]);
}
function xyFrame(cmd, x, y) {
  const buf = Buffer.alloc(9);
  buf[0] = 9;
  buf[1] = cmd.charCodeAt(0);
  buf.writeInt32BE(x | 0, 2);
  buf.writeInt32BE(y | 0, 6);
  return buf;
}

function engineSend(...frames) {
  if (engineSock) engineSock.write(Buffer.concat(frames));
}

// Every command the engine receives applies to the hog whose turn it is NOW, and
// the engine only announces a turn change after it has made it. So a command a
// player sent just before their turn ended could be applied to the NEXT player's
// hog. Phone input is therefore held for INPUT_FENCE_MS and applied only if its
// sender still holds the turn then: the engine's notice arrives well inside the
// fence, and the stale command is dropped.
const INPUT_FENCE_MS = 25;
function relayFromPlayer(sid, ...frames) {
  setTimeout(() => {
    if (engineSock && sid === activeSid) engineSend(...frames);
  }, INPUT_FENCE_MS);
}

// ------------------------------------------------------------ cpu names --
const CPU_TEAM_NAMES = ["Sunshine", "Underlings", "Rising Sun", "Black Lords", "Coppers", "Blossom", "Rocketeers", "Bandits"];
const CPU_HOG_NAMES = ["Domi", "Herb", "Sico", "Venus", "Frankie", "Donut", "Momo", "Brutus", "Benedict", "Berry", "Luciano", "Timon", "Ash", "Smart", "Cristobal", "Pingu"];
const pick = (arr, used) => {
  for (let i = 0; i < 20; i++) {
    const n = arr[Math.floor(Math.random() * arr.length)];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return arr[Math.floor(Math.random() * arr.length)] + Math.floor(Math.random() * 90 + 10);
};
const THEMES = ["Art", "Bamboo", "Bath", "Beach", "Blox", "Brick", "Cake", "Castle", "Cave", "Cheese", "Christmas", "City", "Compost", "Deepspace", "Desert", "EarthRise", "Eyes", "Freeway", "Fruit", "Golf", "Halloween", "Hell", "Hoggywood", "Island", "Jungle", "Nature", "Olympics", "Planes", "Sheep", "Snow", "Stage", "Underwater"];
// distinct clan colours â€” teams of one colour are one clan, and a single
// living clan at round start ends the game with "Everyone wins!"
const CLAN_COLORS = [0xff0000, 0x0000ff, 0x00ff00, 0xffff00, 0xff00ff, 0x00ffff, 0xffffff, 0x7f0000];
const nextColor = () => CLAN_COLORS[teams.length % CLAN_COLORS.length];

function makeCpuTeam(usedTeamNames) {
  const used = new Set(teams.flatMap((t) => t.hogs.map((h) => h.name)));
  const name = filterName(pick(CPU_TEAM_NAMES, usedTeamNames));
  const hogs = [];
  for (let i = 0; i < 4; i++) hogs.push({ name: filterName(pick(CPU_HOG_NAMES, used)) });
  return {
    name, hogs,
    flag: "hedgewars", grave: "Statue", voice: "Default",
    difficulty: CPU_TIER, sid: null, cpu: true,
  };
}

// Seat modes. While the round fills, `lobby` (layout.mjs) holds who is in and
// who is seated where; the stream slides draw it live. When the round starts,
// commitLayout() turns it into the engine's teams: each team fields at least
// MIN_HOGS hogs and one more per extra player, unfilled hogs are engine-driven
// CPU at CPU_TIER. seatOf[slot] = seat record, TEAM_BASE[team] = its first slot.
const seatOf = []; // slot -> { team, hogIdx, sid?, name, claimed }
const TEAM_BASE = {};
let lobby = new Lobby({ mode: ROOM_MODE === "imposter" ? "pairs" : "balanced", max: SEAT_MAX });
let layoutLocked = false; // the round has started: the lobby no longer changes
const seatNotice = new Map(); // sid -> last "Red" | "waiting" told to the phone

function resetLobby() {
  lobby = new Lobby({ mode: ROOM_MODE === "imposter" ? "pairs" : "balanced", max: SEAT_MAX });
  layoutLocked = false;
  seatNotice.clear();
  seatOf.length = 0;
  for (const k of Object.keys(TEAM_BASE)) delete TEAM_BASE[k];
  teams.length = 0;
}

// tell each phone where it sits (only when that changed)
function noticeSeats() {
  const now = new Map();
  for (const t of lobby.teams) for (const m of t.members) now.set(m.sid, t.name);
  for (const w of lobby.waiting) now.set(w.sid, "waiting");
  for (const [sid, where] of now) {
    if (seatNotice.get(sid) === where) continue;
    seatNotice.set(sid, where);
    send({ type: "seat", sid, seated: where !== "waiting", team: where === "waiting" ? null : where });
  }
  for (const sid of [...seatNotice.keys()]) if (!now.has(sid)) seatNotice.delete(sid);
  const lay = lobby.teams.map((t) => `${t.name}[${t.members.map((m) => m.name).join(",")}]`).join(" ");
  log(`lobby ${lobby.joined}/${SEAT_MAX}: ${lay} waiting[${lobby.waiting.map((w) => w.name).join(",")}]`);
}

// the round starts: freeze the lobby into engine teams. Players still waiting
// for a partner are not in this game (see releaseUnseated).
let unseatedAtStart = [];
function commitLayout() {
  layoutLocked = true;
  seatOf.length = 0;
  teams.length = 0;
  for (const k of Object.keys(TEAM_BASE)) delete TEAM_BASE[k];
  for (const lt of lobby.teams) {
    const n = lobby.hogCount(lt);
    const hogs = [];
    TEAM_BASE[lt.name] = seatOf.length;
    for (let i = 0; i < n; i++) {
      const m = lt.members[i];
      const name = m ? m.name : `${lt.name} ${i + 1}`;
      hogs.push({ name });
      seatOf.push({ team: lt.name, hogIdx: i, sid: m ? m.sid : null, name, claimed: !!m });
      if (m) log(`seat claimed: ${lt.name} hog ${i + 1} <- "${m.name}" (${m.sid.slice(0, 8)})`);
    }
    teams.push({
      name: lt.name, color: lt.color, hogs,
      flag: "hedgewars", grave: "Statue", voice: "Default",
      cpu: false, difficulty: 0,
    });
  }
  unseatedAtStart = lobby.waiting.map((w) => w.sid);
  log(`seat teams: ${teams.map((t) => `${t.name} ${t.hogs.length} hogs`).join(", ")} (${seatOf.length} seats)`);
}

// Players still unseated when the game starts go back to the FRONT of the queue
// for the next game. Run only once the queue knows the round is under way, so
// nobody can be admitted straight back into it.
async function releaseUnseated() {
  const sids = unseatedAtStart;
  unseatedAtStart = [];
  if (!sids.length) return;
  log(`${sids.length} player(s) unseated at start - back to the front of the queue`);
  await postQueueCtl("requeue", { room: roundCode, sids });
  for (const sid of sids) send({ type: "release", sid });
}

// lobby re-evaluation, mirroring HWForm::updatePartySlots/updateDynamicCpu
function updateCpu() {
  const usedTeamNames = new Set(teams.map((t) => t.name));
  const humans = teams.filter((t) => !t.cpu);
  const cpus = teams.filter((t) => t.cpu);
  if (ROOM_MODE === "fixed") {
    while (humans.length + cpus.length > ROOM_SLOTS && cpus.length) {
      const last = cpus.pop();
      placeholders.delete(last.name);
      teams.splice(teams.indexOf(last), 1);
      if (teamToSid.has(last.name)) teamToSid.delete(last.name);
    }
    while (humans.length + cpus.length < ROOM_SLOTS) {
      const t = makeCpuTeam(usedTeamNames);
      t.color = nextColor();
      teams.push(t);
      placeholders.add(t.name);
      cpus.push(t);
    }
  } else if (ROOM_MODE === "dynamic") {
    if (humans.length === 1 && cpus.length === 0) {
      const t = makeCpuTeam(usedTeamNames);
      t.color = nextColor();
      teams.push(t);
      placeholders.add(t.name);
    } else if (humans.length !== 1 && cpus.length) {
      for (const t of cpus) {
        placeholders.delete(t.name);
        teams.splice(teams.indexOf(t), 1);
      }
    }
  }
}

// ---------------------------------------------------------------- config --
const AMMO_QT_BASE = "939192942219912103223511100120000000021110010101111100010001";
// test aid (unset in production): AMMO_KAMIKAZE=<0-9> sets the Kamikaze count
// of every team store. The stock loadout gives each TEAM a single Kamikaze,
// too few to script several teammates self-destructing.
const AMMO_QT_KAMI = process.env.AMMO_KAMIKAZE
  ? AMMO_QT_BASE.slice(0, 22) + String(Math.min(9, Math.max(0, Number(process.env.AMMO_KAMIKAZE) || 0))) + AMMO_QT_BASE.slice(23)
  : AMMO_QT_BASE;
// In the team and imposter modes one player drives ONE hog, so "Switch Hedgehog"
// (ammo index 20) is taken out of every store, both in the engine config and in
// the grid the phones see. The room also refuses to select it - this way it is
// not on offer at all, and a hole in either layer is not enough.
const AMMO_QT = SEAT_MODE ? AMMO_QT_KAMI.slice(0, 20) + "0" + AMMO_QT_KAMI.slice(21) : AMMO_QT_KAMI;
const AMMO_PROB = "040504054160065554655446477657666666615551010111541111111073";
const AMMO_DELAY = "000000000000020550000004000700400000000022000000060002000000";
const AMMO_CRATE = "131111031211111112311411111111111111121111111111111111111111";

function buildConfigLines() {
  const theme = THEME === "random" ? THEMES[Math.floor(Math.random() * THEMES.length)] : THEME;
  const seed = "{" + crypto.randomUUID() + "}";
  const cfg = [
    "TL",
    "e$mapgen 0",
    "e$template_filter 0",
    "e$feature_size 12",
    `eseed ${seed}`,
    `etheme ${theme}`,
    "e$gmflags 0",
    "e$damagepct 100",
    "e$turntime 45000",
    "e$inithealth 100",
    "e$sd_turns 15",
    "e$casefreq 5",
    "e$minestime 3000",
    "e$minesnum 4",
    "e$minedudpct 0",
    "e$explosives 2",
    "e$airmines 0",
    "e$sentries 0",
    "e$healthprob 35",
    "e$hcaseamount 25",
    "e$waterrise 47",
    "e$healthdec 5",
    "e$ropepct 100",
    "e$getawaytime 100",
    "e$worldedge 0",
  ];
  // every team needs its own ammo store: the engine assigns stores in order,
  // so each eaddteam must be preceded by a fresh load/store block
  for (const t of teams) {
    cfg.push(
      `eammloadt ${AMMO_QT}`,
      `eammprob ${AMMO_PROB}`,
      `eammdelay ${AMMO_DELAY}`,
      `eammreinf ${AMMO_CRATE}`,
      "eammstore",
    );
    cfg.push(`eaddteam ${"0".repeat(32)} ${t.color ?? 0xffffff} ${t.name}`);
    cfg.push(`egrave ${t.grave}`);
    cfg.push(`efort ${t.fort ?? "Plane"}`);
    cfg.push(`evoicepack ${t.voice}`);
    cfg.push(`eflag ${t.flag}`);
    t.hogs.forEach((h, i) => {
      // teams mode: claimed seat hogs are human (0), unclaimed engine-driven
      // CPU at CPU_TIER — the hog's engine-driven turn self-completes
      let d = t.cpu ? t.difficulty : 0;
      if (SEAT_MODE) {
        const seat = seatOf[TEAM_BASE[t.name] + i];
        d = seat && seat.sid ? 0 : CPU_TIER;
      }
      cfg.push(`eaddhh ${d} 100 ${h.name}`);
      cfg.push("ehat NoHat");
      void i;
    });
  }
  // party input path is on for every mode: enables the relative-cursor 'P'
  // deltas and the x/y turn notices the agent relays to the phones
  cfg.push(SEAT_MODE ? "eparty 2" : "eparty 1");
  cfg.push("!");
  return cfg;
}

function buildConfig() {
  return buildConfigLines().map(frame);
}

// ---------------------------------------------------------------- engine --
function startIpcServer() {
  return new Promise((resolve) => {
    ipcServer = net.createServer((sock) => {
      engineSock = sock;
      let buf = Buffer.alloc(0);
      sock.on("data", (data) => {
        if (process.env.AGENT_HEXDUMP) {
          process.stdout.write("[hex] " + data.toString("hex").match(/../g).join(" ") + "\n");
        }
        buf = Buffer.concat([buf, data]);
        for (;;) {
          if (buf.length < 1) break;
          const len = buf[0];
          if (len === 0 || buf.length < len + 1) break;
          const p = buf.subarray(1, len + 1);
          buf = buf.subarray(len + 1);
          handleEngineFrame(p);
        }
      });
      sock.on("close", () => { if (engineSock === sock) engineSock = null; });
    });
    ipcServer.listen(0, "127.0.0.1", () => resolve(ipcServer.address().port));
  });
}

let configSent = false;
function handleEngineFrame(p) {
  const c = p[0];
  if (c === 0x69 /* i — stat line, SendIPCRaw: no tick suffix */) {
    const text = p.toString("utf8", 1);
    if (process.env.AGENT_TRACE) log(`stat raw: ${JSON.stringify(text)}`);
    statsFrames.push(text);
    // 'H' frames carry the team's TOTAL health keyed by team COLOUR
    // ("H<signed colour int32> <health>") — map the colour back to the team
    if (text[0] === "H") {
      const m = text.slice(1).match(/^(-?\d+) (\d+)$/);
      if (m) teamHealth[parseInt(m[1], 10) & 0xffffff] = parseInt(m[2], 10);
    }
    return;
  }
  if (c === 0x43 /* C */) {
    configSent = true;
    const cfg = buildConfig();
    if (process.env.AGENT_DUMP)
      writeFileSync(process.env.AGENT_DUMP, buildConfigLines().join("\n") + "\n");
    engineSend(...cfg);
    log("engine config sent:", teams.length, "teams");
  } else if (c === 0x3f /* ? */) {
    engineSend(frame("!"));
  } else if (c === 0x78 /* x */) {
    // SendIPC appends a 2-byte GameTicks to every frame â€” strip it from the
    // team name
    const teamName = p.toString("utf8", 1, p.length - 2);
    if (SEAT_MODE) {
      // teams mode: the 'y' hog-index companion completes the turn notice
      pendingTurnTeam = teamName;
      return;
    }
    const sid = teamToSid.get(teamName) ?? "";
    activeSid = sid;
    send({ type: "turn", team: teamName, ...(sid ? { sid } : {}) });
    log("turn:", teamName, sid ? `(sid ${sid.slice(0, 8)})` : "(cpu)");
    if (sid) afkCheck(teamName, sid);
  } else if (c === 0x79 /* y */) {
    // hog index companion notice: a nibble char (0-9, a-f). Teams mode:
    // completes the 'x' team notice — the active seat routes the turn to
    // the claiming controller; unclaimed seats are engine-driven CPU
    const ch = String.fromCharCode(p[1]);
    const hogIdx = (ch >= "0" && ch <= "9") ? ch.charCodeAt(0) - 48
      : (ch >= "a" && ch <= "f") ? ch.charCodeAt(0) - 87 : -1;
    if (!SEAT_MODE || !pendingTurnTeam) return;
    const teamName = pendingTurnTeam;
    pendingTurnTeam = null;
    const slot = (TEAM_BASE[teamName] ?? 0) + Math.max(0, hogIdx);
    let seat = seatOf[slot];
    // after a defection the engine put the traitor's clone in a fresh slot
    // (index n) on the surviving team: its turns route to the traitor's phone
    for (const imp of imposters) {
      if (imp.defected && teamName === imp.cloneTeam && hogIdx === imp.cloneIdx)
        seat = seatOf.find((s) => s.team === imp.team && s.hogIdx === imp.hogIdx);
    }
    const sid = seat ? (seat.sid ?? "") : "";
    activeSid = sid;
    const hogName = seat ? seat.name : teamName;
    send({ type: "turn", team: hogName, ...(sid ? { sid } : {}) });
    log("turn:", hogName, sid ? `(sid ${sid.slice(0, 8)})` : "(engine cpu)");
    // the engine itself checks "is the traitor their team's last living hog"
    // and no-ops otherwise, so firing at every turn start needs no health feed
    for (const imp of imposters)
      if (!imp.defected) engineSend(frame(`etraitor ${imp.hogIdx} ${imp.team}`));
    if (sid) afkCheck(hogName, sid);
  } else if (c === 0x7a /* z — traitor swap notice: the team the traitor left */) {
    const from = p.toString("utf8", 1, p.length - 2);
    const imp = imposters.find((i) => !i.defected && i.team === from);
    if (imp) {
      imp.defected = true;
      log(`imposter ${imp.name} defected from ${from}`);
    }
  } else if (c === 0x71 /* q */) {
    log("engine quit");
  } else if (process.env.AGENT_TRACE) {
    log("frame", String.fromCharCode(c), `len=${p.length}`, p.length <= 8 ? p.toString("hex") : "");
  }
}

function spawnEngine(port) {
  const tap = tapStart(); // encoder for this game, when STREAM_TAP=1
  const args = [
    "--internal", "--port", String(port),
    ...(tap ? tap.engineArgs : []),
    ...videoEngineArgs(),
    ...ENGINE_ARGS,
  ];
  if (ENGINE_PREFIX) args.push("--prefix", ENGINE_PREFIX);
  if (ENGINE_USERPREFIX) args.push("--user-prefix", ENGINE_USERPREFIX);
  const proc = spawn(ENGINE_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: tap ? { ...process.env, ...tap.env } : process.env,
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[engine] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[engine] ${d}`));
  proc.on("exit", (code) => {
    log(`engine exited code=${code}`);
    if (tap) tap.stop();
    engineProc = null;
    onGameEnd();
  });
  return proc;
}

// ----------------------------------------------------------------- relay --
// A stream room's screen names are decided server-side (a signed-in account's
// name, or AnonAlpha...): the room flags those `verified` and they are used as
// is. Anything else - a party room's typed name - goes through the safeword
// filter.
function screenName(config) {
  const raw = String(config.name ?? "").slice(0, 40);
  return config.verified === true ? raw : filterName(raw);
}

function handleControllerMsg(msg) {
  switch (msg.type) {
    case "hello":
      log("host socket ready, room", msg.room, "mode", msg.mode);
      break;
    case "joined": {
      const sid = msg.sid;
      sidTeamCount.set(sid, sidTeamCount.get(sid) ?? 0);
      break;
    }
    case "team": {
      const { sid, config } = msg;
      if (SEAT_MODE) {
        // teams mode: the "team" message claims the next open seat — the
        // seat's hog takes the player's screen name and becomes human-driven
        if (sidTeamCount.has(sid) && sidTeamCount.get(sid) > 0) break; // dedupe by sid
        const name = screenName(config);
        if (!name) break;
        if (started || layoutLocked) {
          // MID-GAME: a returning player reclaims the seat they previously
          // held (the DO keeps mid-game seats reserved by name, and the ws
          // session cookie keeps their sid stable). Anyone else stays
          // spectator: the engine config already fixed this hog's inputs.
          const mine = seatOf.find((s) => s.lastSid === sid);
          if (mine) {
            mine.sid = sid;
            mine.name = name;
            mine.claimed = true;
            const team = teams.find((t) => t.name === mine.team);
            if (team && team.hogs[mine.hogIdx]) team.hogs[mine.hogIdx].name = name;
            teamToSid.set(mine.team, sid);
            log(`seat re-claimed: ${mine.team} hog ${mine.hogIdx + 1} <- "${name}" (${sid.slice(0, 8)})`);
            const back = imposters.find((i) => i.team === mine.team && i.hogIdx === mine.hogIdx);
            if (back) {
              back.sid = sid;
              whisperImposter(back);
            }
            sendRoster();
            sendState();
            break;
          }
          log(`seat claim refused (round started) - ${sid.slice(0, 8)} spectates`);
          break;
        }
        // the round is filling: the claim lets the player into the lobby, and the
        // lobby decides whether they are seated yet (pairs) and where
        if (!lobby.join(sid, name)) {
          log(`lobby full or duplicate - ${sid.slice(0, 8)} not added`);
          break;
        }
        sidTeamCount.set(sid, 1);
        log(`joined lobby: "${name}" (${sid.slice(0, 8)})`);
        noticeSeats();
        sendRoster();
        break;
      }
      // classic/fixed/dynamic: the "team" message registers a whole team
      if (sidTeamCount.has(sid) && sidTeamCount.get(sid) > 0) break; // dedupe by sid
      const name = screenName(config);
      if (!name) break;
      const existing = teams.find((t) => t.name === name);
      if (existing) {
        // re-claim: the DO reserved this seat by name when the player dropped
        // mid-game; re-bind it so turns and heartbeats route to this sid again
        teamToSid.set(name, sid);
        existing.sid = sid;
        sidTeamCount.set(sid, (sidTeamCount.get(sid) ?? 0) + 1);
        log(`re-claimed team "${name}" from ${sid.slice(0, 8)}`);
        sendState();
        break;
      }
      sidTeamCount.set(sid, (sidTeamCount.get(sid) ?? 0) + 1);
      const hogs = (config.hogs ?? []).slice(0, 4).map((h, i) => ({
        name: filterName(String(h?.name ?? `Hog ${i + 1}`).slice(0, 40)),
      }));
      while (hogs.length < 4) hogs.push({ name: `Hog ${hogs.length + 1}` });
      teams.push({
        name, hogs,
        flag: String(config.flag ?? "hedgewars"),
        grave: String(config.grave ?? "Statue"),
        voice: String(config.voice ?? "Default"),
        color: nextColor(),
        sid, cpu: false,
      });
      teamToSid.set(name, sid);
      log(`registered team "${name}" from ${sid.slice(0, 8)}`);
      updateCpu();
      if (started) sendState(); // rosters changed mid-game; controllers refetch on next game
      break;
    }
    case "left": {
      const sid = msg.sid;
      if (SEAT_MODE) {
        if (!started && !layoutLocked) {
          // dropped out of the filling lobby (or was admitted and never took a
          // seat): the layout evens itself out - the latest player on the other
          // team may be unseated - and the queue gives the place and the name back
          const wasIn = lobby.leave(sid);
          sidTeamCount.delete(sid);
          log(`player ${sid.slice(0, 8)} left the lobby${wasIn ? "" : " (never took a seat)"}`);
          postQueueCtl("drop", { sid });
          if (wasIn) noticeSeats();
          sendRoster();
          break;
        }
        // the seat reverts to engine-driven CPU; mid-game a config change is
        // impossible so the dead seat just loses its controller (the AFK
        // flow skips its turns)
        const seat = seatOf.find((s) => s.sid === sid);
        if (seat) {
          const team = teams.find((t) => t.name === seat.team);
          const ph = team ? team.hogs[seat.hogIdx] : null;
          if (ph) ph.name = `${seat.team} ${seat.hogIdx + 1}`; // placeholder back
          log(`seat released: ${seat.team} hog ${seat.hogIdx + 1} (player ${sid.slice(0, 8)} left)`);
          seat.sid = null;
          seat.claimed = false;
          seat.name = ph ? ph.name : seat.name;
          seat.lastSid = sid;
          if (teamToSid.get(seat.team) === sid) teamToSid.delete(seat.team);
        }
        if (activeSid === sid) {
          activeSid = "";
          for (const rel of ["-left", "-right", "-up", "-down", "-attack", "-precise"])
            engineSend(frame("e" + rel));
        }
        sidTeamCount.delete(sid);
        sendRoster();
        break;
      }
      const name = [...teamToSid.entries()].find(([, s]) => s === sid)?.[0];
      if (name) {
        teamToSid.delete(name);
        if (started) {
          // MID-GAME DROP: keep the engine team and seat reservation (the DO
          // also keeps mid-game seats by name). The hogs become uncontrolled
          // here; a reconnecting page re-sends its claim to take the seat
          // back without duplicating or renaming anything in the engine.
          const t = teams.find((x) => x.name === name);
          if (t) t.sid = "";
          log(`player ${sid.slice(0, 8)} dropped (team "${name}") — awaiting re-claim`);
        } else {
          const idx = teams.findIndex((t) => t.name === name);
          if (idx >= 0) teams.splice(idx, 1);
          log(`player ${sid.slice(0, 8)} left (team "${name}")`);
          updateCpu();
          sendRoster();
        }
        if (activeSid === sid) {
          activeSid = "";
          // release held inputs so the hog does not walk off a cliff forever
          for (const rel of ["-left", "-right", "-up", "-down", "-attack", "-precise"])
            engineSend(frame("e" + rel));
        }
      }
      sidTeamCount.delete(sid);
      break;
    }
    case "input": {
      if (!engineSock || msg.sid !== activeSid) return;
      const a = msg.action;
      const cmd = a === "," ? "eskip" : "e" + translateAction(a);
      if (process.env.AGENT_TRACE) log("relay", msg.sid.slice(0, 8), cmd);
      relayFromPlayer(msg.sid, frame(cmd));
      break;
    }
    case "cursor":
      if (engineSock && msg.sid === activeSid) relayFromPlayer(msg.sid, xyFrame("P", msg.x, msg.y));
      break;
    case "put":
      if (engineSock && msg.sid === activeSid) relayFromPlayer(msg.sid, xyFrame("p", msg.x ?? 0, msg.y ?? 0));
      break;
    default:
      break;
  }
}

function sendState(countdownSeconds) {
  const msg = { type: "state", state: started ? "ingame" : "lobby" };
  if (!started && typeof countdownSeconds === "number")
    msg.countdown = countdownSeconds;
  send(msg);
  if (!started) sendRoster();
  if (started) send({ type: "weapons", ammo: AMMO_QT });
}

function sendRoster() {
  // the worker relays roster state to new joiners; the host only pushes
  // turns/weapons/state â€” roster mirroring lives worker-side
}

// ------------------------------------------------------------------ loop --
// The host socket is the room's only line to the phones. A worker deploy or
// restart drops every socket, so while a round is open it reconnects on its own;
// the room replays its state and every live registration to a returning host
// (the lobby ignores the duplicates it already knows).
let hostWanted = false;
async function connectHostWs(code) {
  hostWanted = true;
  const sock = new WebSocket(WORKER_URL.replace(/^http/, "ws") + `/api/rooms/${code}/ws`, { headers: { cookie: jar.cookie } });
  ws = sock;
  sock.addEventListener("message", (e) => {
    try { handleControllerMsg(JSON.parse(e.data)); } catch (err) { log("bad msg", err.message); }
  });
  sock.addEventListener("close", () => {
    log("host ws closed");
    if (hostWanted && roundCode === code && ws === sock) {
      log("host ws lost mid-round: reconnecting");
      setTimeout(() => { if (hostWanted && roundCode === code && ws === sock) connectHostWs(code); }, 2000);
    }
  });
  await new Promise((r) => setTimeout(r, 400));
}
// the round is over (or never started): let the host socket go for good
function closeHostWs() {
  hostWanted = false;
  try { if (ws) ws.close(); } catch {}
}

const humans_ = () => teams.filter((t) => !t.cpu).length;
// the seat grid the slides render: filled seats in join order (CPU fillers
// flagged), the remainder up to capacity stays open
function rosterPayload() {
  if (SEAT_MODE) {
    // the slides draw `teams` (each at least MIN_HOGS rows, growing with the
    // seated players) and `waiting` (in, but not seated yet); `seats` is the
    // flat list of everyone in, for older readers
    const snap = lobby.snapshot();
    const seats = [...snap.teams.flatMap((t) => t.seats.filter(Boolean)), ...snap.waiting];
    return { seats, teams: snap.teams, waiting: snap.waiting, joined: snap.joined, openSeats: Math.max(0, snap.capacity - snap.joined), capacity: snap.capacity };
  }
  const capacity = ROOM_MODE === "fixed" ? ROOM_SLOTS : Math.max(POP_COUNT, 4);
  const seats = teams.map((t) => (t.cpu ? { name: t.name, cpu: true } : { name: t.name }));
  return { seats, openSeats: Math.max(0, capacity - humans_()), capacity };
}

let postedRoster = "";
function postRosterIfChanged() {
  const payload = rosterPayload();
  const sig = JSON.stringify(payload);
  if (sig === postedRoster) return;
  postedRoster = sig;
  postQueueCtl("roster", payload);
}

// wait for the round to fill: pops arrive from the queue, the first
// registration starts the ROUND_WAIT countdown, every further joiner restarts
// it ("timer restarts as each player joins"), the round starts early when the
// lobby is full, and an idle lobby expires so the slate can cycle.
async function waitRound() {
  const firstHumanDeadline = Date.now() + LOBBY_WAIT_MS;
  let countdownEnd = 0;
  let prevHumans = -1;
  const teamsCap = SEAT_MODE;

  for (;;) {
    if (!teamsCap) updateCpu();
    // seat modes: `humans` is who is SEATED (imposter: pairs), `joined` who is
    // in at all - the countdown restarts on every arrival, seated or not
    const humans = teamsCap ? (ROOM_MODE === "imposter" ? lobby.seated : lobby.joined) : humans_();
    const joined = teamsCap ? lobby.joined : humans;
    const capacity = teamsCap
      ? SEAT_MAX
      : Math.max(POP_COUNT, ROOM_MODE === "fixed" ? ROOM_SLOTS : POP_COUNT);
    const openSeats = Math.max(0, capacity - joined);
    const full = joined >= capacity;
    postRosterIfChanged();

    if (humans >= MIN_HUMANS && (teamsCap || teams.length >= 2)) {
      if (full) { log("lobby full, starting"); return true; }
      if (!countdownEnd || (joined > prevHumans && prevHumans >= 0)) {
        countdownEnd = Date.now() + ROUND_WAIT_MS;
        await postQueueCtl("countdown", { endsAt: countdownEnd, openSeats });
      }
      const left = Math.ceil((countdownEnd - Date.now()) / 1000);
      sendState(left);
      if (left <= 0) { log("countdown elapsed, starting"); return true; }
    } else if (humans < MIN_HUMANS) {
      if (countdownEnd) {
        // players dropped below the minimum mid-countdown: it can no longer
        // finish, so take it off the stream and let the queue keep refilling
        countdownEnd = 0;
        log(`countdown cancelled: ${humans}/${MIN_HUMANS} players left`);
        await postQueueCtl("phase", {
          phase: "lobby", room: roundCode, mode: ROOM_MODE, count: POP_COUNT, openSeats, ...(SEAT_MODE ? { capacity } : {}),
        });
      }
      sendState();
      if (Date.now() > firstHumanDeadline) {
        log(humans ? `only ${humans}/${MIN_HUMANS} players joined this round` : "nobody joined this round");
        return false;
      }
    } else {
      sendState();
    }
    prevHumans = joined;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// private reveal to ONE traitor's phone (the DO routes "notify" by sid)
function whisperImposter(imp) {
  if (!imp) return;
  send({
    type: "notify",
    sid: imp.sid,
    text: `You are the IMPOSTER on the ${imp.team} team. Play along - if you end up as ${imp.team}'s last hog you switch sides and win with the other team.`,
  });
}

// imposter mode: each team has one secret traitor, picked at random from the
// seated players of that team (so every game has two, one on each side)
function pickImposters() {
  imposters = [];
  roundPlayers = seatOf.filter((s) => s.sid).map((s) => ({ name: s.name, team: s.team }));
  if (ROOM_MODE !== "imposter") return;
  if (seatOf.filter((s) => s.sid).length < IMPOSTER_MIN_PLAYERS) return;
  for (const t of teams) {
    const claimed = seatOf.filter((s) => s.sid && s.team === t.name);
    if (!claimed.length) continue;
    const seat = claimed[Math.floor(Math.random() * claimed.length)];
    const other = teams.find((x) => x.name !== t.name);
    imposters.push({
      sid: seat.sid, name: seat.name, team: seat.team, hogIdx: seat.hogIdx, defected: false,
      cloneTeam: other ? other.name : "", cloneIdx: other ? other.hogs.length : -1,
    });
    log(`imposter: ${seat.name} (${seat.team} hog ${seat.hogIdx + 1})`);
  }
}

async function playOneGame() {
  configSent = false;
  gameReported = false;
  pickImposters();
  // NOTE: teams/teamToSid are NOT reset here â€” they are this round's roster;
  // the engine's config request can arrive the moment it connects, before any
  // new registration, and a zero-team config crashes the engine (exit 217).
  activeSid = "";
  statsFrames = [];
  statsReset();

  ipcPort = await startIpcServer();
  engineProc = spawnEngine(ipcPort);
  started = true;
  sendState();
  for (const imp of imposters) whisperImposter(imp);

  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (engineProc === null) { clearInterval(iv); resolve(); }
    }, 500);
  });
  if (ipcServer) { ipcServer.close(); ipcServer = null; }
}

// digest the engine's stat frames into the commentary slide's lines plus the
// ladder update. Frame vocabulary (uStats.pas SendStat via 'i' frames):
//   r  game result ("X wins!")            R  team rank (prefix for P/T)
//   T  team stats "name:health:"          P  "colour kills team" (all teams,
//                                             winner first, then death order)
//   H  "signed colour total-health" — the team's summed health, keyed by
//      team COLOUR (matches the config colour with an alpha channel set)
//   k  "N hog (team)" biggest single-turn kill spree (unique hog only)
//   B  "N team" most turn skips (emitted past 2)
function summariseStats() {
  const lines = [];
  let winner = "";
  const kills = {};
  const health = {};
  const rank = {};
  let hogOfMatch = null;
  let skips = null;
  let result = "";
  let pendingRank = 0;
  for (const f of statsFrames) {
    // frames are stored without the leading 'i': the stat type is the first char
    const t = f[0];
    const body = f.slice(1);
    if (t === "r") result = body;
    else if (t === "R") pendingRank = parseInt(body, 10) || 0;
    else if (t === "T") {
      const m = body.match(/^(.*):(\d+):?$/);
      if (m) { health[m[1]] = parseInt(m[2], 10); rank[m[1]] = pendingRank; }
    } else if (t === "P") {
      const m = body.match(/^(-?\d+) (\d+) (.+)$/);
      if (m) { kills[m[3]] = parseInt(m[2], 10); rank[m[3]] = pendingRank; }
    } else if (t === "k") {
      const m = body.match(/^(\d+) (.+) \((.+)\)$/);
      if (m && parseInt(m[1], 10) > 0) hogOfMatch = { hog: m[2], team: m[3], kills: parseInt(m[1], 10) };
    } else if (t === "B") {
      const m = body.match(/^(\d+) (.+)$/);
      if (m) skips = { count: parseInt(m[1], 10), team: m[2] };
    }
  }
  if (result) {
    lines.push(result);
    const w = result.match(/^(.*) wins!$/);
    if (w) winner = w[1];
  }
  if (hogOfMatch)
    lines.push(`Hog of the match: ${hogOfMatch.hog} (${hogOfMatch.team}) - ${hogOfMatch.kills} kills in one turn`);
  if (skips)
    lines.push(`${skips.team} skipped ${skips.count} turns - someone was napping`);
  // team lines: every configured team, in config order, with kills from the
  // P frames and the summed health from the colour-keyed H frames (the
  // colour-keyed path is the only one this engine version reliably sends)
  teams.forEach((team, i) => {
    const k = kills[team.name] ?? 0;
    const h = teamHealth[team.color & 0xffffff];
    const rk = rank[team.name];
    lines.push(`${rk ? rk + ". " : ""}${team.name} - ${k} kills${h != null ? `, ${h} health` : ""}`);
  });
  // any extra teams that only appeared in the stat frames (safety net)
  Object.keys(rank)
    .filter((team) => !teams.some((t) => t.name === team))
    .sort((a, b) => (rank[a] || 99) - (rank[b] || 99))
    .forEach((team) => {
      const k = kills[team] ?? 0;
      const h = health[team];
      lines.push(`${rank[team] ? rank[team] + ". " : ""}${team} - ${k} kills${h != null ? `, ${h} health` : ""}`);
    });
  return { lines, winner, kills };
}

// the engine-exit hook and the main loop both call onGameEnd: the result of a
// game is reported once (a second report would double-count the ladder and,
// having cleared the round's imposter state, overwrite the real one)
let gameReported = true;
async function onGameEnd() {
  started = false;
  activeSid = ""; // nobody holds a turn once the game is over
  videoSetPhase("slate"); setFeedPhase("slate");
  const stats = summariseStats();
  const firstReport = !gameReported;
  gameReported = true;
  if (firstReport && stats.lines.length) {
    const report = { lines: stats.lines, winner: stats.winner, kills: stats.kills };
    if (SEAT_MODE && roundPlayers.length) {
      // seat modes: the worker rates people, so say who sat where and who
      // (if anyone) was the imposter; it decides who counts as a winner
      report.players = roundPlayers;
      if (imposters.length) {
        report.imposters = imposters.map((i) => ({ name: i.name, team: i.team, defected: i.defected }));
        const lines = [...report.lines];
        for (const i of imposters) if (i.defected) lines.push(`Imposter revealed: ${i.name} betrayed ${i.team}!`);
        lines.push(`The imposters were ${imposters.map((i) => `${i.name} (${i.team})`).join(" and ")}.`);
        report.lines = lines;
      }
    }
    await postQueueCtl("lastgame", report);
  }
  imposters = [];
  roundPlayers = [];
  if (roundCode) {
    await postQueueCtl("release", { room: roundCode });
    roundCode = "";
  }
}

// afk turn handling: pause the engine while the active player's heartbeat
// is stale, broadcast the countdown, and either resume (player showed up) or
// skip the turn + resume (timeout). Uses the engine's own pause primitive
// ('I' IPC frame = 'pause server' toggle) â€” the turn timer freezes while
// paused, so a player who shows up still has their remaining turn time.
const AFK_SECONDS = 10;
const AFK_FIRST_CHECK_MS = 3000; // the controller's first ping lands within ~2s

async function controllerAlive(roomCode, sid) {
  try {
    const res = await fetch(`${WORKER_URL}/api/rooms/${roomCode}/alive/${sid}`, { headers: { cookie: jar.cookie } });
    if (!res.ok) return false;
    const d = await res.json();
    if (process.env.AGENT_TRACE) log("alive check:", JSON.stringify(d));
    return d.alive === true;
  } catch { return false; }
}

let afkActive = false;

async function afkCheck(teamName, sid) {
  if (afkActive) return; // previous check still running â€” don't stack pauses
  afkActive = true;
  try {
    await sleep2(AFK_FIRST_CHECK_MS); // the controller's first ping lands within ~2s
    if (!(await controllerAlive(roundCode, sid))) {
      // phone asleep: pause the engine and count down on the stream
      engineSend(frame("I"));
      log(`afk: ${teamName} not responding - paused, ${AFK_SECONDS}s to show up`);
      postQueueCtl("turnafk", { team: teamName, seconds: AFK_SECONDS });
      let showed = false;
      const deadline = Date.now() + AFK_SECONDS * 1000;
      while (Date.now() < deadline) {
        await sleep2(1000);
        if (await controllerAlive(roundCode, sid)) { showed = true; break; }
        // refresh the countdown every few seconds (the slides tick client-side)
      }
      if (showed) {
        log(`afk: ${teamName} showed up - resuming`);
        postQueueCtl("turnafk", { team: teamName, clear: true });
        engineSend(frame("I")); // unpause â€” the player keeps the remaining turn time
      } else {
        log(`afk: ${teamName} timed out - skipping turn`);
        engineSend(frame("eskip"));
        engineSend(frame("I")); // unpause AFTER the skip lands
        postQueueCtl("turnafk", { team: teamName, clear: true });
        activeSid = ""; // controls stay gated for the dead controller
      }
    }
  } catch (e) {
    log(`afk check error: ${e.message}`);
    engineSend(frame("I")); // never leave the engine paused by accident
  } finally {
    afkActive = false;
  }
}

function sleep2(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function createRoom() {
  for (let i = 0; i < 30; i++) {
    try {
      // the queue secret marks the room "managed": only players the queue
      // admitted into it can join
      const res = await api("/api/rooms", {
        method: "POST",
        headers: { "x-stream-secret": STREAM_HOST_SECRET },
        body: JSON.stringify(SEAT_MODE
          ? { mode: ROOM_MODE, slots: Math.min(8, Math.ceil(SEAT_MAX / 2)), maxPlayers: SEAT_MAX }
          : { mode: ROOM_MODE, slots: ROOM_SLOTS }),
      });
      if (res.ok) {
        const { room } = await res.json();
        return room;
      }
      log(`room create failed: ${res.status}, retrying`);
    } catch (e) {
      log(`room create failed: ${e.message}, retrying`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function main() {
  log("stream host agent starting:", WORKER_URL, "mode", ROOM_MODE);
  if (!existsSync(ENGINE_BIN)) {
    console.error(`engine binary not found: ${ENGINE_BIN}`);
    process.exit(1);
  }
  await videoInit();

  for (;;) {
    // slate: the slides cycle (commentary -> scoreboard -> how-to-play) while
    // the queue is open
    await postQueueCtl("phase", { phase: "slate" });
    videoSetPhase("slate"); setFeedPhase("slate");
    await new Promise((r) => setTimeout(r, SLATE_MS));

    const code = await createRoom();
    if (!code) { log("could not create a room; retrying"); continue; }
    roundCode = code;
    log("room:", code);
    teams.length = 0;
    placeholders.clear();
    teamToSid.clear();
    sidTeamCount.clear();
    pendingTurnTeam = null;
    postedRoster = "";
    if (SEAT_MODE) {
      // an empty lobby: the stream slides show the (minimum-size) teams at
      // once, and they grow as players arrive and are seated
      resetLobby();
      postRosterIfChanged();
    }
    await connectHostWs(code);

    // pop the first batch out of the queue; arrivals during the lobby and
    // countdown keep popping (the queue DO handles that while the round is
    // open), and openSeats drives the "last chance to join" UI
    const capacity = SEAT_MODE
      ? SEAT_MAX
      : Math.max(POP_COUNT, ROOM_MODE === "fixed" ? ROOM_SLOTS : POP_COUNT);
    await postQueueCtl("phase", { phase: "lobby", room: code, mode: ROOM_MODE, count: POP_COUNT, openSeats: capacity, ...(SEAT_MODE ? { capacity } : { capacity: 0 }) });
    videoSetPhase("lobby"); setFeedPhase("lobby");
    await postQueueCtl("admit", { room: code, count: POP_COUNT });
    sendState();

    const ready = await waitRound();
    if (!ready) {
      // nobody came: drop the room, rest on the slate, try again
      await onGameEnd();
      closeHostWs();
      continue;
    }

    // freeze the lobby into engine teams (and send anyone still unseated back to
    // the front of the queue) BEFORE anything can change it
    if (SEAT_MODE) commitLayout();
    log("starting game with", teams.length, "teams");
    await postQueueCtl("phase", { phase: "ingame", room: code });
    if (SEAT_MODE) await releaseUnseated();
    videoSetPhase("ingame"); setFeedPhase("ingame");
    await playOneGame();
    log("game over");
    await onGameEnd();
    closeHostWs();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
