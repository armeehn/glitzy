"""Numpy workhorses shared across the op library.

Everything here is written to stay vectorised over the whole frame stack. The
rule that shapes this file: a per-pixel Python loop over a 48-frame 480x480
clip is 11 million iterations and turns a slider drag into a coffee break, so
where an algorithm is sequential the loop runs over the SHORT axis (a radius,
a scan line) with numpy doing the wide axes underneath.
"""

import numpy as np
from PIL import Image


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------

# The four corner gathers below each materialise a full float32 copy of the
# source, and the integer index arrays cost another 8 bytes per pixel apiece.
# Done over a whole clip at once that peaks near 220 bytes for every 4 bytes of
# actual picture -- so an ordinary 480x480x48 clip wanted ~2.4 GB and the
# cgroup SIGKILLed the engine mid-render, which reaches the browser as a 502
# rather than as an error the studio can show. Frames are independent here, so
# the fix is to sample a block at a time and keep peak memory flat in n.
SAMPLE_BLOCK_BYTES = 48 << 20


def sample_bilinear(src, x, y, wrap=True):
    """Sample src at floating (x, y) per pixel.

    src is (n,h,w) or (n,h,w,c); x and y are (n,h,w) in pixel coordinates.
    This is the engine behind every warp, displace and slit-scan op.

    Pass src as uint8 where you have it: the upcast happens per block on the
    gathered corners, so the caller never has to hold a float32 copy of the
    whole stack just to get here.
    """
    n, h, w = src.shape[:3]
    tail = src.shape[3:]
    # x and y are usually already (n,h,w); broadcasting makes a partial grid
    # (a single frame's worth, say) sliceable without copying it.
    x = np.broadcast_to(x, (n, h, w))
    y = np.broadcast_to(y, (n, h, w))
    out = np.empty((n, h, w) + tail, np.float32)

    chan = int(np.prod(tail)) if tail else 1
    # Per frame: 4 gathers + 2 lerps + their temporaries at 4 bytes a channel,
    # plus fx/fy and four int64 index planes. Ten-ish full planes, so budget
    # for twelve and let the block count fall out of it.
    per_frame = h * w * (chan * 4 * 8 + 4 * 8)
    step = max(1, min(n, SAMPLE_BLOCK_BYTES // max(per_frame, 1)))

    for s in range(0, n, step):
        e = min(n, s + step)
        xb, yb = x[s:e], y[s:e]
        x0 = np.floor(xb).astype(np.int64)
        y0 = np.floor(yb).astype(np.int64)
        fx = (xb - x0).astype(np.float32)
        fy = (yb - y0).astype(np.float32)
        x1, y1 = x0 + 1, y0 + 1
        if wrap:
            x0 %= w; x1 %= w; y0 %= h; y1 %= h
        else:
            x0 = np.clip(x0, 0, w - 1); x1 = np.clip(x1, 0, w - 1)
            y0 = np.clip(y0, 0, h - 1); y1 = np.clip(y1, 0, h - 1)
        # Absolute frame indices: the gather still reads the untouched src.
        fi = np.arange(s, e)[:, None, None]
        if src.ndim == 4:
            fx = fx[..., None]; fy = fy[..., None]
        # uint8 corners must be upcast before the lerp or the subtraction
        # wraps around; float32 input passes straight through as a view.
        a = src[fi, y0, x0].astype(np.float32, copy=False)
        b = src[fi, y0, x1].astype(np.float32, copy=False)
        c = src[fi, y1, x0].astype(np.float32, copy=False)
        d = src[fi, y1, x1].astype(np.float32, copy=False)
        top = a + (b - a) * fx
        bot = c + (d - c) * fx
        out[s:e] = top + (bot - top) * fy
    return out


def grid(n, h, w):
    """(xs, ys) pixel-coordinate grids broadcast over n frames."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    return (np.broadcast_to(xs, (n, h, w)).copy(),
            np.broadcast_to(ys, (n, h, w)).copy())


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

def box_blur(a, r):
    """Separable box blur via cumulative sums: cost is independent of radius."""
    r = int(r)
    if r < 1:
        return a
    out = a.astype(np.float32)
    for axis in (1, 2):  # y then x, leaving the frame axis alone
        out = _box1d(out, r, axis)
    return out


def _box1d(a, r, axis):
    n = a.shape[axis]
    r = min(r, max(1, n - 1))
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float32)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return (hi - lo) / (2 * r + 1)


def unsharp(a, r, amount):
    return np.clip(a + (a - box_blur(a, r)) * amount, 0, 1)


# ---------------------------------------------------------------------------
# Distance
# ---------------------------------------------------------------------------

def dist_outside(mask, radius):
    """Distance from each pixel to the nearest True pixel of `mask`, clamped
    at `radius`. Separable min-plus in two bounded sweeps.

    Bounded on purpose. An unbounded exact transform means a sweep the full
    width of the frame; a die-cut border is never more than a few dozen
    pixels, so the radius caps the work at (2r+1) vectorised passes instead.
    """
    r = max(0, int(radius))
    big = np.float32((r + 1) ** 2)
    if r == 0:
        return np.where(mask, 0.0, 1.0).astype(np.float32)
    d0 = np.where(mask, 0.0, big).astype(np.float32)

    # sweep down the y axis: nearest True in the same column
    g = d0.copy()
    for dy in range(1, r + 1):
        q = np.float32(dy * dy)
        shifted_up = np.empty_like(d0)
        shifted_up[:, :-dy] = d0[:, dy:]
        shifted_up[:, -dy:] = big
        shifted_dn = np.empty_like(d0)
        shifted_dn[:, dy:] = d0[:, :-dy]
        shifted_dn[:, :dy] = big
        np.minimum(g, np.minimum(shifted_up, shifted_dn) + q, out=g)

    # then across x, adding the squared horizontal offset
    out = g.copy()
    for dx in range(1, r + 1):
        q = np.float32(dx * dx)
        left = np.empty_like(g)
        left[:, :, :-dx] = g[:, :, dx:]
        left[:, :, -dx:] = big
        right = np.empty_like(g)
        right[:, :, dx:] = g[:, :, :-dx]
        right[:, :, :dx] = big
        np.minimum(out, np.minimum(left, right) + q, out=out)

    return np.minimum(np.sqrt(out), r).astype(np.float32)


def despeckle(mask, min_frac=0.0015):
    """Drop connected specks smaller than a fraction of the frame.

    A cutter follows every contour it is given, so a hundred stray islands
    become a hundred pointless blade moves and a sticker that falls apart.
    """
    n, h, w = mask.shape
    out = mask.copy()
    min_px = max(4, int(h * w * min_frac))
    for i in range(n):
        out[i] = _largest_components(mask[i], min_px)
    return out


def _largest_components(m, min_px):
    """Flood fill with an explicit stack: recursion would blow the stack on a
    frame-filling region long before it finished."""
    h, w = m.shape
    seen = np.zeros((h, w), np.uint8)
    keep = np.zeros((h, w), bool)
    ys, xs = np.nonzero(m)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = 1
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = 1
                    stack.append((ny, nx))
        if len(comp) >= min_px:
            idx = np.array(comp)
            keep[idx[:, 0], idx[:, 1]] = True
    return keep


# ---------------------------------------------------------------------------
# Noise
# ---------------------------------------------------------------------------

def fbm(rng, n, h, w, freq=4, octaves=3, loop=True):
    """Fractal value noise over a frame stack, seamless in time when looping.

    Built by upsampling small random cubes rather than evaluating a gradient
    noise per pixel: same look, and it stays inside numpy.
    """
    out = np.zeros((n, h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(max(1, int(octaves))):
        f = max(2, int(freq * (2 ** o)))
        ft = max(2, min(n, int(4 * (2 ** o)))) if n > 1 else 1
        cube = rng.random((ft, min(f, h), min(f, w))).astype(np.float32)
        out += amp * _upsample(cube, n, h, w, loop)
        total += amp
        amp *= 0.5
    # Bicubic upsampling overshoots past the corners of the random cube, so the
    # sum can land slightly outside 0..1. Callers treat this as a normalised
    # field and index palettes with it, so clamp rather than leak the overshoot.
    return np.clip(out / max(total, 1e-6), 0.0, 1.0)


def _upsample(cube, n, h, w, loop=True):
    ft = cube.shape[0]
    spatial = np.empty((ft, h, w), np.float32)
    for i in range(ft):
        spatial[i] = np.asarray(
            Image.fromarray(cube[i], "F").resize((w, h), Image.BICUBIC))
    if n == 1 or ft == 1:
        return np.broadcast_to(spatial[0], (n, h, w)).copy()
    if loop:
        t = np.linspace(0, ft, n, endpoint=False, dtype=np.float32)
        i0 = np.floor(t).astype(np.int64) % ft
        i1 = (i0 + 1) % ft
    else:
        t = np.linspace(0, ft - 1, n, dtype=np.float32)
        i0 = np.clip(np.floor(t).astype(np.int64), 0, ft - 1)
        i1 = np.clip(i0 + 1, 0, ft - 1)
    f = (t - np.floor(t))[:, None, None]
    return spatial[i0] * (1 - f) + spatial[i1] * f


# ---------------------------------------------------------------------------
# Dither
# ---------------------------------------------------------------------------

def bayer(size=8):
    """Normalised ordered-dither threshold matrix, 0..1."""
    m = np.array([[0, 2], [3, 1]], np.float32)
    while m.shape[0] < size:
        m = np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
    return m / m.size


def tile_to(m, h, w):
    return np.tile(m, (h // m.shape[0] + 1, w // m.shape[1] + 1))[:h, :w]
