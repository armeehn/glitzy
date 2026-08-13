"""Geometry ops -- move the pixels around without judging their colour."""

import numpy as np

from ..clip import Clip, resize_frames
from .. import nputil
from . import flag, num, op, pick


@op(id="geom.fit", label="Resize", cat="geom",
    blurb="Change the working size. Nearest by default, because smooth resampling is what destroys block edges.",
    params=[num("width", "Width", 32, 2400, 480, 16, " px"),
            num("height", "Height", 32, 2400, 480, 16, " px"),
            pick("fit", "Fit", [
                {"v": "stretch", "label": "Stretch"},
                {"v": "cover", "label": "Cover — fill and crop"},
                {"v": "contain", "label": "Contain — letterbox"}], "stretch"),
            flag("smooth", "Smooth", False)])
def fit(clip, p, ctx):
    w, h = int(p["width"]), int(p["height"])
    if p["fit"] == "stretch":
        return clip.like(resize_frames(clip.frames, w, h, p["smooth"]))
    sc = (max(w / clip.w, h / clip.h) if p["fit"] == "cover"
          else min(w / clip.w, h / clip.h))
    iw, ih = max(1, round(clip.w * sc)), max(1, round(clip.h * sc))
    mid = resize_frames(clip.frames, iw, ih, p["smooth"])
    out = np.zeros((clip.n, h, w, 4), np.uint8)
    ox, oy = (w - iw) // 2, (h - ih) // 2
    sx, sy = max(0, -ox), max(0, -oy)
    dx, dy = max(0, ox), max(0, oy)
    cw, ch = min(iw - sx, w - dx), min(ih - sy, h - dy)
    out[:, dy:dy + ch, dx:dx + cw] = mid[:, sy:sy + ch, sx:sx + cw]
    return clip.like(out)


@op(id="geom.transform", label="Transform", cat="geom",
    blurb="Scale, rotate and slide, with the option to animate the move across the clip.",
    params=[num("scale", "Scale", 10, 400, 100, 1, "%"),
            num("angle", "Rotate", -180, 180, 0, 1, "°"),
            num("x", "Offset X", -100, 100, 0, 1, "%"),
            num("y", "Offset Y", -100, 100, 0, 1, "%"),
            num("spin", "Spin over clip", -720, 720, 0, 15, "°"),
            pick("edge", "Edges", [
                {"v": "wrap", "label": "Wrap"},
                {"v": "clamp", "label": "Smear"},
                {"v": "empty", "label": "Transparent"}], "wrap")])
def transform(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    xs, ys = nputil.grid(n, h, w)
    cx, cy = w / 2.0, h / 2.0
    t = (np.arange(n, dtype=np.float32) / max(n, 1))[:, None, None]
    ang = np.deg2rad(p["angle"] + p["spin"] * t)
    inv = 100.0 / max(1e-3, p["scale"])
    ca, sa = np.cos(ang) * inv, np.sin(ang) * inv
    ox, oy = p["x"] / 100.0 * w, p["y"] / 100.0 * h
    dx, dy = xs - cx - ox, ys - cy - oy
    sx = dx * ca + dy * sa + cx
    sy = -dx * sa + dy * ca + cy
    wrap = p["edge"] == "wrap"
    out = nputil.sample_bilinear(clip.frames.astype(np.float32), sx, sy, wrap=wrap)
    if p["edge"] == "empty":
        off = (sx < 0) | (sx > w - 1) | (sy < 0) | (sy > h - 1)
        out[off] = 0
    return clip.like(np.clip(out, 0, 255).astype(np.uint8))


@op(id="geom.mirror", label="Mirror", cat="geom",
    blurb="Fold the frame onto itself. Two folds make a kaleidoscope.",
    params=[pick("mode", "Mode", [
                {"v": "x", "label": "Left onto right"},
                {"v": "y", "label": "Top onto bottom"},
                {"v": "quad", "label": "Quarter — both"},
                {"v": "kaleido", "label": "Kaleidoscope"}], "quad"),
            num("segments", "Segments", 3, 16, 6, 1, "", "Kaleidoscope only."),
            flag("flip", "From the other side", False)])
def mirror(clip, p, ctx):
    f = clip.frames
    n, h, w = clip.n, clip.h, clip.w
    mode = p["mode"]
    if mode == "kaleido":
        xs, ys = nputil.grid(n, h, w)
        cx, cy = w / 2.0, h / 2.0
        dx, dy = xs - cx, ys - cy
        r = np.hypot(dx, dy)
        a = np.arctan2(dy, dx)
        seg = np.pi * 2 / max(3, int(p["segments"]))
        a = np.abs(((a % seg) + seg) % seg - seg / 2)
        out = nputil.sample_bilinear(f.astype(np.float32),
                                     cx + np.cos(a) * r, cy + np.sin(a) * r,
                                     wrap=False)
        return clip.like(np.clip(out, 0, 255).astype(np.uint8))
    out = f.copy()
    if mode in ("x", "quad"):
        half = w // 2
        if p["flip"]:
            out[:, :, :half] = out[:, :, w - half:][:, :, ::-1]
        else:
            out[:, :, w - half:] = out[:, :, :half][:, :, ::-1]
    if mode in ("y", "quad"):
        half = h // 2
        if p["flip"]:
            out[:, :half] = out[:, h - half:][:, ::-1]
        else:
            out[:, h - half:] = out[:, :half][:, ::-1]
    return clip.like(out)


@op(id="geom.tile", label="Tile", cat="geom",
    blurb="Repeat the frame in a grid, optionally flipping alternate cells so the seams vanish.",
    params=[num("cols", "Across", 1, 12, 2), num("rows", "Down", 1, 12, 2),
            flag("mirror", "Mirror alternates", True),
            num("offset", "Row offset", 0, 100, 0, 5, "%")])
def tile(clip, p, ctx):
    cols, rows = int(p["cols"]), int(p["rows"])
    n, h, w = clip.n, clip.h, clip.w
    cw, ch = max(1, w // cols), max(1, h // rows)
    small = resize_frames(clip.frames, cw, ch, True)
    out = np.zeros((n, h, w, 4), np.uint8)
    for r in range(rows):
        row = small
        if p["mirror"] and r % 2:
            row = row[:, ::-1]
        shift = int(cw * (p["offset"] / 100.0) * r)
        for c in range(cols + 1):
            cell = row
            if p["mirror"] and c % 2:
                cell = cell[:, :, ::-1]
            x0 = (c * cw + shift) % (cols * cw) if cols * cw else 0
            y0 = r * ch
            xw = min(cw, w - x0)
            yh = min(ch, h - y0)
            if xw > 0 and yh > 0:
                out[:, y0:y0 + yh, x0:x0 + xw] = cell[:, :yh, :xw]
    return clip.like(out)


@op(id="geom.wave", label="Wave", cat="geom",
    blurb="Sine ripple through the frame. Rolling shutter and heat haze.",
    params=[num("amplitude", "Amplitude", 0, 120, 14, 1, " px"),
            num("frequency", "Frequency", 1, 40, 4),
            num("phase", "Travel", 0, 20, 2, 1, "", "Cycles over the clip."),
            pick("axis", "Along", [
                {"v": "x", "label": "Rows shift sideways"},
                {"v": "y", "label": "Columns shift up"},
                {"v": "both", "label": "Both"}], "x")])
def wave(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    xs, ys = nputil.grid(n, h, w)
    t = (np.arange(n, dtype=np.float32) / max(n, 1))[:, None, None] * np.pi * 2 * p["phase"]
    a, fq = float(p["amplitude"]), float(p["frequency"])
    if p["axis"] in ("x", "both"):
        xs = xs + np.sin(ys / h * np.pi * 2 * fq + t) * a
    if p["axis"] in ("y", "both"):
        ys = ys + np.sin(xs / w * np.pi * 2 * fq + t) * a
    out = nputil.sample_bilinear(clip.frames.astype(np.float32), xs, ys, wrap=True)
    return clip.like(np.clip(out, 0, 255).astype(np.uint8))


@op(id="geom.polar", label="Polar", cat="geom",
    blurb="Bend the frame around a circle, or unroll a circular one flat.",
    params=[pick("dir", "Direction", [
                {"v": "to_polar", "label": "Wrap into a disc"},
                {"v": "to_rect", "label": "Unroll to a strip"}], "to_polar"),
            num("spin", "Spin", 0, 360, 0, 5, "°")])
def polar(clip, p, ctx):
    n, h, w = clip.n, clip.h, clip.w
    xs, ys = nputil.grid(n, h, w)
    cx, cy = w / 2.0, h / 2.0
    rot = np.deg2rad(p["spin"])
    if p["dir"] == "to_polar":
        dx, dy = xs - cx, ys - cy
        r = np.hypot(dx, dy) / max(np.hypot(cx, cy), 1)
        a = ((np.arctan2(dy, dx) + rot) % (np.pi * 2)) / (np.pi * 2)
        sx, sy = a * (w - 1), r * (h - 1)
    else:
        a = xs / max(w - 1, 1) * np.pi * 2 - rot
        r = ys / max(h - 1, 1) * min(cx, cy)
        sx, sy = cx + np.cos(a) * r, cy + np.sin(a) * r
    out = nputil.sample_bilinear(clip.frames.astype(np.float32), sx, sy, wrap=True)
    return clip.like(np.clip(out, 0, 255).astype(np.uint8))
