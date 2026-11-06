Hedgewars Party - an AI coded party mode
========================================

Uses a cloudflared worker based game controller to host "pass the keeb" style hw, but controlled from phone.

Party mode walkthrough
----------------------
Party mode turns phones into controllers. One person hosts the game in the
desktop frontend, everybody else scans a QR code and plays from their browser.
Phones talk to a small Cloudflare Worker (in `party/`) that relays their input
to the host. The host only makes outgoing connections, so it needs no open
ports.

You need:

* a free [Cloudflare](https://dash.cloudflare.com/sign-up) account
* Node.js 20 or newer (for `wrangler`, the Cloudflare CLI)
* this fork built from source, see [INSTALL.md](INSTALL.md); the Qt frontend
  needs the Qt6 WebSockets module (`libqt6websockets6-dev` on Debian/Ubuntu)

### 1. Try the worker locally (optional)

```
cd party
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

The worker listens on <http://localhost:8787>. Open it on a phone on the same
network to check the join page.

### 2. Deploy the party worker

```
cd party
npm ci
npx wrangler login
npx wrangler secret put PARTY_JWT_SECRET   # paste a long random string
npm run deploy
```

`openssl rand -base64 32` makes a good secret. wrangler prints the worker's
address, something like `https://hedgewars.<your-account>.workers.dev`. To use
another worker name or a custom domain, copy `wrangler.toml` to
`wrangler.local.toml`, edit it and deploy with
`npx wrangler deploy --config wrangler.local.toml`. That file is git-ignored,
so your own addresses never end up in a commit.

### 3. Host a game

1. Start Hedgewars and press **Party mode** on the main page.
2. Enter the worker address in **Party server**. To have it filled in for you,
   start the game with `HEDGEWARS_PARTY_URL` set to the address.
3. Press **Open party room**. The page shows a room code, a QR code and a join
   link (**Copy join link** puts it on the clipboard).
4. Players scan the QR code or open the link on their phones, pick a name and
   join. They show up under **Players**.
5. Pick a **Lobby style**:
    * *Classic*: everyone brings a team
    * *Fixed lobby*: a set number of slots, empty ones are CPU teams
    * *Dynamic lobby*: a CPU team appears only while exactly one player is
      present
    * *Teams*: one hog per player, 2 to 4 teams
    * *Imposter*: Red against Blue, 6 to 12 players, a secret traitor on
      each team

   then set the number of slots and the **CPU difficulty**, and press
   **Start**.
6. In the game only the player whose turn it is controls the hedgehog; the
   other phones wait. The phone shows the controls, the weapon menu and a
   countdown if somebody goes AFK.

[party/PARTY_MODES.md](party/PARTY_MODES.md) describes the modes in detail and
[party/README.md](party/README.md) the worker and its protocol.

Stream mode walkthrough
-----------------------
Stream mode runs party games around the clock for an audience. A headless
Hedgewars engine in a container plays rounds with players taken from a queue
on a worker, and streams the result to OBS (or straight to YouTube/Twitch).
Viewers join the queue from their phones.

There are three parts:

* the **stream worker** (`stream-host/worker`): the queue, the room relay for
  the phones and the overlay pages for OBS
* the **signup worker** (`stream-signup`): optional. Passwordless sign-in,
  unique screen names and a rating ladder. Without it, players are called
  `AnonAlpha`, `AnonBeta`, ...
* the **stream host container** (`stream-host`): the engine, a virtual
  display, ffmpeg and the agent that drives the games

You need the same Cloudflare account and Node.js as above, plus Docker (or
Podman) on a Linux machine or WSL2 for the container.

Pick a long random string for each of `STREAM_HOST_SECRET` and
`PARTY_JWT_SECRET`; if you use the signup worker, also for `SIGNUP_SECRET` and
`SESSION_SECRET`. Keep them in a password manager, you need some of them twice.

### 1. Deploy the signup worker (optional)

Skip this section if you do not want accounts and a ladder.

```
cd stream-signup
npm ci
node tools/genkey.mjs        # prints IDP_PRIVATE_JWK and IDP_PUBLIC_JWK
cp wrangler.toml wrangler.local.toml
npx wrangler login
npx wrangler d1 create hwstream-signup
```

Edit `wrangler.local.toml`: put the id that `d1 create` printed into
`database_id`, set `STREAM_URL` to where the stream worker will live (by
default `https://hwstream.<your-account>.workers.dev`) and `MAIL_FROM` to a
sender on a domain with Email Routing set up. The `send_email` binding sends
the sign-in links. On the free plan the destination has to be an address you
verified in the Cloudflare dashboard (Email, Email Routing).

```
npx wrangler d1 execute DB --remote --file=./schema.sql
npx wrangler secret put IDP_PRIVATE_JWK    # the private key from genkey
npx wrangler secret put SIGNUP_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler deploy --config wrangler.local.toml
```

Keep `DEV_MODE` at `"0"` in a real deployment: with `"1"` the sign-in link is
returned in the API response instead of being emailed.

### 2. Deploy the stream worker

```
cd stream-host/worker
npm ci
cp wrangler.toml wrangler.local.toml
```

Edit `wrangler.local.toml`. With the signup worker, set `SIGNUP_PUBLIC_URL` to
its address; the `[[services]]` binding already points at it. Without it,
delete the `[[services]]` block.

```
npx wrangler secret put PARTY_JWT_SECRET
npx wrangler secret put STREAM_HOST_SECRET
npx wrangler secret put IDP_PUBLIC_JWK     # signup worker only: the public key
npx wrangler secret put SIGNUP_SECRET      # signup worker only: same value
npx wrangler deploy --config wrangler.local.toml
```

Open the worker's address on a phone. That page is where players join the
queue. `stream-host/worker` is a copy of the `party/` room code with the queue
added; `stream-host/tests/worker-sync.mjs` checks that the two stay in step.

### 3. Run the stream host container

Build the image from the repository root. The game data is not part of it, it
is mounted at run time:

```
docker build -f stream-host/Dockerfile -t hw-streamhost .
```

Then configure and start it with compose:

```
cp stream-host/.env.example stream-host/.env
```

Set `WORKER_URL` to the stream worker's address and `STREAM_HOST_SECRET` to the
same value you gave the worker. The other settings are optional:

| Variable | Meaning |
|---|---|
| `ROOM_MODE` | `classic`, `fixed`, `dynamic`, `teams` or `imposter`, as in the lobby styles above |
| `ROOM_SLOTS` | slots for `classic` and `fixed` |
| `POP_COUNT` | players taken from the queue per round (`classic`, `fixed`, `dynamic`) |
| `CPU_TIER` | CPU difficulty, 1 (insane) to 5 (very easy) |
| `FEED_URL` | where the video goes (default: the bundled mediamtx) |
| `STREAM_WIDTH`, `STREAM_HEIGHT`, `STREAM_FPS` | video size and frame rate (default 1280x720 at 30) |
| `LOBBY_WAIT_MS`, `ROUND_WAIT_MS`, `SLATE_MS` | timings in milliseconds |

```
docker compose -f stream-host/docker-compose.yml up -d
docker compose -f stream-host/docker-compose.yml logs -f stream
```

Compose starts the host and a mediamtx RTMP server next to it. Both use host
networking, so run them on Linux (or in WSL2). The compose file mounts
`share/hedgewars/Data` read-only and keeps recordings in
`stream-host/recordings`.
The container restarts itself and picks the next game from the queue when one
ends.

Without compose, the same thing as plain `docker run`:

```
docker run -d --name hw-stream --restart always --network host \
  -e WORKER_URL=https://hwstream.<your-account>.workers.dev \
  -e STREAM_HOST_SECRET=<the secret> \
  -e STREAM_DISPLAYS=1 -e ROOM_MODE=dynamic \
  -v "$PWD/share/hedgewars/Data:/data:ro" \
  hw-streamhost
docker run -d --name hw-mediamtx --network host bluenviron/mediamtx:1.12.0
```

To move the image to another machine without a registry, `docker save
hw-streamhost -o hw-streamhost.tar` here and `docker load -i hw-streamhost.tar`
there. If you bake the game data in (a second image `FROM hw-streamhost` with
`COPY share/hedgewars/Data /data`), the machine needs no copy of the repository.

### 4. Go live

OBS mode (the default) keeps video and sound in the container and pushes them
to mediamtx only while a game is on:

1. In OBS add a **Media Source** with the input
   `rtmp://<container-host>:1935/live/game` and untick *Local File*.
2. Add **Browser Source** layers for the overlays the stream worker serves:
   `/stream/scoreboard.html`, `/stream/stats.html`, `/stream/splash.html` and
   `/stream/seats.html`, for example
   `https://hwstream.<your-account>.workers.dev/stream/scoreboard.html`.
3. Build your scenes and start streaming from OBS as usual.

To skip OBS, run the container in legacy mode, which composes the whole picture
itself and pushes it to an RTMPS address: add `-e STREAM_VIDEO=1 -e
RTMP_URL=rtmps://<ingest>/<key>` to the `docker run` command above and drop the
mediamtx container. See [stream-host/README.md](stream-host/README.md) for the
details of both modes.

Keep your real addresses and secrets in the git-ignored files described under
*Local config* in [stream-host/README.md](stream-host/README.md), never in a
commit.

Hedgewars - a turn-based strategy game
======================================
[![Build Status](https://travis-ci.org/hedgewars/hw.svg)](https://travis-ci.org/hedgewars/hw)

Description
-----------
This is the funniest and most addictive game you'll ever play—hilarious fun
that you can enjoy anywhere, anytime. **Hedgewars** is a **turn-based strategy
game** but the real buzz is from watching the **devastation caused by those
pesky hedgehogs** with those fantastic weapons—sneaky little blighters with
a bad attitude!

Each player controls a **team of up to 8 hedgehogs**. During the course of
the game, players take turns with one of their hedgehogs. They then use
whatever tools and weapons are available to **attack and kill the opponents'
hedgehogs**, thereby winning the game.

To destroy your foes you can use one out of **over 40 weapons**!
Launch bazookas or homing bees, drop mines, dynamite or explosive rubber ducks,
throw grenades or watermelon bombs, poison them with stinky cheese, send them
flying with a baseball bat, and much more!

Most weapons cause **explosions that deform the terrain**, removing
circular chunks. Hedgehogs can die by drowning, being thrown off
either side of the arena, or when their health is reduced to zero.

Hedgehogs may move around the terrain in a variety of ways, normally by
walking and jumping but also by using particular tools such as the rope
or parachute, to move to otherwise inaccessible areas. Each **turn is
time-limited** to ensure that players do not hold up the game with
excessive thinking or moving.

Getting started
---------------
For complete beginners we recommend to play in singleplayer mode first.
Start with the Basic Movement Training found in the training menu.
Proceed with the other training missions.
After completing the training, try to play some quick matches against the
computer (also found in the singleplayer menu).
Hedgewars has many weapons, so play a few matches to get a better feeling
for them.

In-depth information about the game can be found online:

* <https://hedgewars.org/start>: Getting Started
* <https://hedgewars.org/wiki.html>: Hedgewars Wiki

Default controls (excerpt)
--------------------------
The most important default controls are:

* Cursor keys: Walk and aim
* Mouse: Move camera
* Right mouse button: Open ammo menu
* Left mouse button: Select target or weapon
* Space bar: Shoot
* Left shift: Precise (this is a modifier key)
* Precise + Up/Down: Precise aiming
* Precise + Left/Right: Turn around without walking
* Hold down Precise: Prevent slipping on ice
* Enter: Jump
* Backspace: High jump
* Backspace ×2: Backjump
* Tab: Switch hedgehog (after activating the utility)
* 1-5: Set weapon timer
* F1-F10: Weapon shortcuts
* M: Mission panel / game mode information. Hold pressed to display, release to hide
* P: Pause, when playing offline, toggle automatic turn skipping when online
* Esc: Quit with prompt
* T: Chat
* U: Clan chat

For the full list, go to the Hedgewars settings. Also read the weapon tooltips
for weapon-specific controls.

### Special controls

These are lesser-known controls of Hedgewars, they are based on your
configured controls:

* Precise + Toggle hedgehog tags: Change visible hedgehog tags (team name/hog name/health)
* Switch  + Toggle hedgehog tags: Toggle hedgehog tag translucency
* Precise + Toggle team bars + Switch: Toggle HUD
* Precise + Capture (screenshot key): Save current map + mask into Screenshot directory
* Precise + zoom in/out: Change zoom in smaller steps
* Precise + volume up/down: Change volume in smaller steps
* Precise + Reset zoom: Set zoom to 100% (instead of the zoom level in the settings)

System requirements
-------------------
For PC or Mac:

* Mouse and keyboard
* Monitor, minimal resolution 1024×768
* 200 MiB storage space
* Processor: 1 GHz (1 core is enough), 64bit recommended
* Video card: 250 MHz or so
              (any decent card from the year 2004 or later should do fine)
* 1 GiB RAM minimum
* Operating system: Windows Vista/7/8/10, GNU/Linux, macOS, FreeBSD, others

Hedgewars has been ported to other operating systems in the past.
Check out <https://hedgewars.org/download.html> for the latest information.

Gamepads are supported partially (only in-game, not in the main menu).

Installation instructions
-------------------------
See the `INSTALL.md` file.

Or see our wiki at <https://hedgewars.org/kb/BuildingHedgewars>.

Source code
-----------
Our main repository is located at <https://hg.hedgewars.org/hedgewars/> using
Mercurial as DVCS. A Git repository is also available (mirrored daily)
at <https://github.com/hedgewars/hw>.

Contribute
----------
If you see a bug or have any suggestion please use the official bug tracker at
<https://hedgewars.org/bugs> or the integrated feedback button.

If you want to help or get to know the sources better you can do that with some
easy tasks from <https://hedgewars.org/kb/TODO>. We also have an extensive API
in Lua to customize your adventures. See our wiki at
<https://hedgewars.org/kb/LuaAPI>.

If you know your way through the code feel free to send a patch or open a pull
request. The best Lua scripts get released in the official DLC page and later
integrated in the next version.

Licence and credits
-------------------
This game is free software (“free” as in “freedom”). Source code is
distributed under the terms of the GNU General Public Licence version 2;
images and sounds are distributed under the terms of the GNU Free Documentation
Licence version 1.2. See the `COPYING` file for the full text of the licenses.

Copyright 2004-2018 Andrey Korotaev <unC0Rr@gmail.com> and others.
Click on the Hedgewars logo in the main menu and read the `CREDITS` text file
for a more complete list of authors.

Contact
-------
* Homepage        - https://hedgewars.org/
* IRC channel     - irc://irc.libera.chat/hedgewars
* Community forum - https://hedgewars.org/forum

