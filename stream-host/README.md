# stream-host

Headless Docker host for party games: runs `hwengine` in a container, loops
games forever from the worker's queue, and heals itself.

Two streaming modes:

- **OBS mode (M12, the compose default)**: the container runs the orchestrator,
  Xvfb + PulseAudio and the engine; `agent/feed.mjs` pushes video+audio to a
  local **mediamtx** RTMP server **only while a game is live**. OBS on the
  streamer machine pulls `rtmp://<this-host>:1935/live/game` as a Media Source
  and layers the hwstream worker's overlay views
  (`/stream/scoreboard|stats|splash|seats.html`) as browser sources. Scene
  switching is OBS-side.
- **Legacy mode (M11.2)**: `STREAM_VIDEO=1` composites everything in the
  container (slate in the feed, window raising per phase) and pushes straight
  to an RTMPS target.

```
WORKER_URL=https://stream.example.com            # stream worker (required)
ROOM_MODE=dynamic                                 # classic|fixed|dynamic|teams|imposter
ROOM_SLOTS=4                                      # slots/cap for the classic/fixed modes
MAX_PLAYERS=12                                    # teams/imposter lobby cap (imposter 12, teams 24)
FEED_URL=rtmp://127.0.0.1:1935/live/game          # OBS-mode push target
RTMP_URL=rtmps://a.rtmp.youtube.com/live2/<key>   # legacy push target
STREAM_HOST_SECRET=...                            # queue control auth
```

Layout (scaffolded in M11.1+):

- `worker/` — this stack's own party worker deployment, `hwstream`
  (same code as the party worker, independent copy; the plain party worker
  stays untouched). Deploy with
  `party/node_modules/.bin/wrangler deploy --config stream-host/worker/wrangler.toml`.
- `agent/host-agent.mjs` — supervisor + worker host client + engine IPC driver
- `agent/video.mjs` — M11.2 live pipeline: Xvfb + PulseAudio + ffmpeg capture
  (RTMP push or local file), chromium showing `/stream/` as the slate, and
  per-phase window switching between slides and the engine
- `agent/safewords.mjs`, `data/safewords.txt` — name filtering for the stream
- `Dockerfile` + `docker-compose.yml` — engine-only build inside the image,
  Xvfb/Pulse/ffmpeg/chromium runtime, game data volume-mounted

Run it:

```
cp stream-host/.env.example stream-host/.env    # then fill in WORKER_URL and the secret
podman-compose -f stream-host/docker-compose.yml up -d
```

## Windows host (no capture)

On Windows the stream host runs natively with no container, no virtual display
and no screen grab. The engine renders into a hidden window on the GPU
(`--hidden`) and hands every frame and its mixed audio to an ffmpeg over two
local ports (`--stream-video-port`, `--stream-audio-port`); ffmpeg encodes with
Intel Quick Sync (or NVENC) at a constant bitrate with a keyframe every two
seconds and pushes to the RTMP server. In a 1080p60 test it took about one
core for the engine and one and a half for ffmpeg, and held 56 to 60 fps.

You need Node.js 22 or newer, a Hedgewars Windows release, an ffmpeg with
`h264_qsv` (or `h264_nvenc`) and, optionally, mediamtx. Lay them out next to
`windows\run.ps1`:

```
.env                   WORKER_URL and STREAM_HOST_SECRET
agent\ data\          from stream-host
game\                  the release: hwengine.exe, Data\, the DLLs
ffmpeg\ffmpeg.exe
mediamtx\mediamtx.exe  optional
```

```
powershell -ExecutionPolicy Bypass -File windows\run.ps1
```

OBS pulls `rtmp://localhost:1935/live/game` as usual. Set `ENCODER=nvenc` or
`x264`, `STREAM_FPS`, `VIDEO_KBPS` and so on in `.env` to change the feed.
The same tap works anywhere: `STREAM_TAP=1` on Linux uses SDL's offscreen
video driver, so it needs no X server either.

The engine reads each frame back through a ring of pixel buffer objects and
sends it from a thread of its own, so the game does not wait for the graphics
card or for ffmpeg. If ffmpeg falls behind, frames are dropped rather than
slowing the game down. Two environment variables of the engine change that:
`HW_TAP_MODE=0` is the plain blocking read, `1` reads through the buffers but
sends in the game thread, `2` (the default) also sends from a thread;
`HW_TAP_STATS=1` logs the time spent per frame and the dropped frames every 300
frames. The Windows launcher gives mediamtx a 60 second timeout instead of 10,
because the engine sends nothing while a game loads.

## GPU rendering (WSL2)

Without a GPU the engine renders in software on the virtual display and uses
about 1.5 cores at 720p. Under WSL2 the container can use the Windows GPU
instead: `/dev/dxg` plus Mesa's d3d12 driver give it hardware OpenGL, and the
engine drops to about 0.15 core. Add the override file to the compose command:

```
docker compose -f stream-host/docker-compose.yml \
               -f stream-host/docker-compose.wsl-gpu.yml up -d
```

`GPU_ADAPTER` picks the adapter by name (`NVIDIA` by default, `Intel` for the
integrated one). This is for WSL2 only; on a Linux host use the vendor's
container toolkit instead.

## Local config

Nothing instance-specific is committed. Real values live in git-ignored files
next to their tracked `*.example`:

| File (git-ignored) | Template | Holds |
|---|---|---|
| `stream-host/.env` | `.env.example` | `WORKER_URL`, `STREAM_HOST_SECRET`, game settings for the compose stack |
| `*/.dev.vars` | `.dev.vars.example` | secrets and URLs for `wrangler dev` |
| `*/wrangler.local.toml` | `wrangler.toml` | the deploy-time values (D1 id, public URLs, sender) |

To deploy with your own values, copy the worker's `wrangler.toml` to
`wrangler.local.toml`, fill in the commented-out settings, and pass it to
wrangler: `wrangler deploy --config wrangler.local.toml`.

Milestones: M11.1 agent v1 (local proof) → M11.2 Docker + RTMPS capture + slate
in the feed → M11.3 modes/seats → M11.4 signup worker (Glicko-2 ladder, top-20
slate). VOD is deferred (possibly out-of-band).
