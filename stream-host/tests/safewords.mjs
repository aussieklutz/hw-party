// safewords.mjs - the stream name filter and its dictionary.
//   node tests/safewords.mjs
// stream-host/data/safewords.txt is the single source; the signup worker's copy
// (stream-signup/src/safewords-list.ts) is generated from it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterName } from "../agent/safewords.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

const words = readFileSync(join(here, "..", "data", "safewords.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const set = new Set(words);

check("the dictionary is plain lowercase words, no duplicates", words.every((w) => /^[a-z]+$/.test(w)) && set.size === words.length, `${words.length} words`);
const pools = {};
for (const w of words) pools[w.length] = (pools[w.length] ?? 0) + 1;
const thin = Object.entries(pools).filter(([l, n]) => Number(l) >= 4 && Number(l) <= 9 && n < 20);
check("every length from 4 to 9 letters has a pool of at least 20 words", thin.length === 0, JSON.stringify(pools));

// the signup worker's generated copy must match
const sync = spawnSync(process.execPath, [join(here, "..", "..", "stream-signup", "tools", "sync-safewords.mjs"), "--check"], { encoding: "utf8" });
check("the signup worker's copy is in sync (run stream-signup/tools/sync-safewords.mjs if not)", sync.status === 0, (sync.stdout + sync.stderr).trim());

// the filter
const allDictionary = (s) => (s.match(/[A-Za-z]+/g) ?? []).every((t) => set.has(t.toLowerCase()));
const inputs = ["Bobby", "xX_Sniper_Xx", "ab", "a", "SUPERCALIFRAGILISTICEXPIALIDOCIOUS", "Bobby Smith 99", "hello world", "d34th", "Teapot Waffle", "x".repeat(60)];
let stable = true, dict = true;
for (const i of inputs) {
  const once = filterName(i);
  if (!allDictionary(once)) dict = false;
  if (filterName(once) !== once) stable = false;
}
check("every letter token that comes out is a dictionary word", dict);
check("filtering is idempotent (a filtered name is accepted unchanged)", stable);
check("known words and numbers pass through untouched", filterName("Teapot Waffle 99") === "Teapot Waffle 99", filterName("Teapot Waffle 99"));
check("case shape is kept (Title, UPPER, lower)", /^[A-Z][a-z]+$/.test(filterName("Zzzzzz")) && /^[A-Z]+$/.test(filterName("ZZZZZZ")) && /^[a-z]+$/.test(filterName("zzzzzz")));

// variety: the old 5-letter pool had ONE word, so every 5-letter name collided
const seen = new Set();
for (let i = 0; i < 300; i++) seen.add(filterName("Zzzzz"));
check("a 5-letter unknown name has plenty of outcomes (was 1)", seen.size >= 20, `${seen.size} distinct in 300 draws`);
const longSeen = new Set();
for (let i = 0; i < 300; i++) longSeen.add(filterName("Qwertyuiopasdfghjkl"));
check("a very long unknown token does not always become the same word", longSeen.size >= 5, `${longSeen.size} distinct`);
const pairs = new Set();
for (let i = 0; i < 400; i++) pairs.add(filterName("Bobby Smith"));
check("a two-word name rarely collides (was ~1 in 1)", pairs.size >= 200, `${pairs.size} distinct in 400 draws`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
