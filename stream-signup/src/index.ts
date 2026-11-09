// stream-signup — M11.4: the dedicated signup worker. Players sign up with
// an email, receive a magic link, and claim a screen name (unique across
// emails; team name = screen name; safeword-filtered at claim time). The
// Glicko-2 ladder lives here in D1; the stream host posts game results with
// service auth, and the stream slides pull the top-20 for the inter-game
// slate.
import { rate, idlePeriods, defaults, type Rating, type Opponent } from "./glicko2";
import { filterName } from "./safewords";
import { signIdToken } from "./idp";
import {
  signSession,
  verifySession,
  getSession,
  makeSessionCookie,
  SESSION_TTL_SECONDS,
  type SessionClaims,
} from "./auth";

export interface Env {
  DB: D1Database;
  SIGNUP_SECRET: string;
  SESSION_SECRET: string;
  // IdP: the ES256 private key (JWK, secret) that signs identity tokens, and
  // the public origin of the stream site the player is sent back to. The
  // redirect target comes only from here, never from the request.
  IDP_PRIVATE_JWK?: string;
  STREAM_URL?: string;
  DEV_MODE?: string;
  MAIL_FROM?: string;
  SEND_EMAIL?: { send(message: { from: string; to: string; subject: string; text: string }): Promise<void> };
}

interface PlayerRow {
  email: string;
  name: string;
  rating: number;
  rd: number;
  volatility: number;
  games: number;
  wins: number;
  kills: number;
  last_played: number;
}

const PAGE = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { background:#0d0b1e; color:#f2ead8; font-family:"Segoe UI",system-ui,sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:rgba(23,19,53,.9); border:1px solid rgba(120,110,190,.5); border-radius:14px;
          padding:2rem 2.4rem; max-width:26rem; width:90vw; }
  h1 { font-size:1.5rem; color:#ffcc00; margin:0 0 .4rem; }
  p, label { color:#b7aed6; }
  input { font:inherit; padding:.6rem .8rem; border-radius:8px; border:1px solid rgba(120,110,190,.6);
          background:#181335; color:#f2ead8; width:100%; margin:.4rem 0; box-sizing:border-box; }
  button { font:inherit; padding:.7rem 1.2rem; border:0; border-radius:8px; background:#ffcc00;
           color:#1a1533; font-weight:700; cursor:pointer; margin-top:.5rem; }
  .err { color:#ff7a7a; }
  .ok { color:#7ec6ff; }
</style></head><body><div class="card">${body}</div></body></html>`;

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };

async function playerByEmail(db: D1Database, email: string): Promise<PlayerRow | null> {
  const row = await db.prepare("SELECT * FROM players WHERE email = ?1").bind(email).first<PlayerRow>();
  return row ?? null;
}

// names are unique ignoring case ("Teapot" and "teapot" are the same screen name)
async function playerByName(db: D1Database, name: string): Promise<PlayerRow | null> {
  const row = await db.prepare("SELECT * FROM players WHERE lower(name) = lower(?1)").bind(name).first<PlayerRow>();
  return row ?? null;
}

const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const NAME_MAX = 40;

// What the entry screen turns a typed name into before the safeword filter:
// ASCII letters/digits and a little punctuation only (anything else - other
// scripts, zero-width or direction-control characters, look-alike letters -
// would sail past a letters-only dictionary filter), whitespace collapsed.
function cleanName(raw: string): string {
  return String(raw).normalize("NFKC").replace(/[^A-Za-z0-9 .'_-]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

// The version of `typed` the stream may show, or null if it is fine as typed.
// A variation is only ever PROPOSED (the entry screen shows it and the player
// confirms or edits): it is stable (re-filtering it changes nothing, so
// confirming it never loops) and free (nobody else holds it).
async function proposeName(
  db: D1Database,
  typed: string,
  email: string,
): Promise<{ ok: true; name: string } | { ok: false; reason: "empty" | "taken" } | { ok: false; reason: "variation"; suggest: string }> {
  const wanted = String(typed).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  const base = cleanName(typed);
  if (!base) return { ok: false, reason: "empty" };
  const holder = async (n: string) => {
    const t = await playerByName(db, n);
    return t && t.email !== email ? t : null;
  };
  for (let i = 0; i < 10; i++) {
    const candidate = filterName(base);
    if (filterName(candidate) !== candidate) continue; // truncation made it unstable: re-roll
    if (/^anon/i.test(candidate)) continue; // AnonAlpha, AnonBeta... are the stream's no-account names
    if (await holder(candidate)) {
      // the substitution only differs by luck: roll again unless it is exactly what was typed
      if (candidate === wanted) return { ok: false, reason: "taken" };
      continue;
    }
    return candidate === wanted ? { ok: true, name: candidate } : { ok: false, reason: "variation", suggest: candidate };
  }
  return { ok: false, reason: "taken" };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const devMode = env.DEV_MODE === "1";

    // ------------------------------------------------ public signup page --
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(PAGE("hw · sign up", `
        <h1>Join the ladder</h1>
        <p>Enter your email — we send a magic link that proves it's you, then
           you pick a screen name. Screen names are unique and appear on the
           stream.</p>
        <form onsubmit="return signup(event)">
          <input id="email" type="email" placeholder="you@example.com" required>
          <button type="submit">Send magic link</button>
        </form>
        <p id="out"></p>
        <script>
          async function signup(ev) {
            ev.preventDefault();
            const out = document.getElementById("out");
            try {
              const r = await fetch("/api/signup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: document.getElementById("email").value }),
              });
              const d = await r.json();
              out.textContent = d.link ? "Magic link (dev mode): " + d.link : "Check your inbox for the magic link.";
              out.className = d.link ? "ok" : "";
            } catch { out.textContent = "Something went wrong."; out.className = "err"; }
            return false;
          }
        </script>`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ------------------------------------------------------- api: signup --
    if (url.pathname === "/api/signup" && req.method === "POST") {
      const { email } = await req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "bad email" }, 400);
      }
      const now = Date.now();
      await env.DB.prepare("DELETE FROM tokens WHERE expires < ?1").bind(now).run();
      // one link per address per minute (a token's expiry is created+24h): the
      // form cannot be used to mail-bomb an address. The reply is identical
      // either way so it does not reveal anything.
      const recent = await env.DB.prepare("SELECT 1 AS n FROM tokens WHERE email = ?1 AND expires > ?2 LIMIT 1")
        .bind(email.toLowerCase(), now + 24 * 3600e3 - 60e3).first();
      if (recent) return json({ ok: true, note: "a link was sent a moment ago - check your inbox" });
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await env.DB.prepare(
        "INSERT INTO tokens (token, email, purpose, expires) VALUES (?1, ?2, 'signup', ?3)",
      ).bind(token, email.toLowerCase(), now + 24 * 3600e3).run();
      const link = `${url.origin}/verify?token=${token}`;
      if (env.SEND_EMAIL) {
        try {
          await env.SEND_EMAIL.send({
            from: env.MAIL_FROM ?? "hw-signup@example.com",
            to: email,
            subject: "Your Hedgewars stream sign-in link",
            text: `Sign in and pick your screen name: ${link}\nThis link expires in 24 hours.`,
          });
        } catch {
          // free-tier email only reaches verified destinations; fall through
          // to the dev-link response so the flow still works
          if (!devMode) return json({ ok: true, note: "email queued" });
        }
      }
      return json(devMode ? { ok: true, link, note: "dev mode: link not emailed" } : { ok: true });
    }

    // ------------------------------------------------------- verify page --
    if (url.pathname === "/verify" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      const row = await env.DB.prepare("SELECT * FROM tokens WHERE token = ?1 AND expires > ?2")
        .bind(token, Date.now()).first<{ token: string; email: string }>();
      if (!row) {
        return new Response(PAGE("hw · link expired", `
          <h1>Link expired</h1>
          <p class="err">That sign-in link is invalid or has expired. Start again at the signup page.</p>`),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const existing = await playerByEmail(env.DB, row.email);
      return new Response(PAGE("hw · claim your name", `
        <h1>Claim your screen name</h1>
        <p>Signing in as <span class="ok">${esc(row.email)}</span></p>
        <form id="f" data-stream="${esc(env.STREAM_URL ?? "")}">
          <input id="name" value="${existing ? esc(existing.name) : ""}" placeholder="Screen name" required
                 maxlength="40" autocomplete="off">
          <button type="submit">${existing ? "Rename" : "Claim name"}</button>
        </form>
        <p id="out"></p>
        <script>
          const tok = new URLSearchParams(location.search).get("token");
          document.getElementById("f").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const out = document.getElementById("out");
            try {
              const r = await fetch("/api/claim", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: tok, name: document.getElementById("name").value }),
              });
              const d = await r.json();
              if (d.suggest) {
                // the stream cannot show that name as typed: cycle back to
                // the entry box with the adjusted version in it, unclaimed
                const box = document.getElementById("name");
                box.value = d.suggest;
                // single quotes: this script sits in a template literal, where a backslash-quote would lose its backslash
                out.textContent = 'That name has to change for the stream. We suggest "' + d.suggest + '" - edit it, or press the button to take it.';
                out.className = "ok";
                box.focus(); box.select();
                return;
              }
              if (!r.ok) { out.textContent = d.error ?? "Claim failed."; out.className = "err"; return; }
              out.textContent = "Welcome, " + d.name + "! You can close this page and play.";
              out.className = "ok";
              const stream = document.getElementById("f").dataset.stream;
              if (d.idToken && stream) {
                // hand the signed identity to the stream site in the URL
                // fragment (never sent to a server or logged)
                out.textContent = "Welcome, " + d.name + "! Taking you back to the stream...";
                location.href = (stream.endsWith("/") ? stream.slice(0, -1) : stream) + "/auth#token=" + encodeURIComponent(d.idToken);
              }
            } catch { out.textContent = "Something went wrong."; out.className = "err"; }
          });
        </script>`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --------------------------------------------------------- api: claim --
    if (url.pathname === "/api/claim" && req.method === "POST") {
      const { token, name } = await req.json<{ token?: string; name?: string }>().catch(
        () => ({}) as { token?: string; name?: string },
      );
      if (!token || !name) return json({ error: "missing token or name" }, 400);
      const row = await env.DB.prepare("SELECT * FROM tokens WHERE token = ?1 AND expires > ?2")
        .bind(token, Date.now()).first<{ token: string; email: string }>();
      if (!row) return json({ error: "invalid or expired link" }, 403);
      // the screen name is what the stream displays. A name that needs the
      // safeword filter (or character clean-up) is NOT claimed behind the
      // player's back: the entry screen gets the adjusted version back to show
      // and confirm/edit.
      const verdict = await proposeName(env.DB, String(name), row.email);
      if (!verdict.ok) {
        if (verdict.reason === "empty") return json({ error: "enter a screen name (letters, numbers, spaces)" }, 400);
        if (verdict.reason === "variation") {
          return json({
            error: "that name has to change for the stream - here is the adjusted version",
            suggest: verdict.suggest,
          }, 422);
        }
        return json({ error: "that name is already taken - pick another name" }, 409);
      }
      const safe = verdict.name;
      const existing = await playerByEmail(env.DB, row.email);
      if (existing && existing.name === safe) {
        // same name re-claimed: just issue a session
        await env.DB.prepare("DELETE FROM tokens WHERE token = ?1").bind(token).run();
        return await issueSession(env, req, existing.email, existing.name);
      }
      const takenMsg = { error: `"${safe}" is already taken - pick another name` };
      try {
        if (existing) {
          await env.DB.prepare("UPDATE players SET name = ?2 WHERE email = ?1")
            .bind(existing.email, safe).run();
        } else {
          const d = defaults();
          await env.DB.prepare(
            "INSERT INTO players (email, name, rating, rd, volatility, games, wins, kills, last_played) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, 0)",
          ).bind(row.email, safe, d.rating, d.rd, d.volatility).run();
        }
      } catch {
        // the unique index decides races between two simultaneous claims
        return json(takenMsg, 409);
      }
      await env.DB.prepare("DELETE FROM tokens WHERE token = ?1").bind(token).run();
      return await issueSession(env, req, row.email, safe);
    }

    // ------------------------------------------------- IdP: authorize --
    // "Sign in with my account": a player who already holds a signup session
    // gets a fresh identity token without another email round trip; anyone
    // else is sent to the magic-link form.
    if (url.pathname === "/authorize" && req.method === "GET") {
      const stream = (env.STREAM_URL ?? "").replace(/\/$/, "");
      const claims = await getSession(req, env.SESSION_SECRET);
      const p = claims ? await playerByEmail(env.DB, claims.email) : null;
      if (!stream || !env.IDP_PRIVATE_JWK || !p) return Response.redirect(`${url.origin}/`, 302);
      const idToken = await signIdToken(env.IDP_PRIVATE_JWK, p.email, p.name);
      return new Response(null, {
        status: 302,
        headers: { Location: `${stream}/auth#token=${encodeURIComponent(idToken)}`, "Cache-Control": "no-store" },
      });
    }

    // ------------------------------------------------------------ api: top --
    if (url.pathname === "/api/top" && req.method === "GET") {
      const res = await env.DB.prepare(
        "SELECT name, rating, rd, games, wins, kills FROM players ORDER BY rating DESC LIMIT 20",
      ).all<{ name: string; rating: number; rd: number; games: number; wins: number; kills: number }>();
      return json(
        {
          top: res.results.map((r, i) => ({ rank: i + 1, ...r, rd: Math.round(r.rd) })),
        },
        200,
        CORS,
      );
    }

    // ------------------------------------------------------ api: results --
    if (url.pathname === "/api/result" && req.method === "POST") {
      if (!env.SIGNUP_SECRET || req.headers.get("x-signup-secret") !== env.SIGNUP_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const { games } = await req.json<{
        games?: { teams: { name: string; kills: number; won?: boolean }[] }[];
      }>().catch(() => ({}) as { games?: undefined });
      if (!Array.isArray(games)) return json({ error: "bad body" }, 400);
      const now = Date.now();
      let rated = 0;
      for (const game of games) {
        const entries = (game.teams ?? []).filter((t) => t && typeof t.name === "string");
        // resolve which of the entrants are rated players (CPU fillers are
        // unknown names and are ignored - humans only rate against humans).
        // Names match ignoring case; keyed by player so two spellings of one
        // name are one entrant.
        const known = new Map<string, { p: PlayerRow; mine: { name: string; kills: number; won?: boolean } }>();
        for (const t of entries) {
          const p = await playerByName(env.DB, t.name);
          if (p && !known.has(p.email)) known.set(p.email, { p, mine: t });
        }
        if (known.size < 2) {
          // stats-only game: count games/kills for the known players
          for (const { p, mine } of known.values()) {
            await env.DB.prepare(
              "UPDATE players SET games = games + 1, kills = kills + ?2 WHERE email = ?1",
            ).bind(p.email, mine.kills ?? 0).run();
          }
          continue;
        }
        for (const { p, mine } of known.values()) {
          const opponents: Opponent[] = [];
          for (const { p: other, mine: otherTeam } of known.values()) {
            if (other.email === p.email) continue;
            opponents.push({
              rating: other.rating,
              rd: other.rd,
              score: mine.won ? (otherTeam.won ? 0.5 : 1) : otherTeam.won ? 0 : 0.5,
            });
          }
          const before: Rating = { rating: p.rating, rd: p.rd, volatility: p.volatility };
          const after = rate(
            before,
            opponents,
            idlePeriods(p.last_played, now),
          );
          await env.DB.prepare(
            "UPDATE players SET rating = ?2, rd = ?3, volatility = ?4, games = games + 1, kills = kills + ?5, wins = wins + ?6, last_played = ?7 WHERE email = ?1",
          ).bind(p.email, after.rating, after.rd, after.volatility, mine.kills ?? 0, mine.won ? 1 : 0, now).run();
          rated++;
        }
      }
      return json({ ok: true, rated });
    }

    // ---------------------------------------------------------- api: me --
    if (url.pathname === "/api/me" && req.method === "GET") {
      const claims = await getSession(req, env.SESSION_SECRET);
      if (!claims) return json({ error: "not signed in" }, 401);
      const p = await playerByEmail(env.DB, claims.email);
      if (!p) return json({ error: "not signed in" }, 401);
      return json({
        email: p.email,
        name: p.name,
        rating: p.rating,
        rd: Math.round(p.rd),
        games: p.games,
        wins: p.wins,
        kills: p.kills,
      });
    }

    return new Response("not found", { status: 404 });
  },
};

async function issueSession(env: Env, req: Request, email: string, name: string): Promise<Response> {
  const claims: SessionClaims = {
    email,
    name,
    sid: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const token = await signSession(claims, env.SESSION_SECRET);
  const cookie = makeSessionCookie(token, new URL(req.url).protocol === "https:");
  const idToken = env.IDP_PRIVATE_JWK ? await signIdToken(env.IDP_PRIVATE_JWK, email, name) : undefined;
  return json(
    { ok: true, name, ...(idToken ? { idToken } : {}) },
    200,
    { "Set-Cookie": cookie, "Cache-Control": "no-store" },
  );
}
