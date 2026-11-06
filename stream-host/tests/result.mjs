// result.mjs - who counts as a winner (worker/src/result.ts), no network.
//   node tests/result.mjs
import { resolveResult } from "../worker/src/result.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};
const sorted = (xs) => [...xs].sort().join(",");
const players = [
  { name: "R1", team: "Red" }, { name: "R2", team: "Red" }, { name: "R3", team: "Red" },
  { name: "B1", team: "Blue" }, { name: "B2", team: "Blue" }, { name: "B3", team: "Blue" },
];

let r = resolveResult({ winner: "Blue", players, imposters: [{ name: "R2", team: "Red", defected: true }, { name: "B3", team: "Blue", defected: false }] });
check("the Red traitor who defected wins with Blue; Blue's own traitor wins as a Blue player", sorted(r.winners) === "B1,B2,B3,R2", sorted(r.winners));

r = resolveResult({ winner: "Blue", players, imposters: [{ name: "R2", team: "Red", defected: false }, { name: "B3", team: "Blue", defected: false }] });
check("traitors who never defected win or lose with their own team", sorted(r.winners) === "B1,B2,B3", sorted(r.winners));

r = resolveResult({ winner: "Red", players, imposters: [{ name: "R2", team: "Red", defected: false }, { name: "B1", team: "Blue", defected: true }] });
check("the Blue traitor can defect to a Red win just the same", sorted(r.winners) === "B1,R1,R2,R3", sorted(r.winners));

r = resolveResult({ winner: "Blue", players, imposter: { name: "R2", team: "Red", defected: true } });
check("a report from an older host (single imposter) still resolves", sorted(r.winners) === "B1,B2,B3,R2", sorted(r.winners));

r = resolveResult({ winner: "", players, imposters: [{ name: "R2", team: "Red", defected: true }] });
check("no winner, nobody is credited (a defector does not win a draw)", r.winners.length === 0, sorted(r.winners));

r = resolveResult({ winner: "Blue", players, imposters: [] });
check("seat entrants carry no kills (team kills are not attributable)", Object.values(r.kills).every((k) => k === 0) && Object.keys(r.kills).length === 6);

r = resolveResult({ winner: "Hedge", kills: { Hedge: 3, Other: 1 } });
check("plain modes keep per-team kills and the single winner", r.winners.join() === "Hedge" && r.kills.Hedge === 3);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
