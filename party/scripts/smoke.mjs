import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
let failures = 0;

function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

function connectWs(code, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`, { headers });
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function waitFor(buffered, ws, predicate, timeoutMs = 3000) {
  const hit = buffered.messages.find(predicate);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);
    function onMessage(data) {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    }
    ws.on("message", onMessage);
  });
}

const res = await fetch(`${BASE}/api/rooms`, { method: "POST" });
check("create room: 201", res.status === 201);
const setCookie = res.headers.get("set-cookie") ?? "";
check("create room: HttpOnly cookie", /hw_session=[^;]+; Path=\/;.*HttpOnly/.test(setCookie));
const hostCookie = setCookie.split(";")[0];
const { room: code } = await res.json();
check("create room: 6-char code", /^[A-Z0-9]{6}$/.test(code));

const host = await connectWs(code, { Cookie: hostCookie });
check("host ws: hello", (await waitFor(host, host.ws, (m) => m.type === "hello")).role === "host");

const joinRes = await fetch(`${BASE}/api/rooms/${code}/join`, { method: "POST" });
check("join room: 200", joinRes.status === 200);
const controllerCookie = (joinRes.headers.get("set-cookie") ?? "").split(";")[0];
const controller = await connectWs(code, { Cookie: controllerCookie });
const controllerHello = await waitFor(controller, controller.ws, (m) => m.type === "hello");
check("controller ws: hello", controllerHello.role === "controller");
const controllerSid0 = controllerHello.sid;
check("host sees controller join", (await waitFor(host, host.ws, (m) => m.type === "joined")).sid.length > 0);

const bearerRes = await fetch(`${BASE}/api/rooms/${code}/join`, { method: "POST" });
const bearerToken = (bearerRes.headers.get("set-cookie") ?? "").match(/hw_session=([^;]+)/)?.[1];
const bearer = await connectWs(code, { Authorization: `Bearer ${bearerToken}` });
const bearerHello = await waitFor(bearer, bearer.ws, (m) => m.type === "hello");
check("bearer ws auth accepted", bearerHello.role === "controller");
const bearerSid0 = bearerHello.sid;

// the worker, not the host, decides who may act: nothing is relayed while no
// turn is live, or to anyone but the player whose turn it is
controller.ws.send(JSON.stringify({ type: "input", action: "+left" }));
controller.ws.send(JSON.stringify({ type: "cursor", x: 1, y: 1 }));
await new Promise((r) => setTimeout(r, 300));
check("input before any turn is dropped", host.messages.filter((m) => m.type === "input" || m.type === "cursor").length === 0);
host.ws.send(JSON.stringify({ type: "turn", team: "T1", sid: bearerSid0 }));
await new Promise((r) => setTimeout(r, 200));
controller.ws.send(JSON.stringify({ type: "input", action: "+left" }));
await new Promise((r) => setTimeout(r, 300));
check("input from a player whose turn it is NOT is dropped", host.messages.filter((m) => m.type === "input").length === 0);
host.ws.send(JSON.stringify({ type: "turn", team: "T1", sid: controllerSid0 }));
await new Promise((r) => setTimeout(r, 200));
controller.ws.send(JSON.stringify({ type: "input", action: "+left" }));
const relay = await waitFor(host, host.ws, (m) => m.type === "input");
check("input relay to host", relay.action === "+left" && relay.sid.length > 0);

controller.ws.send(JSON.stringify({ type: "cursor", x: 4242, y: 1728 }));
const cursorRelay = await waitFor(host, host.ws, (m) => m.type === "cursor");
check("cursor relay to host", cursorRelay.x === 4242 && cursorRelay.y === 1728);

controller.ws.send(JSON.stringify({ type: "put", x: 300, y: 900 }));
const putRelay = await waitFor(host, host.ws, (m) => m.type === "put");
check("put relay to host", putRelay.x === 300 && putRelay.y === 900);

host.ws.send(JSON.stringify({ type: "turn", team: "T1", yourTeam: "T1", sid: controllerSid0 }));
check("turn broadcast to controller", (await waitFor(controller, controller.ws, (m) => m.type === "turn")).team === "T1");

controller.ws.send(JSON.stringify({ type: "team", config: { name: "Team Phone", hogs: [{ name: "Hog 1", hat: "NoHat" }] } }));
const teamMsg = await waitFor(host, host.ws, (m) => m.type === "team");
check("team registration relay", teamMsg.config.name === "Team Phone" && teamMsg.sid.length > 0);

host.ws.send(JSON.stringify({ type: "team", config: { name: "hacker" } }));
await new Promise((r) => setTimeout(r, 300));
check("host cannot register team", host.messages.filter((m) => m.type === "team").length === 1);

host.ws.send(JSON.stringify({ type: "weapons", ammo: "9999999999999999".repeat(1) }));
const weaponsMsg = await waitFor(controller, controller.ws, (m) => m.type === "weapons");
check("weapons broadcast to controller", typeof weaponsMsg.ammo === "string" && weaponsMsg.ammo.length > 0);
controller.ws.send(JSON.stringify({ type: "input", action: "setweap 3" }));
const setweapRelay = await waitFor(host, host.ws, (m) => m.type === "input" && m.action.startsWith("setweap"));
check("setweap relay accepted", setweapRelay.action === "setweap 3");

const controllerSid = relay.sid;
controller.ws.close();
check("host sees controller drop", (await waitFor(host, host.ws, (m) => m.type === "left")).sid === controllerSid);

const joinedBefore = host.messages.filter((m) => m.type === "joined").length;
const reconnected = await connectWs(code, { Cookie: controllerCookie });
check("controller reconnect hello", (await waitFor(reconnected, reconnected.ws, (m) => m.type === "hello")).role === "controller");
check("reconnect replays turn", (await waitFor(reconnected, reconnected.ws, (m) => m.type === "turn")).team === "T1");
await new Promise((r) => setTimeout(r, 500));
check("host sees controller rejoin", host.messages.filter((m) => m.type === "joined").length === joinedBefore + 1);

const goodInputs = host.messages.filter((m) => m.type === "input").length;
controller.ws.send(JSON.stringify({ type: "input", action: "DROP TABLE" }));
controller.ws.send(JSON.stringify({ type: "bogus" }));
controller.ws.send(JSON.stringify("not json"));
await new Promise((r) => setTimeout(r, 500));
check("bad input filtered", host.messages.filter((m) => m.type === "input").length === goodInputs);

const badWs = await connectWs(code, { Cookie: "hw_session=garbage.token.here" }).catch((e) => e);
check("invalid token rejected", badWs instanceof Error && String(badWs.message).includes("401"));

const noAuth = await connectWs(code, {}).catch((e) => e);
check("ws without auth: 401", noAuth instanceof Error && String(noAuth.message).includes("401"));

// --- room modes + member caps (M7.3) ---
check("hello carries mode", (host.messages.find((m) => m.type === "hello") ?? {}).mode === "classic");

const badMode = await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "bogus" }) });
check("create room: invalid mode 400", badMode.status === 400);

const fixedRes = await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ mode: "fixed" }) });
check("create room with mode: 201", fixedRes.status === 201);
const fixedCookie = (fixedRes.headers.get("set-cookie") ?? "").split(";")[0];
const { room: fixedRoom } = await fixedRes.json();
const fixedHost = await connectWs(fixedRoom, { Cookie: fixedCookie });
check(
  "fixed room hello carries mode",
  (await waitFor(fixedHost, fixedHost.ws, (m) => m.type === "hello")).mode === "fixed",
);

host.ws.send(JSON.stringify({ type: "state", state: "ingame" }));
const stateMsg = await waitFor(reconnected, reconnected.ws, (m) => m.type === "state" && m.state === "ingame");
check("state broadcast carries mode", stateMsg.mode === "classic");

// classic room caps at 8 controllers: bearer + reconnected live now. A spare
// session is created BEFORE the room fills: reconnecting with a session that
// is already connected just replaces its own socket (it is not another player)
const spareJoin = await fetch(`${BASE}/api/rooms/${code}/join`, { method: "POST" });
const spareCookie = (spareJoin.headers.get("set-cookie") ?? "").split(";")[0];
const extraControllers = [];
for (let i = 0; i < 6; i++) {
  const j = await fetch(`${BASE}/api/rooms/${code}/join`, { method: "POST" });
  const c = (j.headers.get("set-cookie") ?? "").split(";")[0];
  extraControllers.push(await connectWs(code, { Cookie: c }));
}
check("room fills to cap: 8 controllers", extraControllers.length === 6);
const overflowJoin = await fetch(`${BASE}/api/rooms/${code}/join`, { method: "POST" });
check("join past cap: 409", overflowJoin.status === 409);
const overflowWs = await connectWs(code, { Cookie: spareCookie }).catch((e) => e);
check("ws past cap: 409", overflowWs instanceof Error && String(overflowWs.message).includes("409"));
for (const c of extraControllers) c.ws.close();
fixedHost.ws.close();
await new Promise((r) => setTimeout(r, 300));

// --- fixed-lobby slot count drives the cap (M8) ---
const slotsRes = await fetch(`${BASE}/api/rooms`, {
  method: "POST",
  body: JSON.stringify({ mode: "fixed", slots: 2 }),
});
check("fixed room with slots: 201", slotsRes.status === 201);
const slotsCookie = (slotsRes.headers.get("set-cookie") ?? "").split(";")[0];
const { room: slotsRoom } = await slotsRes.json();
const slotsControllers = [];
for (let i = 0; i < 2; i++) {
  const j = await fetch(`${BASE}/api/rooms/${slotsRoom}/join`, { method: "POST" });
  check(`fixed slots join ${i + 1}: 200`, j.status === 200);
  const c = (j.headers.get("set-cookie") ?? "").split(";")[0];
  slotsControllers.push(await connectWs(slotsRoom, { Cookie: c }));
}
const slotsOverflow = await fetch(`${BASE}/api/rooms/${slotsRoom}/join`, { method: "POST" });
check("fixed slots join past slot count: 409", slotsOverflow.status === 409);
for (const c of slotsControllers) c.ws.close();

const badSlots = await fetch(`${BASE}/api/rooms`, {
  method: "POST",
  body: JSON.stringify({ mode: "fixed", slots: 0 }),
});
check("invalid slots 400", badSlots.status === 400);

// --- teams mode: alternating seats, rebind by name, switch-hog filter (M10) ---
const teamsRes = await fetch(`${BASE}/api/rooms`, {
  method: "POST",
  body: JSON.stringify({ mode: "teams", slots: 2 }),
});
check("teams room: 201", teamsRes.status === 201);
const teamsCookie = (teamsRes.headers.get("set-cookie") ?? "").split(";")[0];
const { room: teamsRoom } = await teamsRes.json();
const teamsHost = await connectWs(teamsRoom, { Cookie: teamsCookie });
await waitFor(teamsHost, teamsHost.ws, (m) => m.type === "hello");

async function teamsSeat(name) {
  const j = await fetch(`${BASE}/api/rooms/${teamsRoom}/join`, { method: "POST" });
  if (!j.ok) return { ws: null, relay: undefined };
  const c = (j.headers.get("set-cookie") ?? "").split(";")[0];
  const conn = await connectWs(teamsRoom, { Cookie: c });
  const hello = await waitFor(conn, conn.ws, (m) => m.type === "hello");
  if (hello.sid === undefined) throw new Error("no sid in hello");
  conn.ws.send(JSON.stringify({ type: "team", config: { name, hogs: [] } }));
  const relay = await waitFor(teamsHost, teamsHost.ws, (m) => m.type === "team" && m.config && m.config.name === name);
  return { ws: conn.ws, sid: hello.sid, relay };
}
const alice = await teamsSeat("Alice");
check("seat 0 -> Alice", alice.relay.seat.slot === 0);
const bob = await teamsSeat("Bob");
check("seat 1 -> Bob", bob.relay.seat.slot === 1);
const carol = await teamsSeat("Carol");
check("seat 2 -> Carol", carol.relay.seat.slot === 2);
const dave = await teamsSeat("Dave");
check("seat 3 -> Dave", dave.relay.seat.slot === 3);
const eve = await teamsSeat("Eve");
check("seat overflow: join 409, no seat", eve.relay === undefined);

// re-registration with the same name rebinds the same seat (same sid)
alice.ws.send(JSON.stringify({ type: "team", config: { name: "Alice", hogs: [] } }));
const aliceRe = await waitFor(teamsHost, teamsHost.ws, (m) => m.type === "team" && m.config && m.config.name === "Alice");
check("rebind: Alice keeps seat 0", aliceRe.seat.slot === 0);

// switch-hog ammo selection is filtered in teams mode; portal-style bare s is not
// (it is Alice's turn: only the player on turn can send input at all)
teamsHost.ws.send(JSON.stringify({ type: "turn", team: "Alice hog", sid: alice.sid }));
await new Promise((r) => setTimeout(r, 200));
const preInputs = teamsHost.messages.filter((m) => m.type === "input").length;
alice.ws.send(JSON.stringify({ type: "input", action: "setweap \u0015" }));
alice.ws.send(JSON.stringify({ type: "input", action: "s" }));
await new Promise((r) => setTimeout(r, 400));
const newInputs = teamsHost.messages.filter((m) => m.type === "input").slice(preInputs);
check("setweap switcher filtered in teams mode",
      newInputs.some((m) => m.action === "s") && !newInputs.some((m) => m.action.startsWith("setweap")));

// cap: 2 teams x 2 hogs = 4 controllers
for (const w of [alice, bob, carol, dave, eve]) if (w.ws) w.ws.close();
teamsHost.ws.close();
await new Promise((r) => setTimeout(r, 300));

host.ws.close();
controller.ws.close();
bearer.ws.close();
await new Promise((r) => setTimeout(r, 300));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
