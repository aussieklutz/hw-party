# Runs the stream host on Windows with no screen capture: the engine renders into
# a hidden window on the GPU, its frames and audio go straight to ffmpeg, and
# Intel Quick Sync (or NVENC) encodes them. See stream-host/README.md.
#
# Layout it expects, next to this script (or the repository's own layout):
#   .env                     WORKER_URL and STREAM_HOST_SECRET, see .env.example
#   agent\host-agent.mjs     the agent (in the repository it is ..\agent)
#   game\hwengine.exe        a Hedgewars Windows release, with game\Data
#   ffmpeg\ffmpeg.exe        an ffmpeg with h264_qsv (or h264_nvenc)
#   mediamtx\mediamtx.exe    optional: the RTMP server OBS pulls from
#
# Two ways to reach Twitch:
#   OBS (default)            one ffmpeg per game pushes to the local mediamtx, OBS pulls it and streams
#   FEED_MODE=composite      no OBS: one ffmpeg for the whole session composites the game, the slate and the
#                            scoreboard and streams straight to Twitch (TWITCH_KEY in .env, see .env.example)
#
# Needs Node.js 22 or newer on the PATH.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Find-First($candidates) {
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
    }
    return $null
}

# .env: KEY=value lines, # comments
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
}
if (-not $env:WORKER_URL -or -not $env:STREAM_HOST_SECRET) {
    throw "Set WORKER_URL and STREAM_HOST_SECRET in $envFile"
}

$agent = Find-First @("$root\agent\host-agent.mjs", "$root\..\agent\host-agent.mjs")
$engine = Find-First @($env:ENGINE_BIN, "$root\game\hwengine.exe", "$root\hwengine.exe")
$ffmpeg = Find-First @($env:FFMPEG_BIN, "$root\ffmpeg\ffmpeg.exe", "$root\ffmpeg.exe")
$mediamtx = Find-First @("$root\mediamtx\mediamtx.exe")
if (-not $agent) { throw "agent\host-agent.mjs not found" }
if (-not $engine) { throw "hwengine.exe not found (set ENGINE_BIN or put a release in game\)" }
if (-not $ffmpeg) { throw "ffmpeg.exe not found (set FFMPEG_BIN or put it in ffmpeg\)" }

$env:ENGINE_BIN = $engine
if (-not $env:ENGINE_PREFIX) { $env:ENGINE_PREFIX = Join-Path (Split-Path $engine) "Data" }
if (-not $env:ENGINE_USERPREFIX) { $env:ENGINE_USERPREFIX = Join-Path $env:TEMP "hw-stream" }
New-Item -ItemType Directory -Force $env:ENGINE_USERPREFIX | Out-Null
$env:FFMPEG_BIN = $ffmpeg

# the tap, Quick Sync and a 1080p60 constant bitrate feed unless .env says otherwise
if (-not $env:STREAM_TAP) { $env:STREAM_TAP = "1" }
if (-not $env:ENCODER) { $env:ENCODER = "qsv" }
if (-not $env:STREAM_WIDTH) { $env:STREAM_WIDTH = "1920" }
if (-not $env:STREAM_HEIGHT) { $env:STREAM_HEIGHT = "1080" }
if (-not $env:STREAM_FPS) { $env:STREAM_FPS = "60" }
if (-not $env:VIDEO_KBPS) { $env:VIDEO_KBPS = "6000" }

$composite = $env:FEED_MODE -eq "composite"
if ($composite) {
    # straight to Twitch: the ingest and the stream key come from .env, nothing is pulled by OBS
    if (-not $env:FEED_URL) {
        if (-not $env:TWITCH_KEY) { throw "FEED_MODE=composite needs TWITCH_KEY (or FEED_URL) in $envFile" }
        if (-not $env:TWITCH_INGEST) { $env:TWITCH_INGEST = "aps20.contribute.live-video.net" } # Sydney
        $env:FEED_URL = "rtmp://$($env:TWITCH_INGEST)/app/$($env:TWITCH_KEY)"
        if ($env:TWITCH_TEST -eq "1") { $env:FEED_URL += "?bandwidthtest=true" } # a test stream: checked by Twitch, never live
    }
    $mediamtx = $null   # nothing to serve locally unless FEED_URL points at it
    if ($env:FEED_URL -match '^rtmp://(127\.0\.0\.1|localhost)') { $mediamtx = Find-First @("$root\mediamtx\mediamtx.exe") }
}
elseif (-not $env:FEED_URL) { $env:FEED_URL = "rtmp://127.0.0.1:1935/live/game" }

$mtxProc = $null
try {
    if ($mediamtx) {
        # the engine sends nothing while a game loads, which can take longer than the default 10 s
        if (-not $env:MTX_READTIMEOUT) { $env:MTX_READTIMEOUT = "60s" }
        if (-not $env:MTX_WRITETIMEOUT) { $env:MTX_WRITETIMEOUT = "60s" }
        $mtxProc = Start-Process $mediamtx -WorkingDirectory (Split-Path $mediamtx) -WindowStyle Hidden -PassThru
        if (-not $composite) { Write-Host "mediamtx started: OBS Media Source input is rtmp://localhost:1935/live/game" }
    }
    if ($composite) { Write-Host "composite feed: one encoder straight to $($env:TWITCH_INGEST) (the stream key is not shown)" }
    Write-Host "stream host: $($env:WORKER_URL), $($env:STREAM_WIDTH)x$($env:STREAM_HEIGHT)@$($env:STREAM_FPS), $($env:ENCODER)"
    & node $agent
}
finally {
    if ($mtxProc -and -not $mtxProc.HasExited) { Stop-Process -Id $mtxProc.Id -Force }
    Get-Process hwengine, ffmpeg -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -in @($engine, $ffmpeg) } | Stop-Process -Force
}
