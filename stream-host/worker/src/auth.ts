export interface SessionClaims {
  room: string;
  sid: string;
  role: "host" | "controller" | "spectator";
  team?: string;
  exp: number;
}

const enc = new TextEncoder();

function ab(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad === 4 ? 0 : pad);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function jsonB64url(value: unknown): string {
  return b64url(enc.encode(JSON.stringify(value)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ab(enc.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const header = jsonB64url({ alg: "HS256", typ: "JWT" });
  const payload = jsonB64url(claims);
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), ab(enc.encode(data)));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    ab(b64urlDecode(sig)),
    ab(enc.encode(`${header}.${payload}`)),
  );
  if (!ok) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (typeof claims.room !== "string" || typeof claims.sid !== "string") return null;
  if (!["host", "controller", "spectator"].includes(claims.role)) return null;
  if (claims.exp < Date.now() / 1000) return null;
  return claims;
}

// Session lifetime for both the JWT expiry and the cookie: 12 hours by
// default, so a phone that parks its browser (or reopens it later) keeps its
// registration for a whole game evening.
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function makeSessionCookie(token: string, secure: boolean): string {
  // Max-Age makes the cookie persistent (survives browser restarts) and keeps
  // it valid exactly as long as the signed session it carries.
  return `hw_session=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function getSession(req: Request, secret: string): Promise<SessionClaims | null> {
  const token = getRawToken(req);
  return token ? verifySession(token, secret) : Promise.resolve(null);
}

export function getRawToken(req: Request): string | null {
  const header = req.headers.get("Cookie") ?? "";
  const m = header.match(/(?:^|;\s*)hw_session=([^;\s]+)/);
  if (m) return m[1];
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

// ---------------------------------------------------------------------------
// Account identity: the stream's screen name comes from a JWT minted by the
// signup worker acting as an identity provider (ES256). This worker holds only
// the PUBLIC key (IDP_PUBLIC_JWK), so it can verify who someone is but cannot
// create an identity. Everything needed rides in the token: `sub` (a hash, no
// email), `name`, `exp`. No call back to the signup worker is needed.
export interface AccountClaims {
  sub: string;
  name: string;
  exp: number;
}

const ID_ISS = "hwstream-signup";
const ID_AUD = "hwstream";

export async function verifyIdToken(token: string, publicJwk: string | undefined): Promise<AccountClaims | null> {
  if (!publicJwk || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  try {
    const h = JSON.parse(new TextDecoder().decode(b64urlDecode(header)));
    if (h.alg !== "ES256") return null; // the only accepted algorithm: no algorithm confusion
    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(publicJwk),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      ab(b64urlDecode(sig)),
      ab(enc.encode(`${header}.${payload}`)),
    );
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (c.iss !== ID_ISS || c.aud !== ID_AUD) return null;
    if (typeof c.sub !== "string" || !c.sub || typeof c.name !== "string" || !c.name) return null;
    if (typeof c.exp !== "number" || c.exp < Date.now() / 1000) return null;
    return { sub: c.sub, name: c.name.slice(0, 40), exp: c.exp };
  } catch {
    return null;
  }
}

// the player's identity token rides in its own cookie, separate from the room
// session (hw_session); it lives exactly as long as the token does
export function makeAccountCookie(token: string, maxAge: number, secure: boolean): string {
  return `hw_acct=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function getAccount(req: Request, publicJwk: string | undefined): Promise<AccountClaims | null> {
  const m = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)hw_acct=([^;\s]+)/);
  return m ? verifyIdToken(m[1], publicJwk) : Promise.resolve(null);
}
