// safewords.ts - stream-safety name filter (port of stream-host/agent/
// safewords.mjs). Every token of an incoming name must be a known safe word;
// anything else is replaced with a random safe word of about the same length
// (case shape preserved). The dictionary is generated from
// stream-host/data/safewords.txt (tools/sync-safewords.mjs), so both workers
// agree on it.
import { WORDS } from "./safewords-list";

const WORD_SET = new Set(WORDS);
const byLength = new Map<number, string[]>();
for (const w of WORDS) {
  const list = byLength.get(w.length) ?? [];
  list.push(w);
  byLength.set(w.length, list);
}
const MIN = Math.min(...WORDS.map((w) => w.length));
// replace with a word of the same length where there is a real choice; for
// lengths with only a couple of words (very long tokens) step down to the next
// length that has a pool, so one long token does not always become one word
const MIN_POOL = 5;

function poolFor(len: number): string[] {
  for (let l = Math.max(MIN, Math.min(15, len)); l >= MIN; l--) {
    const list = byLength.get(l);
    if (list && list.length >= MIN_POOL) return list;
  }
  return WORDS;
}

function replaceToken(token: string): string {
  const lower = token.toLowerCase();
  if (WORD_SET.has(lower)) return token;
  const list = poolFor(token.length);
  const word = list[Math.floor(Math.random() * list.length)];
  if (token === token.toUpperCase() && token.length > 1) return word.toUpperCase();
  if (/^[A-Z]/.test(token)) return word[0].toUpperCase() + word.slice(1);
  return word;
}

// Filter a display name for the stream: split into alnum tokens, pass
// through known safe words, replace everything else. Numbers and
// punctuation pass through unchanged.
export function filterName(name: string): string {
  const out = String(name).replace(/[A-Za-z]+/g, (m) => replaceToken(m));
  return out.trim().slice(0, 40);
}
