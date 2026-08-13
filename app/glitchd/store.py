"""On-disk state: the content-addressed clip cache, uploaded sources, and
saved projects.

The cache is the reason this is a studio rather than a cooker. Every chain
node's output is stored under sha1(op id + params + upstream hash), so
changing the last node in an eight-node chain recomputes exactly one node,
and changing a param back to a value you tried five minutes ago is free.
"""

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid

DATA_DIR = os.environ.get("GLITCHSHEET_DATA", "/var/lib/glitchsheet")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
SRC_DIR = os.path.join(DATA_DIR, "sources")
PROJ_DIR = os.path.join(DATA_DIR, "projects")

# The rootfs is 20 GB and the cache is pure scratch -- every entry can be
# recomputed from the project graph. Keep it well clear of the disk.
CACHE_BUDGET = 6 * 1024 * 1024 * 1024
ID_RE = re.compile(r"^[a-f0-9]{12}$")
HASH_RE = re.compile(r"^[a-f0-9]{40}$")

_lock = threading.Lock()


def init():
    for d in (CACHE_DIR, SRC_DIR, PROJ_DIR):
        os.makedirs(d, exist_ok=True)


def new_id():
    return uuid.uuid4().hex[:12]


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def node_hash(op_id, params, upstream):
    """The cache key for a node's OUTPUT.

    Includes the upstream hash, so the key identifies the whole chain prefix
    rather than one node in isolation -- two projects that happen to start
    the same way share cache entries for free.
    """
    payload = json.dumps(
        {"op": op_id, "p": params, "in": upstream},
        sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(payload.encode()).hexdigest()


def cache_path(h, *parts):
    return os.path.join(CACHE_DIR, h, *parts)


def cached(h):
    """A cache entry counts only when meta.json landed. Anything else is a
    half-written directory from a cook that died, and must be recomputed."""
    return bool(HASH_RE.match(h or "")) and os.path.isfile(cache_path(h, "meta.json"))


def cache_meta(h):
    try:
        with open(cache_path(h, "meta.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def touch(h):
    """Mark an entry as recently used so pruning takes the cold ones."""
    p = cache_path(h)
    try:
        os.utime(p, None)
    except OSError:
        pass


def begin(h):
    """A scratch directory to build an entry in. Built out of place and
    renamed, so a crashed cook can never leave a partial entry that looks
    complete to the next request."""
    tmp = cache_path(h + ".part-" + new_id())
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    return tmp


def commit(tmp, h):
    dest = cache_path(h)
    if os.path.isdir(dest):
        shutil.rmtree(dest, ignore_errors=True)
    os.replace(tmp, dest)
    return dest


def abandon(tmp):
    shutil.rmtree(tmp, ignore_errors=True)


def prune_cache(budget=CACHE_BUDGET):
    """Evict coldest-first down to the budget. Returns bytes freed."""
    with _lock:
        entries = []
        total = 0
        try:
            names = os.listdir(CACHE_DIR)
        except FileNotFoundError:
            return 0
        for name in names:
            p = os.path.join(CACHE_DIR, name)
            if not os.path.isdir(p):
                continue
            size = 0
            for root, _, files in os.walk(p):
                for f in files:
                    try:
                        size += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            try:
                atime = os.path.getmtime(p)
            except OSError:
                atime = 0
            # Sweep abandoned .part dirs regardless of age.
            if ".part-" in name and time.time() - atime > 3600:
                shutil.rmtree(p, ignore_errors=True)
                continue
            entries.append((atime, size, p))
            total += size
        if total <= budget:
            return 0
        entries.sort()  # oldest first
        freed = 0
        for _, size, p in entries:
            if total - freed <= budget:
                break
            shutil.rmtree(p, ignore_errors=True)
            freed += size
        return freed


def cache_stats():
    total, count = 0, 0
    try:
        for name in os.listdir(CACHE_DIR):
            p = os.path.join(CACHE_DIR, name)
            if not os.path.isdir(p):
                continue
            count += 1
            for root, _, files in os.walk(p):
                for f in files:
                    try:
                        total += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
    except FileNotFoundError:
        pass
    return {"entries": count, "bytes": total, "budget": CACHE_BUDGET}


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def source_dir(sid):
    if not ID_RE.match(sid or ""):
        return None
    d = os.path.join(SRC_DIR, sid)
    return d if os.path.isdir(d) else None


def new_source():
    sid = new_id()
    os.makedirs(os.path.join(SRC_DIR, sid), exist_ok=True)
    return sid


def source_meta(sid):
    d = source_dir(sid)
    if not d:
        return None
    try:
        with open(os.path.join(d, "meta.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_source_meta(sid, meta):
    d = os.path.join(SRC_DIR, sid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "meta.json"), "w") as fh:
        json.dump(meta, fh)
    return meta


def list_sources(limit=60):
    out = []
    try:
        names = os.listdir(SRC_DIR)
    except FileNotFoundError:
        return out
    for sid in names:
        m = source_meta(sid)
        if m:
            m = dict(m)
            m["id"] = sid
            try:
                m["at"] = os.path.getmtime(os.path.join(SRC_DIR, sid))
            except OSError:
                m["at"] = 0
            out.append(m)
    out.sort(key=lambda m: m["at"], reverse=True)
    return out[:limit]


def delete_source(sid):
    d = source_dir(sid)
    if d:
        shutil.rmtree(d, ignore_errors=True)
        return True
    return False


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

def save_project(pid, doc):
    if not ID_RE.match(pid or ""):
        pid = new_id()
    doc = dict(doc)
    doc["id"] = pid
    doc["saved"] = time.time()
    path = os.path.join(PROJ_DIR, pid + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(doc, fh)
    os.replace(tmp, path)
    return doc


def load_project(pid):
    if not ID_RE.match(pid or ""):
        return None
    try:
        with open(os.path.join(PROJ_DIR, pid + ".json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def list_projects(limit=100):
    out = []
    try:
        names = os.listdir(PROJ_DIR)
    except FileNotFoundError:
        return out
    for f in names:
        if not f.endswith(".json"):
            continue
        doc = load_project(f[:-5])
        if doc:
            out.append({"id": doc.get("id"), "name": doc.get("name") or "untitled",
                        "saved": doc.get("saved", 0),
                        "nodes": len(doc.get("chain") or [])})
    out.sort(key=lambda d: d["saved"], reverse=True)
    return out[:limit]


def delete_project(pid):
    if not ID_RE.match(pid or ""):
        return False
    try:
        os.unlink(os.path.join(PROJ_DIR, pid + ".json"))
        return True
    except OSError:
        return False
