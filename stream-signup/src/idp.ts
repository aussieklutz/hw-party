// idp.ts - the signup worker as an identity provider. After a player proves
// their email (magic link) and holds a screen name, this worker mints an
// ES256-signed JWT that says so. Relying parties (the stream worker) hold only
// the PUBLIC key: they can verify an identity but can never create one, and
// they never see the email - `sub` is a hash of it.
//
//   iss   "hwstream-signup"
//   aud   "hwstream"
//   sub   hex(sha256(lowercased email)).slice(0, 32)   stable per player
//   name  the claimed screen name (unique, case-insensitive)
//   iat / exp
//
// The token is the whole credential: the relying party needs no call back.
// A rename therefore takes effect when the player's next token is issued, so
// tokens are short-lived (ID_TOKEN_TTL_SECONDS).

export const ID_ISS = "hwstream-signup";
export const ID_AUD = "hwstream";
export const ID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function subjectFor(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(email.trim().toLowerCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function signIdToken(privateJwk: string, email: string, name: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateJwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({
    iss: ID_ISS,
    aud: ID_AUD,
    sub: await subjectFor(email),
    name,
    iat,
    exp: iat + ID_TOKEN_TTL_SECONDS,
  })));
  const data = `${header}.${payload}`;
  // WebCrypto's ECDSA output is the raw r||s form JWS ES256 wants
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
