#!/usr/bin/env python3
"""Backend tests for the Glitchsheet engine.

Runs real chains through real ffglitch binaries -- no mocks. A mocked ffedit
would have passed every one of the traps that actually cost time in v1 (the
silent no-op, the -sp float rejection, the tail-only stderr read), so the
tests are worth little unless the binaries really run.

    python3 tests/test_backend.py
"""

import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

DATA = tempfile.mkdtemp(prefix="gs-test-")
os.environ["GLITCHSHEET_DATA"] = DATA
os.environ.setdefault("GLITCHSHEET_RACK", os.path.join(os.path.dirname(HERE), "rack"))

import numpy as np  # noqa: E402

from glitchd import exporters, graph, nputil, ops, store  # noqa: E402
from glitchd.clip import Clip, ClipTooBig  # noqa: E402
from glitchd.graph import ChainError  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print("%s %s%s" % ("ok  " if cond else "FAIL", name,
                       "" if cond else "  -- " + str(detail)))
    return cond


def section(t):
    print("\n== %s" % t)


store.init()
ops.load_all()

SMALL = {"width": 128, "height": 128, "frames": 6, "fps": 25}


# ---------------------------------------------------------------------------
section("registry")
# ---------------------------------------------------------------------------
reg = ops.public_registry()
check("registry exposes ops", len(reg["ops"]) >= 40, len(reg["ops"]))
check("no op leaks its callable", all("fn" not in o for o in reg["ops"]))
check("every op has a category we declare",
      {o["cat"] for o in reg["ops"]} <= {c["id"] for c in reg["categories"]})
check("every param has a default",
      all("def" in p for o in reg["ops"] for p in o["params"]))
check("every op has a blurb", all(o["blurb"] for o in reg["ops"]))

p, err = ops.coerce("pixel.levels", {"gamma": 99999, "contrast": "nonsense"})
check("params clamp to their range", p["gamma"] == 300, p)
check("junk falls back to the default", p["contrast"] == 0, p)
p, err = ops.coerce("colour.palette", {"palette": "no-such-palette"})
check("unknown enum falls back", p["palette"] == "riposte", p)
_, err = ops.coerce("nope.nope", {})
check("unknown op is rejected", err is not None)


# ---------------------------------------------------------------------------
section("clip")
# ---------------------------------------------------------------------------
c = Clip.solid(32, 16, (255, 0, 0, 255), n=3)
check("clip shape", (c.n, c.h, c.w) == (3, 16, 32), (c.n, c.h, c.w))
check("rgb round trips", np.allclose(c.with_rgb(c.rgb()).frames, c.frames))
rgb3 = np.zeros((2, 8, 8, 3), np.uint8)
check("rgb input gains an opaque alpha", Clip(rgb3).frames[..., 3].min() == 255)
try:
    Clip(np.zeros((400, 1600, 1600, 4), np.uint8))
    check("oversized clip refused", False)
except (ClipTooBig, MemoryError, ValueError) as e:
    check("oversized clip refused", True)

d = os.path.join(DATA, "cliptest")
c.save(d)
c2 = Clip.load(d)
check("clip survives disk", np.array_equal(c.frames, c2.frames))
check("thumbs are written", os.path.isfile(os.path.join(d, "t_00000.jpg")))


# ---------------------------------------------------------------------------
section("numpy helpers")
# ---------------------------------------------------------------------------
m = np.zeros((1, 40, 40), bool)
m[0, 15:25, 15:25] = True
dist = nputil.dist_outside(m, 8)
check("distance is zero inside the shape", dist[0, 20, 20] == 0)
check("distance grows outward", 2.5 < dist[0, 20, 27] < 3.5, dist[0, 20, 27])
check("distance is clamped at the radius", dist.max() <= 8)

spec = np.zeros((1, 40, 40), bool)
spec[0, 5:25, 5:25] = True
spec[0, 35, 35] = True          # a lone speck
cleaned = nputil.despeckle(spec, min_frac=0.01)
check("despeckle keeps the body", cleaned[0, 10, 10])
check("despeckle drops the speck", not cleaned[0, 35, 35])

flat = np.ones((1, 20, 20), np.float32) * 0.5
check("box blur preserves a flat field",
      np.allclose(nputil.box_blur(flat, 3), 0.5, atol=1e-5))

rng = np.random.default_rng(1)
n1 = nputil.fbm(rng, 4, 32, 32, freq=4, octaves=2)
n2 = nputil.fbm(np.random.default_rng(1), 4, 32, 32, freq=4, octaves=2)
check("noise is reproducible from a seed", np.allclose(n1, n2))
check("noise stays in range", 0 <= n1.min() and n1.max() <= 1)


# ---------------------------------------------------------------------------
section("chain validation")
# ---------------------------------------------------------------------------
def expect_chain_error(name, chain):
    try:
        graph.prepare(chain)
        check(name, False, "no error raised")
    except ChainError as e:
        check(name, True)


expect_chain_error("empty chain rejected", [])
expect_chain_error("chain without a source rejected",
                   [{"op": "pixel.levels", "params": {}}])
expect_chain_error("unknown op rejected", [{"op": "not.real", "params": {}}])
expect_chain_error("two sources rejected",
                   [{"op": "source.flow", "params": SMALL},
                    {"op": "source.flow", "params": SMALL}])

plan = graph.prepare([{"op": "source.flow", "params": SMALL},
                      {"op": "pixel.levels", "params": {}, "off": True},
                      {"op": "colour.invert", "params": {}}])
check("disabled nodes are planned but not hashed",
      plan[1]["off"] and "hash" not in plan[1])
check("hashing skips disabled nodes",
      plan[2]["hash"] == store.node_hash("colour.invert",
                                         ops.coerce("colour.invert", {})[0],
                                         plan[0]["hash"]))


# ---------------------------------------------------------------------------
section("evaluation and the cache")
# ---------------------------------------------------------------------------
CHAIN = [
    {"op": "source.truchet", "params": dict(SMALL, seed=7, scale=6)},
    {"op": "pixel.levels", "params": {"contrast": 30}},
    {"op": "colour.palette", "params": {"palette": "acid", "mode": "quantise"}},
]
t0 = time.time()
r1 = graph.evaluate(CHAIN)
cold = time.time() - t0
check("chain evaluates", store.cached(r1["hash"]), r1)
check("every node reported", len(r1["steps"]) == 3, r1["steps"])
check("nothing was cached on the first run",
      all(not s["cached"] for s in r1["steps"]))

t0 = time.time()
r2 = graph.evaluate(CHAIN)
warm = time.time() - t0
check("re-running is a pure cache hit", all(s["cached"] for s in r2["steps"]))
check("same chain gives the same hash", r1["hash"] == r2["hash"])
check("cache hit is much faster", warm < cold / 3 + 0.05,
      "cold %.2fs warm %.2fs" % (cold, warm))

# The whole point: edit the LAST node, and the earlier ones must not re-run.
CHAIN_B = [dict(CHAIN[0]), dict(CHAIN[1]),
           {"op": "colour.palette", "params": {"palette": "vhs", "mode": "quantise"}}]
r3 = graph.evaluate(CHAIN_B)
check("editing the tail reuses the head",
      [s["cached"] for s in r3["steps"]] == [True, True, False],
      [s["cached"] for s in r3["steps"]])
check("a different tail is a different result", r3["hash"] != r1["hash"])

# ... and editing the HEAD must invalidate everything after it.
CHAIN_C = [{"op": "source.truchet", "params": dict(SMALL, seed=8, scale=6)},
           dict(CHAIN[1]), dict(CHAIN[2])]
r4 = graph.evaluate(CHAIN_C)
check("editing the head invalidates the tail",
      not any(s["cached"] for s in r4["steps"]),
      [s["cached"] for s in r4["steps"]])

meta = store.cache_meta(r1["hash"])
check("result meta records the size", meta["w"] == 128 and meta["h"] == 128, meta)
check("result meta records the frame count", meta["n"] == 6, meta)

r5 = graph.evaluate(CHAIN, upto=0)
check("upto stops early", store.cache_meta(r5["hash"])["op"] == "source.truchet")

# A node that fails must name itself rather than blaming the chain.
try:
    graph.evaluate([{"op": "source.media", "params": {"src": "aaaaaaaaaaaa"}}])
    check("a missing source is reported", False)
except ChainError as e:
    check("a missing source is reported", e.index == 0, e.msg)


# ---------------------------------------------------------------------------
section("ops actually change pixels")
# ---------------------------------------------------------------------------
base = graph.evaluate([CHAIN[0]])
base_clip = Clip.load(store.cache_path(base["hash"]))

SAMPLES = [
    ("pixel.sort", {"mode": "whole"}),
    ("pixel.shift", {"red": -8, "blue": 8}),
    ("pixel.displace", {"amount": 20}),
    ("pixel.slices", {"bands": 8, "amount": 40}),
    ("pixel.recompress", {"quality": 4, "passes": 2}),
    ("pixel.bitcrush", {"bits": 2}),
    ("pixel.noise", {"amount": 40}),
    ("pixel.scanlines", {"depth": 60}),
    ("pixel.levels", {"contrast": 60}),
    ("pixel.blur", {"radius": 3}),
    ("colour.palette", {"palette": "neon"}),
    ("colour.dither", {"palette": "mono"}),
    ("colour.hsv", {"hue": 90}),
    ("colour.posterize", {"steps": 3}),
    ("colour.invert", {}),
    ("colour.channels", {"order": "bgr"}),
    ("geom.transform", {"angle": 20, "scale": 130}),
    ("geom.mirror", {"mode": "quad"}),
    ("geom.tile", {"cols": 3, "rows": 3}),
    ("geom.wave", {"amplitude": 10}),
    ("geom.polar", {"dir": "to_polar"}),
    ("geom.fit", {"width": 96, "height": 96}),
    ("time.drift", {"frames": 6}),
    ("time.length", {"frames": 10}),
    ("time.reverse", {"pingpong": False}),
    ("time.echo", {"decay": 80}),
    ("time.slitscan", {}),
    ("time.stutter", {"hold": 2}),
    # The generator's luma never dips below ~0.43, so a "dark" key with a small
    # tolerance legitimately finds nothing to remove. Key the light side.
    ("matte.key", {"mode": "light", "tolerance": 50}),
    ("matte.shape", {"shape": "star"}),
]
for op_id, params in SAMPLES:
    chain = [CHAIN[0], {"op": op_id, "params": params}]
    try:
        res = graph.evaluate(chain)
        out = Clip.load(store.cache_path(res["hash"]))
        same = (out.frames.shape == base_clip.frames.shape
                and np.array_equal(out.frames, base_clip.frames))
        check("%s changes the picture" % op_id, not same)
    except Exception as e:
        check("%s changes the picture" % op_id, False, repr(e))

# matte.border needs an alpha to grow, so it gets its own two-node setup
res = graph.evaluate([CHAIN[0], {"op": "matte.shape", "params": {"shape": "circle"}},
                      {"op": "matte.border", "params": {"width": 6}}])
bordered = Clip.load(store.cache_path(res["hash"]))
shaped = Clip.load(store.cache_path(
    graph.evaluate([CHAIN[0], {"op": "matte.shape", "params": {"shape": "circle"}}])["hash"]))
check("border grows the opaque area",
      (bordered.frames[..., 3] > 128).sum() > (shaped.frames[..., 3] > 128).sum())
check("border leaves the corners transparent", bordered.frames[0, 0, 0, 3] < 128)

res = graph.evaluate([CHAIN[0], {"op": "matte.border", "params": {"width": 6}}])
check("border on an opaque clip explains itself",
      any("Silhouette" in n for n in res["notes"]), res["notes"])

# Trim only has something to do once there is an empty margin to remove, so it
# is tested after a matte rather than against the opaque source.
trimmed = graph.evaluate([CHAIN[0],
                          {"op": "matte.shape", "params": {"shape": "circle",
                                                           "inset": 20}},
                          {"op": "matte.trim", "params": {"pad": 0}}])
tc = Clip.load(store.cache_path(trimmed["hash"]))
check("trim crops away the empty margin", tc.w < 128 and tc.h < 128, (tc.w, tc.h))


# ---------------------------------------------------------------------------
section("codec ops (real ffglitch)")
# ---------------------------------------------------------------------------
CODEC_SRC = {"op": "source.flow", "params": dict(SMALL, frames=12, seed=3)}
try:
    res = graph.evaluate([CODEC_SRC, {"op": "codec.smear",
                                      "params": {"gain_pct": 500}}])
    out = Clip.load(store.cache_path(res["hash"]))
    src = Clip.load(store.cache_path(graph.evaluate([CODEC_SRC])["hash"]))
    check("smear runs and returns frames", out.n > 0, out)
    check("smear changes the picture", not np.array_equal(out.frames, src.frames))
    check("smear keeps the working size", (out.w, out.h) == (src.w, src.h),
          (out.w, out.h))
    check("smear did not silently no-op",
          not any("changed nothing" in n for n in res["notes"]), res["notes"])
    check("out.mpg is kept for the next codec op",
          os.path.isfile(store.cache_path(res["hash"], "out.mpg")))

    stacked = graph.evaluate([CODEC_SRC,
                              {"op": "codec.smear", "params": {"gain_pct": 500}},
                              {"op": "codec.blockquant", "params": {"qscale": 28}}])
    check("a second codec pass reuses the first one's bitstream",
          stacked["steps"][1]["cached"] and not stacked["steps"][2]["cached"])
    st = Clip.load(store.cache_path(stacked["hash"]))
    check("stacked codec pass changes it again",
          not np.array_equal(st.frames, out.frames))

    q = graph.evaluate([CODEC_SRC, {"op": "codec.blockquant", "params": {"qscale": 31}}])
    check("blockquant is not a no-op",
          not any("changed nothing" in n for n in q["notes"]), q["notes"])

    still = graph.evaluate([{"op": "source.flow", "params": dict(SMALL, frames=1)},
                            {"op": "codec.smear", "params": {}}])
    check("a still warns there is no motion to abuse",
          any("single frame" in n for n in still["notes"]), still["notes"])

    matted = graph.evaluate([CODEC_SRC,
                             {"op": "matte.shape", "params": {"shape": "circle"}},
                             {"op": "codec.smear", "params": {"gain_pct": 400}}])
    mc = Clip.load(store.cache_path(matted["hash"]))
    check("a matte survives a codec round trip", mc.frames[0, 0, 0, 3] < 128,
          mc.frames[0, 0, 0, 3])
except Exception as e:
    check("codec ops run", False, repr(e))


# ---------------------------------------------------------------------------
section("export")
# ---------------------------------------------------------------------------
check("print scale rounds up, never down", exporters.print_scale(640, 76, 300) == 2,
      exporters.print_scale(640, 76, 300))
check("print scale never goes below 1", exporters.print_scale(4000, 20, 150) == 1)

sticker = graph.evaluate([CHAIN[0],
                          {"op": "matte.shape", "params": {"shape": "circle"}},
                          {"op": "matte.border", "params": {"width": 8}}])
png, ct, name = exporters.export_png(sticker["hash"], 0, 76, 300)
check("png export produces a png", png[:8] == b"\x89PNG\r\n\x1a\n")
check("png export is upscaled for print", len(png) > 1000)

body, ct, name, overflow = exporters.export_sheet(
    [{"hash": sticker["hash"], "frame": 0, "mm": 50, "name": "one"},
     {"hash": sticker["hash"], "frame": 1, "mm": 50, "name": "two"}], "cricut", 300)
sheet = json.loads(body)
check("sheet declares the format cutsheet expects", sheet["format"] == "cutsheet/1")
check("sheet has both stickers", len(sheet["doc"]["items"]) == 2)
check("sheet embeds the artwork as a data url",
      sheet["images"][0]["dataUrl"].startswith("data:image/png;base64,"))
check("sheet uses the machine profile",
      sheet["doc"]["machine"] == "cricut" and sheet["doc"]["marks"]["style"] == "cricut")
it = sheet["doc"]["items"][0]
check("a matted sticker is cut on its contour", it["cut"]["mode"] == "contour", it["cut"])
check("the contour cut adds no extra offset", it["cut"]["offset"] == 0, it["cut"])
check("items are placed inside the margins",
      it["cx"] - it["w"] / 2 >= sheet["doc"]["margins"]["l"] - 0.01, it)
check("stickers do not overlap",
      abs(sheet["doc"]["items"][1]["cx"] - it["cx"]) >= it["w"] - 0.01)

plain = graph.evaluate([CHAIN[0]])
body2, _, _, _ = exporters.export_sheet(
    [{"hash": plain["hash"], "frame": 0, "mm": 50}], "generic", 300)
cut2 = json.loads(body2)["doc"]["items"][0]["cut"]
check("a fully opaque design gets a box cut with bleed",
      cut2["mode"] == "box" and cut2["offset"] > 0, cut2)

gif, ct, name = exporters.export_animation(sticker["hash"], "gif")
check("gif export works", gif[:3] == b"GIF", gif[:8])
apng, ct, name = exporters.export_animation(sticker["hash"], "apng")
check("apng export works", apng[:8] == b"\x89PNG\r\n\x1a\n")
zipb, ct, name = exporters.export_sequence(sticker["hash"])
check("sequence export is a zip", zipb[:2] == b"PK")


# ---------------------------------------------------------------------------
section("projects")
# ---------------------------------------------------------------------------
doc = store.save_project(None, {"name": "test", "chain": CHAIN})
check("project saves", store.load_project(doc["id"])["name"] == "test")
check("project is listed", any(p["id"] == doc["id"] for p in store.list_projects()))
check("project node count is listed",
      [p for p in store.list_projects() if p["id"] == doc["id"]][0]["nodes"] == 3)
store.delete_project(doc["id"])
check("project deletes", store.load_project(doc["id"]) is None)


# ---------------------------------------------------------------------------
section("cache housekeeping")
# ---------------------------------------------------------------------------
stats = store.cache_stats()
check("cache reports its size", stats["entries"] > 0 and stats["bytes"] > 0, stats)
freed = store.prune_cache(budget=1)
check("prune evicts when over budget", freed > 0, freed)
check("prune emptied the cache", store.cache_stats()["entries"] <= 1)


print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
if FAIL:
    print("failed:")
    for f in FAIL:
        print("  -", f)
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if FAIL else 0)
