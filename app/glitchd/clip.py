"""Clip -- the single data type that flows through a chain.

A Clip is N frames of RGBA uint8, shape (n, h, w, 4), plus a frame rate.
A still is just a Clip with n == 1, and that is the whole trick: an op
written for a still works unchanged on a 60-frame glitch sequence, so the
op library does not split into "image effects" and "video effects".

On disk a Clip is a directory of PNGs plus a meta.json. That one choice does
three jobs: it is lossless, it is far smaller than raw .npy on a 20 GB
rootfs, and the HTTP layer can serve a frame straight off disk without
re-encoding it -- which is why scrubbing the timeline costs nothing.
"""

import io
import json
import os

import numpy as np
from PIL import Image

# A clip is held in RAM as uint8 RGBA. 2 GB of container with the engine
# capped below that means a hard ceiling on total pixels: 480x480x48 is
# ~44 MB, 1200x1200x48 would be ~276 MB. Refuse anything past the budget
# rather than inviting the OOM killer to take the service down mid-cook.
MAX_PIXELS = 220_000_000  # n * w * h, ~880 MB of RGBA at the limit
THUMB_W = 200


class ClipTooBig(Exception):
    pass


class Clip:
    __slots__ = ("frames", "fps")

    def __init__(self, frames, fps=25):
        a = np.asarray(frames)
        if a.ndim == 3:  # a bare still, promote it
            a = a[None, ...]
        if a.ndim != 4 or a.shape[3] not in (3, 4):
            raise ValueError("frames must be (n,h,w,3|4), got %r" % (a.shape,))
        if a.shape[3] == 3:
            a = np.concatenate(
                [a, np.full(a.shape[:3] + (1,), 255, np.uint8)], axis=3)
        if a.dtype != np.uint8:
            a = np.clip(a, 0, 255).astype(np.uint8)
        n, h, w = a.shape[:3]
        if n * h * w > MAX_PIXELS:
            raise ClipTooBig(
                "%d frames at %dx%d is past the engine's memory budget. "
                "Drop the frame count or the working size." % (n, w, h))
        self.frames = a
        self.fps = float(fps) or 25.0

    # -- shape ------------------------------------------------------------
    @property
    def n(self):
        return self.frames.shape[0]

    @property
    def h(self):
        return self.frames.shape[1]

    @property
    def w(self):
        return self.frames.shape[2]

    @property
    def is_still(self):
        return self.frames.shape[0] == 1

    def __repr__(self):
        return "<Clip %dx%d n=%d @%gfps>" % (self.w, self.h, self.n, self.fps)

    def like(self, frames):
        """A new Clip carrying this one's frame rate."""
        return Clip(frames, self.fps)

    def rgb(self):
        """Colour channels as float32 0..1, alpha left behind."""
        return self.frames[..., :3].astype(np.float32) / 255.0

    def alpha(self):
        return self.frames[..., 3].astype(np.float32) / 255.0

    def with_rgb(self, rgb):
        """Rebuild from float 0..1 colour, keeping the existing alpha."""
        out = np.empty_like(self.frames)
        out[..., :3] = np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8)
        out[..., 3] = self.frames[..., 3]
        return self.like(out)

    def with_alpha(self, a):
        """Rebuild from float 0..1 alpha, keeping the existing colour."""
        out = self.frames.copy()
        out[..., 3] = np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)
        return self.like(out)

    # -- disk -------------------------------------------------------------
    def save(self, d, thumbs=True):
        os.makedirs(d, exist_ok=True)
        for i in range(self.n):
            Image.fromarray(self.frames[i], "RGBA").save(
                os.path.join(d, "f_%05d.png" % i), optimize=False,
                compress_level=1)  # level 1: the cache is scratch, not an archive
        if thumbs:
            self._write_thumbs(d)
        meta = {"n": self.n, "w": self.w, "h": self.h, "fps": self.fps}
        with open(os.path.join(d, "meta.json"), "w") as fh:
            json.dump(meta, fh)
        return meta

    def _write_thumbs(self, d):
        tw = min(THUMB_W, self.w)
        th = max(1, round(self.h * tw / self.w))
        for i in range(self.n):
            im = Image.fromarray(self.frames[i], "RGBA").resize(
                (tw, th), Image.BILINEAR)
            # Thumbs are JPEG for size, so alpha has to land on something.
            # Checker it, or every cut-out reads as a solid black square in
            # the filmstrip and you cannot tell your mattes apart.
            bg = _checker(tw, th)
            bg.paste(im, (0, 0), im)
            bg.convert("RGB").save(os.path.join(d, "t_%05d.jpg" % i), quality=72)

    @staticmethod
    def load(d):
        with open(os.path.join(d, "meta.json")) as fh:
            meta = json.load(fh)
        n = meta["n"]
        frames = np.empty((n, meta["h"], meta["w"], 4), np.uint8)
        for i in range(n):
            with Image.open(os.path.join(d, "f_%05d.png" % i)) as im:
                frames[i] = np.asarray(im.convert("RGBA"))
        return Clip(frames, meta.get("fps", 25))

    @staticmethod
    def from_files(paths, fps=25):
        ims = []
        for p in paths:
            with Image.open(p) as im:
                ims.append(np.asarray(im.convert("RGBA")))
        if not ims:
            raise ValueError("no frames")
        h = min(a.shape[0] for a in ims)
        w = min(a.shape[1] for a in ims)
        ims = [a[:h, :w] for a in ims]  # a decoder can emit one odd last frame
        return Clip(np.stack(ims), fps)

    @staticmethod
    def solid(w, h, rgba=(0, 0, 0, 255), n=1, fps=25):
        a = np.empty((n, h, w, 4), np.uint8)
        a[:] = np.array(rgba, np.uint8)
        return Clip(a, fps)

    def png_bytes(self, i=0):
        buf = io.BytesIO()
        Image.fromarray(self.frames[i % self.n], "RGBA").save(buf, "PNG")
        return buf.getvalue()


def _checker(w, h, size=8, a=(58, 52, 46), b=(42, 38, 34)):
    im = Image.new("RGB", (w, h), a)
    px = im.load()
    for y in range(h):
        for x in range(w):
            if ((x // size) + (y // size)) & 1:
                px[x, y] = b
    return im


def resize_frames(frames, w, h, smooth=True):
    """Resample a frame stack. Nearest by default for the blocky work, since
    bicubic is what destroys macroblock edges -- the whole point of the
    aesthetic is that the block grid stays hard."""
    n = frames.shape[0]
    out = np.empty((n, h, w, 4), np.uint8)
    flt = Image.BILINEAR if smooth else Image.NEAREST
    for i in range(n):
        out[i] = np.asarray(
            Image.fromarray(frames[i], "RGBA").resize((w, h), flt))
    return out
