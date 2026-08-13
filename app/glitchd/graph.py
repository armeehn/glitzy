"""Chain evaluation.

A project is a straight list of nodes, each one an op plus its params. The
list is evaluated left to right, and every node's OUTPUT is cached under a
hash of the whole prefix that produced it -- so the cache key for node 6
encodes nodes 1..6, and touching node 6 leaves 1..5 untouched.

That is the difference between this and v1's cook button. In v1 every change
re-ran the whole pipeline from the source; here, dragging the slider on the
last node of an eight-node chain recomputes exactly one node, and dragging it
back to a value you already tried costs nothing at all.
"""

import os
import shutil
import tempfile

from . import ops, store
from .clip import Clip, ClipTooBig
from .ff import FFError


class ChainError(Exception):
    """A problem with a specific node, reported against its index so the
    studio can point at the offending panel instead of saying 'it broke'."""

    def __init__(self, index, msg):
        super().__init__(msg)
        self.index = index
        self.msg = msg


def prepare(chain, upto=None):
    """Validate, coerce and hash every node. No computation happens here."""
    if not isinstance(chain, list) or not chain:
        raise ChainError(-1, "This chain is empty. Start it with a source.")
    if len(chain) > 40:
        raise ChainError(-1, "That is more than 40 nodes; split it into two projects.")

    plan, h, seen_source = [], None, False
    for i, node in enumerate(chain):
        if upto is not None and i > upto:
            break
        if not isinstance(node, dict):
            raise ChainError(i, "Malformed node.")
        op_id = node.get("op")
        entry = ops.get(op_id)
        if not entry:
            raise ChainError(i, "There is no op called %r." % (op_id,))
        if node.get("off"):
            plan.append({"i": i, "op": op_id, "label": entry["label"], "off": True})
            continue
        params, err = ops.coerce(op_id, node.get("params"))
        if err:
            raise ChainError(i, err)
        is_source = entry["domain"] == "source"
        if is_source and seen_source:
            raise ChainError(i, "A chain has one source. Delete the earlier one, "
                                "or start a second project.")
        if not is_source and not seen_source:
            raise ChainError(i, "%s needs something to work on. Put a source "
                                "above it." % entry["label"])
        seen_source = seen_source or is_source
        h = store.node_hash(op_id, params, h)
        plan.append({"i": i, "op": op_id, "label": entry["label"],
                     "domain": entry["domain"], "params": params, "hash": h,
                     "off": False})
    if not seen_source:
        raise ChainError(-1, "This chain has no source, so there are no pixels "
                             "to work with.")
    return plan


def upstream_mpg(h):
    """A codec node hands its bitstream to the next codec node through the
    cache. Without this the stream would be decoded and re-encoded between
    passes, and a clean encode heals exactly the damage the pass just did."""
    if not h:
        return None
    p = store.cache_path(h, "out.mpg")
    return p if os.path.isfile(p) else None


def evaluate(chain, upto=None, progress=None, cancelled=None):
    """Run the chain, reusing every cached prefix. Returns a result dict."""
    plan = prepare(chain, upto)
    active = [n for n in plan if not n["off"]]
    if not active:
        raise ChainError(-1, "Every node is switched off.")

    work = tempfile.mkdtemp(prefix="chain-", dir=_workroot())
    clip, h = None, None
    steps = []
    try:
        for k, n in enumerate(active):
            if cancelled and cancelled():
                raise ChainError(n["i"], "Cancelled.")

            def sub(frac, note, k=k, n=n):
                if progress:
                    progress((k + frac) / len(active), "%s — %s" % (n["label"], note))

            if store.cached(n["hash"]):
                store.touch(n["hash"])
                meta = store.cache_meta(n["hash"]) or {}
                steps.append({"i": n["i"], "op": n["op"], "hash": n["hash"],
                              "cached": True, "notes": meta.get("notes", []),
                              "meta": _pub_meta(meta)})
                h, clip = n["hash"], None
                if progress:
                    progress((k + 1) / len(active), "%s — cached" % n["label"])
                continue

            if clip is None and h is not None:
                sub(0.02, "loading")
                clip = Clip.load(store.cache_path(h))

            entry = ops.get(n["op"])
            tmp = store.begin(n["hash"])
            ctx = ops.Ctx(workdir=work, out_dir=tmp, progress=sub,
                          upstream_mpg=upstream_mpg(h), cancelled=cancelled)
            try:
                out = entry["fn"](clip, n["params"], ctx)
                if not isinstance(out, Clip):
                    raise ChainError(n["i"], "%s returned nothing usable."
                                     % entry["label"])
                sub(0.9, "saving")
                meta = out.save(tmp)
                meta.update({"op": n["op"], "params": n["params"],
                             "notes": ctx.notes, "label": entry["label"]})
                _write_meta(tmp, meta)
                store.commit(tmp, n["hash"])
            except ChainError:
                store.abandon(tmp)
                raise
            except (FFError, ClipTooBig, ValueError) as e:
                store.abandon(tmp)
                raise ChainError(n["i"], str(e))
            except MemoryError:
                store.abandon(tmp)
                raise ChainError(n["i"], "Ran out of memory. Fewer frames, or a "
                                         "smaller working size.")
            except Exception as e:  # a bad op must not take the queue down
                store.abandon(tmp)
                raise ChainError(n["i"], "%s failed: %r" % (entry["label"], e))

            steps.append({"i": n["i"], "op": n["op"], "hash": n["hash"],
                          "cached": False, "notes": ctx.notes,
                          "meta": _pub_meta(meta)})
            clip, h = out, n["hash"]
    finally:
        shutil.rmtree(work, ignore_errors=True)

    store.prune_cache()
    final = store.cache_meta(h) or {}
    return {"hash": h, "steps": steps, "meta": _pub_meta(final),
            "notes": [s for st in steps for s in st["notes"]]}


def _pub_meta(meta):
    return {k: meta.get(k) for k in ("n", "w", "h", "fps", "label")}


def _write_meta(d, meta):
    import json
    with open(os.path.join(d, "meta.json"), "w") as fh:
        json.dump(meta, fh)


def _workroot():
    p = os.path.join(store.DATA_DIR, "work")
    os.makedirs(p, exist_ok=True)
    return p


def preview_chain(chain, upto, max_px=360, max_frames=24):
    """A cheaper copy of the chain for live scrubbing.

    Shrinks the source's working size and frame count. The result is a
    genuinely different chain, so it lands on its own cache keys and never
    collides with the full-resolution render.
    """
    out = []
    for node in chain:
        node = dict(node)
        params = dict(node.get("params") or {})
        entry = ops.get(node.get("op"))
        if entry and entry["domain"] == "source":
            w, h = params.get("width", 480), params.get("height", 480)
            sc = min(1.0, max_px / max(w, h, 1))
            if sc < 1:
                params["width"] = max(64, int(w * sc) // 16 * 16)
                params["height"] = max(64, int(h * sc) // 16 * 16)
            if params.get("frames", 1) > max_frames:
                params["frames"] = max_frames
        node["params"] = params
        out.append(node)
    return out
