# Party mode styles — planned extension

Status: **planned** (not yet implemented). This extends the party mode shipped on
`party-web` (M1–M5, see `README.md`): a Cloudflare worker lobby + phone controller
webapp, a Qt host client, and an engine party-mode input path.

Current behaviour is one style: every phone player registers and owns a **whole
team**; the game starts only when at least one party team exists; phone input is
routed to whichever team's turn it is (`x<Team>` turn notice → `m_partyActiveSid`
gate). This doc defines three additional lobby styles and the shared groundwork
they need.

---

## Modes at a glance

| Mode | Lobby shape | CPU opponents | In-game ownership |
|------|-------------|---------------|-------------------|
| `classic` (today) | unlimited joiners, one team each | none | one phone = one team |
| `fixed` | exactly X slots | every unoccupied slot is a CPU team of a chosen difficulty | slot = team; mid-game joiners adopt a placeholder team |
| `dynamic` | unlimited joiners | only while exactly **one** player is present | one phone = one team (as today) |
| `teams` | 2–4 teams (Red, Blue, Yellow, Green), rebalanced as players come and go, up to 24 players | CPU fills each team up to 3 hogs | one phone = **one hedgehog** named after the player; switch-hog removed |
| `imposter` | Red vs Blue, 6–12 players, seated two at a time | CPU fills each team up to 3 hogs | one phone = one hedgehog; **one secret traitor on each team** |

The mode is chosen by the host when creating the room and is part of the room
config; the phone webapp adapts its UI to it.

---

## Worker UI theming (M6) — first milestone

Make the phone controller look and sound like Hedgewars instead of a bare HTML
page. All needed assets already exist in-tree and are small enough to bundle as
worker static assets (`assets = { directory = "./public" }` in wrangler.toml,
25 MiB/file limit — everything below fits).

### M6.1 Game font

- Copy `share/hedgewars/Data/Fonts/DejaVuSans-Bold.ttf` (660 KB, the engine's UI
  font) to `party/public/assets/fonts/`, register it with `@font-face`, and use
  it for all controller text (headers, buttons, weapon labels, status bar).
- CSS palette derived from the game UI: the steel-blue/grey of the engine's
  ammo menu, warm orange accents (matches the existing `.switcher` accent).
  Skip `wqy-zenhei.ttc` (CJK fallback, ~10 MB — not worth the payload; system
  CJK font fallback is fine).

### M6.2 Real ammo icons in the weapons panel

- The engine draws its weapons menu from `share/hedgewars/Data/Graphics/AmmoMenu`
  (136 KB total; `Ammos_base.png` is the icon atlas). Copy the atlas to
  `party/public/assets/graphics/` and replace the text-only weapon cells in the
  webapp's weapons grid with icon sprites (CSS `background-position` slicing of
  the atlas), keeping the existing dimming and the `.switcher` accent on the
  Switch Hedgehog cell.
- Verify the atlas grid layout against the engine's drawing code
  (uAmmos/uWorld) during implementation; ammo index → cell mapping comes from
  the same `HW_AMMOMENU_ARRAY`-derived `weapons.js` already generated in M5.

### M6.3 "Come on then!" voice on your turn

- Copy `share/hedgewars/Data/Sounds/voices/Default/Comeonthen.ogg` (25 KB, the
  hedgehog's "come on then" — the closest in-game voice to "ok then") to
  `party/public/assets/sounds/`.
- When a `turn` WS message arrives with `team === myTeam`, play it through the
  Web Audio API. Handle autoplay policy: unlock/resume the `AudioContext` on
  the first pointer interaction (the controller is all taps, so this is
  reliable).
- Codec note: .ogg plays in Chrome/Firefox/Android WebView; if `decodeAudioData`
  rejects (older iOS Safari), fall back to a tiny bundled `.m4a`/`.mp3` twin —
  include the fallback encode in the milestone, decide per device sniff.
- Stretch (same milestone if cheap): voicepack selector — every voicepack
  (`Default`, `Classic`, `British`, `HillBilly`, `Mobster`, …) uses the same
  file names, so it is just a base-URL swap; host picks it on the party page
  and the choice rides the `weapons`/`state` broadcast.

### M6.4 Landing page + team menu site dressing (added during M6)

- Assets pulled from hedgewars.org's own theme (`/sites/all/themes/hedgewars/`):
  `images/header2.png` (853×160 banner) and `images/background.jpg` (cave/dirt
  backdrop, 49 KB) → `party/public/assets/site/`.
- The banner replaces the plain `hw-party` heading and renders **full width**
  (height scaled via aspect-ratio); it shows only on the join + team screens —
  in-game (controls and weapons) it is hidden and the page falls back to the
  plain palette so the controller stays uncluttered.
- Join + team-registration get white "form card" styling like the site's forms.

### M6.5 Team pickers (flag / grave / voice) with cycle buttons

- New generator `party/scripts/gen_team_assets.py` (PIL) packs
  `share/hedgewars/Data/Graphics/Flags` (293 flags, 22×15, uniform grid atlas)
  and `Graphics/Graves` (41 graves, fitted into 32×32 cells bottom-aligned)
  into `public/assets/team/flags.png` + `graves.png`, and copies the
  alphabetically-first voice sample of each of the 15 voicepacks to
  `voices/<pack>.ogg`; one `team.json` manifest ties them together (~580 KB
  total added to the worker bundle).
- The flag / grave / voice text fields are now **cycle buttons** (dark-blue
  style like the control buttons): tap advances to the next entry and updates
  the sprite; cycling the voice plays that voicepack's sample immediately.
  The sample also plays the first time the team screen loads (attempted on
  join; if autoplay blocks it, the first tap replays it). Defaults:
  hedgewars / Statue / Default. The registered team config still carries
  plain `flag`/`grave`/`voice` names — protocol unchanged.

### M6.6 Phone-first controls layout

- The controller is designed for phone dimensions/aspect ratios, tested in
  both orientations (390×744 portrait, 744×390 landscape via scaled iframes):
  - portrait: **Pointer pad on top**, then movement pad (labelled "Move/Aim"),
    then action row, then FIRE + weapons;
  - landscape: Pointer pad left spanning full height, buttons right;
  - each pad sits under a small caps label: "Pointer" (left/top) and
    "Move/Aim" (right/bottom);
  - movement pad is `[▲]` over `[◀][▼][▶]`; the action row is
    jump / switch hog (the "tab" button — the engine's gmSwitch
    is contextual per weapon: hog switching, portal colour flip, etc.);
    the game has no backwards jump, so the controller exposes only the single
    jump (`J` → `ehjump`, the high jump);
  - the precise and timer (1–5) buttons were removed from the phone UI (the
    engine inputs stay supported for M7's test coverage); "connected" status
    is hidden in-game; `#controls[hidden]` display fix added.
- **Pointer pad (replaced the drag trackpad)**: the touchpad was removed in
  favour of a second arrow pad with a 4-column × 2-row grid —
  `[void][▲][void][click]` over `[◀][▼][▶][void]`, i.e. the click (put)
  button occupies the top-right cell. Held arrows stream relative cursor
  deltas on the same 15 ms cadence the drag pad used, tuned for a 1920×1080
  screen: full width in ~4 s (480 px/s) and full height in ~4 s (270 px/s);
  fractional deltas accumulate per axis and only whole cursor units go out.
  Diagonals work (multiple arrows held at once). Click sends a single
  `put 0,0` (place target at the cursor), matching the old pad's tap.

### Acceptance

- Controller uses the game font and palette; weapons panel shows real game ammo
  icons; turn becomes yours → hedgehog says "come on then" (after first tap
  unlocks audio); payload added to the worker bundle is small (≈1 MB total).

---

## Groundwork (M7) — needed by all modes

### M7.1 Fix single-char input translation (existing bug)

Phone actions reach the engine as IPC `e`-prefixed commands
(`HWForm::sendPartyCommand`, hwform.cpp:1920 → `game->FromNet` → engine
`ParseIPCCommand` `e` case → `ParseCommand`). That works for variables that
actually exist (`+left`/`-left`, `setweap`, `slot N`, …), but the phone's
single-letter actions are **headcmd letters, not engine variables**, and are
currently silent no-ops:

| Phone action (party/public/index.html) | Sent today | Engine behaviour | Correct command |
|---|---|---|---|
| `J` (jump) | `eJ` | ignored | `ehjump` (the high jump — the game has no backwards jump, so no `eljump` action is exposed) |
| `s` (switch hog) | `es` | ignored | `eswitch` |
| `Z`/`z` (precise hold) | `eZ`/`ez` | ignored | `e+precise` / `e-precise` |
| `1`–`5` (timer) | `e1`…`e5` | ignored | `etimer N` |

(The headcmd letters are only translated in `NetGetNextCmd`, uIO.pas:415–470 —
that path is for net-replay traffic, not for `e`-prefixed IPC. The M3 headless
test only asserts "no fatal `E`", so this slipped through.)

Fix host-side in `PartyInput` (hwform.cpp:1912): map phone actions to proper
engine commands before `sendPartyCommand`, keep the phone protocol unchanged.
Extend `party/scripts/engine-party-test.mjs` to assert the commands are accepted
(and have observable effect where feasible).

### M7.2 Per-hedgehog turn notice (engine)

Team mode (and clean adoption handling) needs to know **which hedgehog** is
active, not just which team. The engine already emits the party turn notice on
*every* hedgehog switch — `SendIPC('x' + TeamName)` in `AfterSwitchHedgehog`
(uTeams.pas:489) — so:

- Keep `x<Team>` unchanged for compatibility, and add a companion notice
  `y<idx>` (single hex char, sent immediately after every `x`) carrying the
  active hog index.
- Frontend: `PartyTurnTeamChanged` (hwform.cpp:1906) learns the (team, hog)
  pair and broadcasts both.
- Extend `engine-party-test.mjs` to assert `x`/`y` pairing.

### M7.3 Worker room modes + lobby capacity

- `RoomConfig` gains `mode: "classic" | "fixed" | "dynamic" | "teams"` (set at
  `POST /create`, immutable) and `slots`/`seatCount` where relevant.
- Enforce a member cap per mode in `RoomDO` (today there is none) — reject joins
  beyond the cap with 409. Fixed: X slots; teams: 2 × N seats; classic/dynamic:
  host-chosen cap (default 8).
- Broadcast the mode in `hello`/`state` so the webapp can adapt.

---

## Mode A: Fixed lobby (M8)

A set number of slots X (host-configurable, 2–8). **Every unoccupied slot is
filled with a CPU team of a chosen difficulty tier.**

### Lobby phase

- Host UI (`PageParty`): slot count spinner + CPU difficulty tier picker
  (engine tiers 1–5, where 5 is the easiest — same mapping as quick-game
  experience scaling, game.cpp SendQuickConfig).
- Placeholder CPU teams are materialised as normal playing teams in the host's
  `TeamSelWidget`, built like quick-game CPU teams
  (`HWTeam::setDifficulty(tier)` + `HWNamegen::teamRandomEverything`), with
  placeholder owners like `cpu:<n>`.
- **Player joins → replaces a placeholder** (pre-game only): in
  `PartyTeamRegistered` (hwform.cpp:1794), first `removeNetTeam` the oldest
  unclaimed placeholder, then add the player's real team (custom name/hogs/flag
  as today). Worker-side the room is "full" once all X slots have live
  registrations.
- **Player leaves pre-game** → put a fresh placeholder CPU team back into that
  slot (inverse of the above).

### In-game

- CPU placeholders are genuine engine AI teams (difficulty ≥ 1 at `eaddhh`,
  team.cpp:286) and play normally.
- **Mid-game joiner adopts a placeholder team.** The engine cannot add a new
  team to a running game; team identity is frozen. Two pieces make adoption
  work:
  - *Routing (frontend only):* retarget `m_partyTeamToSid[<placeholder>] → sid`
    and broadcast turn/state; the sid-based input gate already does the rest.
  - *Engine (small change):* the adopted team must stop being AI-driven. Add an
    engine command `eteamhuman s<TeamName>` that sets `BotLevel := 0` for the
    team's hogs (mirrors how `chTeamBack` already mutates `ExtDriven`,
    uTeams.pas:1003). Until adopted, the placeholder keeps playing as CPU.
- Adopters inherit the placeholder's name/hogs/colours for the rest of the game
  (documented constraint, same as net play). Cosmetic re-skinning mid-game is
  out of scope.
- **Mid-game leaver:** existing M4 path (`eteamgone` + held-key release). The
  freed slot can be re-adopted by the next joiner (after `eteamback`) or left
  gone until the next round.

### Acceptance

- Room with X=4, one joiner: 1 human team + 3 CPU teams of the chosen tier play
  a full game via phones.
- Mid-game join adopts the next unclaimed placeholder; its team stops being AI
  and the phone controls it on the next turn.
- Headless test: engine-party script variant with a CPU team (difficulty ≥ 1)
  + one injected "human" team; assert CPU turns complete and adopted team
  responds to inputs.

---

## Mode B: Dynamic lobby (M9)

CPU opponents exist **only while exactly one human player is present**; with
two or more players there are no CPU teams.

### Rules

- Evaluated on every roster change in the **lobby phase** (pre-game):
  - 0 players: nothing to start anyway.
  - 1 player: host-side adds one CPU team (tier from host setting, default
    middle; generated like quick-game via `HWNamegen::teamRandomEverything`).
  - ≥ 2 players: CPU teams removed from the playing list.
- Roster churn while waiting (players hopping in/out) just re-evaluates the
  rule; no slots, no reservations.
- Once the game starts the roster is frozen for that round (no mid-game CPU
  spawning — a mid-game joiner either waits for the next round or uses the
  adoption machinery from Mode A if enabled).
- The single-player-vs-CPU game is still hosted/started through the same
  `PartyStart` path so phones get the full controller UX.

### Acceptance

- One phone registered → CPU team present; second phone registers → CPU team
  disappears; game starts with 2 human teams.
- Headless + worker smoke tests for the roster→CPU toggle logic.

---

## Mode C: Team game (M10)

Instead of each player owning a team, players are **alternately placed into two
fixed teams** and each player controls **one hedgehog**. They only act when
*their hedgehog* is the active one. The change-hedgehog option is turned off.

### Seats and assignment

- Two fixed teams (generated names/colours, e.g. "Red" vs "Blue"), each with
  `seatCount` hogs (host-configurable, default 4 → 8 players max).
- On registration the worker assigns the next seat **alternating between the
  two teams** (A, B, A, B, …) and locks it to the sid. The seat's hog is named
  after the player's registration name.
- Unclaimed seats are optionally filled by CPU hogs — note this is natively
  supported because `eaddhh` difficulty is **per hedgehog**: claimed seats get
  difficulty 0 (human), unclaimed get the host's chosen tier. Host option,
  default on.
- Teams are built by the host from the seat map at game start (two
  `eaddteam` blocks with per-hog difficulty).

### Control gating (per hedgehog)

- Turn flow: engine emits `x<Team>` + `y<idx>` (M7.2) at every hedgehog switch.
- Host keeps a `seat → sid` map (`(team, hogIdx) → sid`); "your turn" is sent
  **only** to the owner of the active hedgehog. Teammates see
  "waiting — <player>'s hog" instead of controls.
- Input gate becomes `(activeTeam, activeHog) == seat(team, hog)` instead of
  team-only (`PartyInput`/`PartyCursor`/`PartyPut`, hwform.cpp:1912–1927).

### Change-hedgehog disabled (defence in depth)

The switch path exists in three places; all are closed in `teams` mode:

1. **Ammo store masking (primary):** position 21 ("Switch Hedgehog",
   party/public/weapons.js) is forced to `0` in the ammo string the host
   broadcasts (`sendWeapons`) *and* in the `eamm*` config sent to the engine —
   the engine then never offers it, and the phone grid auto-dims it
   (availability-based dimming already exists in the webapp).
2. **Worker:** `INPUT_RE` (party/src/room.ts:18) rejects `setweap <0x15>` and
   bare `s` in `teams` mode.
3. **Engine:** `eparty` gains a submode (`eparty 2` = teams); the engine then
   skips creating the `gtSwitcher` gear that `gfSwitchHog` schemes spawn at
   turn start (uTeams.pas:455). `gmSwitch` itself stays enabled — it is
   contextual per weapon (portal colour flip, uGearsHandlersMess.pas:4999;
   reverse cycling with precise, :3539) — so hog *switching* is blocked by the
   switcher-ammo mask rather than by refusing the input. The phone's "tab"
   button stays available for weapon-contextual uses.

### Dropouts and reconnects

- Leaver's hedgehog stays in the game but must not stall it: the host
  auto-injects `eskip` when an ownerless hedgehog's turn starts (v1), relying
  on the turn timer as backstop. (A per-hog "gone" flag would be an engine
  change; noted as a possible v2.)
- Reconnect (M4 machinery): seat↔sid re-binding is restored from the worker's
  seat map on `joined`, and the hog resumes being human-controlled on its next
  turn.
- Rebalancing between the two teams only happens between rounds; a seat swap
  mid-game is out of scope.

### Acceptance

- 8 phones → 4 v 4, each controlling exactly their hog; nobody can act on a
  teammate's or enemy's hog; Switch Hedgehog is unavailable everywhere.
- Headless test: two teams × 2 hogs (2 human-injected seats + 2 CPU seats),
  assert turn notices carry correct (team, hog) pairs and injected inputs are
  accepted only for the active seat.

---

## Compatibility and rollout

- `classic` remains the default mode; all new behaviour is opt-in per room.
- Old phone clients ignore the `mode` field and keep working in `classic`
  rooms; new webapp features degrade gracefully (buttons hidden by mode).
- Engine changes (M7.2 `y` notice, M8 `eteamhuman`, M10 `eparty 2` + switch
  refusal) are backwards-compatible: old frontends simply never send them.
- Each mode ships behind its own milestone with headless engine tests
  (`party/scripts/engine-party-test.mjs` variants) and worker smoke tests
  (`party/scripts/smoke.mjs`) updated alongside.

## Suggested milestone order

1. **M6** — worker UI theming: game font + palette, real ammo icons, "come on
   then" voice on your turn, screenshot docs.
2. **M7** — groundwork: input translation fix, per-hog turn notice, worker
   mode/capacity fields. (No visible behaviour change in `classic`.)
3. **M8** — fixed lobby (placeholders, adoption, `eteamhuman`).
4. **M9** — dynamic lobby (CPU only for lone player).
5. **M10** — team game (seats, per-hog gating, switch-hog removal).
6. **Final Windows build** — refresh the win64 package after M7–M10 land.

## Post-roadmap project (own branch): streaming Docker host

A separate purpose-specific build, **planned after all milestones and the
final Windows build**:

- Docker container running the game binary (hwengine) that emits an
  **RTMP feed** of game video and audio to a configurable RTMPS server
  (e.g. a YouTube stream key via envvar).
- When a game ends, returns to the lobby and starts the next game (loop).
- **Self-healing**: supervisor restarts the engine on crash and resumes the
  feed (e.g. FFmpeg retry loop).
- Game mode configurable via environment variable.
- **Safeword filter**: team names and hedgehog names received by the app are
  checked against a dictionary of safe words; any word that does not match a
  safe word is replaced with a random safe word of the same length.
- Lives in its own branch (e.g. `stream-host`).
- Each game gets captured as it's own video (VOD), and is auto uploaded to youtube.
- This gets a dedicated, separate, cf worker where players first have to sign up (email + magic link), set a screenname.
- Players are given a sort of ELO, which can degrade over time, and should be harder to increase as you progress. In between games, the livestream shows the top 20 of all time players. ELO should also grow proportionately to the difficulty of the competitors relative to you. Use a well known and understood matchmaking scoring solution that has these characteristics. Any screen name can only be held by one person (email address) at a time. Team names are the screen name for that player.
- Streams and vods should have two audio feeds, one (main) with the music, another (English (Canadian)) without the music.
- The game should auto start once a configured number of teams *players) join, or if atleast 2 teams, after a timeout.
---

## M13 — imposter, rebalanced teams, one hardened room

The `teams` mode was extended and `imposter` added, **identically in the three
places that host a game**: the stream host agent (`stream-host/agent`), the Qt
launcher's party host (`frontend-qt6/hwform.cpp`) and the room logic both
workers share (`party/src/room.ts` = `stream-host/worker/src/room.ts`, kept
byte-identical; `stream-host/tests/worker-sync.mjs` fails if they drift).

### Seating (`agent/layout.mjs` = `frontend-qt6/partylayout.cpp`)

- Everyone who registers is **in the lobby at once** (up to the cap) and shown
  as they arrive. Whether they are *seated* depends on the mode:
  - `imposter`: seated **two at a time**, one per team, so the sides are always
    exactly even. The odd player waits. When a seated player leaves, the most
    recently seated player on the *other* team is unseated; waiting players are
    re-seated as pairs, longest waiting first. Cap 12, at least 6 seated to start.
  - `teams`: everyone is seated. 2 teams up to 12 players, 3 up to 18, 4 up to 24,
    always within one player of even; growing or shrinking the team count moves
    as few players as possible.
- A game that starts with a player still unseated leaves them first in line for
  the next lobby (the stream host sends them back to the front of its queue; the
  launcher carries them into the next lobby).
- A team plays with at least **3 hogs** (CPU fills the rest) and one more per extra
  player: the slides and the launcher's roster grow and shrink with the seated
  players. The engine allows 8 hogs a team and 8 teams; imposter stops at 12
  (6 a side) so one slot per team stays free for the traitor's clone.
- The C++ and JavaScript layouts are proven identical by
  `stream-host/tests/layout-diff.mjs` (the same random joins/leaves through both,
  compared after every operation).

### Names

One player drives one hog in the `teams` and `imposter` modes: the screen name IS
the hog's name (no hog names, flag, grave or voice to pick). In the standard modes
the screen name is the team name and the player still names their hogs. Stream
rooms enforce this server-side (the room replaces whatever the phone sends with
the account's, or an `AnonAlpha`-style, name); party rooms keep typed names.

### Imposter

Each team has one secret traitor, drawn from that team's seated players. The host
tells the engine `etraitor <hogIdx> <team>` at every turn start; the engine acts
only if that hog is now its team's last living hedgehog, then clones it onto the
other team (`z<team>` tells the host) and the traitor wins with the survivors.
The traitor is told privately which team they are on; when the game ends the host
names both imposters.

### Protocol additions (host ⇄ room)

- create: `{mode:"imposter"|"teams", slots, maxPlayers}` (`maxPlayers` 2–24 is the
  cap for the seat modes; the room refuses a nonsensical number).
- host → ONE phone, routed by sid, never visible to anyone else:
  `{type:"notify", sid, text}` (the traitor reveal), `{type:"seat", sid, seated, team}`
  (where the lobby put you), `{type:"release", sid}` (back to the queue).
- host → everyone: `afk` (the AFK countdown banner) next to `turn` / `state` /
  `roster` / `weapons`.

### The room treats every phone as hostile

Only the player whose turn it is can act: `input`, `cursor` and `put` are dropped
unless `lastTurn.sid` is the sender, and a turn does not outlive the game (any
non-`ingame` state clears it; a CPU/engine turn has no owner). Values are
bounded and typed, a controller socket gets a token bucket (120/s sustained, burst
200: the pointer pad peaks near 66/s), the Switch Hedgehog ammo is removed from
every team's store *and* refused by the room (any whitespace spelling), a seat
cannot be taken over by another connection typing the same name while its owner is
connected, host-only message types are ignored from controllers, and a WebSocket
upgrade from another site's page is refused (`Origin` must match the host). Hosts
also hold each relayed command for 25 ms and apply it only if its sender still has
the turn: the engine announces a turn change after making it, so a command from the
player whose turn just ended must not land on the next player's hog.

### Tests

`stream-host/tests`: `layout.mjs`, `layout-diff.mjs`, `result.mjs`, `lobby-drop.mjs`,
`ws-security.mjs`, `auth-flow.mjs`, `phone-forms.mjs`, `worker-sync.mjs`, and the
real-engine games `imposter-ws.mjs` / `teams-ws.mjs` / `imposter-cdp.mjs`
(`imposter-stack.sh` runs the stream container). `party/scripts`: `smoke.mjs`,
`party-modes.mjs`, `party-forms.mjs`.
