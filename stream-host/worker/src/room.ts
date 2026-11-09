import { DurableObject } from "cloudflare:workers";
import type { SessionClaims } from "./auth";

interface WsMeta {
  sid: string;
  role: SessionClaims["role"];
  team?: string;
}

interface RoomConfig {
  code: string;
  createdAt: number;
  state: "lobby" | "ingame" | "ended";
  mode: PartyMode;
  slots?: number;
  maxPlayers?: number; // seat modes: most players in the room (default 2 x slots)
  activeTeam?: string;
  managed?: boolean; // stream-host room: joining requires queue admission
}

export type PartyMode = "classic" | "fixed" | "dynamic" | "teams" | "imposter";

export const PARTY_MODES: readonly PartyMode[] = ["classic", "fixed", "dynamic", "teams", "imposter"];

// Player (controller) cap per lobby style. Fixed lobbies cap at their slot
// count; teams (and imposter, which rides the teams seats) cap at 2x4 seats
// (M10 will make that configurable); the rest host at most 8 phones.
function capForRoom(config: { mode: PartyMode; slots?: number; maxPlayers?: number }): number {
  if (config.mode === "fixed") return Math.min(8, Math.max(1, config.slots ?? 4));
  // teams/imposter: the host says how many players it seats (up to 24: four
  // teams of 6); without that, slots = hogs per team across two teams
  if (config.mode === "teams" || config.mode === "imposter")
    return config.maxPlayers ?? Math.min(16, 2 * Math.min(8, Math.max(1, config.slots ?? 4)));
  return 8;
}

const MAX_TEAM_NAME = 40;
const MAX_INPUT = 256;
const VIEW_MAX = 96 * 1024; // one close-up frame (a small JPEG), host -> the active player

const INPUT_RE = /^(\+[a-z]+|\-[a-z]+|(?:p|P)\s+-?\d+\s+-?\d+|[1-5]|[jJstZz]|slot\s+\d+|setweap\s+[\x01-\x7e])$/;
const TEXT_RE = /^[\x20-\x7e]{0,100}$/;

interface RoomRosterEntry {
  sid: string;
  config: unknown;
  seat?: { slot: number; name: string };
}

export class RoomDO extends DurableObject {
  private config?: RoomConfig;
  private lastTurn: { team: string; sid?: string } | null = null;
  private lastState: string | null = null;
  private lastPing: Record<string, number> = {}; // sid -> ms, controller heartbeats

  // Durable Objects hibernate between messages: in-memory fields (this.config,
  // lastState, lastTurn) vanish on eviction. Everything a handler needs must
  // be (re)loaded from storage — the create-time values only seed the cache.
  private async configNow(): Promise<RoomConfig | undefined> {
    if (!this.config)
      this.config = await this.ctx.storage.get<RoomConfig>("config");
    return this.config;
  }

  private async replayVolatile(): Promise<void> {
    if (this.lastState === null)
      this.lastState = (await this.ctx.storage.get<string>("lastState")) ?? null;
    if (this.lastTurn === null)
      this.lastTurn = (await this.ctx.storage.get<{ team: string; sid?: string }>("lastTurn")) ?? null;
  }

  private async relayView(data: ArrayBuffer): Promise<void> {
    if (data.byteLength < 8 || data.byteLength > VIEW_MAX) return;
    const bytes = new Uint8Array(data);
    const n = bytes[0];
    if (n === 0 || 1 + n >= bytes.length) return;
    const sid = new TextDecoder().decode(bytes.subarray(1, 1 + n));
    await this.replayVolatile();
    if (!this.lastTurn?.sid || this.lastTurn.sid !== sid) return;
    const jpeg = data.slice(1 + n);
    for (const cws of this.ctx.getWebSockets()) {
      const cmeta = cws.deserializeAttachment() as WsMeta;
      if (cmeta.role === "controller" && cmeta.sid === sid) cws.send(jpeg);
    }
  }

  private async roster(): Promise<Record<string, RoomRosterEntry>> {
    return (await this.ctx.storage.get<Record<string, RoomRosterEntry>>("roster")) ?? {};
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const aliveMatch = url.pathname.match(/^\/alive\/([\w-]+)$/);
    if (aliveMatch) {
      // host-only: is a controller's heartbeat fresh? (a phone asleep stops
      // pinging -> alive goes false; used for the AFK turn countdown)
      const sid = aliveMatch[1];
      const last = this.lastPing[sid];
      const age = last ? Date.now() - last : null;
      return Response.json({ sid, alive: age != null && age < 15000, ageMs: age });
    }
    switch (url.pathname) {
      case "/create":
        return this.handleCreate(req);
      case "/join":
        return this.handleJoin(req);
      case "/ws":
        return this.handleWs(req);
      case "/release":
        // the round is over: every registered controller goes back to the
        // stream queue (their webapp re-joins with a fresh position). Storing
        // the state means a controller that reconnects after missing the
        // broadcast still learns the room is dead and re-queues itself.
        this.lastState = "released";
        await this.ctx.storage.put("lastState", "released");
        this.broadcast({ type: "released" }, "controller");
        return Response.json({ ok: true });
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleCreate(req: Request): Promise<Response> {
    const body = await req.json<{ sid?: string; mode?: string; slots?: number; managed?: boolean; maxPlayers?: number }>().catch(
      () => ({}) as { sid?: string; mode?: string; slots?: number; managed?: boolean; maxPlayers?: number },
    );
    const sid = body.sid;
    if (!sid) return new Response("bad request", { status: 400 });
    const mode = (body.mode ?? "classic") as PartyMode;
    if (!PARTY_MODES.includes(mode)) return new Response("bad mode", { status: 400 });
    let slots: number | undefined;
    if (body.slots !== undefined) {
      if (typeof body.slots !== "number" || !Number.isInteger(body.slots) || body.slots < 1 || body.slots > 8) {
        return new Response("bad slots", { status: 400 });
      }
      slots = body.slots;
    }
    let maxPlayers: number | undefined;
    if (body.maxPlayers !== undefined) {
      if (typeof body.maxPlayers !== "number" || !Number.isInteger(body.maxPlayers) || body.maxPlayers < 2 || body.maxPlayers > 24) {
        return new Response("bad maxPlayers", { status: 400 });
      }
      maxPlayers = body.maxPlayers;
    }
    const existing = await this.ctx.storage.get<RoomConfig>("config");
    if (existing) return new Response("room exists", { status: 409 });
    const config: RoomConfig = {
      code: this.ctx.id.name!,
      createdAt: Date.now(),
      state: "lobby",
      mode,
      slots,
      maxPlayers,
      managed: body.managed === true,
    };
    await this.ctx.storage.put("config", config);
    this.config = config;
    console.log(`[room] created code=${config.code} mode=${mode} slots=${slots}`);
    return Response.json({ ok: true, sid });
  }

  // distinct controller sessions, optionally not counting one sid (a player
  // reconnecting replaces its own old socket, it is not an extra player)
  private countControllers(exceptSid?: string): number {
    const sids = new Set<string>();
    for (const hws of this.ctx.getWebSockets()) {
      const meta = hws.deserializeAttachment() as WsMeta;
      if (meta.role === "controller" && meta.sid !== exceptSid) sids.add(meta.sid);
    }
    return sids.size;
  }

  private async handleJoin(req: Request): Promise<Response> {
    const body = await req
      .json<{ sid?: string; player?: string; admitted?: boolean; name?: string }>()
      .catch(() => ({}) as { sid?: string; player?: string; admitted?: boolean; name?: string });
    const sid = body.sid;
    if (!sid) return new Response("bad request", { status: 400 });
    const config = this.config ?? (await this.ctx.storage.get<RoomConfig>("config"));
    if (!config) return new Response("no such room", { status: 404 });
    if (config.state === "ended") return new Response("room ended", { status: 410 });
    // the stream host's room takes only players the queue admitted into it
    if (config.managed && body.admitted !== true) return new Response("not admitted", { status: 403 });
    if (this.countControllers(sid) >= capForRoom(config)) {
      return new Response("room full", { status: 409 });
    }
    if (config.managed) {
      // the stream's screen name is decided server-side (the player's signed-in
      // account, or an AnonAlpha-style name) - never by the phone
      if (typeof body.name !== "string" || !body.name) return new Response("no identity", { status: 403 });
      const idents = (await this.ctx.storage.get<Record<string, string>>("idents")) ?? {};
      idents[sid] = body.name.slice(0, 40);
      await this.ctx.storage.put("idents", idents);
    }
    return Response.json({ ok: true, sid });
  }

  private async handleWs(req: Request): Promise<Response> {
    const claimsHeader = req.headers.get("x-hw-session");
    if (!claimsHeader) return new Response("unauthorized", { status: 401 });
    let claims: SessionClaims;
    try {
      claims = JSON.parse(atob(claimsHeader.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return new Response("unauthorized", { status: 401 });
    }
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const config = this.config ?? (await this.ctx.storage.get<RoomConfig>("config"));
    if (!config) return new Response("no such room", { status: 404 });
    if (claims.role !== "host" && this.countControllers(claims.sid) >= capForRoom(config)) {
      return new Response("room full", { status: 409 });
    }
    const pair = new WebSocketPair();
    const meta: WsMeta = { sid: claims.sid, role: claims.role, team: claims.team };
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(meta);
    // one live socket per controller session: a new tab/reconnect replaces
    // the old socket instead of stacking (a player cannot fill the room with
    // their own sockets, and a stale tab closing cannot kick the live one)
    if (meta.role === "controller") {
      for (const old of this.ctx.getWebSockets()) {
        if (old === pair[1]) continue;
        const om = old.deserializeAttachment() as WsMeta;
        if (om.role === "controller" && om.sid === meta.sid) {
          try { old.close(4000, "replaced"); } catch {}
        }
      }
    }
    if (meta.role === "host") {
      pair[1].send(JSON.stringify({ type: "hello", role: "host", room: claims.room, mode: config.mode }));
      // host reconnect: replay the room state and every live registration so
      // the host catches up after a dropped socket (phones keep registering
      // while the host is away; the front end dedupes by sid on its side)
      if (this.lastState) pair[1].send(JSON.stringify({ type: "state", state: this.lastState, mode: config.mode }));
      const roster = await this.roster();
      for (const entry of Object.values(roster)) {
        pair[1].send(
          JSON.stringify(
            entry.seat
              ? { type: "team", sid: entry.sid, config: entry.config, seat: entry.seat }
              : { type: "team", sid: entry.sid, config: entry.config },
          ),
        );
      }
    } else {
      pair[1].send(JSON.stringify({ type: "hello", role: meta.role, room: claims.room, mode: config.mode, sid: meta.sid }));
      if (this.lastState) pair[1].send(JSON.stringify({ type: "state", state: this.lastState, mode: config.mode }));
      if (this.lastTurn)
        pair[1].send(JSON.stringify({ type: "turn", team: this.lastTurn.team, ...(this.lastTurn.sid ? { sid: this.lastTurn.sid } : {}) }));
      this.broadcast({ type: "joined", sid: meta.sid }, "host");
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // A controller socket is untrusted: it gets a token bucket, so a flood costs
  // the room almost nothing. Real play peaks near 66 messages a second (the
  // pointer pad ticks every 15 ms); the bucket allows 120 a second sustained
  // with a burst of 200. In memory only: a hibernated DO simply starts a full
  // bucket, which a client cannot exploit (it cannot make the DO hibernate).
  private bucket: Record<string, { tokens: number; at: number }> = {};
  private allow(sid: string): boolean {
    const now = Date.now();
    const b = this.bucket[sid] ?? { tokens: 200, at: now };
    b.tokens = Math.min(200, b.tokens + (now - b.at) * 0.12);
    b.at = now;
    this.bucket[sid] = b;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      // the host's close-up of the active hog: [sid length][sid][jpeg], relayed to that one player's phone
      // and only while it is their turn
      const host = ws.deserializeAttachment() as WsMeta;
      if (host.role === "host") await this.relayView(message);
      return;
    }
    if (message.length > MAX_INPUT * 4) return;
    const meta = ws.deserializeAttachment() as WsMeta;
    if (meta.role !== "host" && !this.allow(meta.sid)) return;
    const config = await this.configNow();
    await this.replayVolatile();
    let msg: {
      type?: string;
      action?: string;
      x?: number;
      y?: number;
      sid?: unknown;
      team?: unknown;
      state?: unknown;
      config?: unknown;
    };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    switch (msg.type) {
      case "ping":
        // controller heartbeat: the page pings while it can (a sleeping
        // phone stops pinging) — the host checks liveness at turn starts
        // through /alive/<sid> and counts an AFK player down before skipping
        if (meta.role === "controller") {
          this.lastPing[meta.sid] = Date.now();
          ws.send(JSON.stringify({ type: "pong" }));
        }
        return;
      case "input":
        if (meta.role !== "controller" || typeof msg.action !== "string") return;
        if (msg.action.length > MAX_INPUT || !INPUT_RE.test(msg.action)) return;
        // only the player whose turn it is may drive the game: the host
        // checks this too, dropping here keeps everyone else's traffic off it
        if (!this.lastTurn?.sid || this.lastTurn.sid !== meta.sid) return;
        // teams mode: block selecting the Switch Hedgehog ammo (the ammo
        // store is masked anyway; this is defence in depth). gmSwitch stays
        // available for weapon-contextual uses (portal colour flip etc.).
        if ((config?.mode === "teams" || config?.mode === "imposter") && /^setweap\s+\u0015$/.test(msg.action)) return;
        this.relayToHost({ type: "input", team: meta.team ?? null, sid: meta.sid, action: msg.action });
        return;
      case "cursor":
      case "put":
        if (meta.role !== "controller" || typeof msg.x !== "number" || typeof msg.y !== "number") return;
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
        // pointer deltas are small integers: anything else is not a phone
        if (Math.abs(msg.x) > 10_000 || Math.abs(msg.y) > 10_000) return;
        if (!this.lastTurn?.sid || this.lastTurn.sid !== meta.sid) return;
        this.relayToHost({ type: msg.type, team: meta.team ?? null, sid: meta.sid, x: msg.x, y: msg.y });
        return;
      case "team": {
        if (meta.role !== "controller") return;
        if (typeof (msg as { config?: unknown }).config !== "object" || (msg as { config?: unknown }).config === null) return;
        // `verified` tells the host the name needs no safeword filtering; only
        // this room may say so, never a phone
        const sent = { ...((msg as { config: Record<string, unknown> }).config) };
        delete sent.verified;
        let relayed: Record<string, unknown> = sent;
        if (config?.managed) {
          const idents = (await this.ctx.storage.get<Record<string, string>>("idents")) ?? {};
          const name = idents[meta.sid];
          if (!name) return; // not admitted through the queue: no stream identity, no team
          // The stream decides the name, outright: the screen name bound to the
          // account (or the AnonX name) IS the team name in the standard modes,
          // and IS the hog's name in the team/imposter modes (one player, one
          // hog, so typed hog names mean nothing there). Nothing else a phone
          // sends is trusted beyond a bounded, plain-text shape.
          relayed = { name, verified: true };
          if (config.mode !== "teams" && config.mode !== "imposter") {
            const plain = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_ .\-]{1,40}$/.test(v) ? v : undefined);
            for (const k of ["flag", "grave", "voice"] as const) {
              const v = plain(sent[k]);
              if (v) relayed[k] = v;
            }
            if (Array.isArray(sent.hogs)) {
              relayed.hogs = sent.hogs.slice(0, 4).map((h) => ({
                name: typeof (h as { name?: unknown })?.name === "string" ? ((h as { name: string }).name).slice(0, 50) : undefined,
              }));
            }
          }
        }
        (msg as { config: unknown }).config = relayed;
        if (config?.mode !== "teams" && config?.mode !== "imposter") {
          const cfg = (msg as { config: unknown }).config as RoomRosterEntry["config"];
          const roster = await this.roster();
          roster[meta.sid] = { sid: meta.sid, config: cfg };
          await this.ctx.storage.put("roster", roster);
          this.relayToHost({ type: "team", sid: meta.sid, config: cfg });
          return;
        }
        // M10: assign the next free seat (alternating between the two teams:
        // even slots are team A hogs, odd slots team B hogs). Seats are keyed
        // by screen name so a reconnecting player reclaims the same seat.
        const cfg = (msg as { config: { name?: unknown } }).config;
        const name =
          typeof cfg.name === "string" && cfg.name.trim().length > 0
            ? cfg.name.trim().slice(0, 40)
            : `Player ${meta.sid.slice(0, 4)}`;
        const seatCount = config ? capForRoom(config) : 8;
        const seats = (await this.ctx.storage.get<Record<string, { slot: number; sid: string }>>("seats")) ?? {};
        let seat = seats[name];
        // a seat is keyed by name so a reconnecting player gets it back - but a
        // DIFFERENT connection typing the name of a seat whose owner is still
        // connected must not take it over
        if (seat && seat.sid !== meta.sid) {
          const ownerLive = this.ctx.getWebSockets().some((w) => {
            const m = w.deserializeAttachment() as WsMeta;
            return m.role === "controller" && m.sid === seat!.sid;
          });
          if (ownerLive) {
            console.log(`[seat] REFUSED takeover room=${this.ctx.id.name} name=${name}`);
            this.relayToHost({ type: "team", sid: meta.sid, config: cfg });
            return;
          }
        }
        if (!seat) {
          const used = new Set(Object.values(seats).map((x) => x.slot));
          let slot = 0;
          while (used.has(slot) && slot < seatCount) slot++;
          if (slot >= seatCount) {
            console.log(`[seat] FULL room=${this.ctx.id.name} name=${name} used=${used.size}/${seatCount}`);
            this.relayToHost({ type: "team", sid: meta.sid, config: cfg });
            return;
          }
          seat = { slot, sid: meta.sid };
        } else {
          seat.sid = meta.sid;
        }
        seats[name] = seat;
        await this.ctx.storage.put("seats", seats);
        console.log(`[seat] assigned room=${this.ctx.id.name} slot=${seat.slot} name=${name}`);
        const roster = await this.roster();
        roster[meta.sid] = { sid: meta.sid, config: cfg, seat: { slot: seat.slot, name } };
        await this.ctx.storage.put("roster", roster);
        this.relayToHost({ type: "team", sid: meta.sid, config: cfg, seat: { slot: seat.slot, name } });
        return;
      }
      case "notify":
      case "seat":
      case "release":
        // host -> ONE controller (the imposter reveal, "you are seated on Red /
        // waiting for a partner", "back to the queue"): routed by sid so no
        // other phone ever sees it
        if (meta.role !== "host" || typeof msg.sid !== "string") return;
        for (const cws of this.ctx.getWebSockets()) {
          const cmeta = cws.deserializeAttachment() as WsMeta;
          if (cmeta.role !== "controller" || cmeta.sid !== msg.sid) continue;
          if (msg.type === "release") {
            // the page answers "released" by rejoining the queue
            cws.send(JSON.stringify({ type: "state", state: "released" }));
            cws.close(4001, "released");
          } else {
            const { type, sid, ...rest } = msg;
            cws.send(JSON.stringify({ type: msg.type, ...rest }));
          }
        }
        return;
      case "turn":
      case "state":
      case "roster":
      case "weapons":
      case "afk": // the AFK countdown banner: host -> every phone (the active player acts on it)
        if (meta.role !== "host") return;
        if (msg.type === "turn") {
          // keep the sid with the team: a reconnecting controller replays this
          // turn and must match it by sid (hog names may be safeworded)
          this.lastTurn = typeof msg.team === "string"
            ? { team: msg.team, ...(typeof msg.sid === "string" ? { sid: msg.sid } : {}) }
            : null;
          await this.ctx.storage.put("lastTurn", this.lastTurn);
        }
        if (msg.type === "state" && typeof msg.state === "string") {
          this.lastState = msg.state;
          await this.ctx.storage.put("lastState", this.lastState);
          // nobody holds a turn once the game is not running (lobby, ended,
          // released): a stale "your turn" must not outlive the game
          if (msg.state !== "ingame") {
            this.lastTurn = null;
            await this.ctx.storage.put("lastTurn", this.lastTurn);
          }
        }
        if (msg.type === "state" && config) {
          this.broadcast({ ...msg, mode: config.mode }, "controller");
        } else {
          this.broadcast(msg, "controller");
        }
        return;
      default:
        return;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as WsMeta;
    const config = await this.configNow();
    await this.replayVolatile();
    if (meta.role === "controller") {
      // a replaced/duplicate socket closing is not the player leaving
      const stillHere = this.ctx.getWebSockets().some((w) => {
        if (w === ws || w.readyState !== 1) return false;
        const m = w.deserializeAttachment() as WsMeta;
        return m.role === "controller" && m.sid === meta.sid;
      });
      if (stillHere) return;
      this.broadcast({ type: "left", sid: meta.sid, team: meta.team }, "host");
      // the departed player's registration leaves the roster replay unless
      // the room is in the lobby: there the front end has already dropped
      // the team, so replaying it would resurrect a stale registration.
      // Teams mode keeps mid-game seats reserved for rejoining players.
      const inLobby = this.lastState !== "ingame";
      const roster = await this.roster();
      if (inLobby || (config?.mode !== "teams" && config?.mode !== "imposter")) {
        if (roster[meta.sid]) {
          delete roster[meta.sid];
          await this.ctx.storage.put("roster", roster);
        }
      }
      // teams mode: in the lobby a departed player frees their seat for the
      // next joiner; mid-game seats stay reserved so a reconnect reclaims them
      if ((config?.mode === "teams" || config?.mode === "imposter") && inLobby) {
        const seats = (await this.ctx.storage.get<Record<string, { slot: number; sid: string }>>("seats")) ?? {};
        let changed = false;
        for (const [name, seat] of Object.entries(seats)) {
          if (seat.sid === meta.sid) {
            delete seats[name];
            changed = true;
          }
        }
        if (changed) await this.ctx.storage.put("seats", seats);
      }
    } else if (meta.role === "host") {
      // the host's registrations stay in the roster: on reconnect the host
      // receives them again and its front end dedupes by sid
    }
  }

  private relayToHost(msg: unknown): void {
    for (const hws of this.ctx.getWebSockets()) {
      const meta = hws.deserializeAttachment() as WsMeta;
      if (meta.role === "host") hws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: unknown, to: WsMeta["role"]): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as WsMeta;
      if (meta.role === to) ws.send(data);
    }
  }
}
