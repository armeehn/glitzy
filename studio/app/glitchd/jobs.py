"""The job queue.

Work runs off the request thread so an eval that takes forty seconds does not
hold a socket open, and so the studio can show progress and offer a cancel.

Concurrency is deliberately small. The host is RAM-oversubscribed and this
container has 2 GB; two evaluations holding 48-frame RGBA stacks each is
already most of it, so more workers would trade throughput for the OOM killer.

That trade was being lost at two. A warp over a full-size clip peaks near
900 MB, so a pair of them overruns MemoryMax=1400M and the OOM killer takes
the engine down -- which is not a slow render, it is a 502 for everyone with
the studio open, and a variants sweep queues exactly the burst that triggers
it. One render at a time is what the memory budget in clip.MAX_PIXELS is
sized against; raising this means lowering that.
"""

import threading
import time
import traceback
import uuid

MAX_WORKERS = 1
KEEP = 200

_jobs = {}
_order = []
_lock = threading.Lock()
_cv = threading.Condition(_lock)
_queue = []


class Job:
    __slots__ = ("id", "kind", "state", "progress", "note", "error", "result",
                 "created", "started", "finished", "cancel", "label", "fn")

    def __init__(self, kind, fn, label=""):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.fn = fn
        self.label = label
        self.state = "queued"
        self.progress = 0.0
        self.note = "waiting for the engine"
        self.error = None
        self.result = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self.cancel = False

    def public(self):
        return {"id": self.id, "kind": self.kind, "state": self.state,
                "progress": round(self.progress, 4), "note": self.note,
                "error": self.error, "result": self.result, "label": self.label,
                "created": self.created, "finished": self.finished,
                "waited": round((self.started or time.time()) - self.created, 2)}


def submit(kind, fn, label=""):
    """fn(job) -> result. It should call job.progress/note itself via set()."""
    job = Job(kind, fn, label)
    with _cv:
        _jobs[job.id] = job
        _order.append(job.id)
        _queue.append(job.id)
        _cv.notify()
        while len(_order) > KEEP:
            old = _order.pop(0)
            j = _jobs.get(old)
            if j and j.state in ("done", "error", "cancelled"):
                _jobs.pop(old, None)
            else:
                _order.append(old)
                break
    return job


def get(jid):
    with _lock:
        return _jobs.get(jid)


def cancel(jid):
    with _lock:
        job = _jobs.get(jid)
        if not job:
            return False
        job.cancel = True
        if job.state == "queued":
            job.state = "cancelled"
            job.note = "cancelled before it started"
            job.finished = time.time()
        return True


def set_progress(job, frac, note=""):
    job.progress = max(0.0, min(1.0, float(frac)))
    if note:
        job.note = note


def stats():
    with _lock:
        running = sum(1 for j in _jobs.values() if j.state == "running")
        return {"queued": len(_queue), "running": running, "known": len(_jobs)}


def _worker():
    while True:
        with _cv:
            while not _queue:
                _cv.wait()
            jid = _queue.pop(0)
            job = _jobs.get(jid)
        if not job or job.cancel:
            if job and job.state == "queued":
                job.state = "cancelled"
                job.finished = time.time()
            continue
        job.state = "running"
        job.started = time.time()
        job.note = "starting"
        try:
            job.result = job.fn(job)
            job.state = "cancelled" if job.cancel else "done"
            job.progress = 1.0
            job.note = "" if job.state == "done" else "cancelled"
        except Exception as e:
            job.state = "error"
            job.error = getattr(e, "msg", None) or str(e) or repr(e)
            job.note = ""
            idx = getattr(e, "index", None)
            if idx is not None:
                job.result = {"node": idx, "layer": getattr(e, "layer", None)}
            traceback.print_exc()
        finally:
            job.finished = time.time()


def start():
    for _ in range(MAX_WORKERS):
        threading.Thread(target=_worker, daemon=True).start()
