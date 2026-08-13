"""Time ops -- everything that treats the clip as a stack rather than a picture.

Drift is the important one. A still has no motion, so the codec ops that abuse
motion vectors have nothing to work with and quietly do nothing; putting a
camera move in front of them is what turns a photograph into something the
encoder has to predict, and prediction is what there is to corrupt.
"""

import numpy as np

from .. import nputil
from . import flag, num, op, pick, seed


@op(id="time.drift", label="Drift", cat="time",
    blurb="A slow pan and zoom. Gives a still something for the codec to predict.",
    params=[num("frames", "Frames", 2, 240, 48, 1, " fr"),
            num("zoom", "Zoom", 100, 200, 118, 1, "%"),
            num("pan", "Pan", 0, 100, 40, 1, "%"),
            num("sway", "Sway", 0, 100, 30, 1, "%", "Wander instead of a straight line."),
            num("angle", "Direction", 0, 360, 30, 5, "°")])
def drift(clip, p, ctx):
    n = int(p["frames"])
    h, w = clip.h, clip.w
    z = p["zoom"] / 100.0
    # Sample a window smaller than the frame and slide it: the picture is
    # never scaled down, so a drift over a still never softens it.
    t = np.linspace(0, 1, n, dtype=np.float32)[:, None, None]
    a = np.deg2rad(p["angle"])
    room_x = w - w / z
    room_y = h - h / z
    px = (np.cos(a) * (t - 0.5) * (p["pan"] / 100.0) * 2) * room_x / 2 + room_x / 2
    py = (np.sin(a) * (t - 0.5) * (p["pan"] / 100.0) * 2) * room_y / 2 + room_y / 2
    sway = p["sway"] / 100.0
    px = px + np.sin(t * np.pi * 2) * room_x * 0.25 * sway
    py = py + np.cos(t * np.pi * 2 * 1.3) * room_y * 0.25 * sway
    xs, ys = nputil.grid(n, h, w)
    src = clip.frames.astype(np.float32)
    if clip.n < n:
        idx = (np.arange(n) * clip.n // n) % clip.n
        src = src[idx]
    else:
        src = src[:n]
    sx = np.clip(xs / z + px, 0, w - 1)
    sy = np.clip(ys / z + py, 0, h - 1)
    out = nputil.sample_bilinear(src, sx, sy, wrap=False)
    return clip.like(np.clip(out, 0, 255).astype(np.uint8))


@op(id="time.length", label="Length", cat="time",
    blurb="Set how many frames the clip has, by holding, looping or resampling.",
    params=[num("frames", "Frames", 1, 240, 48, 1, " fr"),
            pick("mode", "How", [
                {"v": "resample", "label": "Stretch in time"},
                {"v": "loop", "label": "Loop"},
                {"v": "hold", "label": "Hold the last frame"}], "resample")])
def length(clip, p, ctx):
    n = int(p["frames"])
    if n == clip.n:
        return clip
    if p["mode"] == "loop":
        idx = np.arange(n) % clip.n
    elif p["mode"] == "hold":
        idx = np.clip(np.arange(n), 0, clip.n - 1)
    else:
        idx = (np.linspace(0, clip.n - 1e-3, n)).astype(np.int64)
    return clip.like(clip.frames[idx])


@op(id="time.reverse", label="Reverse", cat="time",
    blurb="Play it backwards, or out and back so it loops seamlessly.",
    params=[flag("pingpong", "Out and back", True)], varies=())
def reverse(clip, p, ctx):
    if p["pingpong"]:
        if clip.n < 2:
            return clip
        return clip.like(np.concatenate([clip.frames, clip.frames[-2:0:-1]]))
    return clip.like(clip.frames[::-1])


@op(id="time.echo", label="Echo", cat="time",
    blurb="Each frame keeps a fading memory of the ones before it. Trails.",
    params=[num("decay", "Hold", 0, 99, 72, 1, "%"),
            pick("blend", "Blend", [
                {"v": "max", "label": "Brightest wins"},
                {"v": "mix", "label": "Average"},
                {"v": "diff", "label": "Difference"}], "max"),
            num("offset", "Step back", 1, 12, 1, 1, " fr")])
def echo(clip, p, ctx):
    rgb = clip.rgb()
    k = p["decay"] / 100.0
    step = int(p["offset"])
    out = rgb.copy()
    acc = rgb[0].copy()
    for i in range(clip.n):
        cur = rgb[i]
        prev = out[max(0, i - step)] if i >= step else acc
        if p["blend"] == "max":
            out[i] = np.maximum(cur, prev * k)
        elif p["blend"] == "diff":
            out[i] = np.abs(cur - prev * k)
        else:
            out[i] = cur * (1 - k) + prev * k
    return clip.with_rgb(np.clip(out, 0, 1))


@op(id="time.slitscan", label="Slit scan", cat="time",
    blurb="Every row comes from a different moment. One frame holds the whole clip.",
    params=[num("spread", "Spread", 0, 100, 100, 5, "%",
                "How much of the clip a single frame reaches across."),
            pick("axis", "Across", [
                {"v": "y", "label": "Rows"},
                {"v": "x", "label": "Columns"}], "y"),
            flag("collapse", "Collapse to one frame", False)])
def slitscan(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    if n < 2:
        ctx.note("Slit scan needs more than one frame — put it after Drift or a clip source.")
        return clip
    span = (n - 1) * (p["spread"] / 100.0)
    if p["axis"] == "y":
        lag = (np.arange(h, dtype=np.float32) / max(h - 1, 1) * span)[None, :, None]
    else:
        lag = (np.arange(w, dtype=np.float32) / max(w - 1, 1) * span)[None, None, :]
    out_n = 1 if p["collapse"] else n
    base = np.arange(out_n, dtype=np.float32)[:, None, None]
    t = np.clip(base - lag + (span if p["collapse"] else 0), 0, n - 1)
    i0 = np.floor(t).astype(np.int64)
    i1 = np.minimum(i0 + 1, n - 1)
    f = (t - i0)[..., None]
    fi_shape = np.broadcast_to(i0, (out_n, h, w))
    fj_shape = np.broadcast_to(i1, (out_n, h, w))
    ys, xs = np.mgrid[0:h, 0:w]
    a = clip.frames[fi_shape, ys[None], xs[None]].astype(np.float32)
    b = clip.frames[fj_shape, ys[None], xs[None]].astype(np.float32)
    return clip.like(np.clip(a * (1 - f) + b * f, 0, 255).astype(np.uint8))


@op(id="time.stutter", label="Stutter", cat="time",
    blurb="Hold, repeat and skip frames. Broken playback rather than broken pixels.",
    params=[num("hold", "Hold every", 1, 24, 3, 1, " fr"),
            num("jump", "Jump back", 0, 24, 0, 1, " fr"),
            flag("shuffle", "Shuffle blocks", False), seed()])
def stutter(clip, p, ctx):
    n = clip.n
    hold = max(1, int(p["hold"]))
    idx = (np.arange(n) // hold) * hold
    if p["jump"]:
        j = int(p["jump"])
        block = np.arange(n) // hold
        idx = np.where(block % 2 == 1, np.maximum(idx - j * hold, 0), idx)
    if p["shuffle"]:
        rng = np.random.default_rng(int(p["seed"]))
        blocks = np.array_split(np.arange(n), max(1, n // hold))
        rng.shuffle(blocks)
        idx = np.concatenate(blocks)[:n]
    return clip.like(clip.frames[np.clip(idx, 0, n - 1)])
