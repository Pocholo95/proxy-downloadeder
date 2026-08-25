"""Two-phase "Video (detectar)" job manager: paste a page URL (not a
direct video link), a headless browser loads it and reports every video-
looking resource it saw (sniffer.py) — then, once you've picked which of
those you actually want, downloads them with the same headers (referer/
origin/cookies/user-agent) the browser used, since plenty of sites'
CDNs reject a request that doesn't carry them.

Same background-worker-thread shape as jobs.py/upload_jobs.py/
ytdlp_jobs.py, but a single queue carries both phases: a job freshly
created is "queued" (→ sniff it), and once the user confirms a selection
it's re-queued as "queued_download" (→ download the chosen items) —
the worker just checks which phase a job is in.
"""
import json
import threading
import queue
import time
import uuid
from collections import deque
from pathlib import Path

import requests

from . import sniffer
from . import video_optimize

TERMINAL_STATUSES = {"done", "done_with_errors", "error", "cancelled", "no_candidates"}
INFLIGHT_STATUSES = {"queued", "sniffing", "queued_download", "downloading"}
MAX_HISTORY = 100
DOWNLOAD_CHUNK = 256 * 1024
_HLS_DASH_EXTS = (".m3u8", ".mpd")


def _filename_from_url(url, fallback):
    from urllib.parse import urlsplit, unquote
    name = unquote(Path(urlsplit(url).path).name)
    return name or fallback


class SniffJob:
    def __init__(self, job_id, page_url, output_dir):
        self.id = job_id
        self.page_url = page_url
        self.output_dir = output_dir
        self.status = "queued"
        self.error = None
        self.candidates = []   # [{id, url, content_type, size, headers}]
        self.items = []        # populated once a selection is confirmed
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
                "candidates": list(self.candidates),
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
        job.candidates = d.get("candidates") or []
        job.items = d.get("items") or []
        job.created_at = d.get("created_at") or time.time()
        job.started_at = d.get("started_at")
        job.finished_at = d.get("finished_at")
        for line in d.get("log") or []:
            job._log(line)
        return job

    def log_text(self):
        return "\n".join(self.log_lines)


class SniffManager:
    def __init__(self, base_output_dir, state_dir):
        self.base_output_dir = Path(base_output_dir)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._jobs_file = self.state_dir / "sniff.json"

        self.jobs = {}
        self.order = []
        self._meta_lock = threading.Lock()
        self._queue = queue.Queue()

        self._load_persisted()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="sniff-worker")
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
                job = SniffJob.from_dict(jd)
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
    def create_job(self, page_url, output_dir=None):
        page_url = (page_url or "").strip()
        if not page_url:
            raise ValueError("Falta la URL de la página")
        out_dir = Path(output_dir).expanduser() if output_dir else self.base_output_dir
        job_id = uuid.uuid4().hex[:12]
        job = SniffJob(job_id, page_url, str(out_dir))
        with self._meta_lock:
            self.jobs[job_id] = job
            self.order.append(job_id)
        self._persist()
        self._queue.put(job_id)
        return job

    def create_direct_job(self, page_url, url, headers=None, filename=None, output_dir=None):
        """For a candidate found outside sniffer.py entirely — e.g. the
        userscript in extras/violentmonkey/, which watches network traffic
        in the user's own real browser instead of a headless one here, so
        the "sniffing" already happened by the time this is called. Skips
        straight to "queued_download" with the one item already chosen,
        no candidate-picker step (the human already picked it by clicking
        "download" on that specific video in the real page)."""
        page_url = (page_url or "").strip()
        url = (url or "").strip()
        if not url:
            raise ValueError("Falta la URL del video")
        out_dir = Path(output_dir).expanduser() if output_dir else self.base_output_dir
        job_id = uuid.uuid4().hex[:12]
        job = SniffJob(job_id, page_url or url, str(out_dir))
        job.status = "queued_download"
        job.items = [{
            "candidate_id": None, "url": url, "headers": dict(headers or {}),
            "filename": filename or _filename_from_url(url, f"{job_id}.mp4"),
            "status": "queued", "bytes_done": 0, "total": 0,
            "speed_kb": 0, "message": None, "path": None,
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

    def confirm_download(self, job_id, candidate_ids):
        job = self.jobs.get(job_id)
        if not job:
            raise ValueError("Job not found")
        with job.lock:
            if job.status != "ready":
                raise ValueError("Este job no tiene candidatos listos para elegir")
            chosen = [c for c in job.candidates if c["id"] in set(candidate_ids)]
            if not chosen:
                raise ValueError("No se eligió ningún video")
            job.items = [{
                "candidate_id": c["id"], "url": c["url"], "headers": c["headers"],
                "filename": _filename_from_url(c["url"], f"{c['id']}.mp4"),
                "status": "queued", "bytes_done": 0, "total": c.get("size") or 0,
                "speed_kb": 0, "message": None, "path": None,
            } for c in chosen]
            job.status = "queued_download"
        self._persist()
        self._queue.put(job_id)
        return job

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return False
        with job.lock:
            if job.status in ("queued", "queued_download"):
                job.status = "cancelled"
                job.finished_at = time.time()
            elif job.status in ("sniffing", "downloading"):
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
            if job.status not in TERMINAL_STATUSES and job.status != "ready":
                raise ValueError("Esperá a que termine antes de borrarlo")
            del self.jobs[job_id]
            self.order.remove(job_id)
        self._persist()
        return True

    def clear_finished(self):
        finished = TERMINAL_STATUSES | {"ready"}
        with self._meta_lock:
            to_remove = [jid for jid in self.order if jid in self.jobs and self.jobs[jid].status in finished]
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
                phase = job.status
                if phase == "cancelled":
                    continue
            try:
                if phase == "queued":
                    self._run_sniff(job)
                elif phase == "queued_download":
                    self._run_download(job)
            except Exception as e:
                job._log(f"FATAL: {type(e).__name__}: {e}")
                with job.lock:
                    job.status = "error"
                    job.error = str(e)
                    job.finished_at = time.time()
                self._persist()

    def _run_sniff(self, job):
        with job.lock:
            job.status = "sniffing"
            job.started_at = time.time()
        self._persist()
        try:
            found = sniffer.sniff_page(job.page_url)
        except sniffer.SniffError as e:
            with job.lock:
                job.status = "error"
                job.error = str(e)
                job.finished_at = time.time()
            self._persist()
            return

        with job.lock:
            if job.cancel_event.is_set():
                job.status = "cancelled"
                job.finished_at = time.time()
            elif not found:
                job.status = "no_candidates"
                job.error = "No se encontró ningún video en esa página"
                job.finished_at = time.time()
            else:
                job.candidates = [{**c, "id": uuid.uuid4().hex[:8]} for c in found]
                job.status = "ready"
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
        from ..utils import sanitize_filename
        dest = Path(job.output_dir) / sanitize_filename(item["filename"])
        url = item["url"]
        headers = dict(item["headers"])

        if url.split("?")[0].lower().endswith(_HLS_DASH_EXTS):
            return self._download_via_ffmpeg(job, item, url, headers, dest)

        tmp = dest.with_suffix(dest.suffix + ".part")
        with requests.get(url, headers=headers, stream=True, timeout=30) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length") or item.get("total") or 0)
            with job.lock:
                item["total"] = total or item["total"]
            done = 0
            speed_started = time.time()
            speed_bytes_at_start = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(chunk_size=DOWNLOAD_CHUNK):
                    if job.cancel_event.is_set():
                        raise RuntimeError("Cancelado")
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    elapsed = time.time() - speed_started
                    with job.lock:
                        item["bytes_done"] = done
                        if elapsed > 0:
                            item["speed_kb"] = (done - speed_bytes_at_start) / elapsed / 1024
                    now = time.time()
                    if now - last_persist[0] > 1:
                        last_persist[0] = now
                        self._persist()
        # requests.iter_content() can end its generator early on a dropped/
        # truncated connection without ever raising -- the loop above would
        # otherwise finish "normally" with a partial file and nothing to
        # catch it, silently reporting success on a corrupt download.
        if total and done != total:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"Descarga incompleta: se recibieron {done} de {total} bytes esperados")
        tmp.replace(dest)
        return dest

    def _download_via_ffmpeg(self, job, item, url, headers, dest):
        import subprocess
        if dest.suffix.lower() not in (".mp4", ".mkv"):
            dest = dest.with_suffix(".mp4")
        header_lines = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
        cmd = ["ffmpeg", "-y", "-nostdin"]
        if header_lines:
            cmd += ["-headers", header_lines]
        cmd += ["-i", url, "-c", "copy", str(dest)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg: {(proc.stderr or '').strip()[-500:]}")
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
