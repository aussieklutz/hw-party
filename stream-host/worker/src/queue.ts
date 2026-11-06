// QueueDO — the stream's waiting line. Players join through the constant
// (code-free) URL, see their live position, and get popped into a round's
// room by the stream host. The DO also carries the stream's slate state:
// the between-games phase, the countdown, the last game's commentary lines
// and the all-time scoreboard tally the slides page renders.
import { DurableObject } from "cloudflare:workers";

interface QueueEntry {
  sid: string;
  name: string;
  config?: unknown; // team config prebuilt while queued
  at?: number; // when the entry joined (unconnected entries expire)
}

// a player's stream identity, decided HERE (never by the client): either a
// signed-in account (name + `sub`, both from the identity token the stream
// worker verified) or an AnonAlpha-style name for players without an account
interface Identity {
  name: string;
  sub?: string;
}

const ANON_LETTERS = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu",
  "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega",
];
// no-account names are not on the ladder (they are recycled between people)
export const isAnonName = (name: string) => /^Anon[A-Z][a-z]+\d*$/.test(name);

// anonymous queue input is bounded: a name, a prebuilt team config and the
// queue itself must not be a way to wedge the Durable Object's storage or to
// park phantom players at the front of the line
const MAX_NAME = 40;
const MAX_CONFIG_JSON = 2048;
const MAX_WS_MESSAGE = 4096;
const MAX_QUEUE = 200;
const UNCONNECTED_TTL_MS = 60_000;
// a lobby that has been opened (or had its first batch admitted) but is not
// counting down yet still absorbs arrivals, for at most this long: it covers
// the host's longest lobby wait, and a dead host cannot absorb players forever
const LOBBY_OPEN_MAX_MS = 6 * 60_000;

// the round's lobby seats as the host sees them: humans carry their team
// name, CPU fillers are flagged, empty seats are absent
interface Seat {
  name: string;
  cpu?: boolean;
}

// a team as the slides draw it: at least 3 rows, growing with the players
// seated; a null row is an open seat
interface RosterTeam {
  name: string;
  color: number;
  seats: ({ name: string } | null)[];
}

interface Roster {
  seats: Seat[]; // everyone in, flat (older slides)
  openSeats: number;
  capacity: number;
  teams?: RosterTeam[];
  waiting?: { name: string }[]; // in the lobby, not seated yet
  joined?: number;
}

const cleanRosterName = (n: unknown) => (typeof n === "string" ? n.slice(0, MAX_NAME) : "");

function cleanRoster(r: Partial<Roster>): Roster {
  const roster: Roster = {
    seats: (Array.isArray(r.seats) ? r.seats : []).slice(0, 48).map((x) => ({ name: cleanRosterName(x?.name), ...(x?.cpu ? { cpu: true } : {}) })),
    openSeats: Math.max(0, Math.floor(Number(r.openSeats) || 0)),
    capacity: Math.max(0, Math.floor(Number(r.capacity) || 0)),
  };
  if (Array.isArray(r.teams)) {
    roster.teams = r.teams.slice(0, 4).map((t) => ({
      name: cleanRosterName(t?.name),
      color: Number.isFinite(t?.color) ? Math.floor(t.color) & 0xffffff : 0xffffff,
      seats: (Array.isArray(t?.seats) ? t.seats : []).slice(0, 8).map((x) => (x ? { name: cleanRosterName(x.name) } : null)),
    }));
    roster.waiting = (Array.isArray(r.waiting) ? r.waiting : []).slice(0, 24).map((x) => ({ name: cleanRosterName(x?.name) }));
    roster.joined = Math.max(0, Math.floor(Number(r.joined) || 0));
  }
  return roster;
}

interface LadderEntry {
  games: number;
  wins: number;
  kills: number;
}

export class QueueDO extends DurableObject {
  private queue: QueueEntry[] = [];
  private popped: Record<string, string> = {}; // sid -> room they were admitted into
  private ident: Record<string, Identity> = {}; // sid -> who they play as (queued or admitted)
  // players the host sent back to the front of the queue (still unseated when
  // their round started): sid -> expiry. They keep their round session, so
  // rejoining reuses their sid and the place reserved for it.
  private requeued: Record<string, number> = {};
  private capacity = 0; // most players the open round takes (0 = no limit known)
  // the host's game mode (classic | fixed | dynamic | teams | imposter): phones
  // shape their registration form from it before they ever reach the room
  private mode = "";
  private phase: "slate" | "lobby" | "countdown" | "ingame" = "slate";
  private roundRoom: string | null = null;
  private roundCount = 1;
  private countdownEndsAt: number | null = null;
  private openSeats = 0;
  // imposter rounds keep the teams even: after the host's first batch, players
  // only leave the queue in pairs (a lone arrival waits for a partner)
  private pairsOnly = false;
  private phaseAt = 0; // when the host last moved the round (phase/admit/countdown)
  private lastgame: { lines: string[]; winner: string } | null = null;
  private turnafk: { team: string; endsAt: number } | null = null;
  private ladder: Record<string, LadderEntry> = {};
  private roster: Roster = { seats: [], openSeats: 0, capacity: 0 };

  private async load() {
    const stored = await this.ctx.storage.get<{
      queue: QueueEntry[];
      phase: QueueDO["phase"];
      roundRoom: string | null;
      roundCount: number;
      openSeats?: number;
      pairsOnly?: boolean;
      phaseAt?: number;
      countdownEndsAt?: number | null;
      popped?: Record<string, string>;
      ident?: Record<string, Identity>;
      requeued?: Record<string, number>;
      capacity?: number;
      mode?: string;
      lastgame: QueueDO["lastgame"];
      ladder: Record<string, LadderEntry>;
      roster?: Roster;
    }>("state");
    if (stored) {
      this.queue = stored.queue ?? [];
      this.phase = stored.phase ?? "slate";
      this.roundRoom = stored.roundRoom ?? null;
      this.roundCount = stored.roundCount ?? 1;
      this.openSeats = stored.openSeats ?? 0;
      this.pairsOnly = stored.pairsOnly ?? false;
      this.phaseAt = stored.phaseAt ?? 0;
      this.countdownEndsAt = stored.countdownEndsAt ?? null;
      this.popped = stored.popped ?? {};
      this.ident = stored.ident ?? {};
      this.capacity = stored.capacity ?? 0;
      this.mode = stored.mode ?? "";
      const nowMs = Date.now();
      this.requeued = Object.fromEntries(Object.entries(stored.requeued ?? {}).filter(([, exp]) => exp > nowMs));
      this.lastgame = stored.lastgame ?? null;
      this.ladder = stored.ladder ?? {};
      this.roster = stored.roster ?? { seats: [], openSeats: 0, capacity: 0 };
    }
  }

  private async save() {
    // identities live only as long as the player is queued or admitted
    for (const sid of Object.keys(this.ident)) {
      if (!this.popped[sid] && !this.queue.some((e) => e.sid === sid)) delete this.ident[sid];
    }
    await this.ctx.storage.put("state", {
      queue: this.queue,
      phase: this.phase,
      roundRoom: this.roundRoom,
      roundCount: this.roundCount,
      openSeats: this.openSeats,
      pairsOnly: this.pairsOnly,
      phaseAt: this.phaseAt,
      countdownEndsAt: this.countdownEndsAt,
      popped: this.popped,
      ident: this.ident,
      requeued: this.requeued,
      capacity: this.capacity,
      mode: this.mode,
      lastgame: this.lastgame,
      turnafk: this.turnafk,
      ladder: this.ladder,
      roster: this.roster,
    });
  }

  private broadcast(msg: unknown) {
    for (const ws of this.ctx.getWebSockets())
      ws.send(JSON.stringify(msg));
  }

  // a message for ONE queued player: admission carries the round's room code,
  // so it must never reach the other people waiting in line
  private sendTo(sid: string, msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as { sid?: string } | null;
      if (meta?.sid === sid) ws.send(data);
    }
  }

  // entries that never opened their queue socket are phantom joins (a script
  // POSTing /api/queue/join): drop them after a short grace period
  private pruneUnconnected(): boolean {
    const live = new Set(
      this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as { sid?: string } | null)?.sid),
    );
    const now = Date.now();
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => live.has(e.sid) || now - (e.at ?? 0) < UNCONNECTED_TTL_MS);
    return this.queue.length !== before;
  }

  // who can actually be admitted: entries with a live queue socket, or ones
  // that only just joined (their socket is about to open). A phantom join that
  // never connects is skipped, so it can neither take a seat nor act as the
  // "partner" that pairs a real player in.
  private eligible(): QueueEntry[] {
    const live = new Set(
      this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as { sid?: string } | null)?.sid),
    );
    const now = Date.now();
    return this.queue.filter((e) => live.has(e.sid) || now - (e.at ?? 0) < 3000);
  }

  private static cleanConfig(config: unknown): unknown | undefined {
    if (typeof config !== "object" || config === null) return undefined;
    try {
      return JSON.stringify(config).length <= MAX_CONFIG_JSON ? config : undefined;
    } catch {
      return undefined;
    }
  }

  // players admitted into the open round and still in it (the host reports
  // lobby drops with /drop)
  private inRound(): number {
    return Object.values(this.popped).filter((r) => r === this.roundRoom).length;
  }
  private roomLeft(): number {
    return this.capacity > 0 ? Math.max(0, this.capacity - this.inRound()) : Infinity;
  }

  private identify(acctName: string | undefined, sub: string | undefined): Identity {
    if (typeof acctName === "string" && acctName && typeof sub === "string" && sub) {
      return { name: acctName.slice(0, MAX_NAME), sub: sub.slice(0, 64) };
    }
    const taken = new Set(Object.values(this.ident).map((i) => i.name.toLowerCase()));
    for (let round = 0; ; round++) {
      for (const letter of ANON_LETTERS) {
        const name = `Anon${letter}${round ? round + 1 : ""}`;
        if (!taken.has(name.toLowerCase())) return { name };
      }
    }
  }

  // one account, one seat: a name or account already queued or in a round
  // cannot join again (two phones under one name would fight over the seat).
  // A holder whose queue socket is gone (a page reconnecting) is stale and is
  // dropped; one that is admitted into a round is not.
  private clashingHolder(sid: string, me: Identity): "ok" | "busy" {
    if (!me.sub) return "ok"; // anon names are unique by construction
    const live = new Set(
      this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as { sid?: string } | null)?.sid),
    );
    for (const [other, id] of Object.entries(this.ident)) {
      if (other === sid) continue;
      if (id.sub !== me.sub && id.name.toLowerCase() !== me.name.toLowerCase()) continue;
      const entry = this.queue.find((e) => e.sid === other);
      const justJoined = !!entry && Date.now() - (entry.at ?? 0) < 3000; // its socket is still opening
      if (this.popped[other] || live.has(other) || justJoined) return "busy";
      this.queue = this.queue.filter((e) => e.sid !== other); // stale queue entry
      delete this.ident[other];
    }
    return "ok";
  }

  private positionFor(sid: string): number {
    return this.queue.findIndex((e) => e.sid === sid) + 1;
  }

  private pushQueueState() {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as { sid?: string };
      const sid = meta?.sid ?? "";
      const pos = this.positionFor(sid);
      const admittedRoom = this.popped[sid];
      ws.send(JSON.stringify(
        pos > 0
          ? { type: "queue", position: pos, total: this.queue.length }
          : admittedRoom
            ? { type: "queue", position: 0, total: this.queue.length, admitted: true, room: admittedRoom }
            : { type: "queue", position: 0, total: this.queue.length },
      ));
    }
  }

  override async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);

    if (url.pathname === "/join" && req.method === "POST") {
      const { sid, name: acctName, sub } = await req.json<{ sid: string; name?: string; sub?: string }>();
      this.pruneUnconnected();
      if (this.queue.length >= MAX_QUEUE && !this.queue.some((e) => e.sid === sid))
        return new Response("queue full", { status: 503 });
      // who this player is: a signed-in account (name + sub, vouched for by the
      // identity token the stream worker verified) or the next free AnonX name
      const me = this.ident[sid] ?? this.identify(acctName, sub);
      const clash = this.clashingHolder(sid, me);
      if (clash === "busy") {
        return new Response("this account is already queued or playing in a round", { status: 409 });
      }
      // a stale countdown (agent gone) must not keep absorbing players into
      // a dead room
      const countdownLive = this.countdownEndsAt != null
        && this.countdownEndsAt > Date.now() - 10000;
      // open = taking arrivals: a fresh lobby, a live countdown, or a lobby
      // whose first batch was admitted and whose countdown has not begun
      // (imposter rounds wait there until six players have seated)
      const fresh = Date.now() - this.phaseAt < LOBBY_OPEN_MAX_MS;
      const roundOpen = !!this.roundRoom
        && ((this.phase === "lobby" && fresh)
          || (this.phase === "countdown" && (countdownLive || (this.countdownEndsAt == null && fresh))));
      if (!this.queue.some((e) => e.sid === sid)) {
        this.ident[sid] = me;
        this.queue.push({ sid, name: me.name, at: Date.now() });
        // an open round absorbs arrivals on the spot so the lobby fills
        // while the countdown runs
        const elig = this.eligible();
        if (roundOpen && this.roomLeft() > 0 && (!this.pairsOnly || elig.length >= 2)) {
          // pairs-only rounds absorb the two longest-waiting players together
          const entries = elig.slice(0, Math.min(this.pairsOnly ? 2 : 1, this.roomLeft()));
          this.queue = this.queue.filter((e) => !entries.includes(e));
          for (const entry of entries) this.popped[entry.sid] = this.roundRoom!;
          await this.save();
          for (const entry of entries)
            this.sendTo(entry.sid, { type: "admitted", room: this.roundRoom });
          this.pushQueueState();
          // the caller is admitted now unless it is still queued (only
          // possible if it was not among the two admitted)
          if (entries.some((e) => e.sid === sid))
            return Response.json({ admitted: true, room: this.roundRoom, name: me.name });
          return Response.json({ position: this.positionFor(sid), total: this.queue.length, name: me.name });
        }
        await this.save();
      }
      this.pushQueueState();
      return Response.json({ position: this.positionFor(sid), total: this.queue.length, name: me.name });
    }

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const sid = req.headers.get("x-hw-queue-sid") ?? "";
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      (pair[1] as unknown as { serializeAttachment: (a: unknown) => void })
        .serializeAttachment({ sid });
      this.pushQueueState();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/phase" && req.method === "POST") {
      const { phase, room, count, openSeats, pairs, capacity, mode } = await req.json<{
        phase: QueueDO["phase"]; room?: string; count?: number; openSeats?: number; pairs?: boolean; capacity?: number; mode?: string;
      }>();
      if (typeof mode === "string" && /^[a-z]{1,12}$/.test(mode)) this.mode = mode;
      this.phase = phase;
      this.phaseAt = Date.now();
      this.roundRoom = room ?? null;
      this.roundCount = count ?? this.roundCount;
      this.openSeats = openSeats ?? this.openSeats;
      this.pairsOnly = pairs === true; // a host that does not ask for pairs gets singles
      if (typeof capacity === "number" && capacity >= 0) this.capacity = Math.min(64, Math.floor(capacity));
      if (phase === "countdown") this.popped = {};
      if (phase === "slate" || phase === "lobby") this.countdownEndsAt = null;
      if (phase === "slate") this.roster = { seats: [], openSeats: 0, capacity: 0 };
      await this.save();
      this.broadcast({ type: "phase", phase, room: this.roundRoom, endsAt: this.countdownEndsAt, openSeats: this.openSeats, mode: this.mode });
      this.pushQueueState();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/countdown" && req.method === "POST") {
      const { endsAt, openSeats } = await req.json<{ endsAt: number; openSeats?: number }>();
      this.countdownEndsAt = endsAt;
      this.phaseAt = Date.now();
      this.phase = "countdown";
      this.openSeats = openSeats ?? this.openSeats;
      await this.save();
      this.broadcast({ type: "phase", phase: "countdown", room: this.roundRoom, endsAt, openSeats: this.openSeats });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/admit" && req.method === "POST") {
      const { room, count } = await req.json<{ room: string; count: number }>();
      const batch: QueueEntry[] = [];
      // pairs-only: an even batch (an odd leftover waits for its partner)
      const elig = this.eligible();
      let take = Math.min(Math.max(1, count), elig.length, this.roomLeft());
      if (this.pairsOnly) take -= take % 2;
      batch.push(...elig.slice(0, take));
      this.queue = this.queue.filter((e) => !batch.includes(e));
      for (const e of batch) this.popped[e.sid] = room;
      this.phaseAt = Date.now();
      this.phase = "countdown";
      this.roundRoom = room;
      await this.save();
      for (const e of batch)
        this.sendTo(e.sid, { type: "admitted", room });
      this.pushQueueState();
      return Response.json({ admitted: batch.map((e) => e.sid) });
    }

    if (url.pathname === "/admitted" && req.method === "POST") {
      // was this queue session admitted into this room? (room join gate)
      const { sid, room } = await req.json<{ sid?: string; room?: string }>();
      const ok = typeof sid === "string" && typeof room === "string" && this.popped[sid] === room;
      return Response.json({ ok, name: ok ? this.ident[sid]?.name : undefined });
    }

    if (url.pathname === "/requeued" && req.method === "POST") {
      // may this round session rejoin the queue under its old sid?
      const { sid } = await req.json<{ sid?: string }>();
      const ok = typeof sid === "string" && !!this.requeued[sid] && this.queue.some((e) => e.sid === sid);
      return Response.json({ ok });
    }

    if (url.pathname === "/requeue" && req.method === "POST") {
      // the host's round is starting without these players (still unseated):
      // they go to the FRONT of the queue, first listed first, keeping their
      // identity; the room tells their phones to come back
      const { room, sids } = await req.json<{ room?: string; sids?: string[] }>();
      const front: QueueEntry[] = [];
      for (const sid of Array.isArray(sids) ? sids.slice(0, 64) : []) {
        if (typeof sid !== "string" || this.popped[sid] !== room || !this.ident[sid]) continue;
        delete this.popped[sid];
        this.queue = this.queue.filter((e) => e.sid !== sid);
        front.push({ sid, name: this.ident[sid].name, at: Date.now() });
        this.requeued[sid] = Date.now() + 10 * 60_000;
      }
      this.queue = [...front, ...this.queue];
      await this.save();
      this.pushQueueState();
      return Response.json({ ok: true, requeued: front.map((e) => e.sid) });
    }

    if (url.pathname === "/roster" && req.method === "POST") {
      // the stream host's live seat grid: team names, CPU fillers and how
      // many seats are still open in the open lobby
      this.roster = cleanRoster(await req.json<Partial<Roster>>());
      // seat modes report who is in with /drop, so their capacity is trustworthy
      if (this.roster.teams && this.roster.capacity > 0) this.capacity = Math.min(64, this.roster.capacity);
      await this.save();
      this.broadcast({ type: "roster", roster: this.roster });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/lastgame" && req.method === "POST") {
      const { lines, winner, kills, winners } = await req.json<{
        lines: string[]; winner?: string; kills?: Record<string, number>; winners?: string[];
      }>();
      this.lastgame = { lines: lines ?? [], winner: winner ?? "" };
      this.turnafk = null; // a finished round clears any stale AFK banner
      for (const [name, k] of Object.entries(kills ?? {})) {
        if (isAnonName(name)) continue; // AnonAlpha etc. are recycled between people
        const e = this.ladder[name] ?? { games: 0, wins: 0, kills: 0 };
        e.games += 1;
        e.kills += k;
        if (winners ? winners.includes(name) : winner && name === winner) e.wins += 1;
        this.ladder[name] = e;
      }
      await this.save();
      this.broadcast({ type: "lastgame" });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/turnafk" && req.method === "POST") {
      // the host's AFK turn countdown: the slides show "wake up or skipped"
      const { team, seconds, clear } = await req.json<{
        team?: string; seconds?: number; clear?: boolean;
      }>();
      if (clear || !team) {
        this.turnafk = null;
      } else {
        this.turnafk = { team, endsAt: Date.now() + (seconds ?? 10) * 1000 };
      }
      this.broadcast({ type: "turnafk", turnafk: this.turnafk });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/state") {
      const countdownLive = this.countdownEndsAt != null
        && this.countdownEndsAt > Date.now() - 10000;
      const phase = this.phase === "countdown" && !countdownLive ? "lobby" : this.phase;
      const ladder = Object.entries(this.ladder)
        .map(([name, e]) => ({ name, ...e }))
        .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
        .slice(0, 20);
      return Response.json({
        phase,
        mode: this.mode,
        queue: this.queue.length,
        roundRoom: this.roundRoom,
        countdownEndsAt: countdownLive ? this.countdownEndsAt : null,
        openSeats: phase === "lobby" || phase === "countdown" ? this.openSeats : 0,
        lastgame: this.lastgame,
        turnafk: this.turnafk && this.turnafk.endsAt > Date.now() ? this.turnafk : null,
        ladder,
        roster: this.roster,
      });
    }

    if (url.pathname === "/team" && req.method === "POST") {
      // a queued player saved/updated their team config while waiting
      const { sid, config: rawConfig } = await req.json<{ sid: string; config: unknown }>();
      const config = QueueDO.cleanConfig(rawConfig);
      const entry = this.queue.find((e) => e.sid === sid);
      if (entry && config !== undefined) {
        entry.config = config;
        await this.save();
        return Response.json({ ok: true });
      }
      return new Response("not queued", { status: 404 });
    }

    if (url.pathname === "/drop" && req.method === "POST") {
      // a queued player closed their browser
      const { sid } = await req.json<{ sid: string }>();
      const idx = this.queue.findIndex((e) => e.sid === sid);
      if (idx >= 0) this.queue.splice(idx, 1);
      delete this.popped[sid];
      delete this.requeued[sid];
      await this.save();
      this.pushQueueState();
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  // queue sockets are untrusted too: a token bucket (20 a second, burst 40; the
  // only thing a queued page ever sends is its saved team) keeps a flood off
  // the Durable Object's storage
  private bucket: Record<string, { tokens: number; at: number }> = {};
  private allow(sid: string): boolean {
    const now = Date.now();
    const b = this.bucket[sid] ?? { tokens: 40, at: now };
    b.tokens = Math.min(40, b.tokens + (now - b.at) * 0.02);
    b.at = now;
    this.bucket[sid] = b;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_WS_MESSAGE) return;
    const meta = ws.deserializeAttachment() as { sid?: string };
    if (!this.allow(meta?.sid ?? "")) return;
    try {
      const msg = JSON.parse(message) as { type?: string; config?: unknown };
      const config = QueueDO.cleanConfig(msg.config);
      if (msg.type === "team" && config !== undefined && meta?.sid) {
        await this.load();
        const entry = this.queue.find((e) => e.sid === meta.sid);
        if (entry) {
          entry.config = config;
          await this.save();
          ws.send(JSON.stringify({ type: "team-saved" }));
        }
      }
    } catch {}
  }

  override async webSocketClose(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as { sid?: string };
    if (!meta?.sid) return;
    await this.load();
    const idx = this.queue.findIndex((e) => e.sid === meta.sid);
    // a queued player whose socket went away is dropped; popped players are
    // in a room and keep their queue history
    if (idx >= 0 && !this.popped[meta.sid]) {
      this.queue.splice(idx, 1);
      await this.save();
      this.pushQueueState();
    }
  }
}
