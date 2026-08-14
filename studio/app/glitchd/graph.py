"""Chain and stack evaluation.

A layer is a straight list of nodes, each one an op plus its params. The list
is evaluated left to right, and every node's OUTPUT is cached under a hash of
the whole prefix that produced it -- so the cache key for node 6 encodes nodes
1..6, and touching node 6 leaves 1..5 untouched.

That is the difference between this and v1's cook button. In v1 every change
re-ran the whole pipeline from the source; here, dragging the slider on the
last node of an eight-node chain recomputes exactly one node, and dragging it
back to a value you already tried costs nothing at all.

A project is a *stack* of those chains, composited bottom to top (see
layers.py). The composite is itself a cached node keyed on the layer hashes
plus the compositing settings, so the same rule holds one level up: changing
the top layer's blend mode recomputes one composite and re-runs no ops at all.
"""

import os
import shutil
import tempfile

from . import layers as layermod, ops, store
from .clip import Clip, ClipTooBig
from .ff import FFError


class ChainError(Exception):
    """A problem with a specific node, reported against its index -- and, in a
    stack, against its layer -- so the studio can point at the offending panel
    instead of saying 'it broke'."""

    def __init__(self, index, msg, layer=None):
        super().__init__(msg)
        self.index = index
        self.msg = msg
        self.layer = layer


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


# ---------------------------------------------------------------------------
# Stacks of layers
# ---------------------------------------------------------------------------

def _chain_of(layer):
    c = (layer or {}).get("chain")
    return c if isinstance(c, list) else []


def prepare_stack(layers, active=0, upto=None):
    """Validate a stack without computing anything.

    Two rules that are deliberately lenient, because the studio is a place you
    build things in and half-built things are normal:

      * a layer with an empty chain is skipped, not an error -- adding a layer
        and then reaching for the library must not paint an error over the
        artwork you were already looking at;
      * a hidden layer is never validated, so a broken layer you have switched
        off cannot block the render of the ones you can see.
    """
    if not isinstance(layers, list) or not layers:
        raise ChainError(-1, "This project has no layers.", layer=-1)
    if len(layers) > layermod.MAX_LAYERS:
        raise ChainError(-1, "A stack is at most %d layers." % layermod.MAX_LAYERS,
                         layer=-1)

    specs = [layermod.coerce_layer(ly) for ly in layers]
    filled = [k for k, ly in enumerate(layers) if _chain_of(ly)]
    if not filled:
        raise ChainError(-1, "This project is empty. Start a layer with a source.",
                         layer=-1)

    live = [k for k in filled if not (layers[k] or {}).get("off")]
    solo = [k for k in live if (layers[k] or {}).get("solo")]
    visible = solo or live

    plans = {}
    for k in sorted(set(visible) | ({active} if active in filled else set())):
        try:
            plans[k] = prepare(_chain_of(layers[k]), upto if k == active else None)
        except ChainError as e:
            e.layer = k
            raise
    return {"specs": specs, "plans": plans, "visible": visible,
            "active": active if active in plans else None}


def composite_hash(entries):
    """Cache key for a composite: every layer's output hash and its placement."""
    payload = [{"h": h, "s": {k: spec[k] for k in layermod.LAYER_KEYS}}
               for h, spec in entries]
    return store.node_hash("__composite", payload, None)


def evaluate_stack(layers, active=0, upto=None, view="composite",
                   progress=None, cancelled=None):
    """Evaluate every visible layer, then composite them.

    `upto` applies to the ACTIVE layer only: the rest of the stack always runs
    to the end of its own chain. That is what makes scrubbing a parameter
    halfway down one layer show up in context rather than in isolation.

    `view="layer"` returns the active layer's own result and skips the
    composite entirely -- the studio's solo button, and a good deal cheaper
    than compositing something you are not looking at.
    """
    st = prepare_stack(layers, active, upto)
    visible, plans = st["visible"], st["plans"]
    order = ([st["active"]] if view == "layer" and st["active"] is not None
             else sorted(set(visible) | ({st["active"]} if st["active"] is not None
                                         else set())))
    if not order:
        raise ChainError(-1, "Every layer is switched off.", layer=-1)

    results, share = {}, 1.0 / (len(order) + 1)
    for j, k in enumerate(order):
        name = (layers[k] or {}).get("name") or "Layer %d" % (k + 1)

        def sub(f, note, j=j, name=name):
            if progress:
                progress(share * (j + f), "%s — %s" % (name, note))

        try:
            results[k] = evaluate(_chain_of(layers[k]),
                                  upto if k == st["active"] else None,
                                  progress=sub, cancelled=cancelled)
        except ChainError as e:
            e.layer = k
            raise

    def pub(k):
        r = results.get(k)
        return {"i": k, "hash": r["hash"] if r else None,
                "meta": r["meta"] if r else None,
                "visible": k in visible, "notes": r["notes"] if r else []}

    layer_pub = [pub(k) for k in sorted(results)]
    active_res = results.get(st["active"])

    if view == "layer" or not visible:
        if not active_res:
            raise ChainError(-1, "That layer has nothing in it yet.", layer=active)
        return dict(active_res, layers=layer_pub, active=st["active"],
                    composite=False, layer_hash=active_res["hash"])

    entries = [(results[k]["hash"], st["specs"][k]) for k in visible]
    # One ordinary layer is not a composite at all: hand back the chain's own
    # cache entry, so a single-layer project produces the exact bytes v2.0 did
    # and costs nothing extra.
    if len(entries) == 1 and layermod.is_identity(entries[0][1]):
        r = results[visible[0]]
        return dict(r, layers=layer_pub, active=st["active"], composite=False,
                    layer_hash=active_res["hash"] if active_res else r["hash"])

    ch = composite_hash(entries)
    notes = layermod.stack_notes(
        [(store.cache_meta(h) or {}, store.cache_path(h), spec) for h, spec in entries])

    if not store.cached(ch):
        if progress:
            progress(1 - share, "compositing %d layers" % len(entries))
        tmp = store.begin(ch)
        try:
            clip = layermod.composite(
                [(store.cache_meta(h) or {}, store.cache_path(h), spec)
                 for h, spec in entries],
                progress=lambda f, note: progress and progress(1 - share + share * f, note),
                cancelled=cancelled)
            meta = clip.save(tmp)
            meta.update({"op": "__composite", "label": "Composite",
                         "layers": len(entries), "notes": notes,
                         "params": {"layers": [spec for _, spec in entries]}})
            _write_meta(tmp, meta)
            store.commit(tmp, ch)
        except (ClipTooBig, MemoryError) as e:
            store.abandon(tmp)
            raise ChainError(-1, "The stack is past the engine's memory budget: "
                                 "%s" % e, layer=-1)
        except ChainError:
            store.abandon(tmp)
            raise
        except Exception as e:
            store.abandon(tmp)
            raise ChainError(-1, "Compositing failed: %r" % (e,), layer=-1)
    else:
        store.touch(ch)

    store.prune_cache()
    return {"hash": ch, "steps": active_res["steps"] if active_res else [],
            "meta": _pub_meta(store.cache_meta(ch) or {}),
            "notes": notes + [n for k in visible for n in results[k]["notes"]],
            "layers": layer_pub, "active": st["active"], "composite": True,
            "layer_hash": active_res["hash"] if active_res else None}


def preview_stack(layers, upto=None, max_px=360, max_frames=24):
    """The cheap copy of a whole stack. Every layer shrinks by the same rule,
    and because placement is expressed in percentages the composite is the same
    picture at a smaller size rather than a differently-arranged one."""
    out = []
    for ly in layers:
        ly = dict(ly or {})
        ly["chain"] = preview_chain(_chain_of(ly), None, max_px, max_frames)
        out.append(ly)
    return out


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
