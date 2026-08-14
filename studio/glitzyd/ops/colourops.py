"""Colour ops.

Named colourops.py rather than colour.py on purpose: a submodule called
`colour` gets bound onto the ops package at import and would shadow the
`colour()` parameter helper.
"""

import numpy as np

from .. import nputil, palettes
from . import flag, num, op, pick


@op(id="colour.palette", label="Colourway", cat="colour",
    blurb="Forces the artwork into a fixed set of inks. What makes a glitch read as printed.",
    params=[
        pick("palette", "Palette", palettes.PALETTE_IDS, "riposte"),
        pick("mode", "Mapping", [
            {"v": "quantise", "label": "Snap to nearest"},
            {"v": "gradient_map", "label": "Map brightness to ramp"},
            {"v": "duotone", "label": "Duotone"},
            {"v": "tint", "label": "Tint shadows"}], "quantise"),
        num("mix", "Strength", 0, 100, 100, 5, "%"),
    ], varies=("mix",))
def palette(clip, p, ctx):
    cols = palettes.colours_of(p["palette"])
    if cols is None:
        return clip
    rgb = clip.rgb()
    mode = p["mode"]
    if mode == "quantise":
        out = palettes.quantise(rgb, cols)
    elif mode == "gradient_map":
        out = palettes.ramp(cols, palettes.luma(rgb))
    elif mode == "duotone":
        out = palettes.ramp(np.stack([cols[0], cols[-1]]), palettes.luma(rgb))
    else:  # tint: keep the picture, push its shadows toward the palette
        t = palettes.luma(rgb)[..., None]
        target = np.where(t < 0.5, cols[0], cols[2 % len(cols)])
        out = rgb * t + target * (1 - t) * 0.85 + rgb * (1 - t) * 0.15
    mix = p["mix"] / 100.0
    return clip.with_rgb(np.clip(rgb * (1 - mix) + out * mix, 0, 1))


@op(id="colour.dither", label="Dither", cat="colour",
    blurb="Ordered dithering down to few colours. Halftone texture that survives a vinyl cut.",
    params=[
        pick("palette", "Palette", palettes.PALETTE_IDS, "mono"),
        num("matrix", "Matrix", 2, 8, 4, 2, " px"),
        num("strength", "Strength", 0, 200, 100, 5, "%"),
        flag("mono", "Two tone only", False),
    ])
def dither(clip, p, ctx):
    rgb = clip.rgb()
    n, h, w = clip.n, clip.h, clip.w
    m = nputil.bayer(int(p["matrix"]))
    thr = nputil.tile_to(m, h, w)[None, ..., None] - 0.5
    noisy = np.clip(rgb + thr * (p["strength"] / 100.0), 0, 1)
    cols = palettes.colours_of(p["palette"])
    if p["mono"] or cols is None:
        l = palettes.luma(noisy)
        out = np.repeat((l > 0.5).astype(np.float32)[..., None], 3, axis=3)
        if cols is not None:
            out = cols[0] + (cols[-1] - cols[0]) * out
        return clip.with_rgb(out)
    return clip.with_rgb(palettes.quantise(noisy, cols))


@op(id="colour.hsv", label="Hue & saturation", cat="colour",
    blurb="Rotate hue, crush or boost saturation, ride the brightness.",
    params=[num("hue", "Hue", -180, 180, 0, 5, "°"),
            num("sat", "Saturation", 0, 300, 100, 5, "%"),
            num("value", "Brightness", 0, 300, 100, 5, "%"),
            flag("cycle", "Cycle over the clip", False)])
def hsv(clip, p, ctx):
    rgb = clip.rgb()
    n = clip.n
    mx = rgb.max(3); mn = rgb.min(3)
    d = mx - mn
    # hue in turns, avoiding the divide where the pixel is grey
    h = np.zeros_like(mx)
    safe = d > 1e-6
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    with np.errstate(invalid="ignore", divide="ignore"):
        h = np.where(safe & (mx == r), ((g - b) / np.where(safe, d, 1)) % 6, h)
        h = np.where(safe & (mx == g), (b - r) / np.where(safe, d, 1) + 2, h)
        h = np.where(safe & (mx == b), (r - g) / np.where(safe, d, 1) + 4, h)
    h = h / 6.0
    s = np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0)
    v = mx

    shift = p["hue"] / 360.0
    if p["cycle"] and n > 1:
        shift = shift + np.arange(n, dtype=np.float32)[:, None, None] / n
    h = (h + shift) % 1.0
    s = np.clip(s * (p["sat"] / 100.0), 0, 1)
    v = np.clip(v * (p["value"] / 100.0), 0, 1)

    i = np.floor(h * 6).astype(np.int32) % 6
    f = h * 6 - np.floor(h * 6)
    pp = v * (1 - s); q = v * (1 - f * s); t = v * (1 - (1 - f) * s)
    out = np.stack([
        np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [v, q, pp, pp, t, v]),
        np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [t, v, v, q, pp, pp]),
        np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [pp, pp, t, v, v, q]),
    ], axis=3)
    return clip.with_rgb(np.clip(out, 0, 1))


@op(id="colour.posterize", label="Posterize", cat="colour",
    blurb="Collapse to N brightness steps per channel.",
    params=[num("steps", "Steps", 2, 32, 5),
            flag("luma_only", "Brightness only", False)])
def posterize(clip, p, ctx):
    k = int(p["steps"])
    rgb = clip.rgb()
    if p["luma_only"]:
        l = palettes.luma(rgb)
        q = np.round(l * (k - 1)) / (k - 1)
        with np.errstate(invalid="ignore", divide="ignore"):
            scale = np.where(l > 1e-5, q / np.where(l > 1e-5, l, 1), 0)[..., None]
        return clip.with_rgb(np.clip(rgb * scale, 0, 1))
    return clip.with_rgb(np.round(rgb * (k - 1)) / (k - 1))


@op(id="colour.invert", label="Invert", cat="colour",
    blurb="Negative, whole or per channel.",
    params=[flag("red", "Red", True), flag("green", "Green", True),
            flag("blue", "Blue", True)], varies=())
def invert(clip, p, ctx):
    rgb = clip.rgb().copy()
    for ci, k in enumerate(("red", "green", "blue")):
        if p[k]:
            rgb[..., ci] = 1.0 - rgb[..., ci]
    return clip.with_rgb(rgb)


@op(id="colour.channels", label="Swap channels", cat="colour",
    blurb="Rewire red, green and blue into each other.",
    params=[pick("order", "Order", ["rgb", "rbg", "grb", "gbr", "brg", "bgr"], "gbr")],
    varies=())
def channels(clip, p, ctx):
    idx = {"r": 0, "g": 1, "b": 2}
    order = [idx[c] for c in p["order"]]
    return clip.with_rgb(clip.rgb()[..., order])
