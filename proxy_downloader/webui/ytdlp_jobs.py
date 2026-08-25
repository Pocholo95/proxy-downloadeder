"""Background yt-dlp job manager — same shape as jobs.py/upload_jobs.py
(background worker thread, persisted history in state/) but a separate
engine from the SiteProvider-based downloader: yt-dlp does its own URL
resolution, HTTP fetching and audio/video muxing internally, so it doesn't
go through core/downloader.py or registry.py at all.

Reuses the same download output dir and the same proxy pool/cache as the
main engine (proxy_downloader.proxy), but with one real behavioral
difference: a job uses at most one proxy for its entire run, picked once
up front. yt-dlp has no hook to swap the proxy mid-download the way our
own downloader can when a proxy goes slow, so there's no rotation here —
"proxy" just means "use one", "no proxy"/"auto" mean "use the real IP".
"""
import json
import threading
import queue
import time
import uuid
from collections import deque
from pathlib import Path

import yt_dlp
from yt_dlp.utils import DownloadCancelled

from .. import proxy_sources
from . import video_optimize

TERMINAL_STATUSES = {"done", "error", "cancelled"}
INFLIGHT_STATUSES = {"queued", "running", "cancelling"}
MAX_HISTORY = 200


class _JobLogger:
    """Minimal logger yt-dlp writes its own status lines into — mirrors
    what jobs.py does with rich's console output, just simpler since
    yt-dlp's logger interface is 3 plain methods."""

    def __init__(self, job):
        self.job = job

    def debug(self, msg):
        if not msg.startswith("[debug] "):
            self.job._append_log(msg)

    def info(self, msg):
        self.job._append_log(msg)

    def warning(self, msg):
        self.job._append_log(f"⚠ {msg}")

    def error(self, msg):
        self.job._append_log(f"✗ {msg}")


class YtdlpJob:
    def __init__(self, job_id, url, output_dir, proxy_mode):
        self.id = job_id
        self.url = url
        self.output_dir = output_dir
        self.proxy_mode = proxy_mode  # "auto" | "proxy" | "no-proxy" — "auto" behaves like "no-proxy"
        self.status = "queued"  # queued|running|cancelling|done|error|cancelled
        self.error = None
        self.title = None
        self.filename = None
        self.bytes_done = 0
        self.total = 0
        self.speed_kb = 0
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None
        self.log_lines = deque(maxlen=1000)
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()

    def _append_log(self, line):
        for l in str(line).splitlines():
            if l.strip():
                self.log_lines.append(l)

    def to_dict(self):
        with self.lock:
            return {
                "id": self.id,
                "url": self.url,
                "output_dir": self.output_dir,
                "proxy_mode": self.proxy_mode,
                "status": self.status,
                "error": self.error,
                "title": self.title,
                "filename": self.filename,
                "bytes_done": self.bytes_done,
                "total": self.total,
                "speed_kb": self.speed_kb,
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
        job = cls(d["id"], d["url"], d["output_dir"], d.get("proxy_mode", "auto"))
        job.status = d.get("status", "error")
        job.error = d.get("error")
        job.title = d.get("title")
        job.filename = d.get("filename")
        job.bytes_done = d.get("bytes_done", 0)
        job.total = d.get("total", 0)
        job.speed_kb = d.get("speed_kb", 0)
        job.created_at = d.get("created_at") or time.time()
        job.started_at = d.get("started_at")
        job.finished_at = d.get("finished_at")
        for line in d.get("log") or []:
            job._append_log(line)
        return job

    def log_text(self):
        return "\n".join(self.log_lines)


def _collect_downloaded_paths(info):
    """requested_downloads carries the final (post-merge) filepath for a
    single video; a playlist nests one of these per entry instead."""
    if not isinstance(info, dict):
        return []
    paths = [d["filepath"] for d in (info.get("requested_downloads") or []) if d.get("filepath")]
    if paths:
        return paths
    for entry in info.get("entries") or []:
        paths.extend(_collect_downloaded_paths(entry))
    return paths


class YtdlpManager:
    def __init__(self, base_output_dir, state_dir):
        self.base_output_dir = Path(base_output_dir)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._jobs_file = self.state_dir / "ytdlp.json"

        self.jobs = {}
        self.order = []
        self._meta_lock = threading.Lock()
        self._queue = queue.Queue()

        self._load_persisted()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="ytdlp-worker")
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
                job = YtdlpJob.from_dict(jd)
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
    def create_job(self, url, output_dir=None, proxy_mode="auto"):
        url = (url or "").strip()
        if not url:
            raise ValueError("Falta la URL")
        if proxy_mode not in ("auto", "proxy", "no-proxy"):
            raise ValueError("proxy_mode debe ser auto, proxy o no-proxy")

        out_dir = Path(output_dir).expanduser() if output_dir else self.base_output_dir
        job_id = uuid.uuid4().hex[:12]
        job = YtdlpJob(job_id, url, str(out_dir), proxy_mode)
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
            elif job.status == "running":
                job.cancel_event.set()
                job.status = "cancelling"
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
                raise ValueError("Cancelá el trabajo antes de borrarlo")
            del self.jobs[job_id]
            self.order.remove(job_id)
        self._persist()
        return True

    def clear_finished(self):
        with self._meta_lock:
            to_remove = [jid for jid in self.order
                         if jid in self.jobs and self.jobs[jid].status in TERMINAL_STATUSES]
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
                job.status = "running"
                job.started_at = time.time()
            self._persist()
            try:
                self._run_job(job)
            except DownloadCancelled:
                with job.lock:
                    job.status = "cancelled"
                    job.finished_at = time.time()
                self._persist()
            except Exception as e:
                job._append_log(f"FATAL: {type(e).__name__}: {e}")
                with job.lock:
                    job.status = "error"
                    job.error = str(e)
                    job.finished_at = time.time()
                self._persist()

    def _pick_proxy(self, job):
        pool, error = proxy_sources.build_pool(str(self.state_dir / "working_proxies.json"))
        if not pool:
            job._append_log(error)
            return None
        return pool.get_next()

    def _run_job(self, job):
        Path(job.output_dir).mkdir(parents=True, exist_ok=True)

        proxy_url = None
        if job.proxy_mode == "proxy":
            proxy_url = self._pick_proxy(job)
            if not proxy_url:
                with job.lock:
                    job.status = "error"
                    job.error = "No hay proxies disponibles"
                    job.finished_at = time.time()
                self._persist()
                return

        last_persist = [0.0]

        def progress_hook(d):
            if job.cancel_event.is_set():
                raise DownloadCancelled("Cancelado por el usuario")
            status = d.get("status")
            with job.lock:
                if status == "downloading":
                    fname = d.get("filename")
                    if fname:
                        job.filename = Path(fname).name
                    job.bytes_done = d.get("downloaded_bytes") or 0
                    job.total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    job.speed_kb = (d.get("speed") or 0) / 1024
                elif status == "finished":
                    fname = d.get("filename")
                    if fname:
                        job.filename = Path(fname).name
                    if job.total:
                        job.bytes_done = job.total
            now = time.time()
            if now - last_persist[0] > 1:
                last_persist[0] = now
                self._persist()

        ydl_opts = {
            "outtmpl": str(Path(job.output_dir) / "%(title).200B [%(id)s].%(ext)s"),
            "progress_hooks": [progress_hook],
            "noprogress": True,
            "quiet": True,
            "logger": _JobLogger(job),
            "merge_output_format": "mp4",
            "format": "bv*+ba/b",
        }
        if proxy_url:
            ydl_opts["proxy"] = proxy_url
            job._append_log(f"Usando proxy: {proxy_url}")

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(job.url, download=True)
        except DownloadCancelled:
            raise
        except yt_dlp.utils.DownloadError as e:
            with job.lock:
                job.status = "error"
                job.error = str(e).replace("ERROR: ", "", 1)
                job.finished_at = time.time()
            self._persist()
            return

        with job.lock:
            job.title = (info or {}).get("title")
        for path in _collect_downloaded_paths(info):
            self._maybe_optimize(path)

        with job.lock:
            if job.total:
                job.bytes_done = job.total
            job.status = "done"
            job.finished_at = time.time()
        self._persist()

    def _maybe_optimize(self, path):
        if not path or not video_optimize.is_optimizable(Path(path).name):
            return
        try:
            video_optimize.optimize_video(path)
        except Exception:
            pass
