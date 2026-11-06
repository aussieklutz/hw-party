#!/bin/sh
# imposter-stack.sh — run the stream host (agent + engine in STREAM MODE with a
# local recording) in the podman VM, pointed at the worker running on the
# Windows host. The image is built from a tracked-files tarball extracted in
# the VM (a bind-mounted Windows tree is far too slow to COPY):
#
#   git ls-files -z | tar --null -T - -czf ~/hwctx.tgz
#   podman machine ssh "rm -rf ctx && mkdir ctx && tar xzf /mnt/c/Users/<you>/hwctx.tgz -C ctx"
#   podman machine ssh "cd ctx && podman build -f stream-host/Dockerfile -t localhost/hw-streamhost:latest ."
#
# An engine-only change is rebuilt incrementally in the cached build stage
# (container "hwbuilder" from the build-stage image) and its hwengine is bind-
# mounted from ~/engine/hwengine in the VM when present.
#
# The agent directory (and the safeword dictionary) are bind-mounted from the VM
# copy and refreshed from the working tree on every start, so agent-only changes
# need no image rebuild.
#
# usage: tests/imposter-stack.sh start | stop | logs | collect <dir>
# env:   SECRET   worker STREAM_HOST_SECRET (default: read from worker/.dev.vars)
#        SLOTS    hogs per team (default 4)        PORT  worker port (default 8790)
#        ROOM_MODE imposter (default) | teams      MAX_PLAYERS lobby cap (imposter 12, teams 24)
#        KAMIKAZE Kamikaze count per team store (default 9). A team of 6 needs
#                 five self-destructs (one hog stays: the imposter); the stock
#                 loadout has ONE per team.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
SECRET="${SECRET:-$(sed -n 's/^STREAM_HOST_SECRET=//p' "$here/../worker/.dev.vars" | tr -d '\r')}"
SLOTS="${SLOTS:-4}"
PORT="${PORT:-8790}"
KAMIKAZE="${KAMIKAZE:-9}"
AGENT_SRC="$(cd "$here/../agent" && pwd | sed 's#^/\([a-z]\)/#/mnt/\1/#')"

case "$1" in
  start)
    DATA_SRC="$(cd "$here/../data" && pwd | sed 's#^/\([a-z]\)/#/mnt/\1/#')"
    podman machine ssh "cp $AGENT_SRC/*.mjs ctx/stream-host/agent/ && mkdir -p ctx/stream-host/data && cp $DATA_SRC/safewords.txt ctx/stream-host/data/"
    podman machine ssh "podman rm -f hwstream-agent >/dev/null 2>&1; rm -rf out; mkdir -p out
      GW=\$(ip route | awk '/default/{print \$3}')
      ENG=; [ -f engine/hwengine ] && ENG='-v /home/user/engine/hwengine:/opt/hw/bin/hwengine:ro'
      podman run -d --name hwstream-agent --network host --shm-size=1g \
        -e WORKER_URL=http://\$GW:$PORT -e ROOM_MODE=${ROOM_MODE:-imposter} -e ROOM_SLOTS=$SLOTS ${MAX_PLAYERS:+-e MAX_PLAYERS=$MAX_PLAYERS} \
        -e STREAM_HOST_SECRET=$SECRET -e AGENT_TRACE=1 -e AMMO_KAMIKAZE=$KAMIKAZE \
        -e STREAM_VIDEO=1 -e STREAM_RECORD=/out/imposter.flv -e STREAM_WIDTH=1280 -e STREAM_HEIGHT=720 \
        -e LOBBY_WAIT_MS=300000 -e ROUND_WAIT_MS=25000 -e SLATE_MS=3000 \
        -v /home/user/ctx/share/hedgewars/Data:/data:ro -v /home/user/out:/out \
        -v /home/user/ctx/stream-host/agent:/app/agent:ro -v /home/user/ctx/stream-host/data:/app/data:ro \
        \$ENG localhost/hw-streamhost:latest" ;;
  stop)
    podman machine ssh "podman rm -f hwstream-agent" ;;
  logs)
    podman logs hwstream-agent ;;
  collect)
    mkdir -p "$2"
    podman machine ssh "podman stop -t 5 hwstream-agent >/dev/null 2>&1; ls -la out" || true
    podman machine ssh "cat out/imposter.flv" > "$2/imposter.flv" ;;
  *) echo "usage: $0 start|stop|logs|collect <dir>"; exit 2 ;;
esac
