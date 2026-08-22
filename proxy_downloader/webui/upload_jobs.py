"""Background upload job manager — same shape as jobs.py (background worker
thread, persisted history in state/) but for outbound uploads instead of
downloads: no proxy pool, no infinite retry loop, an upload either succeeds
or it doesn't (the caller can just re-submit to retry).
"""
import json
import threading
import queue
import time
import uuid
from pathlib import Path

from .. import site_prefs
from . import upload_sites

TERMINAL_STATUSES = {"done", "error"}
MAX_HISTORY = 200


class UploadJob:
    def __init__(self, job_id, site, source_path, source_name, dest_folder_id,
                 dest_folder_name, is_temp_source):
        self.id = job_id
        self.site = site
        self.source_path = source_path
        self.source_name = source_name
        self.dest_folder_id = dest_folder_id
        self.dest_folder_name = dest_folder_name
        self.is_temp_source = is_temp_source  # delete source_path once finished
        self.status = "queued"  # queued|uploading|done|error
        self.error = None
        self.url = None
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None
        self.lock = threading.RLock()

    def to_dict(self):
        with self.lock:
            return {
                "id": self.id,
                "site": self.site,
                "source_name": self.source_name,
                "dest_folder_name": self.dest_folder_name,
                "status": self.status,
                "error": self.error,
                "url": self.url,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }

    @classmethod
    def from_dict(cls, d):
        job = cls(d["id"], d["site"], d.get("source_path"), d["source_name"],
                   d.get("dest_folder_id"), d.get("dest_folder_name"), False)
        job.status = d.get("status", "error")
        job.error = d.get("error")
        job.url = d.get("url")
        job.created_at = d.get("created_at") or time.time()
        job.started_at = d.get("started_at")
        job.finished_at = d.get("finished_at")
        return job


class UploadManager:
    def __init__(self, state_dir, tmp_dir):
        self.state_dir = Path(state_dir)
        self.tmp_dir = Path(tmp_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self._jobs_file = self.state_dir / "uploads.json"

        self.jobs = {}
        self.order = []
        self._meta_lock = threading.Lock()
        self._queue = queue.Queue()

        self._load_persisted()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="upload-worker")
        self._worker.start()

    # ── accounts ──
    def list_upload_sites(self):
        out = []
        for name, info in upload_sites.SITES.items():
            creds = site_prefs.get_upload_account(name)
            out.append({
                "site": name,
                "label": info["label"],
                "needs_account": info["needs_account"],
                "has_folders": info["has_folders"],
                "configured": bool(creds),
                "account_label": (creds or {}).get("label"),
            })
        return out

    def set_account(self, site, token):
        info = upload_sites.SITES.get(site)
        if not info:
            raise ValueError("Sitio desconocido")
        if not info["needs_account"]:
            raise ValueError("Este sitio no usa cuenta")
        token = (token or "").strip()
        if not token:
            raise ValueError("Falta el token")
        label, root_id = info["verify"](token)
        site_prefs.set_upload_account(site, {"token": token, "root_id": root_id, "label": label})
        return label

    def clear_account(self, site):
        site_prefs.clear_upload_account(site)

    def _creds(self, site):
        creds = site_prefs.get_upload_account(site)
        if not creds:
            raise ValueError("Configurá la cuenta de este sitio primero")
        return creds

    def list_folders(self, site):
        info = upload_sites.SITES.get(site)
        if not info or not info["has_folders"]:
            return []
        creds = self._creds(site)
        return info["list_folders"](creds["token"], creds.get("root_id"))

    def create_folder(self, site, name, parent_id=None):
        info = upload_sites.SITES.get(site)
        if not info or not info["has_folders"]:
            raise ValueError("Este sitio no soporta carpetas/álbumes")
        if not name or not name.strip():
            raise ValueError("Falta el nombre")
        creds = self._creds(site)
        folder_id, folder_name = info["create_folder"](creds["token"], parent_id or creds.get("root_id"), name.strip())
        return {"id": folder_id, "name": folder_name}

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
                job = UploadJob.from_dict(jd)
            except Exception:
                continue
            if job.status not in TERMINAL_STATUSES:
                job.status = "error"
                job.error = "Interrumpido (el servidor se reinició)"
                job.finished_at = job.finished_at or time.time()
            self.jobs[job.id] = job
            self.order.append(job.id)

    def _persist(self):
        with self._meta_lock:
            self._prune_locked()
            try:
                payload = [self.jobs[i].to_dict() for i in self.order if i in self.jobs]
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
    def create_job(self, site, source_path, source_name, dest_folder_id=None,
                    dest_folder_name=None, is_temp_source=False):
        if site not in upload_sites.SITES:
            raise ValueError("Sitio desconocido")
        job_id = uuid.uuid4().hex[:12]
        job = UploadJob(job_id, site, str(source_path), source_name,
                         dest_folder_id, dest_folder_name, is_temp_source)
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
                job.status = "uploading"
                job.started_at = time.time()
            self._persist()
            try:
                self._run_job(job)
            finally:
                with job.lock:
                    job.finished_at = job.finished_at or time.time()
                self._persist()
                self._cleanup_source(job)

    def _run_job(self, job):
        info = upload_sites.SITES[job.site]
        try:
            token = None
            if info["needs_account"]:
                creds = site_prefs.get_upload_account(job.site)
                if not creds:
                    raise upload_sites.UploadError("La cuenta de este sitio ya no está configurada")
                token = creds["token"]
            url = info["upload"](token, job.source_path, job.dest_folder_id)
        except upload_sites.UploadError as e:
            with job.lock:
                job.status = "error"
                job.error = str(e)
            return
        except FileNotFoundError:
            with job.lock:
                job.status = "error"
                job.error = "El archivo de origen ya no existe"
            return
        except Exception as e:
            with job.lock:
                job.status = "error"
                job.error = f"{type(e).__name__}: {e}"
            return

        with job.lock:
            job.status = "done"
            job.url = url

    def _cleanup_source(self, job):
        if not job.is_temp_source:
            return
        try:
            Path(job.source_path).unlink(missing_ok=True)
        except OSError:
            pass
