// devcheck.ts — verify glicko2.ts against Glickman's published worked example
// ("Example of the Glicko-2 system", section 8): rating 1500, rd 200,
// volatility 0.06, one rating period, opponents 1400/30 (win), 1550/100
// (loss), 1700/300 (loss) → new rating 1464.06, rd 151.52, volatility 0.05999.
import { rate, defaults, idlePeriods } from "./glicko2.ts";

let fails = 0;
function eq(label: string, got: unknown, want: unknown, tol = 0.02): boolean {
  const ok =
    typeof want === "number" && typeof got === "number"
      ? Math.abs(got - want) <= tol
      : got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok" : "FAIL"} ${label}: got ${got}${typeof want === "number" ? ` (want ${want} ±${tol})` : ` (want ${want})`}`);
  return ok;
}

// --- Glickman's example ---
const r = rate(
  { rating: 1500, rd: 200, volatility: 0.06 },
  [
    { rating: 1400, rd: 30, score: 1 },
    { rating: 1550, rd: 100, score: 0 },
    { rating: 1700, rd: 300, score: 0 },
  ],
);
console.log("Glickman example:", JSON.stringify(r));
eq("rating", r.rating, 1464.06);
eq("rd", r.rd, 151.52);
eq("volatility", r.volatility, 0.05999, 0.001);

// --- idle growth: RD climbs one period at a time, never past 350 ---
let p = { rating: 1500, rd: 200, volatility: 0.06 };
const r1 = rate(p, []);
const r2 = rate(r1, []);
eq("idle rd #1", r1.rd, Math.min(Math.round(Math.sqrt((200 / 173.7178) ** 2 + 0.06 ** 2) * 173.7178 * 100) / 100, 350));
eq("idle rd #2 grows", r2.rd > r1.rd, true);
eq("idle rating frozen", r2.rating, 1500);
let idle = p;
for (let i = 0; i < 1000; i++) idle = rate(idle, []);
eq("idle rd capped at 350", idle.rd, 350);

// --- multiple idle periods in one call equals repeated single calls ---
const multi = rate(p, [], 3);
let chain = p;
for (let i = 0; i < 3; i++) chain = rate(chain, []);
eq("batch idle == chained idle", multi.rd, chain.rd, 0.01);

// --- defaults + idlePeriods ---
eq("defaults", JSON.stringify(defaults()), JSON.stringify({ rating: 1500, rd: 350, volatility: 0.06 }));
const now = Date.now();
eq("idlePeriods none", idlePeriods(now, now), 0);
eq("idlePeriods 2w", idlePeriods(now - 14 * 24 * 3600e3, now), 2);
eq("idlePeriods future", idlePeriods(now + 1e9, now), 0);

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
