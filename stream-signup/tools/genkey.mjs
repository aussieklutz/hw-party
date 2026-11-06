// genkey.mjs - make the IdP signing key pair (ES256 / P-256).
//   node tools/genkey.mjs
// prints two lines:
//   IDP_PRIVATE_JWK=...   -> the signup worker (a SECRET: wrangler secret put IDP_PRIVATE_JWK,
//                            or stream-signup/.dev.vars locally)
//   IDP_PUBLIC_JWK=...    -> the stream worker (public: wrangler.toml [vars] or .dev.vars)
import { generateKeyPairSync } from "node:crypto";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
console.log("IDP_PRIVATE_JWK=" + JSON.stringify(privateKey.export({ format: "jwk" })));
console.log("IDP_PUBLIC_JWK=" + JSON.stringify(publicKey.export({ format: "jwk" })));
