"""Pixel ops -- direct assault on the decoded picture.

Codec ops corrupt the bitstream; these corrupt what came out of it. Both
matter, and they are different tools: a codec smear follows the encoder's own
motion prediction and so drags the picture along its real movement, while a
pixel displace does not care what the picture is doing and shoves it anyway.
"""

import io

import numpy as np
from PIL import Image

from .. import glyphs, nputil, palettes
from . import colour as colour_param
from . import flag, num, op, pick, seed


@op(id="pixel.sort", label="Pixel sort", cat="pixel",
    blurb="Sorts runs of pixels by brightness. The classic melted-glass smear.",
    params=[
        pick("axis", "Direction", [
            {"v": "x", "label": "Along rows"},
            {"v": "y", "label": "Down columns"}], "x"),
        pick("mode", "Span", [
            {"v": "span", "label": "Between thresholds"},
            {"v": "whole", "label": "Whole line"}], "span"),
        num("lo", "Lower threshold", 0, 100, 25, 1, "%"),
        num("hi", "Upper threshold", 0, 100, 80, 1, "%"),
        flag("reverse", "Reverse", False),
    ])
def sort(clip, p, ctx):
    rgb = clip.rgb()
    a = clip.frames[..., 3]
    if p["axis"] == "y":
        rgb = rgb.transpose(0, 2, 1, 3)
        a = a.transpose(0, 2, 1)
    key = palettes.luma(rgb)

    if p["mode"] == "whole":
        # Fully vectorised: one argsort over the whole stack.
        order = np.argsort(key, axis=2)
        if p["reverse"]:
            order = order[:, :, ::-1]
        out = np.take_along_axis(rgb, order[..., None], axis=2)
        outa = np.take_along_axis(a, order, axis=2)
    else:
        lo, hi = p["lo"] / 100.0, p["hi"] / 100.0
        if lo > hi:
            lo, hi = hi, lo
        mask = (key >= lo) & (key <= hi)
        out = rgb.copy()
        outa = a.copy()
        n, h = key.shape[0], key.shape[1]
        # Spans are per line and differ per frame, so this loop cannot be
        # collapsed. It is the one deliberately sequential op in the library;
        # the cache means you pay for it once per parameter value.
        for i in range(n):
            ctx.progress(i / max(n, 1), "sorting")
            for y in range(h):
                m = mask[i, y]
                if not m.any():
                    continue
                idx = np.flatnonzero(np.diff(np.concatenate(([0], m.view(np.int8), [0]))))
                for s, e in zip(idx[0::2], idx[1::2]):
                    if e - s < 2:
                        continue
                    o = np.argsort(key[i, y, s:e])
                    if p["reverse"]:
                        o = o[::-1]
                    out[i, y, s:e] = rgb[i, y, s:e][o]
                    outa[i, y, s:e] = a[i, y, s:e][o]

    if p["axis"] == "y":
        out = out.transpose(0, 2, 1, 3)
        outa = outa.transpose(0, 2, 1)
    res = clip.with_rgb(out)
    f = res.frames.copy()
    f[..., 3] = outa
    return res.like(f)


@op(id="pixel.shift", label="Channel shift", cat="pixel",
    blurb="Slides the colour channels apart. Chromatic tearing.",
    params=[
        num("red", "Red", -80, 80, -6),
        num("green", "Green", -80, 80, 0),
        num("blue", "Blue", -80, 80, 6),
        num("angle", "Angle", 0, 360, 0, 5, "°"),
        flag("wrap", "Wrap edges", True),
    ])
def shift(clip, p, ctx):
    rgb = clip.rgb()
    ang = np.deg2rad(p["angle"])
    dx, dy = np.cos(ang), np.sin(ang)
    out = rgb.copy()
    for ci, k in enumerate(("red", "green", "blue")):
        d = p[k]
        if not d:
            continue
        sx = int(round(dx * d))
        sy = int(round(dy * d))
        ch = np.roll(rgb[..., ci], (sy, sx), axis=(1, 2))
        if not p["wrap"]:
            if sy > 0:
                ch[:, :sy] = rgb[:, :sy, :, ci]
            elif sy < 0:
                ch[:, sy:] = rgb[:, sy:, :, ci]
            if sx > 0:
                ch[:, :, :sx] = rgb[:, :, :sx, ci]
            elif sx < 0:
                ch[:, :, sx:] = rgb[:, :, sx:, ci]
        out[..., ci] = ch
    return clip.with_rgb(out)


@op(id="pixel.displace", label="Displace", cat="pixel",
    blurb="Pushes pixels around using the picture's own brightness as a map.",
    params=[
        num("amount", "Amount", 0, 200, 30),
        pick("source", "Driven by", [
            {"v": "luma", "label": "Its own brightness"},
            {"v": "noise", "label": "Seeded noise"},
            {"v": "rows", "label": "Row jitter"}], "luma"),
        num("scale", "Map scale", 2, 60, 8, 1, "", "Only for noise."),
        flag("horizontal", "Horizontal", True),
        flag("vertical", "Vertical", False),
        seed(),
    ])
def displace(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    rng = np.random.default_rng(int(p["seed"]))
    if p["source"] == "noise":
        mx = nputil.fbm(rng, n, h, w, freq=int(p["scale"]), octaves=3) - 0.5
        my = nputil.fbm(rng, n, h, w, freq=int(p["scale"]), octaves=3) - 0.5
    elif p["source"] == "rows":
        r = (rng.random((n, h, 1)).astype(np.float32) - 0.5)
        mx = np.broadcast_to(r, (n, h, w)).copy()
        my = np.zeros((n, h, w), np.float32)
    else:
        l = palettes.luma(clip.rgb())
        mx = l - 0.5
        my = np.roll(l, 7, axis=2) - 0.5
    amt = float(p["amount"])
    xs, ys = nputil.grid(n, h, w)
    if p["horizontal"]:
        xs = xs + mx * amt
    if p["vertical"]:
        ys = ys + my * amt
    out = nputil.sample_bilinear(clip.frames, xs, ys, wrap=True)
    return clip.like(np.clip(out, 0, 255, out=out).astype(np.uint8))


@op(id="pixel.slices", label="Slice shuffle", cat="pixel",
    blurb="Cuts the frame into bands and slides each one. The datamosh tear.",
    params=[
        num("bands", "Bands", 2, 80, 16),
        num("amount", "Slide", 0, 100, 30, 1, "%"),
        pick("axis", "Direction", [
            {"v": "x", "label": "Horizontal bands"},
            {"v": "y", "label": "Vertical bands"}], "x"),
        flag("per_frame", "Reshuffle each frame", False),
        seed(),
    ])
def slices(clip, p, ctx):
    f = clip.frames
    axis = 1 if p["axis"] == "x" else 2
    size = f.shape[axis]
    bands = int(np.clip(p["bands"], 1, size))
    edges = np.linspace(0, size, bands + 1).astype(int)
    span = f.shape[2] if axis == 1 else f.shape[1]
    out = f.copy()
    for i in range(clip.n):
        rng = np.random.default_rng(int(p["seed"]) + (i if p["per_frame"] else 0))
        offs = ((rng.random(bands) - 0.5) * 2 * span * p["amount"] / 100).astype(int)
        for b in range(bands):
            s, e = edges[b], edges[b + 1]
            if e <= s:
                continue
            if axis == 1:
                out[i, s:e] = np.roll(f[i, s:e], offs[b], axis=1)
            else:
                out[i, :, s:e] = np.roll(f[i, :, s:e], offs[b], axis=0)
    return clip.like(out)


@op(id="pixel.recompress", label="Recompress", cat="pixel",
    blurb="Saves the frame as a bad JPEG, over and over. Ringing and blocking without the codec.",
    params=[
        num("quality", "Quality", 1, 60, 12),
        num("passes", "Passes", 1, 20, 4),
        num("shrink", "Shrink between", 100, 100, 100, 1, "%"),
    ], varies=("quality", "passes"))
def recompress(clip, p, ctx):
    out = clip.frames.copy()
    q, passes = int(p["quality"]), int(p["passes"])
    for i in range(clip.n):
        ctx.progress(i / max(clip.n, 1), "recompressing")
        im = Image.fromarray(out[i, :, :, :3], "RGB")
        for _ in range(passes):
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=q, subsampling=2)
            buf.seek(0)
            im = Image.open(buf).convert("RGB")
        out[i, :, :, :3] = np.asarray(im)
    return clip.like(out)


@op(id="pixel.bitcrush", label="Bitcrush", cat="pixel",
    blurb="Throws away low bits. Flat plateaus and hard banding.",
    params=[num("bits", "Bits per channel", 1, 8, 3),
            flag("per_channel", "Different per channel", False)])
def bitcrush(clip, p, ctx):
    bits = int(p["bits"])
    f = clip.frames.copy()
    for c in range(3):
        b = max(1, bits - c) if p["per_channel"] else bits
        step = 256 >> b
        f[..., c] = np.clip((f[..., c] // step) * step + step // 2, 0, 255)
    return clip.like(f)


@op(id="pixel.noise", label="Noise", cat="pixel",
    blurb="Seeded grain, from film dust to full snow.",
    params=[num("amount", "Amount", 0, 100, 20, 1, "%"),
            pick("kind", "Kind", [
                {"v": "mono", "label": "Monochrome"},
                {"v": "colour", "label": "Colour"},
                {"v": "salt", "label": "Salt and pepper"}], "mono"),
            flag("animate", "New every frame", True), seed()])
def noise(clip, p, ctx):
    rng = np.random.default_rng(int(p["seed"]))
    n, h, w = clip.n, clip.h, clip.w
    amt = p["amount"] / 100.0
    shape = (n if p["animate"] else 1, h, w, 1 if p["kind"] != "colour" else 3)
    rgb = clip.rgb()
    if p["kind"] == "salt":
        r = rng.random(shape[:3])
        out = rgb.copy()
        out[r < amt / 2] = 0.0
        out[r > 1 - amt / 2] = 1.0
    else:
        g = (rng.random(shape).astype(np.float32) - 0.5) * 2 * amt
        out = np.clip(rgb + g, 0, 1)
    return clip.with_rgb(out)


@op(id="pixel.scanlines", label="Scanlines", cat="pixel",
    blurb="Interlace darkening and a rolling bar. Cheap CRT, honest about it.",
    params=[num("spacing", "Spacing", 2, 32, 3, 1, " px"),
            num("depth", "Depth", 0, 100, 45, 1, "%"),
            num("roll", "Rolling bar", 0, 100, 0, 1, "%")])
def scanlines(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    ys = np.arange(h, dtype=np.float32)[None, :, None]
    line = ((ys % max(2, int(p["spacing"]))) < 1).astype(np.float32)
    m = 1.0 - line * (p["depth"] / 100.0)
    if p["roll"] > 0:
        t = np.arange(n, dtype=np.float32)[:, None, None] / max(n, 1)
        band = np.exp(-(((ys / h - t) % 1.0) - 0.5) ** 2 / 0.004)
        m = m * (1 - band * (p["roll"] / 100.0))
    return clip.with_rgb(np.clip(clip.rgb() * m[..., None], 0, 1))


@op(id="pixel.levels", label="Levels", cat="pixel",
    blurb="Brightness, contrast and gamma. The op you reach for after everything else.",
    params=[num("brightness", "Brightness", -100, 100, 0, 1, "%"),
            num("contrast", "Contrast", -100, 200, 0, 1, "%"),
            num("gamma", "Gamma", 20, 300, 100, 5, "%")])
def levels(clip, p, ctx):
    rgb = clip.rgb()
    g = max(0.01, p["gamma"] / 100.0)
    rgb = np.power(np.clip(rgb, 0, 1), 1.0 / g)
    c = 1.0 + p["contrast"] / 100.0
    rgb = (rgb - 0.5) * c + 0.5 + p["brightness"] / 100.0
    return clip.with_rgb(np.clip(rgb, 0, 1))


@op(id="pixel.blur", label="Blur / sharpen", cat="pixel",
    blurb="Box blur, or unsharp the other way to crisp the block edges back up.",
    params=[num("radius", "Radius", 0, 40, 2, 1, " px"),
            num("sharpen", "Sharpen", 0, 300, 0, 5, "%")])
def blur(clip, p, ctx):
    rgb = clip.rgb()
    if p["radius"] >= 1:
        rgb = nputil.box_blur(rgb, int(p["radius"]))
    if p["sharpen"] > 0:
        rgb = nputil.unsharp(rgb, 2, p["sharpen"] / 100.0)
    return clip.with_rgb(np.clip(rgb, 0, 1))


# ---------------------------------------------------------------------------
# Cell grids
#
# ASCII and mosaic both rebuild the picture out of tiles, so both need the
# canvas to be a whole number of cells. Padding by edge replication and
# cropping back afterwards keeps the output exactly the size it came in at,
# which is what the compositor and every downstream matte assume.
# ---------------------------------------------------------------------------

def _pad_to(a, ch, cw):
    """Edge-replicate an (n,h,w[,c]) array up to ch x cw."""
    ph, pw = ch - a.shape[1], cw - a.shape[2]
    if ph <= 0 and pw <= 0:
        return a
    pad = [(0, 0), (0, max(0, ph)), (0, max(0, pw))] + [(0, 0)] * (a.ndim - 3)
    return np.pad(a, pad, mode="edge")


@op(id="pixel.ascii", label="ASCII", cat="pixel",
    blurb="Redraws the picture as a grid of characters. Terminal art, but at print resolution.",
    params=[
        num("scale", "Dot size", 1, 8, 2, 1, " px",
            "A glyph is 5x7 dots, so at 2 a character cell is 10x14 pixels."),
        pick("ramp", "Character set", [
            {"v": "classic", "label": "Classic  .:-=+*#%@"},
            {"v": "terminal", "label": "Terminal  .,:;o08@"},
            {"v": "sparse", "label": "Sparse  .+X#"},
            {"v": "blocks", "label": "Bar blocks"}], "classic"),
        colour_param("ink", "Ink", "#F0477D"),
        colour_param("paper", "Paper", "#1D1A17"),
        pick("ground", "Between the glyphs", [
            {"v": "paper", "label": "Paper"},
            {"v": "transparent", "label": "Cut away"}], "paper"),
        flag("tint", "Ink takes each cell's own colour", False),
        flag("invert", "Invert", False),
    ], varies=("scale",))
def ascii_art(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    s = int(p["scale"])
    gh, gw = glyphs.GH * s, glyphs.GW * s
    rows, cols = max(1, -(-h // gh)), max(1, -(-w // gw))
    ch, cw = rows * gh, cols * gw

    rgb = _pad_to(clip.rgb(), ch, cw)
    cell = palettes.luma(rgb).reshape(n, rows, gh, cols, gw).mean((2, 4))
    # A dark cell wants a dense glyph, so the ramp is indexed by ink wanted.
    t = cell if p["invert"] else 1.0 - cell

    atlas = glyphs.atlas(p["ramp"], s)
    idx = np.clip(np.round(t * (len(atlas) - 1)), 0, len(atlas) - 1).astype(np.int32)
    # (n,rows,cols,gh,gw) -> (n,rows,gh,cols,gw) -> the flat canvas
    mask = atlas[idx].transpose(0, 1, 3, 2, 4).reshape(n, ch, cw).astype(bool)

    paper = palettes.hex_f(p["paper"])
    body = np.empty((n, ch, cw, 3), np.float32)
    body[:] = paper
    if p["tint"]:
        cell_rgb = rgb.reshape(n, rows, gh, cols, gw, 3).mean((2, 4))
        ink = np.repeat(np.repeat(cell_rgb, gh, axis=1), gw, axis=2)
        np.copyto(body, ink, where=mask[..., None])
    else:
        body[mask] = palettes.hex_f(p["ink"])

    # Alpha is averaged per cell rather than sampled, so an upstream matte
    # survives at the character grid's resolution instead of fraying.
    cell_a = _pad_to(clip.alpha(), ch, cw).reshape(n, rows, gh, cols, gw).mean((2, 4))
    a = np.repeat(np.repeat(cell_a, gh, axis=1), gw, axis=2)
    if p["ground"] == "transparent":
        a = a * mask

    out = np.empty((n, ch, cw, 4), np.uint8)
    out[..., :3] = np.clip(body * 255 + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
    return clip.like(np.ascontiguousarray(out[:, :h, :w]))


def _stencil(cell, shape, gap, bevel):
    """One tile's (coverage, shade), both (cell, cell) float32."""
    u = (np.arange(cell, dtype=np.float32) + 0.5) / cell * 2 - 1
    xx, yy = np.meshgrid(u, u)
    lim = max(0.05, 1.0 - gap)
    if shape == "square":
        r = np.maximum(np.abs(xx), np.abs(yy))
    elif shape == "diamond":
        r = np.abs(xx) + np.abs(yy)
    elif shape == "cross":
        r, lim = np.minimum(np.abs(xx), np.abs(yy)), lim * 0.34
    else:  # dot and stud are both discs
        r = np.hypot(xx, yy)
    edge = 1.5 / cell
    cov = np.clip((lim - r) / edge + 0.5, 0, 1).astype(np.float32)

    # Light from the top left. The bevel is what tells the eye these are
    # objects sitting on a surface rather than flat squares of colour.
    lit = np.clip(0.5 - (xx + yy) * 0.35, 0, 1)
    shade = 1.0 + (lit - 0.5) * bevel
    if shape == "stud":
        d = np.hypot(xx, yy)
        nub = np.clip((lim * 0.52 - d) / edge + 0.5, 0, 1)
        ring = np.clip((lim * 0.64 - d) / edge + 0.5, 0, 1) - nub
        shade = shade * (1 + nub * bevel * 0.30 - ring * bevel * 0.45)
    return cov, shade.astype(np.float32)


@op(id="pixel.mosaic", label="Mosaic", cat="pixel",
    blurb="Rebuilds the picture out of tiles: flat pixel art, printer's dots, or moulded studs.",
    params=[
        num("cell", "Tile", 2, 64, 12, 1, " px"),
        pick("shape", "Shape", [
            {"v": "square", "label": "Square — pixel art"},
            {"v": "dot", "label": "Dot"},
            {"v": "stud", "label": "Stud — moulded brick"},
            {"v": "diamond", "label": "Diamond"},
            {"v": "cross", "label": "Cross"}], "square"),
        num("gap", "Gap", 0, 40, 0, 1, "%"),
        num("bevel", "Bevel", 0, 100, 0, 5, "%", "Lights the tiles from the top left."),
        pick("gaps", "Between the tiles", [
            {"v": "grout", "label": "Darkened grout"},
            {"v": "transparent", "label": "Cut away"}], "grout"),
        pick("palette", "Snap to", palettes.PALETTE_IDS, "as-is"),
    ], varies=("cell", "gap", "bevel"))
def mosaic(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    cell = int(p["cell"])
    rows, cols = max(1, -(-h // cell)), max(1, -(-w // cell))
    ch, cw = rows * cell, cols * cell

    rgb = _pad_to(clip.rgb(), ch, cw).reshape(n, rows, cell, cols, cell, 3)
    tile_rgb = rgb.mean((2, 4))
    tile_a = _pad_to(clip.alpha(), ch, cw).reshape(
        n, rows, cell, cols, cell).mean((2, 4))

    inks = palettes.colours_of(p["palette"])
    if inks is not None:
        tile_rgb = palettes.quantise(tile_rgb, inks)

    cov, shade = _stencil(cell, p["shape"], p["gap"] / 100.0, p["bevel"] / 100.0)
    cov_t = np.tile(cov, (rows, cols))
    shade_t = np.tile(shade, (rows, cols))

    px = np.repeat(np.repeat(tile_rgb, cell, 1), cell, 2) * shade_t[None, ..., None]
    pa = np.repeat(np.repeat(tile_a, cell, 1), cell, 2)
    if p["gaps"] == "transparent":
        pa = pa * cov_t
    else:
        px = px * (0.30 + 0.70 * cov_t)[None, ..., None]

    out = np.empty((n, ch, cw, 4), np.uint8)
    out[..., :3] = np.clip(px * 255 + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(pa * 255 + 0.5, 0, 255).astype(np.uint8)
    return clip.like(np.ascontiguousarray(out[:, :h, :w]))


@op(id="pixel.crt", label="CRT tube", cat="pixel",
    blurb="Puts the picture back inside a tube: curved glass, a shadow mask, bloom and a soft edge.",
    params=[
        num("curve", "Glass", 0, 100, 25, 5, "%", "Barrel curvature of the tube face."),
        pick("mask", "Shadow mask", [
            {"v": "aperture", "label": "Aperture grille — vertical stripes"},
            {"v": "slot", "label": "Slot mask"},
            {"v": "shadow", "label": "Shadow mask — staggered triads"},
            {"v": "none", "label": "None"}], "aperture"),
        num("grille", "Mask depth", 0, 100, 45, 5, "%"),
        num("scan", "Scanlines", 0, 100, 40, 5, "%"),
        num("bloom", "Bloom", 0, 100, 30, 5, "%"),
        num("vignette", "Vignette", 0, 100, 35, 5, "%"),
        num("misconverge", "Misconvergence", 0, 6, 1, 1, " px",
            "Pulls red and blue apart, the way a tube drifts out of alignment."),
    ], varies=("curve", "scan", "bloom"))
def crt(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = (xx + 0.5) / w * 2 - 1
    v = (yy + 0.5) / h * 2 - 1

    # Barrel: push each pixel outward by its squared radius, then read the
    # source from where it landed. Past the rim there is no picture at all,
    # so the tube's corners come back as cut-away alpha rather than black.
    r2 = u * u + v * v
    k = p["curve"] / 100.0 * 0.35
    su, sv = u * (1 + k * r2), v * (1 + k * r2)
    inside = (np.abs(su) <= 1) & (np.abs(sv) <= 1)
    sx = (su + 1) / 2 * w - 0.5
    sy = (sv + 1) / 2 * h - 0.5

    d = float(p["misconverge"])
    out = np.empty((n, h, w, 3), np.float32)
    for c, off in enumerate((-d, 0.0, d)):
        out[..., c] = nputil.sample_bilinear(
            clip.frames[..., c], sx + off, sy, wrap=False) / 255.0
    a = nputil.sample_bilinear(clip.frames[..., 3], sx, sy, wrap=False) / 255.0

    if p["bloom"] > 0:
        # One channel at a time. box_blur pads and cumsums internally, so
        # handing it all three at once holds five full-colour planes at the
        # peak and this op is one of the two that set the pixel ceiling.
        r = max(2, int(min(h, w) / 120))
        gain = p["bloom"] / 100.0 * 0.6
        for c in range(3):
            ch = out[..., c]
            ch += nputil.box_blur(ch, r) * gain
            np.clip(ch, 0, 1, out=ch)

    if p["mask"] != "none" and p["grille"] > 0:
        ix, iy = xx.astype(np.int64), yy.astype(np.int64)
        if p["mask"] == "shadow":
            col = (ix + iy % 3) % 3            # triads stagger every row
        elif p["mask"] == "slot":
            col = (ix + (iy // 2) % 2) % 3     # every other pair of rows
        else:
            col = ix % 3                       # straight vertical stripes
        gains = np.empty((h, w, 3), np.float32)
        for c in range(3):
            gains[..., c] = np.where(col == c, 1.0, 1.0 - p["grille"] / 100.0)
        out *= gains

    if p["scan"] > 0:
        out *= (1.0 - (p["scan"] / 100.0) * (yy.astype(np.int64) % 2))[..., None]

    if p["vignette"] > 0:
        out *= (1.0 - (p["vignette"] / 100.0) * np.clip(r2, 0, 1))[..., None]

    out *= inside[..., None]
    frames = np.empty((n, h, w, 4), np.uint8)
    for c in range(3):
        frames[..., c] = np.clip(out[..., c] * 255 + 0.5, 0, 255).astype(np.uint8)
    frames[..., 3] = np.clip(a * inside * 255 + 0.5, 0, 255).astype(np.uint8)
    return clip.like(frames)
