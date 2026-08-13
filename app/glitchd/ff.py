"""The ffglitch bridge: encode a Clip to MPEG-2, run ffedit over it, decode back.

ffgac is ffmpeg with the glitch patches, so it is also the only decoder here --
there is no separate ffmpeg installed and none is needed.

Two rules in this file are load-bearing and were both paid for in debugging time:

  * `run(full=True)` when you intend to PARSE the output. ffgac prints the
    stream and duration lines near the TOP; a tail-only read reports every
    video as a 0x0 still.
  * encode dimensions are padded to a multiple of 16. An unaligned frame makes
    the macroblock grid stop meeting the frame edge, and the block edges are
    the entire aesthetic.
"""

import hashlib
import os
import re
import subprocess

import numpy as np
from PIL import Image

FFGAC = os.environ.get("GLITCHSHEET_FFGAC", "/opt/ffglitch/bin/ffgac")
FFEDIT = os.environ.get("GLITCHSHEET_FFEDIT", "/opt/ffglitch/bin/ffedit")
RACK_DIR = os.environ.get("GLITCHSHEET_RACK", "/opt/glitchsheet2/rack")


class FFError(Exception):
    pass


def run(cmd, timeout=900, full=False):
    """Run a command, returning (rc, stderr). Never raises on a non-zero exit.

    Pass full=True whenever the output is going to be parsed rather than just
    shown to a human -- see the module docstring.
    """
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError as e:
        return 127, "missing binary: %s" % (e,)
    except subprocess.TimeoutExpired:
        return 124, "timed out after %ds" % timeout
    err = (p.stderr or b"").decode("utf-8", "replace")
    if full:
        return p.returncode, err
    return p.returncode, "\n".join(
        [l for l in err.splitlines() if l.strip()][-8:])


def even16(n):
    n = int(n)
    return max(16, ((n + 15) // 16) * 16)


def sha1_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Clip <-> bitstream
# ---------------------------------------------------------------------------

def encode(clip, workdir, mpg_path, gop="max"):
    """Write a Clip out as an MPEG-2 elementary stream ffedit can chew on.

    The flags are what make the stream *worth* glitching: +forcemv writes a
    motion vector for every macroblock even where the encoder would rather not,
    +nopimb keeps intra blocks out of P frames, and one enormous GOP with
    scene-change detection disabled means a single I frame at the top and
    hundreds of predicted frames after it -- so damage propagates forward
    instead of being scrubbed clean a few frames later.
    """
    fdir = os.path.join(workdir, "enc")
    os.makedirs(fdir, exist_ok=True)
    pw, ph = even16(clip.w), even16(clip.h)
    pad = (pw != clip.w or ph != clip.h)
    for i in range(clip.n):
        a = clip.frames[i]
        if pad:
            # Replicate the edge into the pad rather than filling black: a hard
            # black border becomes a row of high-contrast blocks that the
            # glitch then smears back into the picture.
            a = np.pad(a, ((0, ph - clip.h), (0, pw - clip.w), (0, 0)), mode="edge")
        Image.fromarray(a[..., :3], "RGB").save(
            os.path.join(fdir, "f_%05d.png" % i), compress_level=1)

    cmd = [FFGAC, "-hide_banner", "-framerate", "%g" % clip.fps,
           "-i", os.path.join(fdir, "f_%05d.png"),
           "-an", "-vcodec", "mpeg2video",
           "-mpv_flags", "+nopimb+forcemv",
           "-qscale:v", "1", "-g", str(gop), "-sc_threshold", "max",
           "-f", "rawvideo", "-y", mpg_path]
    rc, err = run(cmd)
    if rc != 0 or not os.path.exists(mpg_path) or os.path.getsize(mpg_path) == 0:
        raise FFError("Could not build a glitchable bitstream.\n" + err)
    return {"w": pw, "h": ph, "pad": pad}


def decode(mpg_path, workdir, want_w=None, want_h=None, fps=25):
    """Decode a bitstream back to a Clip, cropping off any encode padding."""
    from .clip import Clip
    fdir = os.path.join(workdir, "dec")
    os.makedirs(fdir, exist_ok=True)
    for f in os.listdir(fdir):
        os.unlink(os.path.join(fdir, f))
    rc, err = run([FFGAC, "-hide_banner", "-i", mpg_path, "-vsync", "0",
                   "-f", "image2", os.path.join(fdir, "f_%05d.png")])
    names = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
    names = [f for f in names if os.path.getsize(os.path.join(fdir, f)) > 0]
    if not names:
        raise FFError("No frame survived decoding.\n" + err)
    clip = Clip.from_files([os.path.join(fdir, f) for f in names], fps)
    if want_w and want_h and (clip.w != want_w or clip.h != want_h):
        clip = clip.like(clip.frames[:, :want_h, :want_w])
    return clip


def ffedit(in_mpg, out_mpg, feature, script, params, timeout=900):
    """One ffedit pass.

    Every value in `params` must be an integer: ffedit's -sp JSON parser
    rejects floating point outright and then writes no output file at all,
    which reads like a crash. Fractions travel percent-scaled and are divided
    inside the qjs script.
    """
    import json
    clean = {}
    for k, v in (params or {}).items():
        if isinstance(v, bool):
            clean[k] = 1 if v else 0
        elif isinstance(v, (int, float)):
            clean[k] = int(round(v))
        else:
            continue
    sp = json.dumps(clean, separators=(",", ":"))
    rc, err = run([FFEDIT, "-i", in_mpg, "-f", feature, "-threads", "1",
                   "-s", os.path.join(RACK_DIR, script), "-sp", sp,
                   "-o", out_mpg, "-y"], timeout=timeout)
    if rc != 0 or not os.path.exists(out_mpg) or os.path.getsize(out_mpg) == 0:
        raise FFError("ffedit failed on %s.\n%s" % (feature, err))
    return err


# Chained passes print these, and BOTH are benign. A smeared stream is still
# structurally valid, so the decoder conceals what it cannot predict, and a
# coarser quantiser genuinely spends fewer bits. Treating either as failure
# means rejecting exactly the output the user asked for.
BENIGN = re.compile(r"MVs not available|concealing \d+ (DC|AC|MV) errors")


def probe(path):
    """Size and duration of a media file, or None if ffgac cannot decode it."""
    rc, err = run([FFGAC, "-hide_banner", "-i", path, "-frames:v", "1",
                   "-f", "null", "-"], timeout=180, full=True)
    if rc != 0:
        return None
    out = {"width": 0, "height": 0, "duration": 0.0, "fps": 0.0}
    m = re.search(r"Video:.*?,\s*(\d{2,5})x(\d{2,5})", err)
    if m:
        out["width"], out["height"] = int(m.group(1)), int(m.group(2))
    d = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", err)
    if d:
        out["duration"] = (int(d.group(1)) * 3600 + int(d.group(2)) * 60
                           + float(d.group(3)))
    f = re.search(r"(\d+(?:\.\d+)?)\s*fps", err)
    if f:
        out["fps"] = float(f.group(1))
    return out


def extract(path, workdir, n, fps, w, h, start=0.0, fit="cover"):
    """Pull n frames out of a still or a clip at the working size."""
    from .clip import Clip
    fdir = os.path.join(workdir, "src")
    os.makedirs(fdir, exist_ok=True)
    for f in os.listdir(fdir):
        os.unlink(os.path.join(fdir, f))
    if fit == "cover":
        vf = ("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d"
              % (w, h, w, h))
    elif fit == "contain":
        vf = ("scale=%d:%d:force_original_aspect_ratio=decrease,"
              "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black" % (w, h, w, h))
    else:
        vf = "scale=%d:%d" % (w, h)
    pre = ["-ss", "%g" % start] if start > 0 else []
    rc, err = run([FFGAC, "-hide_banner"] + pre + ["-i", path,
                  "-frames:v", str(n), "-r", "%g" % fps, "-vf", vf,
                  "-vsync", "0", "-f", "image2",
                  os.path.join(fdir, "f_%05d.png")])
    names = sorted(f for f in os.listdir(fdir) if f.endswith(".png"))
    if not names:
        raise FFError("Could not read any frame from that source.\n" + err)
    return Clip.from_files([os.path.join(fdir, f) for f in names], fps)
