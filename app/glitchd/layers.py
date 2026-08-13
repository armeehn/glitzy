"""Layers -- several chains composited into one artwork.

A project used to be one chain. It is now a *stack* of chains, bottom to top,
each with its own compositing settings. Nothing about the chain model changed:
a layer's chain is evaluated by exactly the same evaluator, lands on exactly
the same content-addressed cache, and knows nothing about the layers above or
below it. The stack is a second, much smaller graph on top of that.

The composite itself is cached the same way everything else is:

    sha1("__composite", [each layer's spec], "|".join(layer output hashes))

which means the cache key covers the whole stack. Dragging the opacity of the
top layer recomputes one composite over N cached layer results -- it does not
re-run a single op. And because the key includes each layer's own chain hash,
two projects that share a background share its cached frames for free.

Memory is the reason this file loads frames one at a time. Eight layers of
480x480x48 held as RGBA is ~350 MB, and the engine is capped at 1400M on a
host that is already RAM-oversubscribed. Layers stay on disk as PNGs and each
frame is read, placed and dropped, so peak cost is the output clip plus a
handful of single-frame float buffers.
"""

import os

import numpy as np
from PIL import Image

from .clip import MAX_PIXELS, Clip, ClipTooBig
from .ops import flag, num, pick, coerce_specs

MAX_LAYERS = 8
MAX_FRAMES = 240

# Ordinary separable blends, plus three that are here for glitch work: the two
# bitwise ones (which have no meaning in a colour space but produce exactly the
# hard banded artefacts this studio exists for) and the two matte operators
# below, which do not touch colour at all.
BLENDS = [
    ("normal", "Normal"),
    ("multiply", "Multiply"),
    ("screen", "Screen"),
    ("overlay", "Overlay"),
    ("darken", "Darken"),
    ("lighten", "Lighten"),
    ("dodge", "Colour dodge"),
    ("burn", "Colour burn"),
    ("hardlight", "Hard light"),
    ("softlight", "Soft light"),
    ("difference", "Difference"),
    ("exclusion", "Exclusion"),
    ("add", "Add"),
    ("subtract", "Subtract"),
    ("xor", "Bitwise XOR"),
    ("bitand", "Bitwise AND"),
    ("erase", "Erase (punch out)"),
    ("inside", "Keep inside"),
]

# The two that are compositing operators rather than colour blends: they change
# the alpha of what is already underneath and ignore their own colour.
MATTE_MODES = ("erase", "inside")

LAYER_PARAMS = [
    pick("blend", "Blend", [{"v": v, "label": l} for v, l in BLENDS], "normal",
         hint="How this layer's colour meets the layers under it. Erase and "
              "Keep inside ignore colour and use this layer's alpha as a "
              "stencil on everything below."),
    num("opacity", "Opacity", 0, 100, 100, suffix="%"),
    pick("fit", "Fit", [
        {"v": "contain", "label": "Contain"}, {"v": "cover", "label": "Cover"},
        {"v": "stretch", "label": "Stretch"}, {"v": "none", "label": "None"}],
        "contain",
        hint="How a layer that is not the canvas size is placed on it. The "
             "canvas is the bottom visible layer's own size."),
    num("scale", "Scale", 10, 400, 100, suffix="%"),
    num("x", "Offset X", -100, 100, 0, suffix="%",
        hint="Percent of the canvas width, from centred."),
    num("y", "Offset Y", -100, 100, 0, suffix="%"),
    flag("clip", "Clip to below",
         hint="Restrict this layer to where the layers below are already "
              "opaque -- a texture poured into a silhouette."),
    pick("timing", "Timing", [
        {"v": "loop", "label": "Loop"}, {"v": "hold", "label": "Hold last"},
        {"v": "pingpong", "label": "Ping-pong"}], "loop",
        hint="What a short layer does once the longest layer is still running."),
    num("delay", "Frame offset", -120, 120, 0,
        hint="Slide this layer in time against the rest of the stack."),
]

LAYER_KEYS = [p["k"] for p in LAYER_PARAMS]


def public_schema():
    """The layer settings as the studio sees them. Same contract as /api/ops:
    the backend owns the schema and the UI is generated from it, so adding a
    blend mode stays a backend-only change."""
    return {"params": LAYER_PARAMS, "blends": [{"v": v, "label": l} for v, l in BLENDS],
            "max": MAX_LAYERS}


def coerce_layer(raw):
    """Clamp a layer's compositing settings. Chain contents are validated by
    the evaluator; this is only the stack-level part."""
    raw = raw if isinstance(raw, dict) else {}
    spec, _ = coerce_specs(LAYER_PARAMS, raw)
    return spec


def is_identity(spec):
    """True when a layer is placed exactly as-is over an empty canvas, so a
    single-layer stack can skip compositing entirely and hand back the chain's
    own cache entry -- byte for byte what a v2.0 project produced.

    The blend mode is deliberately not part of this. Every separable blend
    against an empty backdrop reduces to the source colour (put ab = 0 into
    the compositing formula and the blend term drops out), so soloing a
    Multiply layer must cost nothing. The two matte modes are the exception:
    they consume the backdrop's alpha, and against nothing they render empty
    -- which is a real result, not an identity.
    """
    return (spec["blend"] not in MATTE_MODES and spec["opacity"] == 100
            and spec["scale"] == 100 and spec["x"] == 0 and spec["y"] == 0
            and not spec["clip"] and spec["delay"] == 0)


# ---------------------------------------------------------------------------
# Blend functions. cb (backdrop) and cs (source) are float32 (h,w,3) in 0..1.
# ---------------------------------------------------------------------------

def _multiply(cb, cs):
    return cb * cs


def _screen(cb, cs):
    return cb + cs - cb * cs


def _hardlight(cb, cs):
    return np.where(cs <= 0.5, _multiply(cb, 2 * cs), _screen(cb, 2 * cs - 1))


def _softlight(cb, cs):
    d = np.where(cb <= 0.25, ((16 * cb - 12) * cb + 4) * cb, np.sqrt(np.maximum(cb, 0)))
    return np.where(cs <= 0.5,
                    cb - (1 - 2 * cs) * cb * (1 - cb),
                    cb + (2 * cs - 1) * (d - cb))


def _dodge(cb, cs):
    out = np.minimum(1.0, cb / np.maximum(1 - cs, 1e-6))
    return np.where(cb <= 0, 0.0, np.where(cs >= 1, 1.0, out))


def _burn(cb, cs):
    out = 1 - np.minimum(1.0, (1 - cb) / np.maximum(cs, 1e-6))
    return np.where(cb >= 1, 1.0, np.where(cs <= 0, 0.0, out))


def _bitwise(op):
    # Bitwise blending only means anything on the 8-bit values, so round-trip
    # through uint8 rather than trying to do it in float.
    def f(cb, cs):
        a = np.clip(cb * 255 + 0.5, 0, 255).astype(np.uint8)
        b = np.clip(cs * 255 + 0.5, 0, 255).astype(np.uint8)
        return op(a, b).astype(np.float32) / 255.0
    return f


BLEND_FN = {
    "normal": lambda cb, cs: cs,
    "multiply": _multiply,
    "screen": _screen,
    "overlay": lambda cb, cs: _hardlight(cs, cb),
    "darken": np.minimum,
    "lighten": np.maximum,
    "dodge": _dodge,
    "burn": _burn,
    "hardlight": _hardlight,
    "softlight": _softlight,
    "difference": lambda cb, cs: np.abs(cb - cs),
    "exclusion": lambda cb, cs: cb + cs - 2 * cb * cs,
    "add": lambda cb, cs: np.minimum(1.0, cb + cs),
    "subtract": lambda cb, cs: np.maximum(0.0, cb - cs),
    "xor": _bitwise(np.bitwise_xor),
    "bitand": _bitwise(np.bitwise_and),
}


# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------

class Placed:
    """One layer, ready to hand out canvas-sized frames on demand.

    Frames are read from the layer's cache directory one at a time. A still
    (n == 1) is resized once and reused, because the common stack is a moving
    background under a still silhouette and re-decoding that silhouette 48
    times would be the slowest thing in the composite.
    """

    def __init__(self, cache_dir, meta, spec, cw, ch):
        self.dir = cache_dir
        self.n = max(1, int(meta.get("n") or 1))
        self.sw = int(meta["w"])
        self.sh = int(meta["h"])
        self.spec = spec
        self.cw, self.ch = cw, ch
        self.mode = spec["blend"]
        self.opacity = spec["opacity"] / 100.0
        self.clip = bool(spec["clip"])
        self._still = None
        self.tw, self.th = self._target()
        # Top-left of the placed layer on the canvas, centred then offset.
        self.x0 = int(round((cw - self.tw) / 2 + spec["x"] * cw / 100.0))
        self.y0 = int(round((ch - self.th) / 2 + spec["y"] * ch / 100.0))

    def _target(self):
        fit, s = self.spec["fit"], self.spec["scale"] / 100.0
        if fit == "stretch":
            tw, th = self.cw, self.ch
        else:
            if fit == "contain":
                k = min(self.cw / self.sw, self.ch / self.sh)
            elif fit == "cover":
                k = max(self.cw / self.sw, self.ch / self.sh)
            else:
                k = 1.0
            tw, th = self.sw * k, self.sh * k
        return max(1, int(round(tw * s))), max(1, int(round(th * s)))

    def _index(self, f):
        """Which of this layer's own frames belongs at canvas frame f."""
        i = f + int(self.spec["delay"])
        if self.n == 1:
            return 0
        timing = self.spec["timing"]
        if timing == "hold":
            return max(0, min(self.n - 1, i))
        if timing == "pingpong":
            period = 2 * self.n - 2 if self.n > 1 else 1
            i %= period
            return i if i < self.n else period - i
        return i % self.n

    def frame(self, f):
        """A canvas-sized RGBA frame, transparent everywhere this layer is not."""
        if self.n == 1 and self._still is not None:
            return self._still
        i = self._index(f)
        with Image.open(os.path.join(self.dir, "f_%05d.png" % i)) as im:
            im = im.convert("RGBA")
            if (self.tw, self.th) != (self.sw, self.sh):
                # Nearest when magnifying keeps the macroblock grid hard, which
                # is the whole aesthetic; bilinear when minifying, because
                # nearest turns fine detail into noise on the way down.
                flt = (Image.NEAREST if self.tw >= self.sw else Image.BILINEAR)
                im = im.resize((self.tw, self.th), flt)
            src = np.asarray(im)
        out = np.zeros((self.ch, self.cw, 4), np.uint8)
        # Intersect the placed rectangle with the canvas; a layer may hang off
        # any edge, and a negative offset must crop rather than wrap.
        dx0, dy0 = max(0, self.x0), max(0, self.y0)
        dx1 = min(self.cw, self.x0 + self.tw)
        dy1 = min(self.ch, self.y0 + self.th)
        if dx1 > dx0 and dy1 > dy0:
            out[dy0:dy1, dx0:dx1] = src[dy0 - self.y0:dy1 - self.y0,
                                        dx0 - self.x0:dx1 - self.x0]
        if self.n == 1:
            self._still = out
        return out


# ---------------------------------------------------------------------------
# Compositing
# ---------------------------------------------------------------------------

def canvas_size(entries):
    """The canvas is the bottom visible layer's own size, and the stack runs
    for as long as its longest layer. Choosing the bottom layer rather than,
    say, the union of all of them means adding a decorative layer can never
    silently resize the artwork you have already been printing."""
    cw, ch = int(entries[0][0]["w"]), int(entries[0][0]["h"])
    n = min(MAX_FRAMES, max(int(m.get("n") or 1) for m, _, _ in entries))
    fps = float(entries[0][0].get("fps") or 25)
    return cw, ch, n, fps


def composite(entries, progress=None, cancelled=None):
    """Composite bottom-to-top.

    `entries` is [(meta, cache_dir, spec)] for the visible layers, in stack
    order. Returns a Clip.

    The maths is the W3C compositing model, not a naive lerp: each layer is
    blended against the accumulated backdrop and then alpha-composited over
    it, so a Multiply layer over a transparent region stays transparent
    instead of turning it black -- which is exactly the bug a lerp produces,
    and it only shows up on the cut line, after the sticker is printed.
    """
    cw, ch, n, fps = canvas_size(entries)
    # Checked BEFORE the buffer is allocated, not by Clip afterwards: the
    # allocation is the thing that would be refused, and on this container an
    # over-budget np.zeros is not an exception, it is the OOM killer taking
    # the engine down and 502ing everyone with the studio open.
    if n * ch * cw > MAX_PIXELS:
        raise ClipTooBig(
            "%d frames at %dx%d is past the engine's memory budget. Shorten "
            "the longest layer, or work smaller." % (n, cw, ch))
    placed = [Placed(d, m, spec, cw, ch) for m, d, spec in entries]
    out = np.zeros((n, ch, cw, 4), np.uint8)

    for f in range(n):
        if cancelled and cancelled():
            raise ValueError("Cancelled.")
        cb = np.zeros((ch, cw, 3), np.float32)   # backdrop colour, unpremultiplied
        ab = np.zeros((ch, cw), np.float32)      # backdrop alpha
        for p in placed:
            fr = p.frame(f)
            a_s = fr[..., 3].astype(np.float32) / 255.0 * p.opacity
            if p.clip:
                a_s = a_s * ab
            if p.mode == "erase":
                ab = ab * (1.0 - a_s)
                continue
            if p.mode == "inside":
                ab = ab * a_s
                continue
            cs = fr[..., :3].astype(np.float32) / 255.0
            b = BLEND_FN.get(p.mode, BLEND_FN["normal"])(cb, cs)
            ao = a_s + ab * (1.0 - a_s)
            a_s3, ab3, ao3 = a_s[..., None], ab[..., None], ao[..., None]
            co = ((1 - ab3) * a_s3 * cs + ab3 * a_s3 * b + (1 - a_s3) * ab3 * cb)
            cb = np.where(ao3 > 0, co / np.maximum(ao3, 1e-6), 0.0)
            ab = ao
        out[f, ..., :3] = np.clip(cb * 255.0 + 0.5, 0, 255).astype(np.uint8)
        out[f, ..., 3] = np.clip(ab * 255.0 + 0.5, 0, 255).astype(np.uint8)
        if progress and n > 1:
            progress(0.1 + 0.85 * (f + 1) / n, "compositing frame %d of %d" % (f + 1, n))

    return Clip(out, fps)


def stack_notes(entries):
    """Remarks the studio shows above the artwork. These are the two mistakes
    that look like a broken render rather than a setting."""
    notes = []
    cw, ch = int(entries[0][0]["w"]), int(entries[0][0]["h"])
    for m, _, spec in entries[1:]:
        if spec["fit"] == "none" and (int(m["w"]) != cw or int(m["h"]) != ch):
            notes.append("A layer is %dx%d on a %dx%d canvas with Fit set to "
                         "None, so it does not cover it." % (m["w"], m["h"], cw, ch))
            break
    base = entries[0][2]
    if base["clip"] or base["blend"] in MATTE_MODES:
        # Both of these consume the alpha underneath, and underneath the bottom
        # layer there is nothing -- so the stack renders empty and looks like a
        # broken render rather than a setting. Say so.
        notes.append("The bottom layer is set to %s, which acts on the layers "
                     "below it — and there are none, so it renders empty."
                     % ("Clip to below" if base["clip"]
                        else dict(BLENDS)[base["blend"]]))
    return notes
