import { RoomDO, PARTY_MODES, type PartyMode } from "./room";
import { QueueDO } from "./queue";
import { resolveResult, type GameReport } from "./result";
import QRCode from "qrcode";
import {
  getAccount,
  makeAccountCookie,
  verifyIdToken,
  getSession,
  makeSessionCookie,
  signSession,
  SESSION_TTL_SECONDS,
  type SessionClaims,
} from "./auth";

export { RoomDO, QueueDO };

export interface Env {
  ROOM: DurableObjectNamespace;
  QUEUE: DurableObjectNamespace;
  PARTY_JWT_SECRET: string;
  STREAM_HOST_SECRET?: string;
  // M11.4 signup worker: game results feed the Glicko-2 ladder there, and
  // /api/top proxies its top-20 for the inter-game slate. Production uses
  // the service binding (same-zone worker fetches are blocked, error 1042);
  // local dev falls back to the SIGNUP_URL fetch.
  SIGNUP?: Fetcher;
  SIGNUP_URL?: string;
  SIGNUP_SECRET?: string;
  // the signup worker is the identity provider: its ES256 PUBLIC key verifies
  // account tokens, and its public origin is where "sign in" sends players
  IDP_PUBLIC_JWK?: string;
  SIGNUP_PUBLIC_URL?: string;
}

function roomStub(env: Env, code: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

function queueStub(env: Env): DurableObjectStub {
  return env.QUEUE.get(env.QUEUE.idFromName("queue"));
}

// A browser always sends Origin on a WebSocket upgrade. A page on another site
// must not be able to open a player's socket with the player's cookies (the
// cookie is SameSite=Lax; this does not rely on that). Non-browser clients (the
// host agent) send no Origin and are unaffected.
function crossSiteSocket(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

async function sessionCookie(
  claims: Omit<SessionClaims, "exp">,
  env: Env,
  req: Request,
): Promise<string> {
  const full: SessionClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const token = await signSession(full, env.PARTY_JWT_SECRET);
  return makeSessionCookie(token, isSecure(req));
}

function genRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[crypto.getRandomValues(new Uint8Array(1))[0] % alphabet.length];
  }
  return code;
}

function encodeClaimsHeader(claims: SessionClaims): string {
  return btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Call the signup worker over the service binding (production) or the
// SIGNUP_URL fetch (local dev, where the binding has no local target).
async function signupFetch(env: Env, path: string, init?: RequestInit): Promise<Response | null> {
  try {
    if (env.SIGNUP) return await env.SIGNUP.fetch(`https://signup${path}`, init);
    if (env.SIGNUP_URL) return await fetch(`${env.SIGNUP_URL}${path}`, init);
  } catch (e) {
    console.error(`signup fetch ${path}: ${(e as Error).message}`);
    return null;
  }
  return null;
}

async function fetchSignupTop(env: Env): Promise<{ top: unknown[] }> {
  const res = await signupFetch(env, "/api/top");
  if (!res || !res.ok) return { top: [] };
  try {
    return (await res.json()) as { top: unknown[] };
  } catch {
    return { top: [] };
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.PARTY_JWT_SECRET) {
      return new Response("server misconfigured", { status: 500 });
    }
    const url = new URL(req.url);

    // M11.4: top-20 of the Glicko-2 ladder, proxied from the signup worker
    // (public data — the slate slides poll it)
    if (url.pathname === "/api/top" && req.method === "GET") {
      const top = await fetchSignupTop(env);
      return json(top);
    }

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1];
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      if (crossSiteSocket(req)) return new Response("cross-site websocket refused", { status: 403 });
      const claims = await getSession(req, env.PARTY_JWT_SECRET);
      if (!claims || claims.room !== code) {
        return new Response("unauthorized", { status: 401 });
      }
      const fwdHeaders = new Headers({
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "x-hw-session": encodeClaimsHeader(claims),
      });
      return roomStub(env, code).fetch("https://room/ws", {
        method: "GET",
        headers: fwdHeaders,
      });
    }

    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const sid = crypto.randomUUID();
      const body = await req
        .json<{ mode?: string; slots?: number; maxPlayers?: number }>()
        .catch(() => ({}) as { mode?: string; slots?: number; maxPlayers?: number });
      // the stream host proves itself with the queue secret: its room is
      // "managed" - only players the queue admitted into it may join
      const managed = !!env.STREAM_HOST_SECRET
        && req.headers.get("x-stream-secret") === env.STREAM_HOST_SECRET;
      const mode = body?.mode;
      if (mode !== undefined && !PARTY_MODES.includes(mode as PartyMode)) {
        return new Response("bad mode", { status: 400 });
      }
      const slots = body?.slots;
      if (slots !== undefined && (typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 || slots > 8)) {
        return new Response("bad slots", { status: 400 });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = genRoomCode();
        const res = await roomStub(env, code).fetch("https://room/create", {
          method: "POST",
          body: JSON.stringify({ sid, mode, slots, managed, maxPlayers: body?.maxPlayers }),
        });
        if (res.status === 409) continue;
        if (!res.ok) return res;
        const cookie = await sessionCookie({ room: code, sid, role: "host" }, env, req);
        return new Response(JSON.stringify({ room: code }), {
          status: 201,
          headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
        });
      }
      return new Response("could not allocate room", { status: 503 });
    }

    // ---- accounts: sign in with the signup worker's identity token ----
    // The signup worker redirects here with the token in the URL FRAGMENT
    // (/auth#token=...), so it never reaches a server log; public/auth.html
    // posts it to this endpoint, which verifies it and keeps it in a cookie.
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const { token } = await req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
      const acct = typeof token === "string" ? await verifyIdToken(token, env.IDP_PUBLIC_JWK) : null;
      if (!acct) return new Response("bad token", { status: 401 });
      return new Response(JSON.stringify({ ok: true, name: acct.name }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": makeAccountCookie(token as string, acct.exp - Date.now() / 1000, isSecure(req)),
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", "Set-Cookie": makeAccountCookie("", 0, isSecure(req)) },
      });
    }
    // who the stream will call this player: their account, or (not signed in)
    // an AnonAlpha-style name handed out when they join the queue
    if (url.pathname === "/api/identity" && req.method === "GET") {
      const acct = await getAccount(req, env.IDP_PUBLIC_JWK);
      const base = env.SIGNUP_PUBLIC_URL ? env.SIGNUP_PUBLIC_URL.replace(/\/$/, "") : null;
      return new Response(JSON.stringify({
        registered: !!acct,
        name: acct?.name ?? null,
        signInUrl: base ? `${base}/authorize` : null,
      }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    // ---- stream queue: the code-free join point for the stream host ----
    // The screen name is never taken from the client: a signed-in account
    // keeps its own name, everyone else is given AnonAlpha, AnonBeta, ...
    if (url.pathname === "/api/queue/join" && req.method === "POST") {
      let sid: string = crypto.randomUUID();
      // a player the host sent back to the FRONT of the queue (still unseated
      // when the round started) still holds their round session: they keep
      // that identity, and the place the queue already reserved for it
      const held = await getSession(req, env.PARTY_JWT_SECRET);
      if (held && held.role === "controller") {
        const chk = await queueStub(env).fetch("https://queue/requeued", {
          method: "POST",
          body: JSON.stringify({ sid: held.sid }),
        });
        if (chk.ok && (await chk.json<{ ok: boolean }>()).ok === true) sid = held.sid;
      }
      const acct = await getAccount(req, env.IDP_PUBLIC_JWK);
      const res = await queueStub(env).fetch("https://queue/join", {
        method: "POST",
        body: JSON.stringify({ sid, name: acct?.name, sub: acct?.sub }),
      });
      if (!res.ok) return res;
      const cookie = await sessionCookie({ room: "queue", sid, role: "spectator" }, env, req);
      return new Response(JSON.stringify({ ...(await res.json<Record<string, unknown>>()), registered: !!acct }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
      });
    }

    if (url.pathname === "/api/queue/ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      if (crossSiteSocket(req)) return new Response("cross-site websocket refused", { status: 403 });
      const claims = await getSession(req, env.PARTY_JWT_SECRET);
      if (!claims || claims.room !== "queue") {
        return new Response("unauthorized", { status: 401 });
      }
      return queueStub(env).fetch("https://queue/ws", {
        method: "GET",
        headers: new Headers({
          "Upgrade": "websocket",
          "Connection": "Upgrade",
          "x-hw-queue-sid": claims.sid,
        }),
      });
    }

    if (url.pathname === "/api/queue/state" && req.method === "GET") {
      return queueStub(env).fetch("https://queue/state");
    }

    // the stream's constant join QR — generated per deployment from the
    // request origin, so slides and controllers never embed a room code
    if (url.pathname === "/api/queue/qr" && req.method === "GET") {
      const joinUrl = `${url.origin}/`;
      const svg = await QRCode.toString(joinUrl, {
        type: "svg", margin: 1, width: 512,
        color: { dark: "#f2ead8", light: "#101020" },
      });
      return new Response(svg, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300" },
      });
    }

    // host-only queue control (the stream agent authenticates by secret)
    const queueCtl = url.pathname.match(/^\/api\/queue\/(admit|countdown|lastgame|phase|release|roster|turnafk|drop|requeue)$/);
    if (queueCtl && req.method === "POST") {
      if (!env.STREAM_HOST_SECRET || req.headers.get("x-stream-secret") !== env.STREAM_HOST_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const action = queueCtl[1];
      if (action === "release") {
        const { room } = await req.json<{ room: string }>();
        return roomStub(env, room).fetch("https://room/release", { method: "POST" });
      }
      let body = await req.text();
      // seat modes report who sat where; resolve entrants + winners once (the
      // imposter who defected wins with the survivors) and hand the resolved
      // result to both the ladder queue and the signup worker
      let resolved: ReturnType<typeof resolveResult> | null = null;
      if (action === "lastgame") {
        try {
          const report = JSON.parse(body) as GameReport;
          resolved = resolveResult(report);
          body = JSON.stringify({ ...report, kills: resolved.kills, winners: resolved.winners });
        } catch (e) {
          console.error(`lastgame resolve: ${(e as Error).message}`);
        }
      }
      // M11.4: game results also feed the Glicko-2 ladder in the signup
      // worker (fire-and-forget: a signup outage must never break a round)
      if (action === "lastgame" && env.SIGNUP_SECRET && resolved) {
        try {
          const { kills, winners } = resolved;
          if (kills && Object.keys(kills).length) {
            const game = {
              teams: Object.entries(kills).map(([name, k]) => ({
                name,
                kills: k,
                won: winners.includes(name),
              })),
            };
            const res = await signupFetch(env, "/api/result", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-signup-secret": env.SIGNUP_SECRET,
              },
              body: JSON.stringify({ games: [game] }),
            });
            if (res && !res.ok) console.error(`signup /api/result: http ${res.status}`);
          }
        } catch (e) {
          console.error(`signup result forward: ${(e as Error).message}`);
        }
      }
      return queueStub(env).fetch(`https://queue/${action}`, {
        method: "POST",
        body,
      });
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/);
    if (joinMatch && req.method === "POST") {
      const code = joinMatch[1];
      // a queue session the queue admitted into THIS room keeps its identity
      // (the room session reuses the queue sid); everyone else gets a fresh
      // sid and can only enter rooms that are not queue-managed
      let sid: string = crypto.randomUUID();
      let admitted = false;
      let name: string | undefined;
      const queueClaims = await getSession(req, env.PARTY_JWT_SECRET);
      if (queueClaims?.room === "queue") {
        const chk = await queueStub(env).fetch("https://queue/admitted", {
          method: "POST",
          body: JSON.stringify({ sid: queueClaims.sid, room: code }),
        });
        const verdict = chk.ok ? await chk.json<{ ok: boolean; name?: string }>() : { ok: false };
        admitted = verdict.ok === true;
        if (admitted) { sid = queueClaims.sid; name = verdict.name; }
      }
      const res = await roomStub(env, code).fetch("https://room/join", {
        method: "POST",
        body: JSON.stringify({ sid, admitted, name }),
      });
      if (!res.ok) return res;
      const cookie = await sessionCookie({ room: code, sid, role: "controller" }, env, req);
      return new Response(JSON.stringify({ room: code }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
      });
    }

    // host-side controller liveness (the AFK turn countdown): the host's
    // session cookie authorises it — controllers cannot read each other
    const aliveMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/alive\/([\w-]+)$/);
    if (aliveMatch && req.method === "GET") {
      const code = aliveMatch[1];
      const claims = await getSession(req, env.PARTY_JWT_SECRET);
      if (!claims || claims.room !== code || claims.role !== "host") {
        return new Response("unauthorized", { status: 401 });
      }
      return roomStub(env, code).fetch(`https://room/alive/${aliveMatch[2]}`);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
