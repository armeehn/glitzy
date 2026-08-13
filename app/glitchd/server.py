"""HTTP API and static host for the studio.

Python's stdlib http.server, on purpose: the container has no pip story beyond
apt, and this has to survive a Debian upgrade untouched. numpy and Pillow are
the only dependencies, and both come from apt.

One rule that is not obvious and cost a day in v1: do_POST must read the
request body BEFORE replying, every time, even to reject it. Reply without
draining and those bytes stay in the socket; the next request on the same
keep-alive connection is parsed starting inside them, which surfaces as a
random 501 and an upload that vanished.
"""

import ipaddress
import json
import os
import re
import shutil
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import exporters, ff, graph, jobs, ops, store
from .graph import ChainError

PORT = int(os.environ.get("GLITCHSHEET_PORT", "8090"))
WEB_DIR = os.environ.get("GLITCHSHEET_WEB", "/opt/glitchsheet2/web")
EXPORT_DIR = os.path.join(store.DATA_DIR, "exports")
MAX_UPLOAD = 400 * 1024 * 1024
VERSION = "2.0"

HASH_RE = re.compile(r"^[a-f0-9]{40}$")
ID_RE = re.compile(r"^[a-f0-9]{12}$")

MIME_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/bmp": ".bmp", "image/tiff": ".tif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "video/x-matroska": ".mkv", "video/mpeg": ".mpg", "video/x-msvideo": ".avi",
}

CTYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json",
    ".ico": "image/png", ".map": "application/json",
}

FAVICON = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d49444154789c6360f0477d0700030d0140f0b4f4"
    "790000000049454e44ae426082")


class Handler(BaseHTTPRequestHandler):
    server_version = "glitchd/%s" % VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # the systemd unit's own logging is enough; per-request noise is not

    # -- plumbing ---------------------------------------------------------
    def send_json(self, obj, code=200):
        self.send_bytes(json.dumps(obj).encode(), "application/json", code=code)

    def send_bytes(self, body, ctype, cache="no-store", code=200, filename=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if filename:
            self.send_header("Content-Disposition",
                             'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg, **extra):
        self.send_json(dict({"error": msg}, **extra), code)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            left = n  # drain anyway, or the connection is unusable
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                left -= len(chunk)
            return None
        return self.rfile.read(n) if n else b""

    def json_body(self):
        try:
            return json.loads(self._body or b"{}"), None
        except Exception:
            return None, "Malformed request."

    # -- GET --------------------------------------------------------------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p, q = u.path, urllib.parse.parse_qs(u.query)

        if p == "/favicon.ico":
            return self.send_bytes(FAVICON, "image/png", "public, max-age=86400")

        if p == "/api/health":
            return self.send_json({
                "ok": True, "version": VERSION, "ffglitch": "0.10.2",
                "jobs": jobs.stats(), "cache": store.cache_stats(),
                "ops": len(ops.REGISTRY)})

        if p == "/api/ops":
            return self.send_json(ops.public_registry())

        if p == "/api/sources":
            return self.send_json({"sources": store.list_sources()})

        if p == "/api/projects":
            return self.send_json({"projects": store.list_projects()})

        m = re.match(r"^/api/project/([a-f0-9]{12})$", p)
        if m:
            doc = store.load_project(m.group(1))
            return self.send_json(doc) if doc else self.fail(404, "No such project.")

        m = re.match(r"^/api/job/([a-f0-9]{12})$", p)
        if m:
            job = jobs.get(m.group(1))
            return self.send_json(job.public()) if job else self.fail(404, "No such job.")

        m = re.match(r"^/api/node/([a-f0-9]{40})$", p)
        if m:
            meta = store.cache_meta(m.group(1))
            return self.send_json(meta) if meta else self.fail(404, "Not cached.")

        m = re.match(r"^/api/node/([a-f0-9]{40})/(frame|thumb)/(\d+)", p)
        if m:
            h, which, n = m.group(1), m.group(2), int(m.group(3))
            name, ct = (("f_%05d.png" % n, "image/png") if which == "frame"
                        else ("t_%05d.jpg" % n, "image/jpeg"))
            fp = store.cache_path(h, name)
            if not os.path.isfile(fp):
                return self.fail(404, "No such frame.")
            with open(fp, "rb") as fh:
                # Content-addressed, so the bytes behind a URL never change.
                return self.send_bytes(fh.read(), ct, "public, max-age=31536000, immutable")

        m = re.match(r"^/api/download/([a-f0-9]{12})$", p)
        if m:
            return self.serve_export(m.group(1))

        return self.serve_static(p)

    def serve_static(self, p):
        rel = p.lstrip("/") or "index.html"
        if ".." in rel or rel.startswith("/"):
            return self.fail(400, "no")
        fp = os.path.join(WEB_DIR, rel)
        if os.path.isdir(fp):
            fp = os.path.join(fp, "index.html")
        if not os.path.isfile(fp):
            return self.fail(404, "Not found.")
        ext = os.path.splitext(fp)[1]
        with open(fp, "rb") as fh:
            cache = "public, max-age=3600" if ext in (".woff2",) else "no-cache"
            return self.send_bytes(fh.read(),
                                   CTYPES.get(ext, "application/octet-stream"), cache)

    def serve_export(self, jid):
        d = os.path.join(EXPORT_DIR, jid)
        if not os.path.isdir(d):
            return self.fail(404, "That export has expired.")
        names = os.listdir(d)
        if not names:
            return self.fail(404, "That export is empty.")
        fp = os.path.join(d, names[0])
        ext = os.path.splitext(fp)[1]
        with open(fp, "rb") as fh:
            return self.send_bytes(fh.read(), CTYPES.get(ext, "application/octet-stream"),
                                   code=200, filename=names[0])

    # -- POST / DELETE ----------------------------------------------------
    def do_DELETE(self):
        self._body = self.read_body()
        p = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/source/([a-f0-9]{12})$", p)
        if m:
            return self.send_json({"ok": store.delete_source(m.group(1))})
        m = re.match(r"^/api/project/([a-f0-9]{12})$", p)
        if m:
            return self.send_json({"ok": store.delete_project(m.group(1))})
        return self.fail(404, "Not found.")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        p, q = u.path, urllib.parse.parse_qs(u.query)
        body = self.read_body()          # ALWAYS drain first -- see module docstring
        if body is None:
            return self.fail(413, "That upload is too large.")
        self._body = body

        if p == "/api/source":
            return self.upload_source(q)
        if p == "/api/source/url":
            return self.fetch_source()
        if p == "/api/eval":
            return self.start_eval()
        if p == "/api/variants":
            return self.start_variants()
        if p == "/api/export":
            return self.start_export()
        if p == "/api/project":
            return self.save_project()
        m = re.match(r"^/api/job/([a-f0-9]{12})/cancel$", p)
        if m:
            return self.send_json({"ok": jobs.cancel(m.group(1))})
        return self.fail(404, "Not found.")

    # -- sources ----------------------------------------------------------
    def upload_source(self, q):
        if not self._body:
            return self.fail(400, "Empty upload.")
        name = os.path.basename((q.get("name") or ["upload"])[0])[:80]
        ext = os.path.splitext(name)[1].lower()
        if not re.match(r"^\.[a-z0-9]{1,5}$", ext):
            ext = ".bin"
        sid = store.new_source()
        d = os.path.join(store.SRC_DIR, sid)
        fp = os.path.join(d, "src" + ext)
        with open(fp, "wb") as fh:
            fh.write(self._body)
        probe = ff.probe(fp)
        if not probe:
            shutil.rmtree(d, ignore_errors=True)
            return self.fail(400, "That file could not be decoded.")
        meta = store.write_source_meta(sid, {
            "name": name, "file": os.path.basename(fp), "bytes": len(self._body),
            "kind": "video" if probe["duration"] > 0.3 else "image", **probe})
        return self.send_json(dict(meta, id=sid))

    def fetch_source(self):
        req, err = self.json_body()
        if err:
            return self.fail(400, err)
        url = (req.get("url") or "").strip()
        if not url:
            return self.fail(400, "Paste a URL first.")
        sid = store.new_source()
        d = os.path.join(store.SRC_DIR, sid)
        path, err = fetch_url(url, d)
        if err:
            shutil.rmtree(d, ignore_errors=True)
            return self.fail(400, err)
        probe = ff.probe(path)
        if not probe:
            shutil.rmtree(d, ignore_errors=True)
            return self.fail(400, "That downloaded fine but is not an image or "
                                  "video we can decode.")
        base = os.path.basename(urllib.parse.urlparse(url).path) or ""
        if not re.search(r"\.[A-Za-z0-9]{1,5}$", base):
            # A URL like /seed/x/800/600 has no filename; fall back to the host
            # so the chip does not read "600".
            base = (urllib.parse.urlparse(url).hostname or "download") + \
                os.path.splitext(path)[1]
        meta = store.write_source_meta(sid, {
            "name": base[:80], "file": os.path.basename(path),
            "bytes": os.path.getsize(path), "source_url": url,
            # Still vs clip is decided by duration, never by extension or MIME.
            "kind": "video" if probe["duration"] > 0.3 else "image", **probe})
        return self.send_json(dict(meta, id=sid))

    # -- evaluation -------------------------------------------------------
    def start_eval(self):
        req, err = self.json_body()
        if err:
            return self.fail(400, err)
        chain = req.get("chain")
        upto = req.get("upto")
        upto = int(upto) if isinstance(upto, (int, float)) else None
        if req.get("preview"):
            chain = graph.preview_chain(chain if isinstance(chain, list) else [], upto)
        try:
            plan = graph.prepare(chain, upto)
        except ChainError as e:
            return self.fail(400, e.msg, node=e.index)

        label = " → ".join(n["label"] for n in plan if not n["off"])[:80]

        def work(job):
            return graph.evaluate(
                chain, upto,
                progress=lambda f, note: jobs.set_progress(job, f, note),
                cancelled=lambda: job.cancel)

        job = jobs.submit("eval", work, label)
        # Report which nodes are already cached so the studio can show the
        # chain lighting up instantly instead of pretending to work.
        warm = [n["hash"] for n in plan if not n["off"] and store.cached(n["hash"])]
        return self.send_json({"job": job.id, "planned": len(plan),
                               "cached": len(warm), "label": label})

    def start_variants(self):
        """Sweep one parameter across a set of values and evaluate each.

        This is the experiment button. Every variant shares the cached prefix
        up to the node being swept, so twelve variants of the last node cost
        twelve cheap tails, not twelve whole chains.
        """
        req, err = self.json_body()
        if err:
            return self.fail(400, err)
        chain = req.get("chain")
        idx = req.get("index")
        param = req.get("param")
        values = req.get("values")
        if not isinstance(chain, list) or not isinstance(idx, int) \
                or not 0 <= idx < len(chain):
            return self.fail(400, "Point the sweep at a node in the chain.")
        if not isinstance(values, list) or not 1 <= len(values) <= 24:
            return self.fail(400, "A sweep is 1 to 24 values.")
        entry = ops.get((chain[idx] or {}).get("op"))
        if not entry:
            return self.fail(400, "That node has no op.")
        if param not in [s["k"] for s in entry["params"]]:
            return self.fail(400, "%s has no parameter called %r."
                             % (entry["label"], param))

        variants = []
        for v in values:
            c = [dict(n) for n in chain]
            node = dict(c[idx])
            node["params"] = dict(node.get("params") or {}, **{param: v})
            node["off"] = False
            c[idx] = node
            variants.append((v, c))

        def work(job):
            out = []
            for k, (v, c) in enumerate(variants):
                if job.cancel:
                    break
                jobs.set_progress(job, k / len(variants),
                                  "variant %d of %d" % (k + 1, len(variants)))
                try:
                    res = graph.evaluate(
                        c, None,
                        progress=lambda f, note, k=k: jobs.set_progress(
                            job, (k + f) / len(variants), note),
                        cancelled=lambda: job.cancel)
                    out.append({"value": v, "hash": res["hash"],
                                "notes": res["notes"]})
                except ChainError as e:
                    # One bad value must not lose the other eleven results.
                    out.append({"value": v, "error": e.msg, "node": e.index})
            return {"variants": out, "param": param, "index": idx}

        job = jobs.submit("variants", work,
                          "%s · %s × %d" % (entry["label"], param, len(values)))
        return self.send_json({"job": job.id, "count": len(variants)})

    def start_export(self):
        req, err = self.json_body()
        if err:
            return self.fail(400, err)
        kind = req.get("kind") or "png"

        def work(job):
            jobs.set_progress(job, 0.1, "rendering")
            overflow = 0
            if kind == "sheet":
                items = req.get("items") or []
                if not isinstance(items, list) or not items:
                    raise ValueError("Nothing on the sheet — keep a design first.")
                body, ct, name, overflow = exporters.export_sheet(
                    items[:60], req.get("machine") or "generic",
                    int(req.get("dpi") or 300), req.get("name"))
            else:
                h = req.get("hash") or ""
                if not store.cached(h):
                    raise ValueError("That result is no longer cached — re-run the chain.")
                frame = int(req.get("frame") or 0)
                mm = float(req.get("mm") or 76)
                dpi = int(req.get("dpi") or 300)
                if kind == "sequence":
                    body, ct, name = exporters.export_sequence(h, mm, dpi, req.get("raw", True))
                elif kind in ("gif", "apng"):
                    body, ct, name = exporters.export_animation(h, kind)
                elif kind == "contact":
                    body, ct, name = exporters.contact_sheet(req.get("hashes") or [h])
                else:
                    body, ct, name = exporters.export_png(h, frame, mm, dpi,
                                                          bool(req.get("raw")))
            jobs.set_progress(job, 0.9, "writing")
            d = os.path.join(EXPORT_DIR, job.id)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name), "wb") as fh:
                fh.write(body)
            _prune_exports()
            return {"url": "/api/download/" + job.id, "name": name,
                    "bytes": len(body), "type": ct, "overflow": overflow}

        job = jobs.submit("export", work, kind)
        return self.send_json({"job": job.id})

    def save_project(self):
        req, err = self.json_body()
        if err:
            return self.fail(400, err)
        pid = req.get("id") or store.new_id()
        if not ID_RE.match(pid):
            pid = store.new_id()
        doc = {"id": pid, "name": (req.get("name") or "untitled")[:80],
               "chain": req.get("chain") or [], "tray": req.get("tray") or [],
               "sticker": req.get("sticker") or {}, "version": VERSION}
        return self.send_json(store.save_project(pid, doc))


# ---------------------------------------------------------------------------
# Remote fetch
# ---------------------------------------------------------------------------

def safe_remote_url(url):
    """Allow http(s) to a real host. Refuse loopback and link-local so a fetch
    cannot be aimed back at this engine or at cloud metadata."""
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return "That is not a URL."
    if u.scheme not in ("http", "https"):
        return "Only http and https URLs can be fetched."
    if not u.hostname:
        return "That URL has no host."
    try:
        infos = socket.getaddrinfo(u.hostname, None)
    except socket.gaierror:
        return "That host does not resolve."
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            return "That address is not allowed."
    return None


def fetch_url(url, dest_dir):
    bad = safe_remote_url(url)
    if bad:
        return None, bad
    os.makedirs(dest_dir, exist_ok=True)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Glitchsheet/2.0 (+https://glitchsheet.hq)",
        "Accept": "image/*,video/*;q=0.9,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            declared = int(r.headers.get("Content-Length") or 0)
            if declared and declared > MAX_UPLOAD:
                return None, "That file is larger than %d MB." % (MAX_UPLOAD >> 20)
            ext = MIME_EXT.get(ctype) or os.path.splitext(
                urllib.parse.urlparse(url).path)[1].lower()
            if not re.match(r"^\.[a-z0-9]{1,5}$", ext or ""):
                ext = ".bin"
            path = os.path.join(dest_dir, "src" + ext)
            total = 0
            with open(path, "wb") as fh:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UPLOAD:
                        fh.close()
                        os.unlink(path)
                        return None, "That file is larger than %d MB." % (MAX_UPLOAD >> 20)
                    fh.write(chunk)
    except urllib.error.HTTPError as e:
        return None, "The server answered %s." % e.code
    except urllib.error.URLError as e:
        return None, "Could not reach it: %s" % (getattr(e, "reason", e),)
    except (socket.timeout, TimeoutError):
        return None, "That download timed out."
    except Exception as e:
        return None, "Download failed: %r" % (e,)
    if total == 0:
        return None, "That URL returned nothing."
    return path, None


def _prune_exports(keep=40):
    try:
        entries = [(os.path.getmtime(os.path.join(EXPORT_DIR, e)), e)
                   for e in os.listdir(EXPORT_DIR)]
    except FileNotFoundError:
        return
    entries.sort(reverse=True)
    for _, e in entries[keep:]:
        shutil.rmtree(os.path.join(EXPORT_DIR, e), ignore_errors=True)


def main():
    store.init()
    os.makedirs(EXPORT_DIR, exist_ok=True)
    ops.load_all()
    jobs.start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
