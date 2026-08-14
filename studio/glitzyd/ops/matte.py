"""Matte ops -- deciding which pixels are sticker and which are nothing.

This is where the artwork stops being a picture and becomes a cut shape. The
silhouette and its die-cut border are baked into the ALPHA, not drawn on top:
etsch traces the contour of the transparency, so the alpha channel is
literally the line the blade follows. That is also why the sheet exporter asks
etsch for a contour at offset 0 -- the offset is already in the artwork, and
asking for one again cuts a second line outside the border.
"""

import numpy as np
from PIL import Image, ImageDraw

from .. import nputil, palettes
from . import colour, flag, num, op, pick, seed

SS = 3  # supersample factor: the cut edge has to be smooth, not stair-stepped

SHAPES = [
    {"v": "rect", "label": "Square / frame"},
    {"v": "round", "label": "Rounded"},
    {"v": "squircle", "label": "Squircle"},
    {"v": "circle", "label": "Circle"},
    {"v": "capsule", "label": "Capsule"},
    {"v": "hex", "label": "Hexagon"},
    {"v": "diamond", "label": "Diamond"},
    {"v": "star", "label": "Star"},
    {"v": "burst", "label": "Starburst"},
    {"v": "shield", "label": "Shield"},
    {"v": "banner", "label": "Ribbon"},
    {"v": "arch", "label": "Arch"},
    {"v": "blob", "label": "Blob"},
]


def _polygon(kind, w, h, sd):
    cx, cy = w / 2.0, h / 2.0
    r = min(w, h) / 2.0
    if kind in ("hex", "diamond"):
        k = 6 if kind == "hex" else 4
        a = np.arange(k) / k * np.pi * 2 - np.pi / 2
        return list(zip(cx + np.cos(a) * r, cy + np.sin(a) * r))
    if kind in ("star", "burst"):
        pts, inner = (5, 0.42) if kind == "star" else (14, 0.78)
        a = np.arange(pts * 2) * np.pi / pts - np.pi / 2
        rr = np.where(np.arange(pts * 2) % 2, r * inner, r)
        return list(zip(cx + np.cos(a) * rr, cy + np.sin(a) * rr))
    if kind == "shield":
        top, bot = h * 0.06, h * 0.97
        left, right = w * 0.08, w * 0.92
        pts = [(left, top), (right, top), (right, h * 0.55)]
        for t in np.linspace(0, 1, 24):  # shoulder down to the point
            pts.append((right + (cx - right) * t,
                        h * 0.55 + (bot - h * 0.55) * np.sin(t * np.pi / 2)))
        for t in np.linspace(0, 1, 24):
            pts.append((cx + (left - cx) * t,
                        bot - (bot - h * 0.55) * (1 - np.cos(t * np.pi / 2))))
        return pts
    if kind == "banner":
        notch = w * 0.13
        return [(w * 0.02, h * 0.24), (w * 0.98, h * 0.24), (w * 0.98 - notch, cy),
                (w * 0.98, h * 0.76), (w * 0.02, h * 0.76), (w * 0.02 + notch, cy)]
    if kind == "blob":
        rng = np.random.default_rng(int(sd))
        k = 7
        amp = rng.random(k).astype(np.float32) * 0.16
        ph = rng.random(k).astype(np.float32) * np.pi * 2
        a = np.linspace(0, np.pi * 2, 180, endpoint=False)
        rr = np.ones_like(a) * r * 0.95
        for i in range(k):
            rr = rr * (1 + amp[i] * np.sin(a * (i + 2) + ph[i]))
        return list(zip(cx + np.cos(a) * rr, cy + np.sin(a) * rr))
    return None


def shape_mask(kind, w, h, radius_pct=10.0, inset_pct=0.0, sd=1):
    """A 0..1 antialiased mask of one silhouette, in a w x h box."""
    inset = min(w, h) * (inset_pct / 100.0) / 2.0
    W, H = int(w * SS), int(h * SS)
    ix = inset * SS
    im = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(im)
    box = [ix, ix, W - 1 - ix, H - 1 - ix]

    if kind == "squircle":
        # A superellipse has no PIL primitive; it is cheaper to solve than to
        # approximate with a polygon, and the exponent is what gives it that
        # not-quite-a-circle silhouette.
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        nx = (xs - W / 2) / max(W / 2 - ix, 1)
        ny = (ys - H / 2) / max(H / 2 - ix, 1)
        m = (np.abs(nx) ** 4 + np.abs(ny) ** 4) <= 1.0
        im = Image.fromarray((m * 255).astype(np.uint8), "L")
    elif kind == "circle":
        r = min(box[2] - box[0], box[3] - box[1]) / 2
        d.ellipse([W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r], fill=255)
    elif kind == "capsule":
        r = min(box[2] - box[0], box[3] - box[1]) / 2
        d.rounded_rectangle(box, radius=r, fill=255)
    elif kind == "round":
        r = min(box[2] - box[0], box[3] - box[1]) * (radius_pct / 200.0)
        d.rounded_rectangle(box, radius=max(0, r), fill=255)
    elif kind == "arch":
        r = (box[2] - box[0]) / 2
        d.rectangle([box[0], box[1] + r, box[2], box[3]], fill=255)
        d.ellipse([box[0], box[1], box[2], box[1] + 2 * r], fill=255)
    elif kind == "rect":
        d.rectangle(box, fill=255)
    else:
        pts = _polygon(kind, W - 2 * ix, H - 2 * ix, sd)
        if pts is None:
            d.rectangle(box, fill=255)
        else:
            d.polygon([(x + ix, y + ix) for x, y in pts], fill=255)

    im = im.resize((int(w), int(h)), Image.BOX)
    return np.asarray(im).astype(np.float32) / 255.0


@op(id="matte.key", label="Key out", cat="matte",
    blurb="Make part of the picture transparent by colour or brightness.",
    params=[
        pick("mode", "Remove", [
            {"v": "corner", "label": "Background — sampled from the corners"},
            {"v": "dark", "label": "Dark areas"},
            {"v": "light", "label": "Light areas"},
            {"v": "colour", "label": "A specific colour"}], "corner"),
        colour("key", "Colour", "#000000"),
        num("tolerance", "Tolerance", 1, 100, 18, 1, "%"),
        num("softness", "Softness", 0, 40, 4, 1, " px"),
        num("clean", "Clean up", 0, 100, 20, 1, "%",
            "Drops islands smaller than this. A cutter follows every speck it is given."),
        flag("invert", "Keep what it removed", False),
    ])
def key(clip, p, ctx):
    rgb = clip.rgb()
    tol = p["tolerance"] / 100.0
    if p["mode"] in ("dark", "light"):
        l = palettes.luma(rgb)
        drop = (l < tol) if p["mode"] == "dark" else (l > 1 - tol)
        soft = np.clip((tol - l) / max(tol, 1e-3), 0, 1) if p["mode"] == "dark" \
            else np.clip((l - (1 - tol)) / max(tol, 1e-3), 0, 1)
    else:
        if p["mode"] == "corner":
            c = np.stack([rgb[:, 0, 0], rgb[:, 0, -1], rgb[:, -1, 0], rgb[:, -1, -1]])
            ref = c.mean(0)[:, None, None, :]
        else:
            ref = palettes.hex_f(p["key"])[None, None, None, :]
        d = np.sqrt(((rgb - ref) ** 2).sum(3) / 3.0)
        drop = d < tol
        soft = np.clip(1.0 - d / max(tol, 1e-3), 0, 1)

    keep = ~drop if not p["invert"] else drop
    if p["clean"] > 0:
        keep = nputil.despeckle(keep, min_frac=0.0002 * p["clean"])
    a = keep.astype(np.float32)
    if not p["invert"]:
        a = np.minimum(a, 1.0 - soft * 0.999)
    if p["softness"] >= 1:
        a = nputil.box_blur(a, int(p["softness"]))
    return clip.with_alpha(np.clip(a, 0, 1) * clip.alpha())


@op(id="matte.shape", label="Silhouette", cat="matte",
    blurb="Cut the artwork to a shape. This outline is the line the blade follows.",
    params=[
        pick("shape", "Shape", SHAPES, "circle"),
        num("radius", "Corner", 0, 100, 18, 1, "%"),
        num("inset", "Inset", 0, 40, 0, 1, "%"),
        num("rotate", "Rotate", 0, 360, 0, 5, "°"),
        seed(),
    ], varies=("radius", "inset", "rotate", "seed"))
def shape(clip, p, ctx):
    m = shape_mask(p["shape"], clip.w, clip.h, p["radius"], p["inset"], p["seed"])
    if p["rotate"]:
        m = np.asarray(Image.fromarray((m * 255).astype(np.uint8), "L").rotate(
            p["rotate"], resample=Image.BILINEAR)).astype(np.float32) / 255.0
    return clip.with_alpha(clip.alpha() * m[None])


@op(id="matte.border", label="Die-cut border", cat="matte",
    blurb="The white ring around a sticker. Baked into the alpha, so the cut line comes with it.",
    params=[
        num("width", "Width", 0, 60, 10, 1, " px"),
        colour("fill", "Colour", "#F6F1E7"),
        flag("transparent", "No fill — just grow the cut", False),
        num("soften", "Soften", 0, 12, 1, 1, " px"),
    ], varies=("width",))
def border(clip, p, ctx):
    r = int(p["width"])
    if r <= 0:
        return clip
    a = clip.alpha()
    inside = a >= 0.5
    if not inside.any():
        ctx.note("Nothing is opaque here, so there was no shape to put a border "
                 "around. Put a Silhouette or Key out before this.")
        return clip
    if inside.all():
        # Every pixel is already sticker, so there is no outside to grow into.
        # Silently returning the input here is what makes a border look broken.
        ctx.note("The whole frame is opaque, so there is no edge to put a border "
                 "on. Put a Silhouette or Key out before this.")
        return clip
    d = nputil.dist_outside(inside, r + 2)
    outer = np.clip(r + 0.5 - d, 0, 1)
    if p["soften"] >= 1:
        outer = nputil.box_blur(outer, int(p["soften"]))
    rgb = clip.rgb()
    if not p["transparent"]:
        fill = palettes.hex_f(p["fill"])[None, None, None, :]
        art = a[..., None]
        rgb = rgb * art + fill * (1 - art)
    return clip.with_rgb(rgb).with_alpha(np.maximum(a, outer))


@op(id="matte.background", label="Backing", cat="matte",
    blurb="Put a flat colour behind whatever is still transparent.",
    params=[colour("fill", "Colour", "#F6F1E7"),
            flag("opaque", "Make fully opaque", True)], varies=())
def background(clip, p, ctx):
    a = clip.alpha()[..., None]
    fill = palettes.hex_f(p["fill"])[None, None, None, :]
    rgb = clip.rgb() * a + fill * (1 - a)
    out = clip.with_rgb(rgb)
    return out.with_alpha(np.ones_like(clip.alpha())) if p["opaque"] else out


@op(id="matte.trim", label="Trim", cat="matte",
    blurb="Crop away the empty margin so the sticker packs tightly on the sheet.",
    params=[num("pad", "Padding", 0, 60, 2, 1, " px"),
            flag("square", "Keep it square", False)], varies=())
def trim(clip, p, ctx):
    a = clip.frames[..., 3].max(0)
    ys, xs = np.nonzero(a > 8)
    if len(xs) == 0:
        return clip
    pad = int(p["pad"])
    x0 = max(0, xs.min() - pad); x1 = min(clip.w, xs.max() + 1 + pad)
    y0 = max(0, ys.min() - pad); y1 = min(clip.h, ys.max() + 1 + pad)
    if p["square"]:
        side = max(x1 - x0, y1 - y0)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        x0 = max(0, cx - side // 2); x1 = min(clip.w, x0 + side)
        y0 = max(0, cy - side // 2); y1 = min(clip.h, y0 + side)
    return clip.like(clip.frames[:, y0:y1, x0:x1])
