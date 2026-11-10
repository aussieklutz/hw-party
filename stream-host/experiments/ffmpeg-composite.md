# Experiment: ffmpeg-composite (drop OBS, one persistent encoder feeds Twitch)

Branch `experiment/ffmpeg-composite`. Everything is behind `FEED_MODE=composite`; the default (one ffmpeg per game, OBS
pulls it) is unchanged. Nothing here was run against real Twitch.

## The question

Can the host drop OBS and give Twitch a feed directly from ONE persistent ffmpeg, so that the stream never drops
between games and carries a single low-latency encode? Base layer = slate while no game runs, the engine's frames when one
does; the worker's `/stream/` page (scoreboard) on top in both phases, as OBS does today; audio continuous.

## Answer in short

**Go, with changes (and with the open items below).** It works end to end, including one real game through the real phone page:
one ffmpeg for the whole session, slate -> game -> slate -> game switching on frame boundaries, monotonic timestamps, a keyframe
exactly every 2 s, CBR 6000k, no audio gap, overlay visible in both phases. Its own latency (engine write -> frame at a low-latency
reader) is about the same as today's per-game encoder once the audio is run slightly ahead of the video (see "audio lead"):
the encode hop does not get worse and the OBS hop (media source buffer + second encode, not measurable here) and the drop between games
disappear. Costs: about 0.6 core more of agent CPU at 1080p60 (the Node forwarder), and you lose OBS's scene editing, webcam and alerts.

## What was built

| file | role |
|---|---|
| `agent/composite.mjs` | persistent encoder + frame-aligned forwarder + supervisor (`FEED_MODE=composite`) |
| `agent/overlay.mjs` | headless Chrome/Edge over CDP, transparent page screenshots about 1/s, finds the painted box |
| `agent/layer.mjs` | RGBA box -> NV12-blendable layer (alpha pre-multiplied), `blendLayer()` |
| `agent/layer-worker.mjs`, `agent/pngdec.mjs` | PNG decode + layer build in a worker thread (no dependencies) |
| `agent/tap.mjs` | in composite mode `tapStart()` hands out only the engine arguments (no per-game ffmpeg) |
| `agent/host-agent.mjs` | starts `compositeStart()` once, at agent start; SIGINT/SIGTERM stop it |
| `windows/run.ps1`, `.env.example`, `windows/release-readme.txt`, `windows/make-release.ps1` | release preconfiguration (below) |
| `tests/fake-engine*.mjs`, `tests/composite-feed.mjs`, `tests/composite-latency.mjs`, `tests/composite-host.mjs`, `tests/composite-real.mjs`, `tests/overlay-bench.mjs`, `tests/composite-lib.mjs` | tests and measurements |

### How it works

* The agent (not ffmpeg) listens on `TAP_VIDEO_PORT`/`TAP_AUDIO_PORT`; the engine connects per game exactly as before. Whatever the
  engine sends is always read, so a slow encoder can never hold the game up; the output side drops.
* ffmpeg connects, as a client, to two ephemeral localhost ports of the agent and receives exactly FPS frames and 44100 samples a
  second (rawvideo NV12 `-framerate 60`, s16le). Timestamps are therefore the counts (monotonic by construction); audio is written
  together with its video frame, so there is no A/V drift whatever the clock does. ffmpeg opens video first and gets real-time
  frames at once; audio connects a moment later and receives what it missed in one go.
* Each 1/FPS slot takes the newest complete engine frame (whole frames only, so the switch always falls on a frame boundary) or the
  slate. The engine's own ~62.5 fps is resampled to 60 (duplicate when late, drop when early). An engine silent for 1.5 s (loading)
  falls back to the slate. Engine disconnect/reconnect only changes which frame is picked; ffmpeg is never touched. If ffmpeg dies or
  stops reading for 3 s it is restarted (the stream then breaks briefly; the engine does not notice).
* Audio: engine audio goes through a small FIFO (50 ms jitter buffer, refilled after an underflow, oldest dropped beyond 130 ms so a
  stall cannot leave the sound permanently late); silence when no engine.
* Overlay: the page (default `<WORKER_URL>/stream/scoreboard.html` for both phases, which is OBS parity: "HW Game" = scoreboard over
  game, "HW Slate" = scoreboard only; `OVERLAY_SLATE_URL=<worker>/stream/` gives the real slate slides instead) is rendered by one headless
  browser (Chrome, else Edge, always present on Windows 11) once a second. A quarter-size screenshot finds the painted box, a full-size
  screenshot of just that box is decoded in a worker thread and blended by the agent into game frames (per frame, box only) and into the
  cached slate frame (once per overlay change).
* Encoder: Quick Sync `h264_qsv`, CBR 6000k, 2 s GOP (IDR), `-bf 0 -look_ahead 0 -async_depth 1`, profile high, AAC-LC 160k 44.1 kHz,
  `-flush_packets 1`. At start a 0.2 s probe encode checks Quick Sync; if it fails it falls back to `libx264 -tune zerolatency`, or to
  `libopenh264` when the ffmpeg has no libx264 (the bundled LGPL build has none).
* Key: `FEED_URL`, or `TWITCH_KEY` (+ `TWITCH_INGEST`, default `aps20.contribute.live-video.net`) -> `rtmp://<ingest>/app/<key>`. Every
  log line and every ffmpeg stderr line goes through `redact()`; the key is never printed. The process priority of the agent and its ffmpeg
  is raised to "high" (`FEED_PRIORITY=normal` to disable): see "timer jitter".

## How to run it

```
# worker (local) and a local mediamtx are only needed for tests; for Twitch put this in .env
FEED_MODE=composite
TWITCH_KEY=<primary stream key>          # TWITCH_INGEST defaults to the Sydney ingest
powershell -File windows\run.ps1         # or: node agent\host-agent.mjs with STREAM_TAP=1 FEED_MODE=composite FEED_URL=...
node stream-host/tests/frames.mjs        # still green
node stream-host/tests/composite-feed.mjs                       # fake engine, 720p30, openh264, no GPU needed (ENCODER=qsv TEST_W=1920 TEST_H=1080 TEST_FPS=60 for Quick Sync, takes the GPU lock)
node stream-host/tests/composite-latency.mjs                    # MODE=composite|baseline, flash ground truth, load
node stream-host/tests/composite-real.mjs                       # one real game through the real phone page (worker on :8791)
node stream-host/tests/overlay-bench.mjs                        # ffmpeg overlay variants
```

## Measurements

Method and caveats first. The machine was **not idle**: the user's OBS was running and encoding, and the two other experiment agents
used the CPU and (under the lock) the iGPU, so run-to-run noise is about +-40 ms in latency. Hence several runs per variant and no claims
below that. A fake engine (own process, high priority) writes 1080p (or 720p) NV12 frames at 62.5 fps with three white frames once a second and
logs the exact write time (`performance.timeOrigin + now`) of the first one; a reader (ffmpeg `-fflags nobuffer -flags low_delay`, 32x18 gray frames
to a pipe, high priority) on a local mediamtx timestamps the arrival of the first bright frame of each flash. latency = arrival - write; it
includes the reader's own decode/pipe time (the same for every variant, a few ms to tens of ms; never calibrated). 18-25 flashes per run, per-run
median (p50) given. The overlay in all of these is the real worker `/stream/scoreboard.html` (local wrangler).

### Latency, 1080p60 Quick Sync, p50 of each run (ms)

| path | runs |
|---|---|
| today's per-game ffmpeg (`tap.mjs`) | 155, 199, 138, 215, 136 |
| composite, audio in step with video (`AUDIO_LEAD_MS=0`) | 193, 224, 233, 179, 196, 196 |
| composite, audio runs 60 ms ahead (the shipped default is 50) | 138, 146, 127 |

720p60: today 120, 132, 133; composite in step 229, 189 (no overlay 169, 214; wallclock timestamps 233, 218); **no audio at all 98, 148**; lead 60: 131, 118, 95;
lead 100: 109.

What this shows: the composite path was 40-100 ms slower than the per-game path until the cause was found: the flv muxer holds every video packet until an
audio packet with a later timestamp has arrived, and an AAC packet is 1024 samples (23 ms) plus the encoder's priming. With audio written exactly in step
that costs 25-100 ms per frame (switching audio off entirely gave 98-148 ms). Running the audio track ~50-60 ms ahead (it starts with that much silence;
the engine audio then plays that much late against the picture, within what viewers do not notice) removes it: composite 127-146 ms at 1080p60 against
136-215 for today's path in the same period. The same effect probably applies to the existing `tap.mjs` (its engine audio arrives ahead); not tried.

### Quick Sync option sets (1080p60, composite, audio in step; p50 per run, ms)

| option set | runs |
|---|---|
| `-async_depth 1 -preset veryfast` (shipped) | 193, 224, 233, 179, 196, 196 |
| async_depth 4, preset medium (today's tap.mjs values) | 171 |
| async_depth 1, preset medium | 201 |
| `-low_delay_brc 1` | 169, 219, 235, 188 |
| `-scenario gamestreaming` | 227 |
| `-low_power 1` | 174, 180, 191, 185 |
| all three | no usable sample |

**None of these is distinguishable from the +-40 ms noise.** `low_power` (and maybe `low_delay_brc`) look a little better (about 180 vs 195) but not
reliably; I left them off by default (`QSV_LOW_POWER=1`, `QSV_LOW_DELAY_BRC=1`, `QSV_SCENARIO=7` switch them on) and kept async_depth 1 and no B frames and
no look-ahead, which are free. `extra_hw_frames` below 8 fails ("Cannot allocate memory"); 32 is used.

### Where the latency actually is

The encoder hop (engine write -> frame at the reader) is roughly 120-200 ms with Quick Sync in every variant and resolution (720p and 1080p are within noise),
so most of it is not pixels: it is the encoder pipeline, the AAC/muxer interleave, mediamtx and the reader. Twitch's own ingest/transcode/HLS, which is where
seconds go, is outside this test (Twitch "Low latency" setting).

### CPU and GPU (middle of a 30 s game, per process, % of one core; GPU engines of the ffmpeg process)

| | ffmpeg | agent (Node) | overlay browser | GPU 3D / video (ffmpeg process) |
|---|---|---|---|---|
| composite 1080p60 | 61 | 55 | 8 | 33% / 13% |
| today's per-game path 1080p60 | 61 | 0 | 0 | 36% / 13% |
| composite 720p60 | 36 | 34 | 9 | 23% / 6% |
| today's per-game path 720p60 | 33 | 0 | 0 | 25% / 6% |

(In other runs the Node agent was 60-80% at 1080p60 and 27-35% at 720p60; the fake engine itself took 12-19%.) So composite adds the agent's
forwarding, about 0.5-0.7 core at 1080p60, which replaces OBS (whose own CPU/GPU use is not counted here). The Node cost is the socket traffic itself:
a `--cpu-prof` of the agent showed `writeBuffer` (the write of 3 MB frames to the ffmpeg socket) as the biggest item, 3.8 s of a 32 s run, plus the frame copies.
The GPU load is identical to today's, as expected.

Blend cost (agent, per game frame, the real scoreboard's painted box): 0.7 ms at 720p, 1.2 ms at 1080p; the test page with two far-apart panels (box = whole frame) 2.4-5 ms.
The overlay is rebuilt only when the page changed (one layer for the real scoreboard in a 40 s run: it is a static page when nobody has played).

### Overlay in ffmpeg or in the agent? (`tests/overlay-bench.mjs`, synthetic lavfi sources, no `-re`; 1.0x = real time at 60 fps)

| variant | speed | ffmpeg CPU |
|---|---|---|
| CPU `overlay`, full frame yuva420p, null output | 8.6x | 0.30 core |
| CPU `overlay`, 1200x180 box, null output | 13.5x | 0.21 core |
| QSV encode only | 2.09x | 0.33 core |
| CPU overlay full frame + QSV encode | 1.98x | 0.79 core |
| CPU overlay box + QSV encode | 2.04x | 0.61 core |
| `overlay_qsv` full frame + QSV encode | 1.22x | 0.66 core |
| `overlay_qsv` box + QSV encode | 1.69x | 0.53 core |

(The QSV encode reaches only 2.09x at 1080p because the iGPU was shared with OBS and the other agents.) So the POC's 0.3-0.65x was not the overlay
filter's blend itself (the CPU overlay of a full 1080p yuva420p frame is cheap at constant 60 fps overlay input) but the combination with a 1 fps image
input: ffmpeg's `overlay` (framesync) waits for the next overlay frame before releasing main frames; with a 1 fps overlay, `-re` on both inputs, the first
output frame left 0.54 s late. A fix inside ffmpeg would be to feed the overlay at the full frame rate (86-190 MB/s of BGRA over TCP) or to loop/re-read it.
`overlay_qsv` is slower than the CPU overlay here and needs the box also uploaded as a surface. Doing the blend in the agent costs about 1 ms per frame
(0.05-0.07 core), has no framesync wait and keeps ffmpeg's graph trivial: that is what is shipped. Not tried: crop-to-bbox ffmpeg overlay with a 60 fps
rawvideo overlay feed, and `movie`/`-loop 1` re-reads (the framesync stall makes them unattractive).

### Switching test (fake engine, `tests/composite-feed.mjs`, Quick Sync 1920x1080@60, slate 9 s / game 8 s / slate 5 s / game 8 s / slate 6 s, overlay on)

* ONE ffmpeg for the run (`ffmpegStarts` 1), the engine connected twice.
* The recording of what a viewer gets from mediamtx (`ffprobe -show_packets`): video dts/pts monotonic, **0 B-frames**, keyframes every **2.0 s** exactly (no extra ones),
  **60.03 fps**, video 6003 kbps with every 1 s window at 6000 kbps (CBR holds on the static slate too), audio AAC-LC 44.1 kHz stereo, **max audio packet gap 25 ms
  (one AAC frame is 23.2 ms)**, H.264 High 1920x1080.
* Frame extraction: the viewer sequence classified from the pictures (4 per second) is slate, game, slate, game, slate; the overlay panel and badge are detected in all phases.
  I looked at the contact sheet of the 720p run (the translucent panel is blended over the moving bar in the game phases, ticking once a second) and, with the real scoreboard page,
  at a game frame and a slate frame (text and shadow blended over the game).
* With the software fallback encoder (`libopenh264`, 1280x720@30): same checks pass except that openh264 adds an IDR at scene changes (2 extra keyframes), which is allowed (max 2 s).
* `libx264` itself could not be tested: the bundled ffmpeg has none.

### One real game through the real phone page (`tests/composite-real.mjs`, real hwengine, 1280x720@60, Quick Sync)

headless Chrome as the phone joined the queue, built a team and fired a Bazooka (`weapons-cdp.mjs`: PASS, `gtShell` in the engine log). The agent log shows one engine video
connect, one ffmpeg; the recording is slate (the "Loading" screen, then the map) -> real game with the scoreboard text on it -> game, 60.02 fps, keyframes every 2 s, no gaps.
The real engine delivered only 50 fps of frames on this loaded machine (the forwarder duplicated the rest), and its audio, 176-178 KB/s as it should be, arrives in bursts:
37 times in a 26 s run the audio buffer ran dry (engine pauses of 40-560 ms; 14 pauses over 40 ms) and a short silence was inserted. Whether that is audible was not judged by ear.

### Twitch compatibility (ffprobe on the recording above, no real Twitch)

H.264 High, 1920x1080 60 fps, no B-frames, IDR every 2.0 s, CBR 6003 kbps average; on the quiet test pictures every 1 s window is exactly 6000 kbps, on the real game (720p) 1 s windows ranged
4.4-8.2 Mbit/s (Quick Sync CBR with `bufsize = bitrate` lets short bursts through; Twitch tolerates that, but it is not a strict 6000), AAC-LC 44.1 kHz stereo (160 kbps target; silence and a sine
average 74-105 kbps). That matches what Twitch asks for. Not validated: that Twitch accepts the stream (no key was used).

## What did not work / what was found on the way

* **Audio in step costs 25-100 ms** (above). Fixed with an audio lead.
* **The overlay filter and a 1 fps overlay**: stalls (above).
* **Timer jitter**: a normal-priority Node process on this loaded machine woke up on average every 22 ms instead of every 2 ms (443 ticks in 10 s, 121 stalls over 30 ms,
  worst 200 ms); at high priority 4411 ticks, worst 5 ms. A frame clock needs wake-ups every few ms, so the agent and its ffmpeg are raised to high priority
  (`os.setPriority`, no admin needed; `FEED_PRIORITY=normal` to turn off). Without it the forwarder missed slots and the engine socket backed up.
* **ffmpeg input probing blocks**: a raw TCP input is only "open" once ffmpeg has read enough, so whichever input opens first must be fed at once; the video is first and
  fed in real time, the audio gets its backlog when it connects. (Writing 8 kB to audio first deadlocked.) `hwupload` needs `extra_hw_frames` of at least 8.
* A fixed Chrome `--remote-debugging-port` does not write `DevToolsActivePort`; a given `OVERLAY_CDP_PORT` is therefore used as given.
* The bundled ffmpeg has no `libx264`. The software fallback uses `libopenh264` (CBR is approximate with it).

## Release preconfiguration

* `.env.example` has a "Twitch direct (FEED_MODE=composite)" block: `FEED_MODE`, `TWITCH_KEY`, `TWITCH_INGEST` (Sydney `aps20.contribute.live-video.net`), overlay URLs, `SLATE_COLOR`,
  `OVERLAY=0`, `OVERLAY_BROWSER`, `FEED_PRIORITY`. It is commented out so that a plain copy keeps today's OBS behaviour.
* `windows/run.ps1`: with `FEED_MODE=composite` and no `FEED_URL` it needs `TWITCH_KEY`, builds `rtmp://<ingest>/app/<key>`, does not start mediamtx (unless `FEED_URL` is local) and does not
  print the key. Otherwise unchanged.
* `windows/make-release.ps1` still refuses to pack a `.env` (tested: a `.env` in the game folder aborts) and now also refuses any text file that looks like a stream key (`live_<digits>_<token>`).
* `windows/release-readme.txt` documents the steps and everything the user sets by hand.

### What the user has to do by hand

1. Put `FEED_MODE=composite` and `TWITCH_KEY=<Primary Stream key>` in `.env` (never in git or a zip).
2. Twitch dashboard > Settings > Stream > Latency mode: **Low latency**. Without it viewers see 8-15 s whatever the feed does (the 2-5 s for low latency is "widely reported", unverified).
3. Close OBS' stream (only one source may stream to the channel). Chrome or Edge must be installed (Edge is on every Windows 11).
4. First time: stream with `?bandwidthtest=true` appended to the key (a non-live test stream for Twitch Inspector) before going live.

### What is lost compared with OBS, and how to keep OBS

Lost: scene editing (the layout is one worker page per phase, set in `.env`), webcam or any other source, alerts and chat overlays, OBS's preview and its own reconnect behaviour
(a dropped Twitch connection restarts ffmpeg after 1-5 s and the stream breaks for that long). Keep OBS: leave `FEED_MODE` out of `.env`; nothing changes (per-game feed to the local
mediamtx, OBS Media Source `rtmp://localhost:1935/live/game`).

## Risks

* Early runs of the overlay browser used a random free DevTools port on 127.0.0.1 instead of 9711-9719 (later runs used `OVERLAY_CDP_PORT`); nothing was exposed beyond loopback.
* Twitch ingest was never tried; reconnection after a network drop is only "restart ffmpeg with backoff" (tested against a stuck local ffmpeg, not against a real ingest).
* The Node forwarder uses 0.5-0.7 core at 1080p60 and depends on getting scheduled promptly (hence the priority); on a PC much busier than this one frames could be dropped (the output
  drops, the engine is never stalled, but the stream stutters).
* The audio plays ~50 ms (lead) + up to 50 ms (jitter buffer) late against the picture; the engine's bursty audio produced buffer underruns (short silences) in the real game.
* The overlay is one page per phase: the multi-source OBS layouts (splash QR next to the scoreboard) are not reproduced; one could point `OVERLAY_*_URL` at a purpose built page.
* The slate between games is a plain colour plus the scoreboard (OBS parity). A full slate page works (`OVERLAY_SLATE_URL=<worker>/stream/`, one full-frame decode per change in the worker
  thread; the full-frame stub test ran fine at 1080p60) but was not looked at in a long run.
* Runs were at most ~3 minutes: long-session behaviour (memory, drift against Twitch's clock) is unverified. NVENC and the Linux paths are untested.
* The comparison with OBS is indirect: only the part up to a local reader was measured; the OBS chain (media source buffer, compose, second encode) was not touched.

## Recommendation and next steps

**Go with changes.** Keep it behind `FEED_MODE=composite`, merge after the user's Twitch trial. Next steps:

1. A real test stream to Twitch with `?bandwidthtest=true`, then a short real one with Low latency on; measure glass-to-glass with the flash method on a second device.
2. Listen to the audio of a real game (underruns, A/V offset); tune `AUDIO_LEAD_MS`/`AUDIO_JITTER_MS`; try the same audio lead in `tap.mjs`.
3. Decide on the slate content (scoreboard only like OBS, or `/stream/` slides) and whether a second overlay (splash/QR) is wanted.
4. Reduce the agent's forwarding cost: forward engine chunks cut-through (no whole-frame assembly) or have the engine write at exactly 60 fps; try `low_power`/`low_delay_brc` over a longer, quieter measurement.
5. Handle Twitch drops explicitly (log, retry with the same key, maybe `-reconnect` options) and run a long soak.
