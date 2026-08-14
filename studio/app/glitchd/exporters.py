"""Everything that leaves the studio.

The cutsheet/1 sheet is the contract that matters: cutsheet opens these files
with its own loader and needed no changes to accept them, so the shape of this
payload is fixed by another program and is not ours to improve.
"""

import base64
import io
import json
import math
import os
import time
import zipfile

import numpy as np
from PIL import Image

from . import store
from .clip import Clip

MM_PER_IN = 25.4

# Mirrors cutsheet's own presets so a sheet opens with the right defaults.
MACHINES = {
    "generic": {"bleed": 3.175, "margin": 6.35, "marks": "crop"},
    "cricut": {"bleed": 1.5875, "margin": 12.7, "marks": "cricut"},
    "silhouette": {"bleed": 1.5875, "margin": 12.7, "marks": "silhouette"},
    "roland": {"bleed": 3.175, "margin": 9.525, "marks": "crop"},
}


def print_scale(width_px, mm, dpi):
    """Integer upscale factor for print.

    Rounds UP, never down: a 640 px render against an 898 px target rounds to
    1x and silently prints below the DPI that was asked for. Nearest-neighbour
    at 2x costs only file size, and rounding down costs the job.
    """
    target = mm / MM_PER_IN * dpi
    return max(1, math.ceil(target / max(width_px, 1)))


def frame_image(h, n=0):
    p = store.cache_path(h, "f_%05d.png" % n)
    if not os.path.isfile(p):
        raise ValueError("That frame is no longer cached — re-run the chain.")
    return Image.open(p).convert("RGBA")


def upscale(im, factor):
    """Nearest-neighbour, always. Bicubic is what destroys the block edges the
    whole aesthetic is built on."""
    if factor <= 1:
        return im
    return im.resize((im.width * factor, im.height * factor), Image.NEAREST)


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def export_png(h, frame=0, mm=76, dpi=300, raw=False):
    im = frame_image(h, frame)
    if not raw:
        im = upscale(im, print_scale(im.width, mm, dpi))
    return png_bytes(im), "image/png", "glitchsheet-%s-f%d.png" % (h[:8], frame)


def _all_frames(h):
    meta = store.cache_meta(h) or {}
    return [frame_image(h, i) for i in range(int(meta.get("n", 1)))]


def export_sequence(h, mm=76, dpi=300, raw=True):
    ims = _all_frames(h)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, im in enumerate(ims):
            if not raw:
                im = upscale(im, print_scale(im.width, mm, dpi))
            z.writestr("f_%05d.png" % i, png_bytes(im))
    return buf.getvalue(), "application/zip", "glitchsheet-%s-frames.zip" % h[:8]


def export_animation(h, kind="apng", fps=None):
    """APNG keeps the alpha; GIF keeps the file small. Both loop forever."""
    ims = _all_frames(h)
    meta = store.cache_meta(h) or {}
    rate = fps or meta.get("fps") or 25
    delay = max(20, int(round(1000.0 / max(rate, 1))))
    buf = io.BytesIO()
    if kind == "gif":
        pal = [im.convert("RGB").quantize(colors=255, method=Image.MEDIANCUT)
               for im in ims]
        pal[0].save(buf, "GIF", save_all=True, append_images=pal[1:],
                    duration=delay, loop=0, disposal=2, optimize=True)
        return buf.getvalue(), "image/gif", "glitchsheet-%s.gif" % h[:8]
    ims[0].save(buf, "PNG", save_all=True, append_images=ims[1:],
                duration=delay, loop=0, default_image=False)
    return buf.getvalue(), "image/apng", "glitchsheet-%s.png" % h[:8]


# ---------------------------------------------------------------------------
# The sheet
# ---------------------------------------------------------------------------

def _cut_for(im, radius_mm=0.0, tolerance=0.12):
    """Cut settings that match what is actually baked into the artwork.

    A silhouette and its die-cut border live in the alpha, so the blade should
    follow the alpha at offset 0. Adding an offset here would double-count and
    cut a second line outside the border. Only a fully opaque rectangle -- no
    matte anywhere in the chain -- gets a box cut with a real bleed offset.
    """
    a = np.asarray(im)[..., 3]
    if a.min() >= 250:
        return {"mode": "box", "offset": 3.175, "radius": radius_mm,
                "key": "alpha", "tolerance": tolerance, "minArea": 0.4,
                "smooth": 0.5}
    return {"mode": "contour", "offset": 0, "radius": 0, "key": "alpha",
            "tolerance": tolerance, "minArea": 1.5, "smooth": 0.5}


def export_sheet(items, machine="generic", dpi=300, name=None):
    """Pack kept designs onto a letter sheet as a cutsheet/1 project."""
    prof = MACHINES.get(machine) or MACHINES["generic"]
    page = {"w": 8.5 * MM_PER_IN, "h": 11 * MM_PER_IN}
    gutter = 3.0
    x, y, row_h = prof["margin"], prof["margin"], 0.0
    images, docitems = [], []
    overflow = 0

    for i, it in enumerate(items):
        h = it.get("hash") or ""
        if not store.cached(h):
            continue
        frame = int(it.get("frame", 0))
        mm = float(it.get("mm", 76))
        im = frame_image(h, frame)
        im = upscale(im, print_scale(im.width, mm, dpi))
        w_mm = mm
        h_mm = mm * (im.height / max(im.width, 1))

        if x + w_mm > page["w"] - prof["margin"]:
            x = prof["margin"]
            y += row_h + gutter
            row_h = 0.0
        if y + h_mm > page["h"] - prof["margin"]:
            overflow = len(items) - i
            break
        row_h = max(row_h, h_mm)

        img_id = "im%d" % (i + 1)
        images.append({
            "id": img_id, "name": "glitch-%d.png" % (i + 1),
            "width": im.width, "height": im.height, "hasAlpha": True,
            "type": "image/png",
            "dataUrl": "data:image/png;base64," +
                       base64.b64encode(png_bytes(im)).decode(),
        })
        docitems.append({
            "id": "it%d" % (i + 1), "imageId": img_id,
            "name": it.get("name") or ("sticker %d" % (i + 1)),
            "cx": round(x + w_mm / 2, 3), "cy": round(y + h_mm / 2, 3),
            "w": round(w_mm, 3), "h": round(h_mm, 3), "rot": 0,
            "flipH": False, "flipV": False, "opacity": 1,
            "locked": False, "visible": True,
            "cut": _cut_for(im, radius_mm=float(it.get("radius_mm", 0))),
            "contour": None, "contourKey": None,
        })
        x += w_mm + gutter

    if not docitems:
        raise ValueError("Nothing on the sheet — keep a design first.")

    doc = {
        "name": name or ("Glitchsheet " + time.strftime("%Y-%m-%d")),
        "unit": "in",
        "page": {"preset": "letter", "w": page["w"], "h": page["h"],
                 "orientation": "portrait"},
        "bleed": prof["bleed"],
        "margins": {"t": prof["margin"], "r": prof["margin"],
                    "b": prof["margin"], "l": prof["margin"], "linked": True},
        "machine": machine,
        "marks": {"style": prof["marks"], "size": 6.35, "offset": 2, "weight": 0.25},
        "exportOpts": {"dpi": dpi, "background": "#ffffff",
                       "includeArtInSvg": True, "jpegQuality": 0.94},
        "items": docitems,
    }
    payload = {"format": "cutsheet/1",
               "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
               "doc": doc, "images": images}
    body = json.dumps(payload, indent=1).encode()
    return (body, "application/json",
            "glitchsheet-%d.cutsheet.json" % int(time.time()), overflow)


def contact_sheet(hashes, cols=4, cell=220):
    """A quick grid of several results, for eyeballing a sweep."""
    ims = []
    for h in hashes:
        try:
            im = frame_image(h, 0)
        except ValueError:
            continue
        im.thumbnail((cell, cell), Image.NEAREST)
        ims.append(im)
    if not ims:
        raise ValueError("Nothing to show.")
    rows = math.ceil(len(ims) / cols)
    out = Image.new("RGBA", (cols * cell, rows * cell), (29, 26, 23, 255))
    for i, im in enumerate(ims):
        ox = (i % cols) * cell + (cell - im.width) // 2
        oy = (i // cols) * cell + (cell - im.height) // 2
        out.paste(im, (ox, oy), im)
    return png_bytes(out), "image/png", "glitchsheet-contact.png"
