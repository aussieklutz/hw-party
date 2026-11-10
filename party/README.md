# hw-party — Cloudflare worker + phone webapp

Backend and phone webapp for the Jackbox-style party mode: room creation,
JWT-cookie sessions, and a Durable Object relay per lobby.

## Layout

- `src/index.ts` — worker entry: room create/join HTTP API, WS upgrade + JWT validation, JWT issuance (HS256, HttpOnly cookie `hw_session`)
- `src/auth.ts` — JWT sign/verify (WebCrypto HMAC), cookie helpers
- `src/room.ts` — `RoomDO` Durable Object: membership, WS relay, input validation
- `public/` — the phone webapp: join page, lobby, and the game controller

## Dev

```
cd party
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open `http://localhost:8787` on the phone. Note: the session cookie omits
`Secure` on plain-http origins (localhost dev); in production it is always
Secure, and WS requires the cookie — so phone testing over LAN http relies on
the non-Secure cookie path. For an HTTPS dev origin use `npm run dev -- --remote`.

To try the Qt host against a worker, enter its URL on the Party mode page, or
set `HEDGEWARS_PARTY_URL` in the environment to pre-fill the field.

## Deploy

```
npx wrangler secret put PARTY_JWT_SECRET
npm run deploy
```

## Protocol (v1, JSON over WSS)

- client → DO: `{type:'input', action:'+left'|…}`, `{type:'cursor', x, y}`
- host → DO: `{type:'turn', team, yourTeam}`, `{type:'state'}`, `{type:'roster'}`
- DO → host: `{type:'input', team, sid, action}` (input routed to host only)
- DO → clients: `{type:'hello'}`, `{type:'joined'|'left', sid}`
- host → ONE client (routed by sid): `{type:'notify', sid, text}`, `{type:'seat', sid, seated, team}`, `{type:'release', sid}`,
  `{type:'ammo', sid, ammo}` (the active player's weapons: 60 x a count `0`-`8`, `9` for nine or more, `*` for infinite,
  then the turns still to wait `0`-`9`; the engine's `V` notice; the phone greys out what cannot be used)
- host → all clients: `{type:'afk', team, seconds, endsAt}` (AFK countdown banner)

## Coming back

A phone that closes its tab and returns keeps its seat: the session cookie names the room and the player, `GET
/api/session` says whether that room still has a host (then the page goes straight back in, no code to type), and the
room's `hello` hands back what the phone registered. A newer tab for the same player takes the seat over: the older
socket is closed with code 4000 and its page shows "Taken over" with a "Take control here" button instead of
reconnecting. A tab that comes back mid-game gets the turn, the game's weapons and its latest `ammo` replayed.

Only the player whose turn it is can send `input`/`cursor`/`put`; see
`PARTY_MODES.md` (M13) for the modes (`imposter`, rebalanced `teams`) and for how
the room treats every phone as hostile.

Input whitelist in `room.ts`: `+mod`-style holds, `p`/`P x y` cursor, `[1-5]`
timer, `j`/`J`/`s`/`Z`, `slot N`. Messages are length-capped and JSON-validated
before relay.
