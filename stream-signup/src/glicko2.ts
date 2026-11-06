// glicko2.ts — Glickman's Glicko-2 rating system (the system behind
// Chess.com and Lichess). Chosen over plain Elo because the spec asks for
// ratings that decay over time (RD grows when idle), get harder to climb as
// a player settles (RD shrinks with games played), and weigh opponent
// strength including their uncertainty.
//
// Reference: Glickman, "Example of the Glicko-2 system", glicko2 example
// document (2009-2012) — the constants and the Illinois algorithm are
// straight from it.

const SCALE = 173.7178; // (400 / (2 * ln(10))) * ln(10) — glicko-2 scale factor
const TAU = 0.3; // volatility constraint (Glickman's suggested default)
const DEFAULT_R = 1500;
const DEFAULT_RD = 350;
const RD_CAP = 350; // rd ceiling: a player idle forever never exceeds the base deviation

export interface Rating {
  rating: number; // Glicko scale (1500 base)
  rd: number; // rating deviation, Glicko scale (350 base)
  volatility: number; // sigma, Glicko-2 scale
}

export interface Opponent {
  rating: number;
  rd: number;
  score: number; // 1 win / 0.5 draw / 0 loss
}

const toMu = (r: number) => (r - DEFAULT_R) / SCALE;
const toPhi = (rd: number) => rd / SCALE;
const toR = (mu: number) => mu * SCALE + DEFAULT_R;
const toRD = (phi: number) => phi * SCALE;

// g(φ) in Glickman's notation
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

// E(μ, μj, φj): expected score against one opponent
function expectScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

// The Illinois algorithm: solve f(x) = 0 for σ' (Glickman's step 5)
function illinois(a: number, deltaSq: number, phiSq: number, v: number): number {
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (deltaSq - phiSq - v - ex);
    const den = (phiSq + v + ex) * (phiSq + v + ex);
    return a - num / den - x / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (Math.pow(deltaSq, 2) > phiSq + v) {
    B = Math.log(deltaSq / (phiSq + v));
  } else {
    let k = 1;
    for (; f(a - k * TAU) < 0 && k < 20; k++);
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > 1e-6) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fC;
    }
    B = C;
    fB = f(C);
  }
  return Math.exp(A / 2);
}

// Rate one player against this period's opponents. `periods` is the number
// of idle rating periods since the player's last game (RD grows toward the
// cap the more you sit out).
export function rate(player: Rating, opponents: Opponent[], periods = 1): Rating {
  const mu = toMu(player.rating);
  const sigma = player.volatility;
  const phi = toPhi(Math.min(player.rd, RD_CAP));

  // Glickman step 1 (pre-rating), applied once per idle rating period:
  // phi grows by sqrt(phi^2 + sigma^2) each period, capped at RD_CAP.
  let phiStar = phi;
  for (let i = 0; i < periods; i++) {
    phiStar = Math.sqrt(phiStar * phiStar + sigma * sigma);
    if (phiStar * SCALE >= RD_CAP) {
      phiStar = RD_CAP / SCALE;
      break;
    }
  }

  if (opponents.length === 0) {
    // idle period: RD only grows toward the cap
    return {
      rating: player.rating,
      rd: Math.min(Math.round(phiStar * SCALE * 100) / 100, RD_CAP),
      volatility: sigma,
    };
  }

  let v = 0;
  let deltaSum = 0;
  for (const o of opponents) {
    const phiJ = toPhi(Math.min(o.rd, RD_CAP));
    const E = expectScore(mu, toMu(o.rating), phiJ);
    v += g(phiJ) * g(phiJ) * E * (1 - E);
    deltaSum += g(phiJ) * (o.score - E);
  }
  v = 1 / v;
  const delta = v * deltaSum;

  const newSigma = illinois(
    Math.log(sigma * sigma),
    delta * delta,
    phiStar * phiStar,
    v,
  );
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: Math.round(toR(muPrime) * 100) / 100,
    rd: Math.min(Math.round(toRD(phiPrime) * 100) / 100, RD_CAP),
    volatility: newSigma,
  };
}

export const defaults = (): Rating => ({
  rating: DEFAULT_R,
  rd: DEFAULT_RD,
  volatility: 0.06,
});

// Idle periods between two timestamps at a configurable period length
// (weeks). Ratings decay by growing RD, one period per idle week.
export function idlePeriods(lastPlayed: number, now: number, periodMs = 7 * 24 * 3600 * 1000): number {
  if (!lastPlayed || now <= lastPlayed) return 0;
  return Math.max(0, Math.floor((now - lastPlayed) / periodMs));
}
