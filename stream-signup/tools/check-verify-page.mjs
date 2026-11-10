// check-verify-page.mjs - the /verify page's inline script must be valid JavaScript.
//
// The page is a TypeScript template literal, where a backslash-quote loses its backslash. One such
// escape once turned a message into a syntax error: none of the page's script ran, the browser then
// submitted the form natively to /verify?name=... without the token, and the player saw "Link expired".
//
//   wrangler dev --port 8795   (DEV_MODE=1, local database: wrangler d1 execute hwstream-signup --local --file schema.sql)
//   node tools/check-verify-page.mjs
// env: BASE (default http://127.0.0.1:8795)
const BASE = process.env.BASE ?? "http://127.0.0.1:8795";
const res = await fetch(`${BASE}/api/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `check${Date.now()}@example.com` }),
});
const { link } = await res.json();
if (!link) { console.error("FAIL  no dev link: run the worker with DEV_MODE=1"); process.exit(2); }
const html = await (await fetch(link)).text();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) { console.error("FAIL  the verify page has no script"); process.exit(1); }
let bad = 0;
for (const [i, s] of scripts.entries()) {
  try { new Function(s); console.log(`PASS  verify page script ${i + 1} parses`); }
  catch (e) { bad++; console.error(`FAIL  verify page script ${i + 1}: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
