// auth.ts — signup-worker sessions: the same HS256 JWT pattern the stream
// worker uses, with signup-specific claims. A session identifies a verified
// email and its claimed screen name.

export interface SessionClaims {
  email: string;
  name: string;
  sid: string;
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
  if (typeof claims.email !== "string" || typeof claims.name !== "string") return null;
  if (claims.exp < Date.now() / 1000) return null;
  return claims;
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // long-lived profile session

export function makeSessionCookie(token: string, secure: boolean): string {
  return `hw_signup=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function getSession(req: Request, secret: string): Promise<SessionClaims | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)hw_signup=([^;\s]+)/);
  const token = m ? m[1] : null;
  return token ? verifySession(token, secret) : Promise.resolve(null);
}
