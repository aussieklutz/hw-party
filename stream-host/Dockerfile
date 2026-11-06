# stream-host image — hwengine (Linux) + the live-stream stack.
#
# Build (from the repo root, in WSL):
#   podman build -f stream-host/Dockerfile -t localhost/hw-streamhost:latest .
#
# Build stage compiles the engine (FPC + SDL2 + the bundled lua/physfs and the
# rust lib-hwengine-future via corrosion). NOFRONTEND/NOVIDEOREC/NOSERVER keep
# the build engine-only; game data is volume-mounted at runtime.
FROM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build fpc ca-certificates curl pkg-config \
      libsdl2-dev libsdl2-image-dev libsdl2-mixer-dev libsdl2-ttf-dev libsdl2-net-dev \
      libgl1-mesa-dev libpng-dev libphysfs-dev \
    && rm -rf /var/lib/apt/lists/*

# the rust helper lib needs a modern toolchain (bookworm's rustc is too old
# for the crates.io deps)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin

WORKDIR /src
COPY . /src

RUN cmake -S . -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DNOSERVER=1 -DNOFRONTEND=1 -DNOVIDEOREC=1 -DNOVERSIONINFOUPDATE=1 \
      -DLUA_SYSTEM=OFF -DCMAKE_INSTALL_PREFIX=/opt/hw \
 && cmake --build /build --parallel \
 && cmake --install /build

# ---- runtime ----
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xvfb wmctrl xdotool x11-utils \
      pulseaudio pulseaudio-utils \
      ffmpeg \
      chromium \
      nodejs \
      libsdl2-2.0-0 libsdl2-image-2.0-0 libsdl2-mixer-2.0-0 libsdl2-ttf-2.0-0 libsdl2-net-2.0-0 \
      libgl1 libglx-mesa0 libgl1-mesa-dri \
      libpng16-16 libphysfs1 \
    && rm -rf /var/lib/apt/lists/*

# the agent uses the global WebSocket client (node >= 21)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# pulse system mode: anonymous unix auth (ffmpeg/engine connect as root) and
# the null sink the engine plays into, pre-created at boot
RUN printf 'load-module module-native-protocol-unix auth-anonymous=1 socket=/run/pulse/native\n\
load-module module-null-sink sink_name=hw sink_properties=device.description=Hedgewars\n\
set-default-sink hw\n' > /etc/pulse/system.pa

COPY --from=build /opt/hw /opt/hw
COPY stream-host/agent /app/agent
COPY stream-host/data /app/data

ENV ENGINE_BIN=/opt/hw/bin/hwengine \
    LD_LIBRARY_PATH=/opt/hw/lib:/opt/hw/bin \
    ENGINE_PREFIX=/data \
    ENGINE_USERPREFIX=/tmp/hwuser \
    XDG_RUNTIME_DIR=/run/pulse

WORKDIR /app
ENTRYPOINT ["node", "/app/agent/host-agent.mjs"]
