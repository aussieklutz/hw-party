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
