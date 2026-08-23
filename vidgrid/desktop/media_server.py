"""Local-only HTTP server (127.0.0.1) serving four things:

- The built dist/ folder at the server root (matches vite.config.ts's
  `base: "/"` -- root-relative asset paths resolve correctly here, unlike
  a bare file:// load).
- Arbitrary user-selected video files under /media/<token>, with HTTP Range
  support so the browser's native <video> element can seek exactly like it
  does today with blob URLs -- without ever loading the whole file into the
  JS heap.
- A JSON API under /api/* (desktop/api.py's Api class) plus an /api/events
  Server-Sent Events stream for ffmpeg log/progress push -- this is the
  frontend's bridge to the Python backend now that the UI runs in the
  user's regular browser instead of an embedded pywebview window.
- /api/upload_input, which streams a browser-picked file's bytes straight
  to a local temp copy (browsers don't expose real filesystem paths from
  <input type=file>, and ffmpeg needs one) and hands back that copy's path.

Tokens are random and only ever map to paths the app itself registered
(via register_media()) -- raw filesystem paths are never accepted in URLs.
"""

import http.server
import json
import mimetypes
import os
import queue
import re
import secrets
import shutil
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable

from .events import subscribe as _subscribe_events
from .events import unsubscribe as _unsubscribe_events

_MEDIA_REGISTRY: dict[str, str] = {}
_MEDIA_LAST_ACCESS: dict[str, float] = {}
_DIST_DIR = ""
_API: Any = None
_UPLOAD_DIR = ""

_RouteFn = Callable[[Any, dict], Any]

_ROUTES: dict[tuple[str, str], _RouteFn] = {
    ("GET", "/api/check_ffmpeg"): lambda api, body: api.check_ffmpeg(),
    ("GET", "/api/cpu_count"): lambda api, body: {"count": api.get_cpu_count()},
    ("GET", "/api/shared_dir"): lambda api, body: {"path": api.shared_dir()},
    ("POST", "/api/scan_path"): lambda api, body: api.scan_path(body["path"]),
    ("POST", "/api/probe_metadata"): lambda api, body: api.probe_metadata(body["path"]),
    ("POST", "/api/register_media"): lambda api, body: api.register_media(body["path"]),
    ("POST", "/api/tasks/bind_input"): (
        lambda api, body: api.bind_input_path(body["taskId"], body["path"]) or {}
    ),
    ("POST", "/api/tasks/exec"): (
        lambda api, body: api.exec_ffmpeg(
            body["taskId"], body["args"], body.get("durationHint")
        )
        or {}
    ),
    ("POST", "/api/tasks/write_file"): (
        lambda api, body: api.write_task_file(
            body["taskId"], body["filename"], body["dataB64"]
        )
        or {}
    ),
    ("POST", "/api/tasks/read_file"): (
        lambda api, body: {
            "dataB64": api.read_task_file(body["taskId"], body["filename"])
        }
    ),
    ("POST", "/api/tasks/list_dir"): (
        lambda api, body: {
            "entries": api.list_task_dir(body["taskId"], body.get("subpath", ""))
        }
    ),
    ("POST", "/api/tasks/delete_file"): (
        lambda api, body: api.delete_task_file(body["taskId"], body["filename"]) or {}
    ),
    ("POST", "/api/tasks/abort"): lambda api, body: api.abort_task(body["taskId"]) or {},
    ("POST", "/api/tasks/reset"): lambda api, body: api.reset_task(body["taskId"]) or {},
}


def register_media(path: str) -> str:
    """Register a real file path for serving; returns its /media/<token> path segment."""
    token = secrets.token_urlsafe(16)
    _MEDIA_REGISTRY[token] = path
    _MEDIA_LAST_ACCESS[token] = time.time()
    return token


def unregister_media(token: str) -> None:
    _MEDIA_REGISTRY.pop(token, None)
    _MEDIA_LAST_ACCESS.pop(token, None)


def prune_media_registry(timeout_seconds: float) -> int:
    """Drops any /media/<token> registration nobody's fetched (registration
    counts as a fetch too) in timeout_seconds -- these are cheap (a dict
    entry pointing at a path, not a copy of the file), but on a long-running
    server they'd otherwise accumulate one per video ever previewed/played,
    forever. Never touches _UPLOAD_DIR files directly; TaskSession cleanup
    (api.py's sweep_idle_sessions) owns deleting those, this only forgets
    the /media/ token that pointed at one. Returns how many were dropped."""
    now = time.time()
    stale = [t for t, last in _MEDIA_LAST_ACCESS.items() if now - last > timeout_seconds]
    for token in stale:
        unregister_media(token)
    return len(stale)


def upload_dir() -> str:
    """Directory browser-uploaded input files land in (see _handle_upload
    below) -- a function rather than exporting _UPLOAD_DIR directly since
    it's only set once MediaServer.__init__ runs, not at import time.
    Used by ffmpeg_runner.TaskSession.cleanup() to tell an uploaded file
    (safe/expected to delete once its task is done) apart from a
    scan_path()'d file living wherever the user's own filesystem has it
    (never ours to delete)."""
    return _UPLOAD_DIR


def _parse_range(range_header: str, size: int) -> tuple[int, int]:
    m = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
    if not m:
        raise ValueError(f"Unsupported Range header: {range_header!r}")
    start_s, end_s = m.groups()
    if start_s == "" and end_s == "":
        raise ValueError("Empty Range header")
    if start_s == "":
        length = int(end_s)
        start = max(0, size - length)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    end = min(end, size - 1)
    if start < 0 or start > end:
        raise ValueError("Range not satisfiable")
    return start, end


class MediaHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/events":
            self._serve_events()
        elif path.startswith("/api/"):
            self._serve_api("GET")
        elif self.path.startswith("/media/"):
            self._serve_media(head_only=False)
        else:
            self._serve_dist(head_only=False)

    def do_HEAD(self) -> None:
        if self.path.startswith("/media/"):
            self._serve_media(head_only=True)
        else:
            self._serve_dist(head_only=True)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/upload_input":
            self._handle_upload()
        elif path.startswith("/api/"):
            self._serve_api("POST")
        else:
            self.send_error(404, "Not found")

    def _handle_upload(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        raw_name = (query.get("name") or ["upload"])[0]
        safe_name = os.path.basename(raw_name) or "upload"
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send_json(400, {"error": "Missing or empty request body"})
            return

        dest = os.path.join(_UPLOAD_DIR, f"{secrets.token_hex(8)}_{safe_name}")
        try:
            with open(dest, "wb") as f:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
        except OSError as e:
            self._send_json(500, {"error": f"Failed to save upload: {e}"})
            return

        token = register_media(dest)
        self._send_json(200, {"path": dest, "token": token})

    def _serve_api(self, method: str) -> None:
        route = _ROUTES.get((method, self.path.split("?", 1)[0]))
        if route is None:
            self._send_json(404, {"error": "Unknown API route"})
            return
        body: dict = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    self._send_json(400, {"error": "Invalid JSON body"})
                    return
        try:
            result = route(_API, body)
        except Exception as e:  # noqa: BLE001 -- relayed to the frontend as-is
            self._send_json(500, {"error": str(e)})
            return
        self._send_json(200, result)

    def _send_json(self, status: int, payload) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_events(self) -> None:
        """SSE stream of ffmpeg log/progress events (desktop/events.py).

        No Content-Length/chunked framing: this handler never returns while
        the connection is alive, so there's no next-response boundary on
        this socket for a client to misparse -- browsers' EventSource reads
        it as an open byte stream regardless.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = _subscribe_events()
        try:
            while True:
                try:
                    data = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionError, OSError):
            pass
        finally:
            _unsubscribe_events(q)

    def _serve_media(self, head_only: bool) -> None:
        token = self.path[len("/media/"):].split("?", 1)[0]
        path = _MEDIA_REGISTRY.get(token)
        if path is None or not os.path.isfile(path):
            self.send_error(404, "Unknown or missing media token")
            return
        _MEDIA_LAST_ACCESS[token] = time.time()

        size = os.path.getsize(path)
        range_header = self.headers.get("Range")
        start, end, status = 0, size - 1, 200
        if range_header:
            try:
                start, end = _parse_range(range_header, size)
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return

        content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        length = end - start + 1
        self.send_response(status)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only:
            return

        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def _serve_dist(self, head_only: bool) -> None:
        dist_root = Path(_DIST_DIR).resolve()
        rel = self.path.split("?", 1)[0].lstrip("/")
        candidate = (dist_root / (rel or "index.html")).resolve()

        if not candidate.is_relative_to(dist_root):
            self.send_error(403, "Forbidden")
            return
        if not candidate.is_file():
            candidate = dist_root / "index.html"
            if not candidate.is_file():
                self.send_error(404, "Not found")
                return

        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        super().log_message(format, *args)


class MediaServer:
    """Owns the ThreadingHTTPServer lifecycle.

    Binds to 127.0.0.1 with an OS-assigned ephemeral port by default,
    matching the desktop app's original "only this machine, ever" trust
    model. host/port are overridable (e.g. to bind "0.0.0.0" with a fixed
    port for a container deployment reachable over a private network) --
    see desktop/app.py, which reads VIDGRID_HOST/VIDGRID_PORT for this.
    """

    def __init__(self, dist_dir: str, api: Any, host: str = "127.0.0.1", port: int = 0):
        global _DIST_DIR, _API, _UPLOAD_DIR
        _DIST_DIR = dist_dir
        _API = api
        _UPLOAD_DIR = tempfile.mkdtemp(prefix="vidgrid_uploads_")
        self._host = host
        self._httpd = http.server.ThreadingHTTPServer(
            (host, port), MediaHTTPRequestHandler
        )
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    @property
    def base_url(self) -> str:
        # Always show 127.0.0.1 here even when bound to 0.0.0.0 -- that's
        # not itself a reachable address, and this URL is only ever used
        # for the local webbrowser.open() call / a human-readable log line.
        return f"http://127.0.0.1:{self.port}/"

    def start(self) -> None:
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if _UPLOAD_DIR:
            shutil.rmtree(_UPLOAD_DIR, ignore_errors=True)
