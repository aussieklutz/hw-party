# Experiment: ffmpeg-composite (drop OBS, one persistent encoder feeds Twitch)

Branch `experiment/ffmpeg-composite`. Status: work in progress, this file is updated as measurements arrive.

## The question

Can the host drop OBS and give Twitch a feed directly from ONE persistent ffmpeg, so that the stream never drops
between games and carries a single low-latency encode? Base layer = slate while no game runs, the engine's frames
when one does; the worker's `/stream/` page (scoreboard) on top in both phases, as OBS does today; audio continuous.

## What was built (all behind `FEED_MODE=composite`, default unchanged)

| file | role |
|---|---|
| `agent/composite.mjs` | the persistent encoder + the frame-aligned forwarder + supervisor |
| `agent/overlay.mjs` | headless Chrome/Edge over CDP, transparent page screenshots about 1/s, finds the painted box |
| `agent/layer.mjs` | RGBA box -> NV12-blendable layer (alpha pre-multiplied), `blendLayer()` |
| `agent/layer-worker.mjs`, `agent/pngdec.mjs` | PNG decode + layer build in a worker thread (no dependencies) |
| `agent/tap.mjs` | `tapStart()` hands out only the engine arguments in composite mode (no per-game ffmpeg) |
| `agent/host-agent.mjs` | starts `compositeStart()` once, at agent start |
| `tests/fake-engine*.mjs`, `tests/composite-*.mjs` | fake engine, feed test, latency/load test |

How it works:

* The agent (not ffmpeg) listens on `TAP_VIDEO_PORT`/`TAP_AUDIO_PORT`; the engine connects per game exactly as before.
  Whatever the engine sends is always read, so a slow encoder can never hold the game up; the output side drops.
* ffmpeg connects, as a client, to two ephemeral localhost ports of the agent and receives exactly FPS frames and
  44100 samples a second (rawvideo NV12 `-framerate 60`, s16le). Timestamps are therefore the counts (monotonic by
  construction), audio is written together with its video frame (`floor(frames*44100/FPS) - samplesSent`), so there is no A/V
  drift whatever the clock does. ffmpeg opens video first and gets real-time frames at once; audio connects a moment
  later and gets what it missed in one go.
* Each 1/FPS slot takes the newest complete engine frame (whole frames only: the switch always falls on a frame
  boundary) or the slate frame. Engine frames arrive at its own ~62.5 fps and are resampled to 60 (duplicate when late, drop when early).
  An engine that sends nothing for 1.5 s (loading) falls back to the slate. Disconnect/reconnect of the engine only changes
  which frame is picked; ffmpeg is never touched. If ffmpeg dies or stops reading for 3 s it is restarted (the stream then breaks, the engine does not).
* Audio: engine audio goes through a small FIFO (40 ms jitter buffer, oldest dropped beyond 160 ms); silence when no engine.
* Overlay: the page (default `<WORKER_URL>/stream/scoreboard.html`, for both phases, OBS parity; `OVERLAY_SLATE_URL` can be
  `/stream/` for the real slate slides) is rendered by one headless browser (Chrome, else Edge, always present on Windows 11) at
  1 fps. A quarter-size screenshot finds the painted box, a full-size screenshot of just that box is decoded in a worker thread and
  blended by the agent into game frames (per frame, box only) and into the cached slate frame (once per overlay change).
* Encoder: Quick Sync (`h264_qsv`, CBR 6000k, 2 s GOP, `-bf 0 -look_ahead 0 -async_depth 1`, profile high, AAC 160k, `-flush_packets 1`);
  falls back to libx264 (`zerolatency`) or, in the bundled LGPL ffmpeg that has no libx264, to `libopenh264` when the Quick Sync probe fails.
* Key: `FEED_URL`, or `TWITCH_KEY` (+ `TWITCH_INGEST`, default `aps20.contribute.live-video.net`). The key never goes to a log:
  `redact()` is applied to every ffmpeg stderr line and log line.

(Measurements, what failed, risks and the recommendation follow below as they are produced.)
