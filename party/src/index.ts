import { RoomDO, PARTY_MODES, type PartyMode } from "./room";
import {
  getSession,
  makeSessionCookie,
  signSession,
  SESSION_TTL_SECONDS,
  type SessionClaims,
} from "./auth";

export { RoomDO };

export interface Env {
  ROOM: DurableObjectNamespace;
  PARTY_JWT_SECRET: string;
}

function roomStub(env: Env, code: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

// A browser always sends Origin on a WebSocket upgrade. A page on another site
// must not be able to open a player's socket with the player's cookies (the
// cookie is SameSite=Lax; this does not rely on that). Non-browser clients (the
// Qt host) send no Origin and are unaffected.
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.PARTY_JWT_SECRET) {
      return new Response("server misconfigured", { status: 500 });
    }
    const url = new URL(req.url);

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
          body: JSON.stringify({ sid, mode, slots, maxPlayers: body?.maxPlayers }),
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

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/);
    if (joinMatch && req.method === "POST") {
      const code = joinMatch[1];
      const sid = crypto.randomUUID();
      const res = await roomStub(env, code).fetch("https://room/join", {
        method: "POST",
        body: JSON.stringify({ sid }),
      });
      if (!res.ok) return res;
      const cookie = await sessionCookie({ room: code, sid, role: "controller" }, env, req);
      return new Response(JSON.stringify({ room: code }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
