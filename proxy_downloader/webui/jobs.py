"""Background job manager for the web UI.

Reuses the exact same site providers, proxy pool and download engine as the
CLI (proxy_downloader/core, proxy_downloader/proxy, proxy_downloader/sites) —
this module is just an alternate front-end that runs jobs on a background
worker thread instead of blocking a terminal, and reports progress through
`progress_cb` instead of a live rich console.

Jobs run one at a time, in submission order, on a single worker thread —
same as running the CLI repeatedly. That keeps the shared `console` redirect
below (needed so rich's colored/live output doesn't corrupt itself across
concurrent jobs) trivially safe, and matches the CLI's own behavior of
downloading one file after another.

Job history (including logs) is persisted to state_dir/jobs.json after every
meaningful state change, so it survives container restarts/redeploys — any
job still mid-flight when the process died is reconciled to "error" on the
next load, since the worker thread that owned it is gone (the partial .part
file on disk is untouched, so retrying/resubmitting just resumes it).
"""
import json
import re
import sys
import threading
import queue
import time
import uuid
from collections import deque
from pathlib import Path
from types import SimpleNamespace

from .. import site_prefs
from ..cli import _resolve_folder_jobs, _job_uses_proxy, FOLDER_LABEL_RE
from ..config import PROXIES_URL, MIN_SPEED_KB
from ..core import registry
from ..core.downloader import download_file, download_direct
from ..proxy import ProxyCache, ProxyPool, fetch_proxy_list
from ..ui import console
from ..utils import sanitize_filename
from . import video_optimize

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

TERMINAL_STATUSES = {"done", "done_with_errors", "error", "cancelled"}
INFLIGHT_STATUSES = {"queued", "resolving", "fetching_proxies", "running", "cancelling"}
MAX_HISTORY = 300


def _strip_ansi(text):
    return _ANSI_RE.sub("", text)


class _JobLogWriter:
    """Stand-in for console.file: captures rich's output into the job's log
    (ANSI-stripped, since a non-tty file already makes rich itself skip
    colors — this is just a safety net) while still echoing to the real
    stdout so `docker logs` shows live activity."""

    def __init__(self, job):
        self.job = job
        self._buf = ""

    def write(self, text):
        if not text:
            return
        self._buf += text
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self.job._append_log(_strip_ansi(line))
        try:
            sys.__stdout__.write(text)
        except Exception:
            pass
        return len(text)

    def flush(self):
        try:
            sys.__stdout__.flush()
        except Exception:
            pass

    def isatty(self):
        return False


class Job:
    def __init__(self, job_id, kind, raw_input, output_dir, proxy_mode, speed):
        self.id = job_id
        self.kind = kind                # "file" | "folder" | "batch"
        self.raw_input = raw_input
        self.output_dir = output_dir
        self.proxy_mode = proxy_mode    # "auto" | "proxy" | "no-proxy"
        self.speed = speed
        self.status = "queued"          # queued|resolving|fetching_proxies|running|cancelling|done|done_with_errors|error|cancelled
        self.error = None
        self.retry_of = None            # id of the job this one retries, if any
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None
        self.items = []                 # list[dict], see JobManager._mk_item
        self.log_lines = deque(maxlen=2000)
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()

    def _append_log(self, line):
        if line.strip():
            self.log_lines.append(line)

    def log(self, text):
        for line in text.splitlines():
            self._append_log(line)

    def to_dict(self):
        with self.lock:
            items = [{k: v for k, v in it.items() if k != "provider"} for it in self.items]
            done = sum(1 for it in items if it["status"] == "done")
            failed = sum(1 for it in items if it["status"] == "failed")
            return {
                "id": self.id,
                "kind": self.kind,
                "input": self.raw_input,
                "output_dir": self.output_dir,
                "proxy_mode": self.proxy_mode,
                "speed": self.speed,
                "status": self.status,
                "error": self.error,
                "retry_of": self.retry_of,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "items": items,
                "summary": {"total": len(items), "done": done, "failed": failed},
            }

    def to_persist_dict(self):
        d = self.to_dict()
        d["log"] = list(self.log_lines)
        return d

    @classmethod
    def from_dict(cls, data):
        job = cls(data["id"], data["kind"], data["input"], data["output_dir"],
                   data.get("proxy_mode", "auto"), data.get("speed") or MIN_SPEED_KB)
        job.status = data.get("status", "error")
        job.error = data.get("error")
        job.retry_of = data.get("retry_of")
        job.created_at = data.get("created_at") or time.time()
        job.started_at = data.get("started_at")
        job.finished_at = data.get("finished_at")
        job.items = data.get("items") or []
        for line in data.get("log") or []:
            job._append_log(line)
        return job

    def log_text(self):
        return "\n".join(self.log_lines)


class JobManager:
    def __init__(self, base_output_dir, state_dir):
        self.base_output_dir = Path(base_output_dir)
        self.state_dir = Path(state_dir)
        self.base_output_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._jobs_file = self.state_dir / "jobs.json"

        self.jobs = {}
        self.order = []
        self._preset_items = {}
        self._meta_lock = threading.Lock()
        self._queue = queue.Queue()

        self._ensure_config_files()
        self._load_persisted_jobs()

        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="job-worker")
        self._worker.start()

    # ── site config (mirrors cli.py --list-sites / --enable-proxy) ──
    def _ensure_config_files(self):
        for p in registry.all_providers():
            site_prefs.sync_config_file(p.name, p.use_proxy_by_default)

    def list_sites(self):
        out = []
        for p in registry.all_providers():
            override = site_prefs.get_override(p.name)
            effective = p.use_proxy_by_default if override is None else override
            out.append({
                "name": p.name,
                "domains": p.domains,
                "is_default": p.is_default,
                "default_use_proxy": p.use_proxy_by_default,
                "override": override,
                "effective_use_proxy": effective,
            })
        return out

    def set_site_proxy(self, name, action):
        known = {p.name for p in registry.all_providers()}
        if name not in known:
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
    def _load_persisted_jobs(self):
        if not self._jobs_file.exists():
            return
        try:
            payload = json.loads(self._jobs_file.read_text())
        except Exception:
            return
        for jd in payload:
            try:
                job = Job.from_dict(jd)
            except Exception:
                continue
            if job.status in INFLIGHT_STATUSES:
                msg = "Interrumpido (el servidor se reinició)"
                job.status = "error"
                job.error = f"{job.error}; {msg}" if job.error else msg
                job.finished_at = job.finished_at or time.time()
                for it in job.items:
                    if it.get("status") in ("queued", "running"):
                        it["status"] = "failed"
                        it["message"] = it.get("message") or "Interrumpido"
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
        """Keep at most MAX_HISTORY jobs, dropping the oldest *finished* ones
        first — active jobs are never pruned."""
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
    def create_job(self, kind, value, output_dir=None, proxy_mode="auto", speed=None):
        if kind not in ("file", "folder", "batch", "auto"):
            raise ValueError("kind must be file, folder, batch or auto")
        if not value or not value.strip():
            raise ValueError("value is required")
        if proxy_mode not in ("auto", "proxy", "no-proxy"):
            raise ValueError("proxy_mode must be auto, proxy or no-proxy")

        out_dir = Path(output_dir).expanduser() if output_dir else self.base_output_dir
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id, kind, value.strip(), str(out_dir), proxy_mode, speed or MIN_SPEED_KB)

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
            elif job.status in ("resolving", "fetching_proxies", "running"):
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
        src = self.jobs.get(job_id)
        if not src:
            raise ValueError("Job not found")
        with src.lock:
            if src.status not in TERMINAL_STATUSES or src.status == "done":
                raise ValueError("Solo se puede reintentar un trabajo terminado con fallos")
            failed_items = [dict(it) for it in src.items if it["status"] in ("failed", "cancelled")]
        if not failed_items:
            raise ValueError("No hay items fallidos para reintentar")

        preset = []
        for it in failed_items:
            provider = registry.get(it["site"])
            if not provider:
                continue
            preset.append(self._mk_item(provider, it["file_id"], it.get("hint_name"), it["dest_dir"]))
        if not preset:
            raise ValueError("No se pudo reconstruir ningún item fallido")

        job_id_new = uuid.uuid4().hex[:12]
        job = Job(job_id_new, src.kind, src.raw_input, src.output_dir, src.proxy_mode, src.speed)
        job.retry_of = src.id

        with self._meta_lock:
            self.jobs[job.id] = job
            self.order.append(job.id)
            self._preset_items[job.id] = preset
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
                job.status = "resolving"
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
        writer = _JobLogWriter(job)
        old_file = console.file
        console.file = writer
        try:
            Path(job.output_dir).mkdir(parents=True, exist_ok=True)

            with self._meta_lock:
                preset = self._preset_items.pop(job.id, None)
            items = preset if preset is not None else self._build_items(job)

            with job.lock:
                job.items = items
            self._persist()
            if not items:
                with job.lock:
                    job.status = "error"
                    job.error = job.error or "No se encontraron archivos para descargar"
                    job.finished_at = time.time()
                self._persist()
                return

            args = SimpleNamespace(no_proxy=(job.proxy_mode == "no-proxy"),
                                    proxy=(job.proxy_mode == "proxy"))

            proxy_pool = None
            if any(_job_uses_proxy(it["provider"], args) for it in items):
                with job.lock:
                    job.status = "fetching_proxies"
                self._persist()
                raw = fetch_proxy_list(PROXIES_URL)
                if raw:
                    cache = ProxyCache(str(self.state_dir / "working_proxies.json"))
                    proxy_pool = ProxyPool(raw, PROXIES_URL, cache)
                    if proxy_pool.initial_load() == 0:
                        job.log("No working proxies found — jobs needing a proxy will fail")
                        proxy_pool = None
                else:
                    job.log("Could not fetch the proxy list")

            with job.lock:
                job.status = "running"
            self._persist()

            for item in items:
                if job.cancel_event.is_set():
                    break
                provider = item["provider"]
                wants_proxy = _job_uses_proxy(provider, args)
                use_proxy = proxy_pool is not None and wants_proxy
                with job.lock:
                    item["status"] = "running"
                    item["mode"] = "proxy" if wants_proxy else "direct"
                self._persist()

                cb = self._make_progress_cb(job, item)
                if use_proxy:
                    ok, code = download_file(provider, item["file_id"], proxy_pool,
                                              item["dest_dir"], job.speed, item["hint_name"],
                                              progress_cb=cb, cancel_event=job.cancel_event)
                elif wants_proxy:
                    # site/job wanted a proxy but none are available — don't
                    # silently fall back to the real IP.
                    ok, code = False, None
                    with job.lock:
                        item["message"] = "No proxies available"
                else:
                    ok, code = download_direct(provider, item["file_id"], item["dest_dir"],
                                                item["hint_name"], progress_cb=cb,
                                                cancel_event=job.cancel_event)

                with job.lock:
                    if code == "cancelled":
                        item["status"] = "cancelled"
                    else:
                        item["status"] = "done" if ok else "failed"
                        # The last "downloading" progress report is throttled
                        # to once/second, so the final bytes written after
                        # that tick never get reflected — snap to 100%.
                        if ok and item["total"]:
                            item["bytes_done"] = item["total"]
                    item["code"] = code
                self._persist()

                if ok and code != "cancelled":
                    self._maybe_optimize(item)

            with job.lock:
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                else:
                    failed = sum(1 for it in job.items if it["status"] == "failed")
                    job.status = "done" if failed == 0 else "done_with_errors"
                job.finished_at = time.time()
            self._persist()
        finally:
            console.file = old_file

    def _maybe_optimize(self, item):
        """Best-effort faststart remux right after a successful download —
        never fails the download itself; a video that couldn't be
        optimized (no ffmpeg, weird container, whatever) is still a
        perfectly good download, just maybe slower to start streaming."""
        path = item.get("path")
        if not path or not video_optimize.is_optimizable(Path(path).name):
            return
        try:
            video_optimize.optimize_video(path)
        except video_optimize.OptimizeError as e:
            console.print(f"[yellow]⚠  No se pudo optimizar para streaming ({Path(path).name}): {e}[/yellow]")
        except Exception as e:
            console.print(f"[yellow]⚠  Error inesperado optimizando {Path(path).name}: {e}[/yellow]")

    def _make_progress_cb(self, job, item):
        def cb(status, **info):
            with job.lock:
                item["phase"] = status
                if info.get("filename"):
                    item["filename"] = info["filename"]
                if "bytes_done" in info:
                    item["bytes_done"] = info["bytes_done"]
                if "total" in info:
                    item["total"] = info["total"]
                if "speed_kb" in info:
                    item["speed_kb"] = info["speed_kb"]
                if info.get("message"):
                    item["message"] = info["message"]
                if info.get("path"):
                    item["path"] = info["path"]
        return cb

    def _mk_item(self, provider, file_id, hint_name, dest_dir):
        wants_proxy = provider.use_proxy_by_default
        return {
            "provider": provider,
            "site": provider.name,
            "file_id": file_id,
            "hint_name": hint_name,
            "filename": hint_name,
            "dest_dir": str(dest_dir),
            "status": "queued",
            "mode": "proxy" if wants_proxy else "direct",
            "phase": None,
            "bytes_done": 0,
            "total": 0,
            "speed_kb": 0,
            "message": None,
            "code": None,
            "path": None,
        }

    def _build_items(self, job):
        out_dir = Path(job.output_dir)
        value = job.raw_input
        items = []

        if job.kind == "file":
            provider = registry.detect(value)
            if not provider:
                job.error = "No se reconoce el sitio para ese ID/URL"
                return items
            fid = provider.extract_file_id(value)
            if not fid:
                job.error = "ID o URL inválida"
                return items
            items.append(self._mk_item(provider, fid, None, out_dir))

        elif job.kind == "folder":
            provider = registry.detect(value) or registry.default_provider()
            if not provider:
                job.error = "No se reconoce el sitio para esa carpeta"
                return items
            folder_id = provider.extract_folder_id(value) or value.strip()
            raw_items, _sub_dir = _resolve_folder_jobs(provider, folder_id, out_dir)
            for p, fid, fname, _orig, dest in raw_items:
                items.append(self._mk_item(p, fid, fname, dest))

        elif job.kind == "auto":
            # Same precedence as the CLI's interactive/batch auto-detect:
            # try folder first, fall back to a single file.
            provider = registry.detect(value)
            if not provider:
                job.error = "No se reconoce el sitio para ese ID/URL"
                return items
            folder_id = provider.extract_folder_id(value)
            if folder_id:
                raw_items, _sub_dir = _resolve_folder_jobs(provider, folder_id, out_dir)
                for p, fid, fname, _orig, dest in raw_items:
                    items.append(self._mk_item(p, fid, fname, dest))
            else:
                fid = provider.extract_file_id(value)
                if not fid:
                    job.error = "ID o URL inválida"
                    return items
                items.append(self._mk_item(provider, fid, None, out_dir))

        elif job.kind == "batch":
            current_dir = out_dir
            for line in value.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                label = FOLDER_LABEL_RE.match(line)
                if label:
                    name = label.group(1).split("#", 1)[0].strip()
                    current_dir = (out_dir / sanitize_filename(name)) if name else out_dir
                    current_dir.mkdir(parents=True, exist_ok=True)
                    continue
                provider = registry.detect(line)
                if not provider:
                    job.log(f"⚠  Sitio no reconocido, se ignora: {line}")
                    continue
                folder_id = provider.extract_folder_id(line)
                if folder_id:
                    raw_items, _ = _resolve_folder_jobs(provider, folder_id, current_dir)
                    for p, fid, fname, _orig, dest in raw_items:
                        items.append(self._mk_item(p, fid, fname, dest))
                    continue
                fid = provider.extract_file_id(line)
                if fid:
                    items.append(self._mk_item(provider, fid, None, current_dir))

        return items
