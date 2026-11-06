# hwstream-signup — sign-in and ladder for the stream host

A Cloudflare Worker that gives stream players a name: magic-link sign-up
(no passwords), unique screen names filtered by the safeword list, a
Glicko-2 ladder in D1, and an ES256 identity token that the stream worker
(`stream-host/worker`) verifies with the public key only. Players who do not
sign in are called `AnonAlpha`, `AnonBeta`, ... by the stream worker.

## Layout

- `src/index.ts` — worker entry: sign-up form, magic links, `/authorize`
  (the identity provider), profile pages, result intake and the top-20 API
- `src/idp.ts`, `src/auth.ts` — identity token signing, session cookies
- `src/glicko2.ts` — rating maths (`src/devcheck.ts` checks it against the
  worked example in Glickman's paper)
- `src/safewords.ts`, `src/safewords-list.ts` — screen name filter, generated
  from `stream-host/data/safewords.txt` by `tools/sync-safewords.mjs`
- `schema.sql` — the D1 schema
- `tools/genkey.mjs` — makes the identity key pair

## Local dev

```
cd stream-signup
npm install
node tools/genkey.mjs                # prints IDP_PRIVATE_JWK and IDP_PUBLIC_JWK
cp .dev.vars.example .dev.vars       # add IDP_PRIVATE_JWK and STREAM_URL=http://127.0.0.1:8790
npm run db                           # create the tables in the local D1
npm run dev -- --port 8791
```

With `DEV_MODE=1` (the `.dev.vars.example` default) the magic link is returned
in the API response instead of being emailed. The stream worker needs the
matching `IDP_PUBLIC_JWK` and `SIGNUP_PUBLIC_URL=http://127.0.0.1:8791` in its
own `.dev.vars`, and `SIGNUP_URL`/`SIGNUP_SECRET` to match this worker's
`SIGNUP_SECRET`. `stream-host/tests/auth-flow.mjs` runs the whole flow against
both workers.

## Deploy

```
npx wrangler d1 create hwstream-signup      # put the printed id in wrangler.local.toml
npx wrangler d1 execute DB --remote --file=./schema.sql
npx wrangler secret put IDP_PRIVATE_JWK
npx wrangler secret put SIGNUP_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler deploy --config wrangler.local.toml
```

Do the deploy from a git-ignored copy of the config, so that your real values
never end up in a commit: `cp wrangler.toml wrangler.local.toml`, put the D1 id
in it, set `STREAM_URL` (where signed-in players are sent back to) and
`MAIL_FROM` in `[vars]`, and deploy with
`npx wrangler deploy --config wrangler.local.toml`. Configure Email Routing for
the `send_email` binding. The stream worker gets `IDP_PUBLIC_JWK` (public) and
`SIGNUP_PUBLIC_URL` as vars, and a `SIGNUP` service binding to this worker.
