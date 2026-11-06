// layout-diff.mjs - the stream host's lobby (agent/layout.mjs) and the Qt
// launcher's (frontend-qt6/partylayout.cpp) must seat players IDENTICALLY.
// The same random joins and leaves go through both; after every single
// operation the results (accepted or refused) and the whole lobby (teams, seats,
// waiting, counts) must match exactly.
//
//   node tests/layout-diff.mjs
//
// The C++ side is built and run in a WSL distro that has Qt6 (default "Ubuntu",
// override with WSL_DISTRO). On Linux/macOS with Qt6 it builds locally.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Lobby } from "../agent/layout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const DISTRO = process.env.WSL_DISTRO ?? "Ubuntu";
const isWin = process.platform === "win32";
const toWsl = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

// ---- build the C++ side ------------------------------------------------------
const OUT = "/tmp/hw-layout-cli";
const build = isWin
  ? spawnSync("wsl", ["-d", DISTRO, "--", "bash", "-lc", `cd ${toWsl(root)} && sh stream-host/tests/test-layout.sh ${OUT}`], { encoding: "utf8" })
  : spawnSync("sh", [join(root, "stream-host/tests/test-layout.sh"), OUT], { encoding: "utf8" });
check("the C++ layout builds against Qt6", build.status === 0, (build.stderr || build.stdout).trim().split("\n").slice(-2).join(" | "));
if (build.status !== 0) process.exit(1);
const runCpp = (input) =>
  (isWin
    ? spawnSync("wsl", ["-d", DISTRO, "--", `${OUT}/layout-cli`], { input, encoding: "utf8", maxBuffer: 256 << 20 })
    : spawnSync(`${OUT}/layout-cli`, { input, encoding: "utf8", maxBuffer: 256 << 20 })
  ).stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// canonical form: sorted keys, so key order cannot matter
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function trial(label, mode, max, ops, seedBase) {
  let seed = seedBase;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lobby = new Lobby({ mode, max });
  const live = [];
  const lines = [`mode ${mode} ${max}`];
  const expected = [];
  let n = 0;
  for (let i = 0; i < ops; i++) {
    // join twice as often as leave while below the cap, then churn around it
    if (!live.length || rnd() < 0.55) {
      // sometimes try a duplicate sid (must be refused) or overfill
      const dup = live.length && rnd() < 0.05;
      const sid = dup ? live[Math.floor(rnd() * live.length)] : `s${n++}`;
      const name = `N${n}x`;
      lines.push(`join ${sid} ${name}`);
      const ok = lobby.join(sid, name);
      if (ok && !dup) live.push(sid);
      expected.push({ ok, snap: lobby.snapshot() });
    } else {
      const k = Math.floor(rnd() * live.length);
      const sid = rnd() < 0.05 ? "ghost" : live[k];
      lines.push(`leave ${sid}`);
      const ok = lobby.leave(sid);
      if (ok) live.splice(live.indexOf(sid), 1);
      expected.push({ ok, snap: lobby.snapshot() });
    }
  }
  const got = runCpp(lines.join("\n") + "\n").slice(1); // the first answer is for the mode line
  let bad = "";
  if (got.length !== expected.length) bad = `C++ answered ${got.length} of ${expected.length} operations`;
  for (let i = 0; i < expected.length && !bad; i++) {
    if (got[i].ok !== expected[i].ok) bad = `op ${i} (${lines[i + 1]}): accepted=${got[i].ok}, JS says ${expected[i].ok}`;
    else if (canon(got[i].snap) !== canon(expected[i].snap)) bad = `op ${i} (${lines[i + 1]}): lobbies differ\n   C++: ${canon(got[i].snap)}\n   JS : ${canon(expected[i].snap)}`;
  }
  check(`${label}: ${ops} random joins/leaves seat identically after every operation`, !bad, bad);
}

trial("imposter (pairs, max 12)", "pairs", 12, 4000, 4242);
trial("imposter (pairs, max 12), another seed", "pairs", 12, 4000, 99);
trial("teams (balanced, max 24)", "balanced", 24, 4000, 777);
trial("teams (balanced, max 24), another seed", "balanced", 24, 4000, 31337);
trial("a small teams lobby (balanced, max 8)", "balanced", 8, 2000, 5);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
