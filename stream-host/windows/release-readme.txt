Hedgewars stream host for Windows (headless, Quick Sync)
========================================================

The engine renders into a hidden window on your GPU and hands every frame and
its audio straight to ffmpeg, which encodes with Intel Quick Sync (or NVENC)
and pushes to the RTMP server. No screen capture, no container.

Needs: Node.js 22 or newer on the PATH, and a GPU with a hardware H.264 encoder
(Intel Quick Sync works with the bundled ffmpeg; NVENC needs a driver that ships
nvEncodeAPI64.dll).

Setup
-----
1. Copy .env.example to .env and set
     WORKER_URL=<your stream worker, e.g. https://hwstream.<account>.workers.dev>
     STREAM_HOST_SECRET=<the worker's STREAM_HOST_SECRET>
2. Run:  launch.bat   (or powershell -ExecutionPolicy Bypass -File run.ps1)

OBS: add a Media Source with the input
     rtmp://localhost:1935/live/game
(untick "Local File"). The stream only exists while a game is running.

Straight to Twitch, without OBS (FEED_MODE=composite)
----------------------------------------------------
One ffmpeg lives for the whole session. It composes the game, a slate between games and the
scoreboard page, encodes once with Quick Sync and streams straight to Twitch. The stream does not
drop between games, and there is no second encode and no OBS buffer in the way.

What you set by hand:
  1. In .env (copy .env.example first) uncomment and fill in
       FEED_MODE=composite
       TWITCH_KEY=<your Primary Stream key: Twitch dashboard > Settings > Stream>
     TWITCH_INGEST is already the Sydney ingest (aps20.contribute.live-video.net); change it to any
     ingest from https://ingest.twitch.tv/ingests if you are elsewhere. The key stays in .env: it is
     never logged, never in git and make-release.ps1 refuses to pack a .env.
  2. Twitch dashboard > Settings > Stream > "Latency mode": choose "Low latency". Without it viewers
     see 8-15 s of delay however fast the feed leaves your PC (low latency is reported to be about 2-5 s).
  3. Close OBS (or at least its Twitch stream): only one thing may stream to the channel at a time.
  4. Chrome or Edge must be installed (Edge is on every Windows 11): it draws the scoreboard overlay.
  5. run.ps1 / launch.bat as usual. It checks Quick Sync and falls back to software if it is missing.
  Optional (.env): OVERLAY_GAME_URL / OVERLAY_SLATE_URL (any worker /stream/ page, for example
  <WORKER_URL>/stream/ for the slate slides while no game runs), SLATE_COLOR, OVERLAY=0, VIDEO_KBPS.

What you give up compared with OBS: scene editing (the layout is the one page per phase, set in .env),
a webcam or any other source, alerts and chat overlays, and OBS's own preview. If you want those,
simply leave FEED_MODE out of .env: nothing changes, the per-game feed to the local mediamtx and OBS
work exactly as before (OBS Media Source rtmp://localhost:1935/live/game).

Settings (put them in .env)
---------------------------
  ENCODER=qsv          qsv | nvenc    (x264 needs an ffmpeg built with libx264)
  STREAM_WIDTH=1920    STREAM_HEIGHT=1080    STREAM_FPS=60
  VIDEO_KBPS=6000      constant bitrate, a keyframe every 2 seconds
  ROOM_MODE=dynamic    classic | fixed | dynamic | teams | imposter
  POP_COUNT, CPU_TIER, LOBBY_WAIT_MS ...   see .env.example

Measured on a laptop with an Iris Xe at 1080p60, 6 Mbit CBR: a steady 60 fps, the
engine using about 0.8 of a core and ffmpeg about 0.6. The engine converts each
frame to NV12 on the GPU (TAP_FORMAT=bgra turns that off; TAP_STATS=1 logs
ffmpeg's frame rate and dropped frames every 5 seconds).

Layout
------
  run.ps1       the launcher
  agent\        the stream host agent (Node.js)
  data\         screen name filter
  game\         Hedgewars engine (hwengine.exe, Data\, DLLs)
  ffmpeg\       ffmpeg 7.1 (LGPL build, see its LICENSE.txt)
  mediamtx\     the RTMP server OBS pulls from (optional, MIT licence)

Source and docs: stream-host\README.md in the Hedgewars repository.
