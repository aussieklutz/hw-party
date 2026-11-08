// fake-phone.mjs — scripted controller for stream-host local proofs.
// Joins the STREAM QUEUE (code-free URL), waits for admission, then plays.
// usage: node fake-phone.mjs <base> <teamName>
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "package.json"));
const WebSocket = require("ws");

const [base, teamName] = process.argv.slice(2);

let cookie = "";
async function joinQueue() {
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${base}/api/queue/join`, { method: "POST" });
    if (r.ok) {
      cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
      const data = await r.json();
      // during the countdown the queue admits on the spot
      if (data.admitted && data.room) {
        console.log("admitted immediately (countdown) to", data.room);
        enterRoom(data.room);
        return;
      }
      console.log("queued at", data.position);
      connectQueueWs();
      return;
    }
    console.log("queue join retry:", r.status);
    await new Promise((x) => setTimeout(x, 1500));
  }
  throw new Error("queue join failed");
}

const proto = base.replace(/^http/, "ws");

let roomWs = null;
let mySid = null;
let turns = 0;

function enterRoom(room) {
  console.log("admitted to room", room);
  // a stream room takes only the player the queue admitted: its session cookie says who
  fetch(`${base}/api/rooms/${room}/join`, { method: "POST", headers: cookie ? { cookie } : {} }).then((res) => {
    console.log("room join:", res.status);
    const rcookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    roomWs = new WebSocket(`${proto}/api/rooms/${room}/ws`, { headers: { cookie: rcookie } });
    roomWs.on("open", () => {
      // the prebuilt team registers itself the moment the room is open
      if (roomWs.readyState !== 1) return;
      roomWs.send(JSON.stringify({ type: "team", config: {
        name: teamName,
        hogs: [{ name: "Alpha1" }, { name: "Alpha2" }, { name: "Alpha3" }, { name: "Alpha4" }],
        flag: "hedgewars", grave: "Statue", voice: "Default",
      } }));
      console.log("team registered:", teamName);
    });
    roomWs.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "hello" && m.sid) mySid = m.sid;
      if (m.type === "state") console.log("state:", m.state, m.countdown ? `(in ${m.countdown}s)` : "");
      if (m.type === "turn") {
        const mine = m.sid != null && mySid != null && m.sid === mySid;
        console.log("turn:", m.team, mine ? "MINE" : "");
        if (mine && roomWs.readyState === 1) {
          turns++;
          if (process.env.AIM && turns <= 2) {
            // an airstrike: pick it, steer the cursor, put the target down, fire.
            // (cursor deltas and puts were once dropped by the agent for being malformed)
            const send = (o) => roomWs.readyState === 1 && roomWs.send(JSON.stringify(o));
            send({ type: "input", action: "setweap \u0010" });
            for (let i = 0; i < 10; i++) setTimeout(() => send({ type: "cursor", x: 25, y: -15 }), 500 + i * 60);
            setTimeout(() => send({ type: "put", x: 1200, y: 600 }), 1400);
            setTimeout(() => send({ type: "input", action: "+attack" }), 1800);
            setTimeout(() => send({ type: "input", action: "-attack" }), 2000);
            console.log("airstrike sequence sent");
          } else if (turns <= 2) {
            roomWs.send(JSON.stringify({ type: "input", action: "+right" }));
            setTimeout(() => roomWs.send(JSON.stringify({ type: "input", action: "-right" })), 700);
            setTimeout(() => roomWs.send(JSON.stringify({ type: "input", action: "J" })), 1000);
            setTimeout(() => {
              roomWs.send(JSON.stringify({ type: "input", action: "+attack" }));
              setTimeout(() => roomWs.send(JSON.stringify({ type: "input", action: "-attack" })), 800);
            }, 1400);
          }
        }
      }
      if (m.type === "released") {
        console.log("released — back to the queue");
        roomWs.close();
        joinQueue().then(() => connectQueueWs());
      }
    });
  });
}

function connectQueueWs() {
  if (!cookie) return;
  const qws = new WebSocket(`${proto}/api/queue/ws`, { headers: { cookie } });
  qws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "queue") console.log("queue position:", m.position, "/", m.total);
    if (m.type === "team-saved") console.log("team pre-built while queued");
    if (m.type === "phase") console.log("phase:", m.phase, m.endsAt ? `ends ${new Date(m.endsAt).toISOString().slice(11,19)}` : "", m.openSeats != null ? `openSeats=${m.openSeats}` : "");
    if (m.type === "admitted" && m.room) enterRoom(m.room);
  });
  qws.on("open", () => {
    console.log("queue ws open");
    // pre-build the team while queued so admission is instant
    qws.send(JSON.stringify({ type: "team", config: {
      name: teamName,
      hogs: [{ name: "Alpha1" }, { name: "Alpha2" }, { name: "Alpha3" }, { name: "Alpha4" }],
      flag: "hedgewars", grave: "Statue", voice: "Default",
    } }));
  });
}

joinQueue();

setTimeout(() => { console.log("turns driven:", turns); process.exit(0); }, 300000);
