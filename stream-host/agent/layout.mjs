// layout.mjs - who sits where in a seat-mode lobby. Pure and stateful, no I/O:
// the host agent feeds it joins and leaves and renders whatever it says.
//
// Two policies:
//
//   "pairs"     (imposter) two teams, Red and Blue. Everyone who arrives is IN
//               the lobby at once, but is only SEATED two at a time (one per
//               team) so the sides are always exactly even. The odd player out
//               waits, unseated, for a partner. When a seated player leaves,
//               the most recently seated player on the OTHER team is unseated
//               to keep it even; unseated players are re-seated as pairs,
//               longest-waiting first.
//
//   "balanced"  (party-style teams) everyone is seated. Two teams up to 12
//               players, three up to 18, four up to 24 (Red, Blue, Yellow,
//               Green), always within one player of even. Growing or
//               shrinking the team count rebalances with as few moves as
//               possible.
//
// A team plays with at least MIN_HOGS hogs (the unfilled ones are CPU) and
// grows one hog per extra player.
export const MIN_HOGS = 3;
export const TEAM_DEFS = [
  { name: "Red", color: 0xff0000 },
  { name: "Blue", color: 0x0000ff },
  { name: "Yellow", color: 0xffff00 },
  { name: "Green", color: 0x00ff00 },
];

// balanced: how many teams for n players
export function teamCountFor(n) {
  return n <= 12 ? 2 : n <= 18 ? 3 : 4;
}

export class Lobby {
  // mode: "pairs" | "balanced"; max: most players the lobby holds
  constructor({ mode, max }) {
    this.mode = mode;
    this.max = max;
    this.seq = 0; // arrival counter
    this.teamsList = TEAM_DEFS.slice(0, 2).map((d) => ({ ...d, members: [] }));
    this.waitingList = [];
  }

  get joined() {
    return this.teamsList.reduce((n, t) => n + t.members.length, 0) + this.waitingList.length;
  }
  get seated() {
    return this.joined - this.waitingList.length;
  }
  get teams() {
    return this.teamsList;
  }
  get waiting() {
    return this.waitingList;
  }
  has(sid) {
    return !!this.find(sid);
  }
  find(sid) {
    for (const t of this.teamsList) {
      const m = t.members.find((x) => x.sid === sid);
      if (m) return { team: t, member: m };
    }
    const w = this.waitingList.find((x) => x.sid === sid);
    return w ? { team: null, member: w } : null;
  }

  // the hogs a team fields: at least MIN_HOGS, one per extra player
  hogCount(team) {
    return Math.max(MIN_HOGS, team.members.length);
  }

  join(sid, name) {
    if (this.has(sid) || this.joined >= this.max) return false;
    const p = { sid, name, n: this.seq++ };
    this.waitingList.push(p);
    this.settle();
    return true;
  }

  leave(sid) {
    const at = this.find(sid);
    if (!at) return false;
    if (at.team) at.team.members.splice(at.team.members.indexOf(at.member), 1);
    else this.waitingList.splice(this.waitingList.indexOf(at.member), 1);
    this.settle();
    return true;
  }

  // restore the policy's invariants after any change
  settle() {
    if (this.mode === "pairs") this.settlePairs();
    else this.settleBalanced();
  }

  settlePairs() {
    const [red, blue] = this.teamsList;
    // sides must be exactly even: bench the latest-seated player of the bigger
    // side, and put them first in line (remembering where they sat)
    while (red.members.length !== blue.members.length) {
      const big = red.members.length > blue.members.length ? red : blue;
      const out = big.members.pop();
      out.prev = big.name;
      this.waitingList.unshift(out);
    }
    // seat waiting players two at a time, one per team
    while (this.waitingList.length >= 2 && this.seated + 2 <= this.max) {
      const a = this.waitingList.shift();
      const b = this.waitingList.shift();
      const aTeam = a.prev === "Blue" ? blue : red;
      const bTeam = aTeam === red ? blue : red;
      aTeam.members.push(a);
      bTeam.members.push(b);
      a.prev = b.prev = undefined;
    }
  }

  settleBalanced() {
    // everybody is seated; players only ever wait in "pairs" mode
    const T = teamCountFor(this.joined);
    const waiting = this.waitingList.splice(0);
    // grow/shrink the team list; players of removed teams go back in the pool
    while (this.teamsList.length < T) this.teamsList.push({ ...TEAM_DEFS[this.teamsList.length], members: [] });
    const pool = [...waiting];
    while (this.teamsList.length > T) pool.push(...this.teamsList.pop().members);
    pool.sort((x, y) => x.n - y.n);
    const smallest = () => this.teamsList.reduce((s, t) => (t.members.length < s.members.length ? t : s));
    const largest = () => this.teamsList.reduce((l, t) => (t.members.length > l.members.length ? t : l));
    for (const p of pool) smallest().members.push(p);
    // within one player of even: move the latest arrival of the biggest team
    for (;;) {
      const big = largest(), small = smallest();
      if (big.members.length - small.members.length <= 1) break;
      let latest = big.members[0];
      for (const m of big.members) if (m.n > latest.n) latest = m;
      big.members.splice(big.members.indexOf(latest), 1);
      small.members.push(latest);
    }
    for (const t of this.teamsList) t.members.sort((x, y) => x.n - y.n);
  }

  // what the slides draw: per team the seats shown (at least MIN_HOGS rows, one
  // more per extra player), who waits, how many are in
  snapshot() {
    return {
      teams: this.teamsList.map((t) => ({
        name: t.name,
        color: t.color,
        seats: Array.from({ length: this.hogCount(t) }, (_, i) => (t.members[i] ? { name: t.members[i].name } : null)),
      })),
      waiting: this.waitingList.map((w) => ({ name: w.name })),
      joined: this.joined,
      capacity: this.max,
    };
  }
}
