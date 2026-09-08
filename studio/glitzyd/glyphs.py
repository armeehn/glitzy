"""A 5x7 bitmap font, and the character ramps the ASCII op draws with.

The glyphs are literals rather than a rendered TTF on purpose. A font file
would have to exist on both the dev container and the engine container, and
the two silently disagreeing about which face was installed is exactly the
kind of divergence that renders a different picture on the box that matters.
Seventeen hand-set glyphs are cheap, identical everywhere, and land on the
pixel grid with no resampling, which is the whole look.

Each glyph is 7 rows of 5 columns; '#' is ink.
"""

import numpy as np

GW, GH = 5, 7

_FONT = {
    " ": ("....."
          "....."
          "....."
          "....."
          "....."
          "....."
          "....."),
    ".": ("....."
          "....."
          "....."
          "....."
          "....."
          "..#.."
          "....."),
    ",": ("....."
          "....."
          "....."
          "....."
          "..#.."
          "..#.."
          ".#..."),
    ":": ("....."
          "....."
          "..#.."
          "....."
          "..#.."
          "....."
          "....."),
    ";": ("....."
          "....."
          "..#.."
          "....."
          "..#.."
          "..#.."
          ".#..."),
    "-": ("....."
          "....."
          "....."
          ".###."
          "....."
          "....."
          "....."),
    "=": ("....."
          "....."
          ".###."
          "....."
          ".###."
          "....."
          "....."),
    "+": ("....."
          "....."
          "..#.."
          ".###."
          "..#.."
          "....."
          "....."),
    "*": ("....."
          "..#.."
          "#.#.#"
          ".###."
          "#.#.#"
          "..#.."
          "....."),
    "o": ("....."
          "....."
          ".###."
          "#...#"
          "#...#"
          ".###."
          "....."),
    "O": (".###."
          "#...#"
          "#...#"
          "#...#"
          "#...#"
          "#...#"
          ".###."),
    "0": (".###."
          "#...#"
          "#..##"
          "#.#.#"
          "##..#"
          "#...#"
          ".###."),
    "8": (".###."
          "#...#"
          "#...#"
          ".###."
          "#...#"
          "#...#"
          ".###."),
    "X": ("#...#"
          "#...#"
          ".#.#."
          "..#.."
          ".#.#."
          "#...#"
          "#...#"),
    "#": (".#.#."
          ".#.#."
          "#####"
          ".#.#."
          "#####"
          ".#.#."
          ".#.#."),
    "%": ("##..#"
          "##.#."
          "...#."
          "..#.."
          ".#..."
          ".#.##"
          "#..##"),
    "@": (".###."
          "#...#"
          "#.###"
          "#.#.#"
          "#.###"
          "#...."
          ".###."),
}

# Ramps run light to dark: index 0 is the palest cell, the last is solid ink.
RAMPS = {
    "classic": " .:-=+*#%@",
    "terminal": " .,:;o08@",
    "sparse": " .+X#",
    "blocks": None,   # drawn, not set -- see _blocks()
}

RAMP_IDS = list(RAMPS)

_BLOCK_LEVELS = 8


def _glyph(ch):
    rows = _FONT[ch]
    a = np.frombuffer(rows.encode(), np.uint8).reshape(GH, GW)
    return (a == ord("#")).astype(np.uint8)


def _blocks():
    """Bottom-up fill bars, the way a terminal draws a level meter."""
    out = np.zeros((_BLOCK_LEVELS, GH, GW), np.uint8)
    for i in range(_BLOCK_LEVELS):
        fill = round(i * GH / (_BLOCK_LEVELS - 1))
        if fill:
            out[i, GH - fill:, :] = 1
    return out


def atlas(ramp_id, scale=1):
    """(k, GH*scale, GW*scale) uint8 masks for one ramp, palest first."""
    chars = RAMPS.get(ramp_id)
    a = _blocks() if chars is None else np.stack([_glyph(c) for c in chars])
    if scale > 1:
        a = np.repeat(np.repeat(a, scale, axis=1), scale, axis=2)
    return a
