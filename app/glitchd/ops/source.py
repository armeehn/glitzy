"""Source ops -- the ops that make a clip instead of transforming one.

The generators are numpy now rather than canvas code in the browser. That is
not just tidiness: a generator that runs on the backend is seeded, cached and
identical every time, so a chain you saved last week reproduces exactly, and
the studio can sweep a seed across twelve variants without twelve round trips
of pixels over the wire.
"""

import os

import numpy as np

from .. import ff, nputil, palettes, store
from ..clip import Clip
from . import colour as colour_param
from . import flag, num, op, pick, seed, src


def _base_params(extra=()):
    return [
        num("width", "Width", 64, 1600, 480, 16, " px",
            "Codec ops pad to a multiple of 16, so 16s keep the block grid on the edge."),
        num("height", "Height", 64, 1600, 480, 16, " px"),
        num("frames", "Frames", 1, 240, 48, 1, " fr",
            "One frame is a still. Motion is what the codec ops have to work with."),
        num("fps", "Rate", 6, 30, 25, 1, " fps"),
        seed(),
        pick("palette", "Colourway", palettes.PALETTE_IDS[1:], "riposte"),
        flag("invert", "Invert", False),
    ] + list(extra)


def _colourise(field, pid, invert):
    cols = palettes.colours_of(pid)
    f = np.clip(field, 0, 1)
    if invert:
        f = 1.0 - f
    if cols is None:
        return np.repeat(f[..., None], 3, axis=3)
    return palettes.ramp(cols, f)


def _finish(field, p, ctx):
    rgb = _colourise(field, p["palette"], p["invert"])
    frames = np.empty(rgb.shape[:3] + (4,), np.uint8)
    frames[..., :3] = np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8)
    frames[..., 3] = 255
    return Clip(frames, p["fps"])


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------

def gen_flow(rng, n, h, w, p):
    """Domain-warped fractal noise: soft marbled currents."""
    scale = p["scale"]
    a = nputil.fbm(rng, n, h, w, freq=scale, octaves=3)
    b = nputil.fbm(rng, n, h, w, freq=scale, octaves=3)
    xs, ys = nputil.grid(n, h, w)
    amt = p["warp"]
    base = nputil.fbm(rng, n, h, w, freq=scale, octaves=4)
    return nputil.sample_bilinear(base, xs + (a - 0.5) * amt, ys + (b - 0.5) * amt)


def gen_truchet(rng, n, h, w, p):
    """Quarter-arc tiles. Hard geometry, which the codec ops love: every arc
    edge is a high-contrast block boundary for the quantiser to chew."""
    cells = max(2, int(p["scale"]))
    table = (rng.random((cells, cells)) > 0.5)
    xs, ys = nputil.grid(n, h, w)
    t = np.arange(n, dtype=np.float32)[:, None, None] / max(n, 1)
    u = (xs / w * cells + t * p["drift"]) % cells
    v = (ys / h * cells + t * p["drift"] * 0.6) % cells
    ti = np.floor(u).astype(np.int64) % cells
    tj = np.floor(v).astype(np.int64) % cells
    fu, fv = u - np.floor(u), v - np.floor(v)
    flip = table[tj, ti]
    d_a = np.minimum(np.abs(np.hypot(fu, fv) - 0.5),
                     np.abs(np.hypot(fu - 1, fv - 1) - 0.5))
    d_b = np.minimum(np.abs(np.hypot(fu - 1, fv) - 0.5),
                     np.abs(np.hypot(fu, fv - 1) - 0.5))
    d = np.where(flip, d_a, d_b)
    thick = max(0.02, p["warp"] / 60.0)
    return np.clip(1.0 - d / thick, 0, 1)


def gen_moire(rng, n, h, w, p):
    """Two rotating gratings beating against each other."""
    xs, ys = nputil.grid(n, h, w)
    cx, cy = w / 2, h / 2
    t = np.arange(n, dtype=np.float32)[:, None, None] * (np.pi * 2 / max(n, 1))
    f = p["scale"] / 60.0
    a1 = 0.4 + t * 0.05 * p["drift"]
    a2 = -0.4 - t * 0.03 * p["drift"] + rng.random() * 0.5
    g1 = np.sin(((xs - cx) * np.cos(a1) + (ys - cy) * np.sin(a1)) * f)
    g2 = np.sin(((xs - cx) * np.cos(a2) + (ys - cy) * np.sin(a2)) * f * 1.07)
    return (g1 * g2 + 1) / 2


def gen_plasma(rng, n, h, w, p):
    xs, ys = nputil.grid(n, h, w)
    t = np.arange(n, dtype=np.float32)[:, None, None] * (np.pi * 2 / max(n, 1))
    f = p["scale"] / 240.0
    o = rng.random(3).astype(np.float32) * 6.0
    v = (np.sin(xs * f + t + o[0])
         + np.sin(ys * f * 1.3 - t + o[1])
         + np.sin((xs + ys) * f * 0.7 + t * 1.5 + o[2])
         + np.sin(np.hypot(xs - w / 2, ys - h / 2) * f * 1.9 - t))
    return (v / 4 + 1) / 2


def gen_rings(rng, n, h, w, p):
    xs, ys = nputil.grid(n, h, w)
    cx = w * (0.3 + rng.random() * 0.4)
    cy = h * (0.3 + rng.random() * 0.4)
    t = np.arange(n, dtype=np.float32)[:, None, None] * (np.pi * 2 / max(n, 1))
    d = np.hypot(xs - cx, ys - cy)
    return (np.sin(d * (p["scale"] / 60.0) - t * p["drift"]) + 1) / 2


def gen_voronoi(rng, n, h, w, p):
    """Cell mosaic from drifting points. Reads as shattered plate glass once
    a quantiser has been over it."""
    k = int(np.clip(p["scale"], 3, 90))
    pts = rng.random((k, 2)).astype(np.float32) * [w, h]
    vel = (rng.random((k, 2)).astype(np.float32) - 0.5) * p["drift"] * 4
    xs, ys = nputil.grid(1, h, w)
    xs, ys = xs[0], ys[0]
    out = np.empty((n, h, w), np.float32)
    ids = rng.random(k).astype(np.float32)
    for i in range(n):
        px = (pts[:, 0] + vel[:, 0] * i) % w
        py = (pts[:, 1] + vel[:, 1] * i) % h
        best = np.full((h, w), np.inf, np.float32)
        val = np.zeros((h, w), np.float32)
        for j in range(k):
            d = (xs - px[j]) ** 2 + (ys - py[j]) ** 2
            m = d < best
            best = np.where(m, d, best)
            val = np.where(m, ids[j], val)
        out[i] = val
    return out


def gen_feedback(rng, n, h, w, p):
    """Zoom-and-rotate feedback: each frame is the last one, scaled a little
    and turned a little, with a seed shape stamped back in."""
    xs, ys = nputil.grid(1, h, w)
    xs, ys = xs[0], ys[0]
    cx, cy = w / 2, h / 2
    zoom = 1.0 + p["warp"] / 400.0
    ang = p["drift"] * 0.04
    ca, sa = np.cos(ang) / zoom, np.sin(ang) / zoom
    sx = (xs - cx) * ca - (ys - cy) * sa + cx
    sy = (xs - cx) * sa + (ys - cy) * ca + cy
    stamp = np.clip(1.0 - np.hypot(xs - cx, ys - cy) / (min(w, h) * 0.16), 0, 1)
    bars = ((np.floor(ys / max(2, h / p["scale"])) % 2) == 0).astype(np.float32)
    stamp = np.maximum(stamp, bars * 0.35)
    cur = nputil.fbm(rng, 1, h, w, freq=6, octaves=2)[0]
    out = np.empty((n, h, w), np.float32)
    for i in range(n):
        warped = nputil.sample_bilinear(
            cur[None], sx[None], sy[None], wrap=False)[0]
        cur = np.clip(warped * 0.94 + stamp * 0.22, 0, 1)
        out[i] = cur
    return out


GENERATORS = [
    ("flow", "Flow field", gen_flow,
     "Marbled currents from warped fractal noise. The soft one."),
    ("truchet", "Truchet tiles", gen_truchet,
     "Interlocking quarter arcs. Hard edges the quantiser can bite."),
    ("moire", "Moire", gen_moire,
     "Two gratings beating against each other into interference bands."),
    ("plasma", "Plasma", gen_plasma,
     "Stacked sine fields. Smooth, cyclic, endlessly loopable."),
    ("rings", "Rings", gen_rings,
     "Concentric waves pulsing out of an off-centre point."),
    ("voronoi", "Cells", gen_voronoi,
     "A mosaic of drifting cells. Shattered plate glass."),
    ("feedback", "Feedback zoom", gen_feedback,
     "Each frame is the last one zoomed and turned. Tunnels and spirals."),
]


def _register_generators():
    extra = [
        num("scale", "Scale", 2, 90, 12, 1, "", "Feature size, or cell count."),
        num("warp", "Warp", 0, 120, 40, 1, ""),
        num("drift", "Drift", 0, 20, 4, 1, "", "How fast it moves over the clip."),
    ]
    for gid, label, fn, blurb in GENERATORS:
        def make(fn=fn):
            def run(clip, p, ctx):
                rng = np.random.default_rng(int(p["seed"]))
                n = int(p["frames"])
                h, w = int(p["height"]), int(p["width"])
                ctx.progress(0.2, "generating")
                field = fn(rng, n, h, w, p)
                ctx.progress(0.8, "colouring")
                return _finish(field, p, ctx)
            return run
        op(id="source." + gid, label=label, cat="source", blurb=blurb,
           params=_base_params(extra), domain="source",
           varies=("seed", "scale", "warp", "drift"))(make())


_register_generators()


# ---------------------------------------------------------------------------
# Media and flat fills
# ---------------------------------------------------------------------------

@op(id="source.media", label="Image or video", cat="source", domain="source",
    blurb="A file you uploaded or pulled from a URL, cut to the working size.",
    params=[
        src("src", "File"),
        num("width", "Width", 64, 1600, 480, 16, " px"),
        num("height", "Height", 64, 1600, 480, 16, " px"),
        num("frames", "Frames", 1, 240, 48, 1, " fr"),
        num("fps", "Rate", 6, 30, 25, 1, " fps"),
        num("start", "Start at", 0, 600, 0, 1, " s", "Seek into a longer clip."),
        pick("fit", "Fit", [
            {"v": "cover", "label": "Cover — fill and crop"},
            {"v": "contain", "label": "Contain — letterbox"},
            {"v": "stretch", "label": "Stretch"}], "cover"),
    ],
    varies=("start",))
def media(clip, p, ctx):
    sid = p.get("src") or ""
    meta = store.source_meta(sid)
    d = store.source_dir(sid)
    if not meta or not d:
        raise ValueError("Pick a file for this source — the one it had is gone.")
    path = os.path.join(d, meta["file"])
    if not os.path.isfile(path):
        raise ValueError("That upload is no longer on disk.")
    ctx.progress(0.3, "reading %s" % meta.get("name", "file"))
    n = int(p["frames"])
    out = ff.extract(path, ctx.workdir, n, p["fps"], int(p["width"]),
                     int(p["height"]), start=p["start"], fit=p["fit"])
    if out.n < n and meta.get("duration", 0) <= 0.3:
        # A still gives one frame no matter how many were asked for. Hold it,
        # so the frame count downstream is the one the chain was built around.
        out = out.like(np.repeat(out.frames[:1], n, axis=0))
        ctx.note("That is a still, so every frame is identical. Add Time ▸ Drift "
                 "before a codec op or there will be no motion to damage.")
    return out


@op(id="source.solid", label="Flat colour", cat="source", domain="source",
    blurb="A plain field. Useful as a backdrop under a matte.",
    params=[
        num("width", "Width", 64, 1600, 480, 16, " px"),
        num("height", "Height", 64, 1600, 480, 16, " px"),
        num("frames", "Frames", 1, 240, 1, 1, " fr"),
        num("fps", "Rate", 6, 30, 25, 1, " fps"),
        colour_param("fill", "Colour", "#1D1A17"),
    ], varies=())
def solid(clip, p, ctx):
    r, g, b = palettes.hex_rgb(p["fill"])
    return Clip.solid(int(p["width"]), int(p["height"]), (r, g, b, 255),
                      int(p["frames"]), p["fps"])


@op(id="source.gradient", label="Gradient", cat="source", domain="source",
    blurb="A linear or radial ramp through a colourway.",
    params=_base_params([
        pick("shape", "Shape", ["linear", "radial", "conic"], "linear"),
        num("angle", "Angle", 0, 360, 90, 5, "°"),
    ]), varies=("angle", "seed"))
def gradient(clip, p, ctx):
    n, h, w = int(p["frames"]), int(p["height"]), int(p["width"])
    xs, ys = nputil.grid(n, h, w)
    cx, cy = w / 2, h / 2
    if p["shape"] == "radial":
        t = np.hypot(xs - cx, ys - cy) / (np.hypot(cx, cy) or 1)
    elif p["shape"] == "conic":
        t = (np.arctan2(ys - cy, xs - cx) + np.pi) / (np.pi * 2)
    else:
        a = np.deg2rad(p["angle"])
        t = ((xs - cx) * np.cos(a) + (ys - cy) * np.sin(a))
        t = (t - t.min()) / (np.ptp(t) or 1)
    return _finish(t, p, ctx)
