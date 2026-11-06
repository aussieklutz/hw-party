// safewords.mjs — stream-safety name filter. Every token of an incoming
// name must be a known safe word; anything else is replaced with a random
// safe word of about the same length (case shape preserved). Dictionary:
// ../data/safewords.txt, one lowercase word per line.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dictPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "safewords.txt");
const WORDS = readFileSync(dictPath, "utf8")
  .split("\n").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
const byLength = new Map();
for (const w of WORDS) {
  const list = byLength.get(w.length) ?? [];
  list.push(w);
  byLength.set(w.length, list);
}
const MIN = Math.min(...WORDS.map((w) => w.length));
const WORD_SET = new Set(WORDS);
// replace with a word of the same length where there is a real choice; for
// lengths with only a couple of words (very long tokens) step down to the next
// length that has a pool, so one long token does not always become one word
const MIN_POOL = 5;

function poolFor(len) {
  for (let l = Math.max(MIN, Math.min(15, len)); l >= MIN; l--) {
    const list = byLength.get(l);
    if (list && list.length >= MIN_POOL) return list;
  }
  return WORDS;
}

function replaceToken(token) {
  const lower = token.toLowerCase();
  if (WORD_SET.has(lower)) return token;
  const list = poolFor(token.length);
  const word = list[Math.floor(Math.random() * list.length)];
  // preserve the original case shape
  if (token === token.toUpperCase() && token.length > 1) return word.toUpperCase();
  if (/^[A-Z]/.test(token)) return word[0].toUpperCase() + word.slice(1);
  return word;
}

// Filter a display name for the stream: split into alnum tokens, pass
// through known safe words, replace everything else. Numbers and
// punctuation pass through unchanged.
export function filterName(name) {
  const out = String(name).replace(/[A-Za-z]+/g, (m) => replaceToken(m));
  return out.trim().slice(0, 40);
}
