"""Background gallery-dl job manager -- same shape as ytdlp_jobs.py
(background worker thread, persisted history in state/) but for the sites
handled by the gallery-dl library (Bunkr, Gofile, Filester) instead of this
project's own SiteProvider/core/downloader.py path. Pixeldrain moved here
and then back to the SiteProvider path (see sites/__init__.py) -- gallery-dl's
Pixeldrain extractor errored out too often in practice.

Proxy rotation is handled by gallery_downloader.RotatingHttpDownloader (mid-
download, speed-based) plus a coarser whole-job retry-with-a-fresh-proxy
here (needed for a proxy that's dead outright rather than just slow -- see
gallery_downloader's module docstring for why the mid-download hook alone
can't recover from that case; verified live that retrying the whole job with
"skip existing" on resumes cleanly rather than re-fetching what already
finished).
"""
import json
import threading
import queue
import time
import uuid
from collections import deque
from pathlib import Path

import gallery_dl.config
import gallery_dl.extractor
import gallery_dl.job

from .. import proxy_sources
from .. import site_prefs
from ..config import MIN_SPEED_KB
from . import gallery_downloader
from . import video_optimize

TERMINAL_STATUSES = {"done", "done_with_errors", "error", "cancelled"}
INFLIGHT_STATUSES = {"queued", "running", "cancelling"}
MAX_HISTORY = 200
MAX_PROXY_ATTEMPTS = 5  # whole-job retries with a fresh proxy on a hard (not just slow) failure

# Carried over from the old SiteProvider.use_proxy_by_default values (same
# site_prefs.py store, same config/<site>.json files) so "auto" resolves to
# what each site actually needs instead of one blanket behavior. Bunkr's CDN
# treats proxied traffic as suspicious and rate-limits/blocks it -- proxy
# there is actively counterproductive, hence the one False among the three.
# Pixeldrain moved back to the original SiteProvider path (see
# sites/__init__.py) -- its proxy preference lives in JobManager/registry.py
# now, same site_prefs.py store, not here.
GALLERY_SITE_DEFAULTS = {
    "bunkr": False,
    "gofile": True,
    "filester": True,
}

GALLERY_SITE_DOMAINS = {
    "bunkr": ["bunkr.si", "bunkr.sk", "bunkr.ph", "bunkr.cr", "bunkr.is", "bunkr.to"],
    "gofile": ["gofile.io"],
    "filester": ["filester.me", "filester.gg"],
}


class GalleryJob:
    def __init__(self, job_id, url, output_dir, proxy_mode, min_speed_kb=None,
                 batch_id=None, batch_label=None, site=None):
        self.id = job_id
        self.url = url
        self.output_dir = output_dir
        self.proxy_mode = proxy_mode  # "auto" | "proxy" | "no-proxy" -- "auto" resolves per-site via site_prefs/GALLERY_SITE_DEFAULTS
        self.min_speed_kb = min_speed_kb or MIN_SPEED_KB
        self.batch_id = batch_id
        self.batch_label = batch_label
        # The real site (bunkr/gofile/filester), not just "gallery-dl" --
        # resolved once via gallery_dl.extractor.find() so the UI can show
        # the same per-site badge/color it already uses for everything else
        # instead of one generic label for all three.
        self.site = site or "gallery-dl"
        self.status = "queued"  # queued|running|cancelling|done|done_with_errors|error|cancelled
        self.error = None
        self.items = []  # [{filename, bytes_done, total, speed_kb, status}], populated live
        self.proxy_pool = None  # set by _run_job when proxy_mode=="proxy"; read by gallery_downloader's hook
        self.log_lines = deque(maxlen=1000)
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None

    def log(self, line):
        with self.lock:
            for l in str(line).splitlines():
                if l.strip():
                    self.log_lines.append(l)

    def report_progress(self, path, bytes_done, total, speed_kb):
        """Called from gallery_downloader's receive hook, on the worker
        thread. gallery-dl streams files one at a time with no upfront
        manifest, so a new path showing up means the previous item (if any)
        is done and a new one has started. `path` is whatever the open file
        object's .name is -- the real on-disk path (gallery-dl nests files
        under base-directory by category/album, not flat), kept around so
        _maybe_optimize() can find the file; `filename` is just the display
        basename."""
        path = str(path)
        if path.endswith(".part"):
            path = path[: -len(".part")]
        with self.lock:
            if not self.items or self.items[-1]["path"] != path:
                if self.items:
                    self.items[-1]["status"] = "done"
                    self.items[-1]["speed_kb"] = 0
                self.items.append({"path": path, "filename": Path(path).name, "bytes_done": 0,
                                    "total": 0, "speed_kb": 0, "status": "running"})
            item = self.items[-1]
            item["bytes_done"] = bytes_done
            item["total"] = total
            item["speed_kb"] = speed_kb

    def to_dict(self):
        with self.lock:
            items = list(self.items)
            done_bytes = sum(it.get("bytes_done") or 0 for it in items)
            total_bytes = sum(it.get("total") or 0 for it in items)
            speed_kb = items[-1]["speed_kb"] if items and items[-1]["status"] == "running" else 0
            return {
                "id": self.id,
                "url": self.url,
                "site": self.site,
                "output_dir": self.output_dir,
                "proxy_mode": self.proxy_mode,
                "min_speed_kb": self.min_speed_kb,
                "status": self.status,
                "error": self.error,
                "batch_id": self.batch_id,
                "batch_label": self.batch_label,
                "items": items,
                "bytes_done": done_bytes,
                "total": total_bytes,
                "speed_kb": speed_kb,
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
        job = cls(d["id"], d["url"], d["output_dir"], d.get("proxy_mode", "auto"),
                   min_speed_kb=d.get("min_speed_kb"), site=d.get("site"),
                   batch_id=d.get("batch_id"), batch_label=d.get("batch_label"))
        job.status = d.get("status", "error")
        job.error = d.get("error")
        job.items = d.get("items") or []
        job.created_at = d.get("created_at") or time.time()
        job.started_at = d.get("started_at")
        job.finished_at = d.get("finished_at")
        for line in d.get("log") or []:
            job.log(line)
        return job

    def log_text(self):
        return "\n".join(self.log_lines)


class GalleryJobManager:
    def __init__(self, base_output_dir, state_dir):
        self.base_output_dir = Path(base_output_dir)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._jobs_file = self.state_dir / "gallery.json"

        self.jobs = {}
        self.order = []
        self._meta_lock = threading.Lock()
        self._queue = queue.Queue()

        gallery_downloader.install()
        gallery_downloader.install_logging()

        self._ensure_config_files()
        self._load_persisted()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="gallery-worker")
        self._worker.start()

    # ── site config (mirrors jobs.py's JobManager, same config/<site>.json
    # store, now covering the 4 gallery-dl categories too) ──
    def _ensure_config_files(self):
        for name, default in GALLERY_SITE_DEFAULTS.items():
            site_prefs.sync_config_file(name, default)

    def list_sites(self):
        out = []
        for name, default in GALLERY_SITE_DEFAULTS.items():
            override = site_prefs.get_override(name)
            effective = default if override is None else override
            out.append({
                "name": name,
                "domains": GALLERY_SITE_DOMAINS.get(name, []),
                "is_default": False,
                "default_use_proxy": default,
                "override": override,
                "effective_use_proxy": effective,
            })
        return out

    def set_site_proxy(self, name, action):
        if name not in GALLERY_SITE_DEFAULTS:
            raise ValueError(f"Unknown site: {name}")
        if action == "enable":
            site_prefs.set_override(name, True)
        elif action == "disable":
            site_prefs.set_override(name, False)
        elif action == "reset":
            site_prefs.clear_override(name)
        else:
            raise ValueError(f"Unknown action: {action}")

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
                job = GalleryJob.from_dict(jd)
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
    def create_job(self, url, output_dir=None, proxy_mode="auto", speed=None,
                    batch_id=None, batch_label=None):
        url = (url or "").strip()
        if not url:
            raise ValueError("Falta la URL")
        if proxy_mode not in ("auto", "proxy", "no-proxy"):
            raise ValueError("proxy_mode debe ser auto, proxy o no-proxy")

        out_dir = Path(output_dir).expanduser() if output_dir else self.base_output_dir
        job_id = uuid.uuid4().hex[:12]
        try:
            ext = gallery_dl.extractor.find(url)
            site = ext.category if ext else None
        except Exception:
            site = None
        job = GalleryJob(job_id, url, str(out_dir), proxy_mode, min_speed_kb=speed,
                          batch_id=batch_id, batch_label=batch_label, site=site)
        with self._meta_lock:
            self.jobs[job_id] = job
            self.order.append(job_id)
        self._persist()
        self._queue.put(job_id)
        return job

    def create_batch(self, urls, output_dir=None, proxy_mode="auto", speed=None, batch_label=None):
        """N independent jobs sharing one batch_id, same pattern
        upload_jobs.py's folder-upload batches already use -- lets the
        frontend cluster them into one group without a jobs.py-style
        items[]-inside-one-job model, which doesn't fit gallery-dl's per-
        URL extraction shape."""
        urls = [u.strip() for u in urls if u and u.strip()]
        if not urls:
            raise ValueError("No hay URLs para descargar")
        batch_id = uuid.uuid4().hex[:12]
        label = batch_label or f"{len(urls)} URLs"
        return [self.create_job(u, output_dir, proxy_mode, speed, batch_id=batch_id, batch_label=label)
                for u in urls]

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

    def retry_job(self, job_id):
        """In-place retry -- same id, same spot in the list (see jobs.py's
        own retry_job()/upload_jobs.py's for why: a new job/row for a retry
        reads as an unrelated new task jumping to the top of the list
        instead of the failed one being replaced)."""
        job = self.jobs.get(job_id)
        if not job:
            raise ValueError("Job not found")
        with job.lock:
            if job.status not in TERMINAL_STATUSES or job.status == "done":
                raise ValueError("Solo se puede reintentar un trabajo terminado con fallos")
            job.status = "queued"
            job.error = None
            job.items = []
            job.proxy_pool = None
            job.started_at = None
            job.finished_at = None
            job.cancel_event.clear()
        self._persist()
        self._queue.put(job.id)
        return job

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
            except Exception as e:
                job.log(f"FATAL: {type(e).__name__}: {e}")
                with job.lock:
                    job.status = "error"
                    job.error = str(e)
                    job.finished_at = time.time()
                self._persist()

    def _run_job(self, job):
        Path(job.output_dir).mkdir(parents=True, exist_ok=True)

        use_proxy = job.proxy_mode == "proxy"
        if job.proxy_mode == "auto" and job.site in GALLERY_SITE_DEFAULTS:
            override = site_prefs.get_override(job.site)
            default = GALLERY_SITE_DEFAULTS[job.site]
            use_proxy = default if override is None else override
            if use_proxy:
                job.log(f"Proxy activado por preferencia de sitio ({job.site})")

        proxy_pool = None
        if use_proxy:
            proxy_pool, err = proxy_sources.build_pool(str(self.state_dir / "working_proxies.json"))
            if not proxy_pool:
                with job.lock:
                    job.status = "error"
                    job.error = err or "No hay proxies disponibles"
                    job.finished_at = time.time()
                self._persist()
                return
            job.proxy_pool = proxy_pool

        max_attempts = MAX_PROXY_ATTEMPTS if proxy_pool else 1
        status_bits = None
        last_exc = None

        gallery_downloader.set_active_job(job)
        try:
            for attempt in range(1, max_attempts + 1):
                if job.cancel_event.is_set():
                    break
                gallery_dl.config.clear()
                gallery_dl.config.set((), "base-directory", job.output_dir)
                gallery_dl.config.set((), "quiet", True)
                gallery_dl.config.set((), "skip", True)
                if proxy_pool:
                    proxy = proxy_pool.get_next()
                    if not proxy:
                        job.log("No hay más proxies disponibles")
                        break
                    gallery_dl.config.set((), "proxy", proxy)
                    if attempt > 1:
                        job.log(f"Reintentando ({attempt}/{max_attempts}) vía {proxy}")

                try:
                    dl_job = gallery_dl.job.DownloadJob(job.url)
                    status_bits = dl_job.run()
                    last_exc = None
                except gallery_downloader.JobCancelled:
                    status_bits = None
                    break
                except Exception as e:
                    last_exc = e
                    status_bits = None

                if job.cancel_event.is_set() or status_bits == 0:
                    break
                # nonzero status or an exception -- if we have more proxies
                # to try, loop and attempt again; "skip" above means files
                # that already finished won't be re-fetched.
        finally:
            gallery_downloader.set_active_job(None)

        with job.lock:
            if job.cancel_event.is_set():
                job.status = "cancelled"
            elif status_bits == 0:
                job.status = "done"
            else:
                job.status = "done_with_errors" if job.items else "error"
                if not job.error:
                    job.error = str(last_exc) if last_exc else "No se pudo completar la descarga"
            # report_progress() only ever closes out the *previous* item
            # when a new one starts -- the last item in the job never gets
            # a "next" one to trigger that, so it's still "running" here.
            if job.items and job.items[-1]["status"] == "running" and job.status in ("done", "done_with_errors"):
                job.items[-1]["status"] = "done"
                job.items[-1]["speed_kb"] = 0
            job.finished_at = time.time()
        for it in job.items:
            self._maybe_optimize(job, it)
        self._persist()

    def _maybe_optimize(self, job, item):
        path = item.get("path")
        if not path or item.get("status") != "done":
            return
        path = Path(path)
        if not path.is_file() or not video_optimize.is_optimizable(path.name):
            return
        try:
            video_optimize.optimize_video(path)
        except Exception:
            pass
