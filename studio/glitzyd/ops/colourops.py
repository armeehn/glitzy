"""Colour ops.

Named colourops.py rather than colour.py on purpose: a submodule called
`colour` gets bound onto the ops package at import and would shadow the
`colour()` parameter helper.
"""

import numpy as np

from .. import nputil, palettes
from . import colour as colour_param
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
    if mix >= 1.0:   # the default: no blend, and three fewer planes held
        return clip.with_rgb(np.clip(out, 0, 1, out=out))
    return clip.with_rgb(np.clip(rgb * (1 - mix) + out * mix, 0, 1))


@op(id="colour.dither", label="Dither", cat="colour",
    blurb="Down to few colours by scattering the error instead of hiding it. Texture that survives a vinyl cut.",
    params=[
        pick("palette", "Palette", palettes.PALETTE_IDS, "mono"),
        pick("method", "Method", [
            {"v": "ordered", "label": "Ordered — Bayer matrix"},
            {"v": "floyd_steinberg", "label": "Floyd-Steinberg"},
            {"v": "atkinson", "label": "Atkinson"}], "ordered"),
        num("matrix", "Matrix", 2, 8, 4, 2, " px", "Ordered only."),
        num("strength", "Strength", 0, 200, 100, 5, "%"),
        flag("mono", "Two tone only", False),
    ])
def dither(clip, p, ctx):
    rgb = clip.rgb()
    cols = palettes.colours_of(p["palette"])
    two_tone = p["mono"] or cols is None

    def snap(px):
        """Nearest ink for a (px,3) block -- shared by both methods so the
        two never disagree about what the palette is."""
        if not two_tone:
            return palettes.quantise(px, cols)
        b = np.repeat((px @ palettes.LUMA > 0.5).astype(np.float32)[:, None], 3, 1)
        return b if cols is None else cols[0] + (cols[-1] - cols[0]) * b

    if p["method"] != "ordered":
        out = nputil.error_diffuse(rgb, snap, p["method"], p["strength"] / 100.0)
        return clip.with_rgb(np.clip(out, 0, 1))

    m = nputil.bayer(int(p["matrix"]))
    thr = nputil.tile_to(m, clip.h, clip.w)[None, ..., None] - 0.5
    noisy = np.clip(rgb + thr * (p["strength"] / 100.0), 0, 1)
    return clip.with_rgb(snap(noisy.reshape(-1, 3)).reshape(rgb.shape))


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


def _screen(density, xx, yy, angle, pitch, shape, soft):
    """Coverage 0..1 of one ink screen.

    `density` is how much ink the pixel wants, (n,h,w). The screen geometry
    itself is only (h,w): it does not move over the clip, so keeping it two
    dimensional is the difference between a few megabytes and one per-frame
    copy of every intermediate.
    """
    a = np.deg2rad(angle)
    ca, sa = np.cos(a), np.sin(a)
    u = (xx * ca + yy * sa) / pitch
    v = (-xx * sa + yy * ca) / pitch
    fu, fv = u - np.floor(u) - 0.5, v - np.floor(v) - 0.5

    d = np.clip(density, 0, 1)
    if shape == "square":
        r, radius = np.maximum(np.abs(fu), np.abs(fv)), np.sqrt(d) / 2
    elif shape == "line":
        r, radius = np.abs(fv), d / 2
    elif shape == "euclidean":
        r, radius = np.abs(fu) + np.abs(fv), np.sqrt(d / 2)
    else:
        # A round dot of area d has radius sqrt(d/pi). Past d ~= 0.79 the dots
        # touch and merge, which is exactly what a real screen does too.
        r, radius = np.hypot(fu, fv), np.sqrt(d / np.pi)
    # radius is ours alone, so the threshold is folded into it in place: the
    # chained form allocated four more full-clip planes and this op is one of
    # the two that set the engine's pixel ceiling.
    radius -= r
    radius /= (0.02 + soft * 0.25)
    radius += 0.5
    return np.clip(radius, 0, 1, out=radius)


@op(id="colour.halftone", label="Halftone", cat="colour",
    blurb="A real printer's screen: rotated dot grids whose dots grow with the ink underneath.",
    params=[
        pick("screen", "Screen", [
            {"v": "mono", "label": "One ink"},
            {"v": "cmyk", "label": "CMYK — four rotated screens"},
            {"v": "rgb", "label": "RGB — light on black"}], "mono"),
        num("dots", "Frequency", 8, 160, 40, 2, " across",
            "Dots across the width. Higher is finer."),
        num("angle", "Angle", 0, 90, 45, 5, "°"),
        pick("shape", "Dot", ["round", "square", "line", "euclidean"], "round"),
        num("softness", "Softness", 0, 100, 25, 5, "%"),
        colour_param("ink", "Ink", "#1D1A17"),
        colour_param("paper", "Paper", "#F4EFE6"),
        num("mix", "Strength", 0, 100, 100, 5, "%"),
    ], varies=("dots", "angle"))
def halftone(clip, p, ctx):
    rgb = clip.rgb()
    h, w = clip.h, clip.w
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    pitch = max(2.0, w / float(p["dots"]))
    shape, soft, ang = p["shape"], p["softness"] / 100.0, float(p["angle"])

    if p["screen"] == "mono":
        ink, paper = palettes.hex_f(p["ink"]), palettes.hex_f(p["paper"])
        cov = _screen(1.0 - palettes.luma(rgb), xx, yy, ang, pitch, shape, soft)
        out = paper + (ink - paper) * cov[..., None]
    elif p["screen"] == "rgb":
        # Additive: the dots are light, so a channel's own value is its coverage.
        out = np.empty_like(rgb)
        for c, off in enumerate((0.0, 30.0, 60.0)):
            out[..., c] = _screen(rgb[..., c], xx, yy, ang + off, pitch, shape, soft)
    else:
        # The classic screen angles. They are 30° apart so the four grids beat
        # into a rosette instead of a moire; black takes the least visible 45°.
        k = 1.0 - rgb.max(3)
        inv = np.clip(1.0 - k, 1e-4, None)
        kc = _screen(k, xx, yy, ang + 45, pitch, shape, soft)
        out = np.empty_like(rgb)
        # One ink at a time. Holding all of C, M and Y as a second full-colour
        # array cost more than every other step here put together.
        for c, off in enumerate((15.0, 75.0, 0.0)):
            ink = 1.0 - rgb[..., c]
            ink -= k
            ink /= inv
            cov = _screen(ink, xx, yy, ang + off, pitch, shape, soft)
            cov -= 1.0
            cov *= -(1.0 - kc)
            out[..., c] = cov

    mix = p["mix"] / 100.0
    return clip.with_rgb(np.clip(rgb * (1 - mix) + out * mix, 0, 1))
