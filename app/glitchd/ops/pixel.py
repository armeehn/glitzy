"""Pixel ops -- direct assault on the decoded picture.

Codec ops corrupt the bitstream; these corrupt what came out of it. Both
matter, and they are different tools: a codec smear follows the encoder's own
motion prediction and so drags the picture along its real movement, while a
pixel displace does not care what the picture is doing and shoves it anyway.
"""

import io

import numpy as np
from PIL import Image

from .. import nputil, palettes
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
    out = nputil.sample_bilinear(clip.frames.astype(np.float32), xs, ys, wrap=True)
    return clip.like(np.clip(out, 0, 255).astype(np.uint8))


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
