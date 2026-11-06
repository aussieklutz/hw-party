// layout.mjs - the lobby seating rules (agent/layout.mjs), no network.
//   node tests/layout.mjs
import { Lobby, teamCountFor, MIN_HOGS } from "../agent/layout.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};
const names = (m) => m.map((x) => x.name).join(",");
const show = (l) => `${l.teams.map((t) => `${t.name}[${names(t.members)}]`).join(" ")} wait[${names(l.waiting)}]`;
const fill = (l, n, from = 1) => { for (let i = 0; i < n; i++) l.join(`s${from + i}`, `P${from + i}`); };

console.log("-- pairs (imposter): everyone joins, seating is two at a time");
{
  const l = new Lobby({ mode: "pairs", max: 12 });
  l.join("s1", "P1");
  check("a lone arrival is in the lobby but unseated", l.joined === 1 && l.seated === 0 && l.waiting.length === 1, show(l));
  l.join("s2", "P2");
  check("the second arrival seats both, one per team", l.seated === 2 && names(l.teams[0].members) === "P1" && names(l.teams[1].members) === "P2", show(l));
  fill(l, 3, 3);
  check("5 joined: 4 seated (2v2), one waiting", l.joined === 5 && l.seated === 4 && l.waiting.length === 1, show(l));
  fill(l, 7, 6);
  check("fills to 12: 6v6, nobody waiting", l.joined === 12 && l.teams[0].members.length === 6 && l.teams[1].members.length === 6 && !l.waiting.length, show(l));
  check("a 13th player is refused", l.join("s13", "P13") === false && l.joined === 12);
}
{
  // 6 joined (3v3): P1,P3,P5 Red / P2,P4,P6 Blue
  const l = new Lobby({ mode: "pairs", max: 12 });
  fill(l, 6);
  l.leave("s3"); // a Red player drops
  check("a seated player drops: the LAST player on the other team is unseated", names(l.teams[0].members) === "P1,P5" && names(l.teams[1].members) === "P2,P4" && names(l.waiting) === "P6", show(l));
  check("teams stay exactly even", l.teams[0].members.length === l.teams[1].members.length);
}
{
  const l = new Lobby({ mode: "pairs", max: 12 });
  fill(l, 7); // 3v3 + P7 waiting
  l.leave("s3"); // Red drops: P6 benched, then P6+P7 are a pair again
  check("with someone already waiting, the benched player and the waiter are seated together", l.seated === 6 && !l.waiting.length && l.teams[0].members.length === 3 && l.teams[1].members.length === 3, show(l));
  check("the benched player returns to the team they were on", names(l.teams[1].members).includes("P6"), show(l));
}
{
  const l = new Lobby({ mode: "pairs", max: 12 });
  fill(l, 5); // 2v2 + P5 waiting
  l.leave("s5");
  check("a waiting player leaving changes nothing else", l.seated === 4 && !l.waiting.length, show(l));
}

console.log("\n-- pairs: invariants under random joins and leaves");
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const l = new Lobby({ mode: "pairs", max: 12 });
  const inLobby = new Set();
  let n = 0, bad = "";
  for (let i = 0; i < 5000 && !bad; i++) {
    if (!inLobby.size || rnd() < 0.55) {
      const sid = `r${n++}`;
      if (l.join(sid, sid)) inLobby.add(sid);
    } else {
      const sid = [...inLobby][Math.floor(rnd() * inLobby.size)];
      l.leave(sid);
      inLobby.delete(sid);
    }
    const [r, b] = l.teams;
    if (r.members.length !== b.members.length) bad = `uneven at step ${i}: ${show(l)}`;
    else if (l.waiting.length > 1) bad = `${l.waiting.length} waiting at step ${i}: ${show(l)}`;
    else if (l.joined !== inLobby.size || l.joined > 12) bad = `count drift at step ${i}`;
    else if (new Set([...r.members, ...b.members, ...l.waiting].map((m) => m.sid)).size !== l.joined) bad = `duplicate at step ${i}`;
  }
  check("5000 random joins/leaves: always even, at most one waiting, no duplicates, never over 12", !bad, bad);
}

console.log("\n-- balanced (party teams): 2 teams to 12, 3 to 18, 4 to 24");
{
  check("team counts", [1, 12, 13, 18, 19, 24].map(teamCountFor).join() === "2,2,3,3,4,4");
  const l = new Lobby({ mode: "balanced", max: 24 });
  fill(l, 12);
  check("12 players: two teams of 6", l.teams.length === 2 && l.teams.every((t) => t.members.length === 6), show(l));
  fill(l, 1, 13);
  check("the 13th rebalances into three teams, within one player of even", l.teams.length === 3 && Math.max(...l.teams.map((t) => t.members.length)) - Math.min(...l.teams.map((t) => t.members.length)) <= 1, show(l));
  check("the third team is Yellow", l.teams[2].name === "Yellow");
  fill(l, 5, 14);
  check("18 players: three teams of 6", l.teams.length === 3 && l.teams.every((t) => t.members.length === 6), show(l));
  fill(l, 1, 19);
  check("the 19th makes four teams, the fourth is Green", l.teams.length === 4 && l.teams[3].name === "Green" && l.teams.every((t) => t.members.length >= 4), show(l));
  fill(l, 5, 20);
  check("24 players: four teams of 6", l.teams.length === 4 && l.teams.every((t) => t.members.length === 6));
  check("a 25th is refused", l.join("s25", "P25") === false);
  l.leave("s24");
  check("dropping to 23 stays at four teams, within one of even", l.teams.length === 4 && l.teams.every((t) => t.members.length >= 5), show(l));
  for (let i = 1; i <= 11; i++) l.leave(`s${i}`);
  check("dropping to 12 folds back to two teams", l.joined === 12 && l.teams.length === 2 && l.teams.every((t) => t.members.length === 6), show(l));
}
{
  const l = new Lobby({ mode: "balanced", max: 24 });
  fill(l, 8);
  const before = l.teams.map((t) => names(t.members));
  fill(l, 1, 9);
  const after = l.teams.map((t) => names(t.members));
  const moved = before.flatMap((b, i) => b.split(",").filter((p) => !after[i].split(",").includes(p)));
  check("adding a player below a threshold moves nobody else", moved.length === 0, `moved=${moved}`);
  const l2 = new Lobby({ mode: "balanced", max: 24 });
  fill(l2, 12);
  const prev = new Map(l2.teams.flatMap((t) => t.members.map((m) => [m.name, t.name])));
  fill(l2, 1, 13);
  const moves = l2.teams.flatMap((t) => t.members.filter((m) => prev.has(m.name) && prev.get(m.name) !== t.name));
  check("crossing 12 to 13 moves only the 3 players the new team needs besides the newcomer", moves.length === 3, `moved ${moves.length}: ${names(moves)}`);
}
{
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const l = new Lobby({ mode: "balanced", max: 24 });
  const inLobby = new Set();
  let n = 0, bad = "";
  for (let i = 0; i < 5000 && !bad; i++) {
    if (!inLobby.size || rnd() < 0.55) { const sid = `b${n++}`; if (l.join(sid, sid)) inLobby.add(sid); }
    else { const sid = [...inLobby][Math.floor(rnd() * inLobby.size)]; l.leave(sid); inLobby.delete(sid); }
    const sizes = l.teams.map((t) => t.members.length);
    if (l.waiting.length) bad = `someone waiting at step ${i}`;
    else if (l.teams.length !== teamCountFor(l.joined)) bad = `wrong team count at step ${i}: ${l.teams.length} for ${l.joined}`;
    else if (Math.max(...sizes) - Math.min(...sizes) > 1) bad = `uneven ${sizes} at step ${i}`;
    else if (Math.max(...sizes) > 6) bad = `team over 6 at step ${i}`;
    else if (l.joined !== inLobby.size) bad = `count drift at step ${i}`;
  }
  check("5000 random joins/leaves: right team count, within one of even, no team over 6", !bad, bad);
}

console.log("\n-- hogs per team and what the slides draw");
{
  const l = new Lobby({ mode: "pairs", max: 12 });
  fill(l, 4);
  let s = l.snapshot();
  check(`a team shows at least ${MIN_HOGS} hogs even with 2 players`, s.teams.every((t) => t.seats.length === MIN_HOGS) && s.teams[0].seats.filter(Boolean).length === 2, JSON.stringify(s.teams.map((t) => t.seats.length)));
  fill(l, 6, 5);
  s = l.snapshot();
  check("with 5 a side the team grows to 5 hogs", s.teams.every((t) => t.seats.length === 5), JSON.stringify(s.teams.map((t) => t.seats.length)));
  l.leave("s1"); l.leave("s2");
  s = l.snapshot();
  check("and shrinks back as players leave (never below 3)", s.teams.every((t) => t.seats.length >= MIN_HOGS && t.seats.length <= 5) && s.joined === 8, JSON.stringify(s.teams.map((t) => t.seats.length)));
  check("snapshot reports who waits", Array.isArray(s.waiting) && s.capacity === 12);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
