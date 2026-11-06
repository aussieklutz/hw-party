// Turns the host agent's end-of-game report into ladder entrants and winners.
//
// Plain modes report per-team kills where each team IS one player, and a
// single winning team name. Seat modes (teams/imposter) also report who sat
// where (`players`) so the ladder can rate people rather than "Red"/"Blue".
// In imposter mode every team has one secret traitor. A traitor the engine
// swapped onto the surviving team (`defected`: they were their old team's last
// hog) wins along with the players of the winning team; a traitor who never
// defected simply wins or loses with their own team.

export interface GameReport {
  lines?: string[];
  winner?: string;
  kills?: Record<string, number>;
  players?: { name: string; team: string }[];
  imposters?: { name: string; team: string; defected?: boolean }[];
  imposter?: { name: string; team: string; defected?: boolean }; // older hosts: a single traitor
}

export interface ResolvedResult {
  kills: Record<string, number>;
  winners: string[];
}

export function resolveResult(r: GameReport): ResolvedResult {
  if (!Array.isArray(r.players) || r.players.length === 0) {
    return { kills: r.kills ?? {}, winners: r.winner ? [r.winner] : [] };
  }
  const winners = new Set<string>();
  for (const p of r.players) if (r.winner && p.team === r.winner) winners.add(p.name);
  const traitors = r.imposters ?? (r.imposter ? [r.imposter] : []);
  for (const t of traitors) if (r.winner && t.defected) winners.add(t.name);
  // team kills are not attributable to one seat, so seat entrants carry none
  const kills: Record<string, number> = {};
  for (const p of r.players) kills[p.name] = 0;
  return { kills, winners: [...winners] };
}
