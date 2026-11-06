// auth-flow.mjs - the stream player identity flow, end to end against the real
// workers (no engine, no browser):
//
//   signup worker (the IdP)      magic link -> unique, safeworded screen name
//                                -> ES256 identity token
//   stream worker                verifies the token with the PUBLIC key only;
//                                no account => AnonAlpha, AnonBeta, ...
//                                names are enforced server-side, never typed
//
// usage: node tests/auth-flow.mjs
//   needs: signup worker on SIGNUP (default :8791, DEV_MODE=1 so the magic link
//   comes back in the API response, STREAM_URL pointing at the stream worker)
//   and the stream worker on BASE (default :8790, IDP_PUBLIC_JWK set).
//   Fresh local state for both is easiest.
import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
const WebSocket = require("ws");

const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const SIGNUP = process.env.SIGNUP ?? "http://127.0.0.1:8791";
const WS = BASE.replace(/^http/, "ws");
const envFile = (f, k) => readFileSync(join(here, "..", f), "utf8").match(new RegExp(`^${k}=(.+)$`, "m"))[1].trim();
const SECRET = process.env.STREAM_HOST_SECRET ?? envFile("worker/.dev.vars", "STREAM_HOST_SECRET");
const IDP_PRIVATE = process.env.IDP_PRIVATE_JWK ?? envFile("../stream-signup/.dev.vars", "IDP_PRIVATE_JWK");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

// a browser: its own cookie jar (several cookies - hw_session, hw_acct, hw_signup)
class Browser {
  constructor(origin) { this.origin = origin; this.jar = new Map(); }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path, init = {}) {
    const res = await fetch(this.origin + path, {
      redirect: "manual",
      ...init,
      headers: { ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (v === "" || /Max-Age=0/i.test(sc)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return res;
  }
  post(path, body) {
    return this.req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  }
  open(path, origin = WS) {
    return new Promise((resolve) => {
      const ws = new WebSocket(origin + path, { headers: { cookie: this.cookie } });
      const sock = { ws, msgs: [], status: null };
      ws.on("message", (d) => { try { sock.msgs.push(JSON.parse(d.toString())); } catch {} });
      ws.on("open", () => { sock.status = 101; resolve(sock); });
      ws.on("unexpected-response", (_r, res) => { sock.status = res.statusCode; resolve(sock); });
      ws.on("error", () => {});
    });
  }
}

const ctl = (path, body) => fetch(`${BASE}/api/queue/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-stream-secret": SECRET },
  body: JSON.stringify(body),
});

// ------------------------------------------------------------ signup side ---
let seq = 0;
const stamp = Date.now().toString(36);
// per-run names (digits pass the safeword filter) so reruns need no fresh database
const N = String(Date.now() % 100000);
const TP = `Teapot${N}`, WF = `Waffle${N}`, ND = `Noodle${N}`;
async function signUp(email = `p${stamp}${seq++}@example.com`) {
  const b = new Browser(SIGNUP);
  const r = await (await b.post("/api/signup", { email })).json();
  const token = r.link?.split("token=")[1];
  return { b, email, token, r };
}
const claim = async (who, name) => {
  const res = await who.b.post("/api/claim", { token: who.token, name });
  return { status: res.status, body: await res.json() };
};

console.log("\n-- signup worker: names");
const a = await signUp();
check("magic link is issued (dev mode returns it)", !!a.token);
const ca = await claim(a, TP);
check("a clean, free name is claimed immediately", ca.status === 200 && ca.body.name === TP, JSON.stringify(ca.body).slice(0, 80));
check("claim returns a signed identity token", typeof ca.body.idToken === "string" && ca.body.idToken.split(".").length === 3);
const aToken = ca.body.idToken;

const dupes = [];
for (const typed of [TP.toLowerCase(), TP.toUpperCase(), TP, `  ${TP}  `, TP.slice(0, 3) + "​" + TP.slice(3), TP + "‮"]) {
  const x = await signUp();
  const r = await claim(x, typed);
  dupes.push([typed, r.status]);
}
check("nobody else can take it - not by case, padding, zero-width or direction characters",
  dupes.every(([, s]) => s === 409), JSON.stringify(dupes));

const b = await signUp();
const cb = await claim(b, `Bobby Smith ${N}`);
check("a name that needs the safeword filter is NOT claimed - the entry screen is sent a suggestion",
  cb.status === 422 && typeof cb.body.suggest === "string" && cb.body.suggest !== `Bobby Smith ${N}`, JSON.stringify(cb.body));
const top1 = (await (await fetch(`${SIGNUP}/api/top`)).json()).top.map((t) => t.name);
check("...and nothing was registered behind the player's back", !top1.includes(cb.body.suggest) && !top1.includes(`Bobby Smith ${N}`), top1.join(","));
const cb2 = await claim(b, cb.body.suggest);
check("confirming the suggestion takes exactly that name (no second roll)", cb2.status === 200 && cb2.body.name === cb.body.suggest, `${cb.body.suggest} -> ${JSON.stringify(cb2.body.name)}`);

const e = await signUp();
const ce = await claim(e, "Теарот"); // Cyrillic look-alike of "Teapot"
check("non-Latin look-alike letters are rejected, not passed through", ce.status === 400 || ce.status === 422, `status=${ce.status}`);
const f = await signUp();
const cf = await claim(f, "AnonAlpha");
check("AnonAlpha cannot be claimed (no-account names are reserved)", !(cf.status === 200 && /^anon/i.test(cf.body.name ?? "")), JSON.stringify(cf.body).slice(0, 90));

const race = await Promise.all([signUp(), signUp()]);
const rr = await Promise.all(race.map((x) => claim(x, WF)));
check("two simultaneous claims of one name: exactly one wins", rr.filter((r) => r.status === 200).length === 1, rr.map((r) => r.status).join(","));
const loser = race[rr.findIndex((r) => r.status !== 200)];
const retry = await claim(loser, ND);
check("a refused link stays usable for another try", retry.status === 200 || retry.status === 409, `status=${retry.status}`);

const x1 = await signUp();
const second = await (await x1.b.post("/api/signup", { email: x1.email })).json();
check("the same address cannot be mail-bombed (one link a minute)", !second.link, JSON.stringify(second));

const xss = await signUp("a<svg/onload=alert(1)>@b.co");
const html = await (await fetch(`${SIGNUP}/verify?token=${xss.token}`)).text();
check("the verify page does not reflect markup from an email address", !html.includes("<svg/onload"));

const auth = await a.b.req("/authorize");
check("an already-signed-in player is bounced to the stream with a fresh token in the fragment",
  auth.status === 302 && /\/auth#token=/.test(auth.headers.get("location") ?? ""), auth.headers.get("location")?.slice(0, 60));
const anonAuth = await new Browser(SIGNUP).req("/authorize");
check("no signup session: /authorize sends them to the magic-link form instead", anonAuth.status === 302 && !/token=/.test(anonAuth.headers.get("location") ?? ""));

// ------------------------------------------------------------ stream side ---
console.log("\n-- stream worker: identity tokens");
const jwt = (alg, claims, key) => {
  const h = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = key ? createSign("SHA256").update(`${h}.${p}`).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url") : "";
  return `${h}.${p}.${sig}`;
};
const idpKey = createPrivateKey({ key: JSON.parse(IDP_PRIVATE), format: "jwk" });
const now = Math.floor(Date.now() / 1000);
const good = { iss: "hwstream-signup", aud: "hwstream", sub: "s".repeat(32), name: "Forged", iat: now, exp: now + 600 };
const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const login = async (token) => (await new Browser(BASE).post("/api/auth/login", { token })).status;
const parts = aToken.split(".");
const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url")), name: "Evil" })).toString("base64url")}.${parts[2]}`;
const results = {
  "genuine token": await login(aToken),
  "payload tampered": await login(tampered),
  "signed by another key": await login(jwt("ES256", good, other)),
  "expired": await login(jwt("ES256", { ...good, exp: now - 5 }, idpKey)),
  "wrong audience": await login(jwt("ES256", { ...good, aud: "elsewhere" }, idpKey)),
  "wrong issuer": await login(jwt("ES256", { ...good, iss: "evil" }, idpKey)),
  "alg none": await login(jwt("none", good, null)),
  "alg HS256 (confusion)": await login(jwt("HS256", good, null)),
  "garbage": await login("not.a.jwt"),
};
check("a genuine identity token signs in", results["genuine token"] === 200);
const bad = Object.entries(results).filter(([k]) => k !== "genuine token");
check("every forged, tampered, expired or mis-addressed token is refused", bad.every(([, s]) => s === 401), JSON.stringify(bad));

const me = new Browser(BASE); // signs in with the genuine token
await me.post("/api/auth/login", { token: aToken });
const ident = await (await me.req("/api/identity")).json();
check("signed in: identity shows the account name", ident.registered && ident.name === TP, JSON.stringify(ident));
check("identity advertises where to sign in", typeof (await (await new Browser(BASE).req("/api/identity")).json()).signInUrl === "string");

console.log("\n-- stream worker: names are enforced in the room");
await sleep(3500); // phantom joins from earlier runs lapse
const host = new Browser(BASE);
const created = await host.req("/api/rooms", { method: "POST", headers: { "x-stream-secret": SECRET }, body: JSON.stringify({ mode: "imposter", slots: 4 }) });
const { room } = await created.json();
const hostSock = await host.open(`/api/rooms/${room}/ws`);
await ctl("phase", { phase: "lobby", room, count: 6, openSeats: 8, pairs: true });
// admission happens as players join (the lobby is open, pairs only)
const pairA = new Browser(BASE), pairB = new Browser(BASE);
const ja = await (await pairA.post("/api/queue/join", {})).json();
const jb = await (await pairB.post("/api/queue/join", {})).json();
await sleep(500);
check("the pair is admitted and each is told a stream name", /^Anon[A-Z]/.test(ja.name) && /^Anon[A-Z]/.test(jb.name) && ja.name !== jb.name, `${ja.name}, ${jb.name}`);
const joinA = await pairA.req(`/api/rooms/${room}/join`, { method: "POST" });
const joinB = await pairB.req(`/api/rooms/${room}/join`, { method: "POST" });
check("admitted players enter the room", joinA.status === 200 && joinB.status === 200, `${joinA.status}/${joinB.status}`);
const sa = await pairA.open(`/api/rooms/${room}/ws`);
const sb = await pairB.open(`/api/rooms/${room}/ws`);
await sleep(300);
sa.ws.send(JSON.stringify({ type: "team", config: { name: "Impostor Prime", verified: true, hogs: [] } }));
sb.ws.send(JSON.stringify({ type: "team", config: { name: TP, verified: false } }));
await sleep(600);
const teamMsgs = hostSock.msgs.filter((m) => m.type === "team");
const byA = teamMsgs.find((m) => m.config?.name === ja.name), byB = teamMsgs.find((m) => m.config?.name === jb.name);
check("the host receives each player's server-assigned name, not what the phone typed", !!byA && !!byB, JSON.stringify(teamMsgs.map((m) => m.config?.name)));
check("typed names (Impostor Prime / a registered name) never reach the host", !teamMsgs.some((m) => ["Impostor Prime", TP].includes(m.config?.name)));
check("the room marks the name verified (even when the phone said false)", byA?.config?.verified === true && byB?.config?.verified === true);
check("team/imposter: typed hog names are not relayed (the screen name IS the hog)", byA?.config?.hogs === undefined && byB?.config?.hogs === undefined, JSON.stringify(byA?.config));

console.log("\n-- standard modes: the screen name is the team name; hogs are typed but bounded");
{
  await sleep(3500); // phantom joins lapse
  const host2 = new Browser(BASE);
  const made = await host2.req("/api/rooms", { method: "POST", headers: { "x-stream-secret": SECRET }, body: JSON.stringify({ mode: "dynamic" }) });
  const { room: room2 } = await made.json();
  const hostSock2 = await host2.open(`/api/rooms/${room2}/ws`);
  await ctl("phase", { phase: "lobby", room: room2, mode: "dynamic", count: 2, openSeats: 4 });
  const solo = new Browser(BASE);
  const js = await (await solo.post("/api/queue/join", {})).json();
  await sleep(300);
  const jr = await solo.req(`/api/rooms/${room2}/join`, { method: "POST" });
  const so = await solo.open(`/api/rooms/${room2}/ws`);
  check("(setup) a player is in the standard-mode room", jr.status === 200 && so.status === 101 && js.admitted === true, `join=${jr.status} ws=${so.status}`);
  await sleep(300);
  so.ws.send(JSON.stringify({ type: "team", config: {
    name: "Evil Team", verified: false, flag: "x\nquit", grave: "Statue", voice: "Default",
    hogs: [{ name: "Zippy" }, { name: "y".repeat(200) }, { name: null }, { name: "a" }, { name: "fifth hog" }],
  } }));
  await sleep(600);
  const tm = hostSock2.msgs.find((m) => m.type === "team");
  check("the typed team name is replaced outright by the bound screen name", tm?.config?.name === js.name && tm.config.name !== "Evil Team", JSON.stringify(tm?.config?.name));
  check("...and marked verified for the host", tm?.config?.verified === true);
  check("hog names are still the player's (up to four), each bounded", tm?.config?.hogs?.length === 4 && tm.config.hogs[0].name === "Zippy" && tm.config.hogs[1].name.length <= 50, JSON.stringify(tm?.config?.hogs?.map((h) => (h.name ?? "").length)));
  check("a malformed hog name is dropped, not relayed as junk", tm?.config?.hogs?.[2]?.name === undefined);
  check("a flag with control characters never reaches the host's engine config; a plain one does", tm?.config?.flag === undefined && tm?.config?.grave === "Statue", JSON.stringify({ flag: tm?.config?.flag, grave: tm?.config?.grave }));
  for (const sk of [hostSock2, so]) try { sk.ws.close(); } catch {}
}

console.log("\n-- stream worker: queue names");
const guest1 = new Browser(BASE), guest2 = new Browser(BASE);
const g1 = await (await guest1.post("/api/queue/join", { name: "Teapot" })).json(); // tries to ask for a registered name
const g2 = await (await guest2.post("/api/queue/join", { name: "Evil" })).json();
check("a guest is assigned an AnonX name", /^Anon[A-Z][a-z]+\d*$/.test(g1.name) && /^Anon[A-Z][a-z]+\d*$/.test(g2.name), `${g1.name}, ${g2.name}`);
check("a client cannot choose its stream name (a registered name / Evil ignored)", g1.name !== TP && g2.name !== "Evil");
check("guests get distinct names", g1.name !== g2.name);
const mine = await (await me.post("/api/queue/join", {})).json();
check("a signed-in player queues under their own name", mine.name === TP && mine.registered === true, JSON.stringify(mine));
const again = new Browser(BASE);
again.jar.set("hw_acct", me.jar.get("hw_acct"));
const dup = await again.post("/api/queue/join", {});
check("the same account cannot hold two places (second device refused)", dup.status === 409, `status=${dup.status}`);
const sock = (await guest1.open("/api/queue/ws"));
check("(setup) guest queue socket opens", sock.status === 101);

console.log("\n-- party rooms are unchanged and cannot fake `verified`");
const phost = new Browser(BASE);
const pc = await phost.req("/api/rooms", { method: "POST", body: JSON.stringify({ mode: "teams", slots: 4 }) });
const { room: proom } = await pc.json();
const phostSock = await phost.open(`/api/rooms/${proom}/ws`);
const pj = new Browser(BASE);
const pjr = await pj.req(`/api/rooms/${proom}/join`, { method: "POST" });
check("a party room still takes anyone with the code", pjr.status === 200, `status=${pjr.status}`);
const ps = await pj.open(`/api/rooms/${proom}/ws`);
await sleep(300);
ps.ws.send(JSON.stringify({ type: "team", config: { name: "Typed Name", verified: true } }));
await sleep(500);
const pm = phostSock.msgs.find((m) => m.type === "team");
check("party mode keeps the typed name", pm?.config?.name === "Typed Name", JSON.stringify(pm?.config));
check("a phone cannot set `verified` to dodge the safeword filter", pm && pm.config.verified === undefined, JSON.stringify(pm?.config));

console.log("\n-- the leaderboard never carries guests");
await ctl("lastgame", { lines: [], winner: TP, kills: { [TP]: 2, [ja.name]: 5, [jb.name]: 1 } });
const state = await (await fetch(`${BASE}/api/queue/state`)).json();
const names = (state.ladder ?? []).map((l) => l.name);
check("the stream ladder lists the account but no AnonX name", names.includes(TP) && !names.some((n) => /^Anon[A-Z]/.test(n)), names.join(","));

for (const s of [sock, hostSock, sa, sb, phostSock, ps]) try { s.ws.close(); } catch {}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
