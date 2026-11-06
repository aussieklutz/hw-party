#!/usr/bin/env python3
"""Generate the team-select assets for the party webapp from the game data:
  - flags  -> one uniform atlas (22x15 cells) + manifest
  - graves -> one uniform atlas (32x32 cells, art fitted & bottom-aligned) + manifest
  - voices -> one alphabetically-first sample .ogg per voicepack + manifest
All land in party/public/assets/team/ as flags.png, graves.png, voices/*.ogg
and a single team.json. Run from the repo root: python3 party/scripts/gen_team_assets.py
"""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "party" / "public" / "assets" / "team"

FLAG_CELL = (22, 15)
GRAVE_CELL = (32, 32)


def build_flags() -> list:
    files = sorted((ROOT / "share/hedgewars/Data/Graphics/Flags").glob("*.png"))
    cols = 16
    rows = (len(files) + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * FLAG_CELL[0], rows * FLAG_CELL[1]), (0, 0, 0, 0))
    manifest = []
    for i, f in enumerate(files):
        img = Image.open(f).convert("RGBA")
        if img.size != FLAG_CELL:
            img = img.resize(FLAG_CELL, Image.NEAREST)
        x, y = (i % cols) * FLAG_CELL[0], (i // cols) * FLAG_CELL[1]
        atlas.paste(img, (x, y))
        manifest.append({"name": f.stem, "x": x, "y": y, "w": FLAG_CELL[0], "h": FLAG_CELL[1]})
    atlas.save(OUT / "flags.png", optimize=True)
    return manifest


def build_graves() -> list:
    files = sorted((ROOT / "share/hedgewars/Data/Graphics/Graves").glob("*.png"))
    cols = 8
    rows = (len(files) + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * GRAVE_CELL[0], rows * GRAVE_CELL[1]), (0, 0, 0, 0))
    manifest = []
    for i, f in enumerate(files):
        img = Image.open(f).convert("RGBA")
        img.thumbnail((GRAVE_CELL[0], GRAVE_CELL[1]), Image.LANCZOS)
        cx, cy = (i % cols), (i // cols)
        x, y = cx * GRAVE_CELL[0], cy * GRAVE_CELL[1]
        # bottom-centre alignment: tombstones stand on the ground
        px = x + (GRAVE_CELL[0] - img.width) // 2
        py = y + (GRAVE_CELL[1] - img.height)
        atlas.paste(img, (px, py))
        manifest.append({"name": f.stem, "x": x, "y": y, "w": GRAVE_CELL[0], "h": GRAVE_CELL[1]})
    atlas.save(OUT / "graves.png", optimize=True)
    return manifest


def build_voices() -> list:
    vdir = ROOT / "share/hedgewars/Data/Sounds/voices"
    outdir = OUT / "voices"
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for d in sorted(p for p in vdir.iterdir() if p.is_dir()):
        samples = sorted(d.glob("*.ogg"))
        if not samples:
            print(f"warning: no .ogg in voicepack {d.name}", file=sys.stderr)
            continue
        first = samples[0]
        shutil.copy(first, outdir / f"{d.name}.ogg")
        manifest.append({"name": d.name, "sample": f"/assets/team/voices/{d.name}.ogg"})
    return manifest


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    flags = build_flags()
    graves = build_graves()
    voices = build_voices()
    team = {
        "flagCell": FLAG_CELL,
        "flagCols": 16,
        "graveCell": GRAVE_CELL,
        "graveCols": 8,
        "flags": flags,
        "graves": graves,
        "voices": voices,
    }
    (OUT / "team.json").write_text(json.dumps(team))
    print(f"flags: {len(flags)}  graves: {len(graves)}  voices: {len(voices)}")
    for p in ("flags.png", "graves.png", "team.json"):
        print(p, (OUT / p).stat().st_size)


if __name__ == "__main__":
    main()
