"""Colourways, shared by the generators and the colour ops.

These live on the backend now. In v1 recolouring happened in the browser
because a colourway had to be instant while a re-cook was not; with the
content-addressed cache a colour change is one cheap node on top of a cached
chain, so the browser no longer needs its own copy of the palette logic.
"""

import numpy as np

PALETTES = [
    {"id": "as-is", "label": "As cooked", "colours": []},
    {"id": "riposte", "label": "Riposte", "colours": ["#1D1A17", "#F6F1E7", "#F0477D", "#12B795", "#FE9A0D"]},
    {"id": "acid", "label": "Acid", "colours": ["#0B0F00", "#EFFF3C", "#00FF85", "#FF00A8", "#FFFFFF"]},
    {"id": "neon", "label": "Neon night", "colours": ["#0A0118", "#7A00FF", "#00E5FF", "#FF2E7E", "#FFF200"]},
    {"id": "mono", "label": "Mono", "colours": ["#111111", "#4A4A4A", "#8C8C8C", "#D2D2D2", "#FFFFFF"]},
    {"id": "sunset", "label": "Sunset", "colours": ["#2B1055", "#7597DE", "#FF8C42", "#FF3C38", "#FFF3B0"]},
    {"id": "cyber", "label": "Cyber", "colours": ["#04060F", "#0FF4C6", "#146FF8", "#F5F5F5", "#FF206E"]},
    {"id": "pastel", "label": "Pastel", "colours": ["#2F3E46", "#FFD6E0", "#C1FBA4", "#A0E7E5", "#FFF5BA"]},
    {"id": "cmyk", "label": "Process", "colours": ["#000000", "#00AEEF", "#EC008C", "#FFF200", "#FFFFFF"]},
    {"id": "rust", "label": "Rust", "colours": ["#1A0F0A", "#5C2E11", "#B8551E", "#E8A33D", "#F2E8D5"]},
    {"id": "vhs", "label": "VHS", "colours": ["#0D0221", "#261447", "#FF3864", "#2DE2E6", "#F6F740"]},
]

PALETTE_IDS = [p["id"] for p in PALETTES]
BY_ID = {p["id"]: p for p in PALETTES}

MODES = ["quantise", "duotone", "tint", "gradient_map"]


def hex_rgb(h):
    h = (h or "#000000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        n = int(h, 16)
    except ValueError:
        return (0, 0, 0)
    return ((n >> 16) & 255, (n >> 8) & 255, n & 255)


def hex_f(h):
    r, g, b = hex_rgb(h)
    return np.array([r, g, b], np.float32) / 255.0


def colours_of(pid):
    """Palette colours as a float32 (k,3) array in 0..1, or None for as-is."""
    p = BY_ID.get(pid)
    if not p or not p["colours"]:
        return None
    return np.stack([hex_f(c) for c in p["colours"]])


LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def luma(rgb):
    """Perceptual luminance of a float 0..1 RGB array, keeping leading axes."""
    return rgb @ LUMA


def ramp(cols, t):
    """Sample a palette as a continuous gradient. t is any shape, 0..1."""
    k = len(cols)
    if k == 1:
        return np.broadcast_to(cols[0], t.shape + (3,)).copy()
    x = np.clip(t, 0, 1) * (k - 1)
    i0 = np.floor(x).astype(np.int32)
    i0 = np.clip(i0, 0, k - 2)
    f = (x - i0)[..., None]
    return cols[i0] * (1 - f) + cols[i0 + 1] * f


def quantise(rgb, cols):
    """Snap each pixel to its nearest palette colour.

    Posterises into flat plates, which is what makes a glitch read as a
    printed sticker rather than a video still. Done as one broadcast against
    all k colours -- a per-pixel Python loop over a 60-frame clip is minutes.
    """
    flat = rgb.reshape(-1, 3)
    # (px, k) squared distance, chunked so a big clip does not allocate
    # px * k * 3 floats in one go.
    out = np.empty(flat.shape[0], np.int32)
    step = 1 << 20
    for i in range(0, flat.shape[0], step):
        chunk = flat[i:i + step]
        d = ((chunk[:, None, :] - cols[None, :, :]) ** 2).sum(2)
        out[i:i + step] = d.argmin(1)
    return cols[out].reshape(rgb.shape)
