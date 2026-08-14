"""The op registry.

An op is a pure function Clip -> Clip with a declared parameter schema. The
schema is the single source of truth: the studio builds every slider, toggle
and dropdown from /api/ops, so adding an effect is a backend-only change and
the frontend never learns its name.

Domains, which the evaluator cares about:

    source  no input clip -- it makes one
    pixel   numpy, in and out of RAM, cheap
    codec   needs an MPEG-2 bitstream, so it runs through ffgac/ffedit

The domain split is why the chain can interleave a pixel sort between two
ffedit passes without the user ever thinking about encodes.
"""

import re

REGISTRY = {}
CATEGORIES = [
    {"id": "source", "label": "Source", "blurb": "Where the pixels come from."},
    {"id": "codec", "label": "Codec damage", "blurb": "Corruption inside the MPEG-2 bitstream itself."},
    {"id": "pixel", "label": "Pixel", "blurb": "Direct assault on the pixels."},
    {"id": "colour", "label": "Colour", "blurb": "Palettes, quantising, dithering."},
    {"id": "geom", "label": "Geometry", "blurb": "Move, tile, mirror, warp."},
    {"id": "matte", "label": "Matte", "blurb": "Cut the shape out of the artwork."},
    {"id": "time", "label": "Time", "blurb": "Operations across frames."},
]


class Ctx:
    """What an op is handed besides its clip and params.

    `upstream_mpg` is the load-bearing one: when a codec op follows another
    codec op, the bitstream is passed straight through instead of being
    decoded to PNGs and re-encoded, which would quietly heal the very
    damage the previous pass just did.
    """

    def __init__(self, workdir, out_dir, progress=None, upstream_mpg=None,
                 source_dir=None, cancelled=None):
        self.workdir = workdir
        self.out_dir = out_dir
        self.upstream_mpg = upstream_mpg
        self.source_dir = source_dir
        self._progress = progress
        self._cancelled = cancelled
        self.emitted_mpg = None   # a codec op sets this to hand the stream on
        self.notes = []           # non-fatal remarks surfaced in the UI

    def progress(self, frac, note=""):
        if self._progress:
            self._progress(max(0.0, min(1.0, frac)), note)

    def note(self, msg):
        if msg and msg not in self.notes:
            self.notes.append(msg)

    def cancelled(self):
        return bool(self._cancelled and self._cancelled())


# ---------------------------------------------------------------------------
# Parameter schema helpers
# ---------------------------------------------------------------------------

def num(k, label, lo, hi, default, step=1, suffix="", hint="", scale=1):
    """A numeric slider.

    `scale` exists for ffedit: its -sp JSON parser rejects floating point
    outright, so a fractional codec param travels as an integer percent and
    is divided inside the qjs script. Everything the user sees is the real
    number; only the wire value is scaled.
    """
    return {"k": k, "label": label, "type": "num", "min": lo, "max": hi,
            "def": default, "step": step, "suffix": suffix, "hint": hint,
            "scale": scale}


def flag(k, label, default=False, hint=""):
    return {"k": k, "label": label, "type": "bool", "def": bool(default), "hint": hint}


def pick(k, label, options, default=None, hint=""):
    opts = [{"v": o, "label": o.replace("_", " ").title()} if isinstance(o, str) else o
            for o in options]
    return {"k": k, "label": label, "type": "enum", "options": opts,
            "def": default if default is not None else opts[0]["v"], "hint": hint}


def colour(k, label, default="#F0477D", hint=""):
    return {"k": k, "label": label, "type": "colour", "def": default, "hint": hint}


def src(k="src", label="File", hint=""):
    """A reference to an uploaded source. The studio renders this as a file
    picker plus the upload/fetch controls, not as a text box."""
    return {"k": k, "label": label, "type": "source", "def": "", "hint": hint}


def seed(k="seed", label="Seed", default=4816):
    return {"k": k, "label": label, "type": "seed", "min": 1, "max": 999999,
            "def": default, "step": 1, "suffix": "", "hint": "", "scale": 1}


def text(k, label, default="", placeholder="", hint=""):
    return {"k": k, "label": label, "type": "text", "def": default,
            "placeholder": placeholder, "hint": hint}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def op(id, label, cat, blurb="", params=(), domain="pixel", still_ok=True,
       varies=()):
    """Register an op.

    `varies` names the params worth sweeping in the Variants panel. Sweeping
    a seed is interesting; sweeping a colour hex is not, and the studio
    should not have to guess which is which.
    """
    def deco(fn):
        entry = {
            "id": id, "label": label, "cat": cat, "blurb": blurb,
            "params": list(params), "domain": domain, "still_ok": still_ok,
            "varies": list(varies) or [p["k"] for p in params
                                       if p["type"] in ("num", "seed")],
            "fn": fn,
        }
        if id in REGISTRY:
            raise RuntimeError("duplicate op id %r" % id)
        REGISTRY[id] = entry
        return fn
    return deco


def get(op_id):
    return REGISTRY.get(op_id)


def coerce(op_id, raw):
    """Clamp and type every incoming param. Nothing user-supplied reaches an
    op -- or worse, an ffedit -sp payload -- as an unchecked string."""
    entry = REGISTRY.get(op_id)
    if not entry:
        return None, "Unknown op %r." % (op_id,)
    return coerce_specs(entry["params"], raw)


def coerce_specs(specs, raw):
    """The clamping half of coerce(), against any schema rather than an op's.

    Split out because a layer's compositing settings are declared with the
    same helpers and have to be sanitised the same way -- the alternative was
    a second, subtly different validator, which is how a studio ends up with
    one path that clamps and one that does not.
    """
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for spec in specs:
        k, t = spec["k"], spec["type"]
        v = raw.get(k, spec["def"])
        if t in ("num", "seed"):
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = float(spec["def"])
            v = max(spec["min"], min(spec["max"], v))
            if float(spec.get("step", 1)).is_integer() and float(spec["min"]).is_integer():
                v = int(round(v))
        elif t == "bool":
            v = bool(v)
        elif t == "enum":
            allowed = [o["v"] for o in spec["options"]]
            if v not in allowed:
                v = spec["def"]
        elif t == "colour":
            v = str(v)
            if not _is_hex(v):
                v = spec["def"]
        elif t == "text":
            v = str(v)[:400]
        elif t == "source":
            v = str(v or "")
            if v and not re.match(r"^[a-f0-9]{12}$", v):
                v = ""
        out[k] = v
    return out, None


def _is_hex(s):
    if not isinstance(s, str) or len(s) not in (4, 7) or not s.startswith("#"):
        return s == "none"
    return all(c in "0123456789abcdefABCDEF" for c in s[1:])


def public_registry():
    """The registry as the studio sees it -- schema only, no callables."""
    ops = []
    for entry in REGISTRY.values():
        ops.append({k: v for k, v in entry.items() if k != "fn"})
    ops.sort(key=lambda e: (e["cat"], e["label"]))
    return {"ops": ops, "categories": CATEGORIES}


def load_all():
    """Import every op module for its side effects.

    The colour ops live in colourops.py, not colour.py: a submodule named
    `colour` would be bound onto this package on import and quietly replace
    the `colour()` param helper above.
    """
    from . import source, codec, pixel, colourops, geom, matte, timeops  # noqa: F401
    return REGISTRY
