"""Job manager for videos found by the Violentmonkey userscript
(extras/violentmonkey/video-catcher.user.js) — that script watches
network traffic in the user's own real browser and, once they pick which
detected video they want, POSTs it to POST /api/extension/download. All
the "detection" already happened client-side by the time this module ever
sees a job, so there's no candidate-picker phase here at all — every job
goes straight to downloading the one item the user already chose, with
the Referer/Origin/User-Agent/Cookie headers their browser actually used,
since plenty of CDNs reject a request that doesn't carry them.

Same background-worker-thread shape as jobs.py/upload_jobs.py/
ytdlp_jobs.py.
"""
import json
import threading
import queue
import time
import uuid
from collections import deque
from pathlib import Path

from ..core import aria2
from ..utils import sanitize_filename
from . import video_optimize

TERMINAL_STATUSES = {"done", "done_with_errors", "error", "cancelled"}
INFLIGHT_STATUSES = {"queued", "downloading"}
MAX_HISTORY = 100
_HLS_DASH_EXTS = (".m3u8", ".mpd")


def _filename_from_url(url, fallback):
    from urllib.parse import urlsplit, unquote
    name = unquote(Path(urlsplit(url).path).name)
    return name or fallback


def _ext_from_url(url):
    from urllib.parse import urlsplit
    return Path(urlsplit(url).path).suffix


_KNOWN_MEDIA_EXTS = (
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".wmv",
    ".ts", ".3gp", ".mpg", ".mpeg", ".ogv", ".m3u8", ".mpd",
)


def _pick_filename(url, page_title, fallback):
    """Prefer the browser tab's title over the URL's own basename -- most
    HLS manifests are just called index.m3u8 regardless of what video they
    actually are (every stream off the same CDN collides on that name),
    while the tab title is what actually identifies the video.

    Plenty of file-hosting/video sites set their <title> to literally
    "<real filename>.<ext> - SiteName" (or without the dash) -- naively
    using the whole title and then appending another extension on top of
    that turned e.g. "Mila-Pie-MigiAoki.mp4 filester.me" into
    "Mila-Pie-MigiAoki.mp4 filester.me.mp4". Look for an already-known
    media extension embedded in the title first and cut there instead;
    only a title with no such extension anywhere falls through to
    appending one derived from the URL.
    """
    title = (page_title or "").strip()
    if title:
        low = title.lower()
        for ext in _KNOWN_MEDIA_EXTS:
            idx = low.find(ext)
            if idx == -1:
                continue
            end = idx + len(ext)
            # Only treat it as a real extension boundary, not a mid-word
            # coincidence (e.g. ".mp4converter") -- nothing alphanumeric
            # immediately after it.
            if end == len(title) or not title[end].isalnum():
                cut = sanitize_filename(title[:end])
                if cut and cut != "download.bin":
                    return cut
        return sanitize_filename(title) + (_ext_from_url(url) or ".mp4")
    return _filename_from_url(url, fallback)


def _unique_dest(path):
    """Never silently overwrite an existing file -- append " (2)", " (3)",
    etc. the same way a browser's own downloads do, since two different
    videos can easily land on the same name (same generic tab title, or
    both falling back to a manifest basename like index.m3u8)."""
    if not path.exists():
        return path
    stem, suffix, n = path.stem, path.suffix, 2
    while True:
        candidate = path.with_name(f"{stem} ({n}){suffix}")
        if not candidate.exists():
            return candidate
        n += 1


class ExtensionJob:
    def __init__(self, job_id, page_url, output_dir):
        self.id = job_id
        self.page_url = page_url
        self.output_dir = output_dir
        self.status = "queued"  # queued|downloading|done|done_with_errors|error|cancelled
        self.error = None
        self.items = []  # [{url, headers, filename, status, bytes_done, total, speed_kb, message, path}]
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None
        self.log_lines = deque(maxlen=500)
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()

    def _log(self, line):
        for l in str(line).splitlines():
            if l.strip():
                self.log_lines.append(l)

    def to_dict(self):
        with self.lock:
            return {
                "id": self.id,
                "page_url": self.page_url,
                "output_dir": self.output_dir,
                "status": self.status,
                "error": self.error,
                "items": [{k: v for k, v in it.items() if k != "headers"} for it in self.items],
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }

    def to_persist_dict(self):
        d = self.to_dict()
        d["log"] = list(self.log_lines)
        return d

    @classmethod
    def from_dict(cls, d):
        job = cls(d["id"], d["page_url"], d["output_dir"])
        job.status = d.get("status", "error")
        job.error = d.get("error")
        job.items = d.get("items") or []
        job.created_at = d.get("created_at") or time.time()
        job.started_at = d.get("started_at")
        job.finished_at = d.get("finished_at")
        for line in d.get("log") or []:
            job._log(line)
        return job

    def log_text(self):
        return "\n".join(self.log_lines)


class ExtensionJobManager:
    def __init__(self, base_output_dir, state_dir):
        self.base_output_dir = Path(base_output_dir)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._jobs_file = self.state_dir / "extension.json"

        self.jobs = {}
        self.order = []
        self._meta_lock = threading.Lock()
        self._queue = queue.Queue()

        self._load_persisted()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="extension-worker")
        self._worker.start()

    # ── persistence ──
    def _load_persisted(self):
        if not self._jobs_file.exists():
            return
        try:
            payload = json.loads(self._jobs_file.read_text())
        except Exception:
            return
        for jd in payload:
            try:
                job = ExtensionJob.from_dict(jd)
            except Exception:
                continue
            if job.status in INFLIGHT_STATUSES:
                job.status = "error"
                job.error = "Interrumpido (el servidor se reinició)"
                job.finished_at = job.finished_at or time.time()
            self.jobs[job.id] = job
            self.order.append(job.id)

    def _persist(self):
        with self._meta_lock:
            self._prune_locked()
            try:
                payload = [self.jobs[i].to_persist_dict() for i in self.order if i in self.jobs]
                tmp_path = self._jobs_file.with_suffix(".json.tmp")
                tmp_path.write_text(json.dumps(payload))
                tmp_path.replace(self._jobs_file)
            except Exception:
                pass

    def _prune_locked(self):
        excess = len(self.order) - MAX_HISTORY
        if excess <= 0:
            return
        keep = []
        for jid in self.order:
            job = self.jobs.get(jid)
            if excess > 0 and job and job.status in TERMINAL_STATUSES:
                del self.jobs[jid]
                excess -= 1
                continue
            keep.append(jid)
        self.order = keep

    # ── jobs ──
    def create_job(self, page_url, url, headers=None, filename=None, page_title=None, output_dir=None):
        page_url = (page_url or "").strip()
        url = (url or "").strip()
        if not url:
            raise ValueError("Falta la URL del video")
        out_dir = Path(output_dir).expanduser() if output_dir else self.base_output_dir
        job_id = uuid.uuid4().hex[:12]
        job = ExtensionJob(job_id, page_url or url, str(out_dir))
        # aria2 can't remux an HLS/DASH manifest itself, so those go through
        # ffmpeg instead -- known up front from the URL alone, no need to
        # wait until the download actually starts to show which one it'll be.
        engine = "ffmpeg" if url.split("?")[0].lower().endswith(_HLS_DASH_EXTS) else "aria2"
        job.items = [{
            "url": url, "headers": dict(headers or {}),
            "filename": filename or _pick_filename(url, page_title, f"{job_id}.mp4"),
            "status": "queued", "bytes_done": 0, "total": 0,
            "speed_kb": 0, "message": None, "path": None, "engine": engine,
        }]
        with self._meta_lock:
            self.jobs[job_id] = job
            self.order.append(job_id)
        self._persist()
        self._queue.put(job_id)
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)

    def list_jobs(self):
        with self._meta_lock:
            ids = list(reversed(self.order))
        return [self.jobs[i] for i in ids if i in self.jobs]

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return False
        with job.lock:
            if job.status == "queued":
                job.status = "cancelled"
                job.finished_at = time.time()
            elif job.status == "downloading":
                job.cancel_event.set()
                job.status = "cancelled"  # worker checks cancel_event and stops promptly
            else:
                return False
        self._persist()
        return True

    def delete_job(self, job_id):
        with self._meta_lock:
            job = self.jobs.get(job_id)
            if not job:
                return False
            if job.status not in TERMINAL_STATUSES:
                raise ValueError("Esperá a que termine antes de borrarlo")
            del self.jobs[job_id]
            self.order.remove(job_id)
        self._persist()
        return True

    def clear_finished(self):
        with self._meta_lock:
            to_remove = [jid for jid in self.order if jid in self.jobs and self.jobs[jid].status in TERMINAL_STATUSES]
            for jid in to_remove:
                del self.jobs[jid]
            self.order = [jid for jid in self.order if jid not in to_remove]
        self._persist()
        return len(to_remove)

    # ── worker ──
    def _worker_loop(self):
        while True:
            job_id = self._queue.get()
            job = self.jobs.get(job_id)
            if not job:
                continue
            with job.lock:
                if job.status == "cancelled":
                    continue
            try:
                self._run_download(job)
            except Exception as e:
                job._log(f"FATAL: {type(e).__name__}: {e}")
                with job.lock:
                    job.status = "error"
                    job.error = str(e)
                    job.finished_at = time.time()
                self._persist()

    def _run_download(self, job):
        with job.lock:
            job.status = "downloading"
            job.started_at = job.started_at or time.time()
        self._persist()
        Path(job.output_dir).mkdir(parents=True, exist_ok=True)

        last_persist = [0.0]
        for item in job.items:
            if job.cancel_event.is_set():
                with job.lock:
                    item["status"] = "cancelled"
                continue
            with job.lock:
                item["status"] = "running"
            self._persist()
            try:
                path = self._download_one(job, item, last_persist)
                with job.lock:
                    item["status"] = "done"
                    item["path"] = str(path)
                self._maybe_optimize(path)
            except Exception as e:
                job._log(f"{item['filename']}: {type(e).__name__}: {e}")
                with job.lock:
                    item["status"] = "failed"
                    item["message"] = str(e)
            self._persist()

        with job.lock:
            if job.cancel_event.is_set():
                job.status = "cancelled"
            else:
                failed = sum(1 for it in job.items if it["status"] == "failed")
                job.status = "done" if failed == 0 else "done_with_errors"
            job.finished_at = time.time()
        self._persist()

    def _download_one(self, job, item, last_persist):
        url = item["url"]
        headers = dict(item["headers"])
        is_hls = url.split("?")[0].lower().endswith(_HLS_DASH_EXTS)

        fname = Path(sanitize_filename(item["filename"]))
        # ffmpeg always muxes HLS/DASH to .mp4 (see _download_via_ffmpeg) --
        # resolve that *before* checking uniqueness below, otherwise two
        # different "index.m3u8" downloads would both pass the uniqueness
        # check (nothing else is ever named "index.m3u8" on disk) and only
        # collide once ffmpeg renames them both to "index.mp4".
        if is_hls and fname.suffix.lower() not in (".mp4", ".mkv"):
            fname = fname.with_suffix(".mp4")

        dest = _unique_dest(Path(job.output_dir) / fname)
        with job.lock:
            item["filename"] = dest.name

        if is_hls:
            return self._download_via_ffmpeg(job, item, url, headers, dest)

        tmp = dest.with_suffix(dest.suffix + ".part")

        def on_progress(done, total, speed_kb):
            with job.lock:
                item["bytes_done"] = done
                if total:
                    item["total"] = total
                item["speed_kb"] = speed_kb
            now = time.time()
            if now - last_persist[0] > 1:
                last_persist[0] = now
                self._persist()

        # This endpoint never uses a proxy (the userscript sends the URL
        # your own real browser already loaded it from), so it's always a
        # candidate for aria2's resumable, multi-connection fetch -- same
        # engine as the no-proxy SiteProvider path in core/downloader.py.
        status, msg = aria2.fetch(url, tmp, headers=headers, on_progress=on_progress,
                                   cancel_event=job.cancel_event)
        if status == "cancelled":
            raise RuntimeError("Cancelado")
        if status != "done":
            raise RuntimeError(msg or "aria2: fallo desconocido")

        tmp.replace(dest)
        return dest

    def _download_via_ffmpeg(self, job, item, url, headers, dest):
        # dest's extension and uniqueness are already resolved by the
        # caller (_download_one) before it decides to come down this path.
        import subprocess
        header_lines = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
        cmd = ["ffmpeg", "-y", "-nostdin"]
        if header_lines:
            cmd += ["-headers", header_lines]
        # -progress pipe:1 makes ffmpeg emit machine-readable key=value
        # progress lines (total_size=..., speed=...) on stdout instead of
        # its normal human-readable stats on stderr -- lets this report
        # live bytes_done the same way the aria2 path above does, and
        # having a real subprocess handle (Popen, not run()) is what makes
        # cancellation possible at all: a plain subprocess.run() call blocks
        # until ffmpeg finishes on its own with no way to interrupt it, so
        # "cancel" used to just set a flag nothing ever checked while the
        # download kept growing on disk regardless.
        cmd += ["-i", url, "-c", "copy", "-progress", "pipe:1", "-nostats", str(dest)]

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, bufsize=1)
        stderr_tail = deque(maxlen=15)

        def read_stderr():
            for line in proc.stderr:
                line = line.rstrip("\n")
                if line:
                    stderr_tail.append(line)
        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stderr_thread.start()

        last_persist_local = [0.0]
        last_size, last_time = 0, time.time()
        try:
            for line in proc.stdout:
                if job.cancel_event.is_set():
                    proc.terminate()
                    break
                line = line.strip()
                if line.startswith("total_size="):
                    try:
                        size = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    now = time.time()
                    elapsed = now - last_time
                    speed_kb = ((size - last_size) / 1024 / elapsed) if elapsed > 0 else 0
                    with job.lock:
                        item["bytes_done"] = size
                        item["speed_kb"] = speed_kb
                    last_size, last_time = size, now
                    if now - last_persist_local[0] > 1:
                        last_persist_local[0] = now
                        self._persist()
        finally:
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            stderr_thread.join(timeout=2)

        if job.cancel_event.is_set():
            dest.unlink(missing_ok=True)
            raise RuntimeError("Cancelado")
        if proc.returncode != 0:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg: {' | '.join(stderr_tail)[-500:]}")

        with job.lock:
            item["total"] = dest.stat().st_size
            item["bytes_done"] = item["total"]
        return dest

    def _maybe_optimize(self, path):
        if not path or not video_optimize.is_optimizable(Path(path).name):
            return
        try:
            video_optimize.optimize_video(path)
        except Exception:
            pass
