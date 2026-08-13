"""Codec ops -- damage done inside the MPEG-2 bitstream by ffedit.

These are the ops that make this Glitchsheet rather than a filter box. A pixel
op paints over a picture; a codec op lies to the decoder about how to
RECONSTRUCT the picture, and the decoder's attempt to obey is the artwork.

Two behaviours here matter more than the effects themselves:

  * consecutive codec ops pass the bitstream directly to each other. Decoding
    to PNG and re-encoding between passes would heal the damage the previous
    pass just did, and the stack would look like one effect.
  * alpha is carried around the round trip. MPEG-2 has no alpha channel, so a
    matte placed before a codec op would otherwise be silently filled in.
"""

import os

import numpy as np

from .. import ff
from . import flag, num, op, seed


def _run(script, feature, clip, p, ctx):
    work = ctx.workdir
    in_mpg = ctx.upstream_mpg
    if not in_mpg or not os.path.isfile(in_mpg):
        ctx.progress(0.1, "encoding a glitchable bitstream")
        ff.encode(clip, work, os.path.join(work, "in.mpg"))
        in_mpg = os.path.join(work, "in.mpg")

    if clip.n == 1 and feature == "mv":
        ctx.note("This ran on a single frame, so there were no motion vectors "
                 "to abuse. Add Time ▸ Drift before it to give it movement.")

    out_mpg = os.path.join(ctx.out_dir, "out.mpg")
    ctx.progress(0.4, "rewriting %s" % feature)
    params = {k: v for k, v in p.items() if k != "keep_alpha"}
    ff.ffedit(in_mpg, out_mpg, feature, script, params)

    if (os.path.getsize(out_mpg) == os.path.getsize(in_mpg)
            and ff.sha1_file(out_mpg) == ff.sha1_file(in_mpg)):
        # ffedit exits 0 and writes a perfectly good file when a script
        # touches nothing, so a silent no-op looks exactly like success.
        ctx.note("This pass changed nothing — the stream carried no %s data to "
                 "edit. Try a different grain, or an effect on another feature."
                 % feature)

    ctx.progress(0.7, "decoding the wreckage")
    out = ff.decode(out_mpg, work, clip.w, clip.h, clip.fps)
    ctx.emitted_mpg = out_mpg

    if p.get("keep_alpha", True) and (clip.frames[..., 3] != 255).any():
        a = clip.frames[..., 3]
        if a.shape[0] != out.n:
            reps = int(np.ceil(out.n / max(a.shape[0], 1)))
            a = np.tile(a, (reps, 1, 1))[:out.n]
        f = out.frames.copy()
        f[..., 3] = a[:, :out.h, :out.w]
        out = out.like(f)
    return out


CODEC = [
    dict(id="codec.smear", label="Smear", script="mv_smear.js", feature="mv",
         blurb="Scales every motion vector. The frame drags itself sideways and never recovers.",
         params=[num("gain_pct", "Gain", 100, 800, 300, 10, "%"),
                 num("bias_x", "Push X", -24, 24, 0),
                 num("bias_y", "Push Y", -24, 24, 0)]),
    dict(id="codec.tail", label="Tail", script="mv_tail.js", feature="mv",
         blurb="Rolling average across N frames. Motion turns into long combed streaks.",
         params=[num("tail", "Tail length", 2, 60, 12, 1, " fr")]),
    dict(id="codec.sink", label="Sink & rise", script="mv_sink.js", feature="mv",
         blurb="Adds a constant vector. The image pours out of the frame.",
         params=[num("dx", "Drift X", -20, 20, 0),
                 num("dy", "Drift Y", -20, 20, 7),
                 flag("ramp", "Accelerate", False)]),
    dict(id="codec.storm", label="Storm", script="mv_storm.js", feature="mv",
         blurb="Seeded random vectors per block. Full dissolve into confetti.",
         params=[num("amp", "Amplitude", 2, 64, 26),
                 num("mix_pct", "Coverage", 5, 100, 80, 5, "%"),
                 seed()]),
    dict(id="codec.freeze", label="Freeze", script="mv_freeze.js", feature="mv",
         blurb="Zeroes a fraction of vectors so those blocks lock in place while the rest moves on.",
         params=[num("prob_pct", "Frozen blocks", 5, 100, 60, 5, "%"), seed()]),
    dict(id="codec.blockquant", label="Blockquant", script="qscale_max.js",
         feature="qscale",
         blurb="Pins quantisation high. Hard DCT chunks and heavy banding.",
         params=[num("qscale", "Quantiser", 2, 31, 31)]),
    dict(id="codec.bleed", label="Bleed", script="q_dc_bleed.js",
         feature="q_dc_delta",
         blurb="Drifts DC coefficients. Blocks flood with flat, wrong colour.",
         params=[num("drift", "Drift", 4, 120, 40, 2),
                 num("mix_pct", "Coverage", 5, 100, 50, 5, "%"),
                 flag("chroma", "Colour too", True), seed()]),
]


def _register():
    keep = flag("keep_alpha", "Keep matte", True,
                "MPEG-2 has no alpha, so any matte is re-applied after the pass.")
    for spec in CODEC:
        def make(script=spec["script"], feature=spec["feature"]):
            def run(clip, p, ctx):
                return _run(script, feature, clip, p, ctx)
            return run
        op(id=spec["id"], label=spec["label"], cat="codec", blurb=spec["blurb"],
           params=spec["params"] + [keep], domain="codec")(make())


_register()
