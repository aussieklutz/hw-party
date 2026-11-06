#!/bin/sh
# Builds stream-host/tests/layout-cli (frontend-qt6/partylayout.cpp + a stdin driver) with
# the system Qt6 and prints the binary's path. Run in a distro that has Qt6
# (qt6-base-dev). stream-host/tests/layout-diff.mjs then compares it with the
# JavaScript lobby.
#
#   sh stream-host/tests/test-layout.sh [out-dir]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-/tmp/hw-layout-cli}
mkdir -p "$OUT"
FLAGS=$(pkg-config --cflags --libs Qt6Core)
g++ -std=c++17 -fPIC -O1 -Wall -Wextra -o "$OUT/layout-cli" \
  "$ROOT/stream-host/tests/layout-cli.cpp" "$ROOT/frontend-qt6/partylayout.cpp" $FLAGS
echo "$OUT/layout-cli"
