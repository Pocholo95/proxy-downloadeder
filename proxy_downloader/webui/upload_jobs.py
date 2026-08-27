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
                 dest_folder_name, is_temp_source, guest_token=None, batch_id=None, batch_label=None):
        self.id = job_id
        self.site = site
        self.source_path = source_path
        self.source_name = source_name
        self.dest_folder_id = dest_folder_id
        self.dest_folder_name = dest_folder_name
        self.is_temp_source = is_temp_source  # delete source_path once finished successfully
        # Only set for an anonymous-Gofile folder batch: the temp guest
        # account token every file in that batch shares, so they all land
        # in the same dest_folder_id instead of each getting its own
        # independent one-file "folder" the way a lone anonymous upload
        # normally would. None for every other site, and for Gofile when a
        # real account is configured (that account's own token is used
        # instead, from site_prefs, same as any other upload).
        self.guest_token = guest_token
        # Only set when this job came from POST /api/uploads/folder-jobs
        # (uploading every file in a local folder at once): every job from
        # that one request shares the same batch_id/batch_label, so the UI
        # can cluster them into one group even though they're N different
        # source files (unlike the single-file-to-several-sites case below,
        # which already groups naturally by sharing one source_name).
        self.batch_id = batch_id
        self.batch_label = batch_label
        self.status = "queued"  # queued|uploading|done|error
        self.error = None
        self.url = None
        self.folder_url = None  # set only when dest_folder_id was used AND the site
                                 # exposes a real, independent link for the folder itself
        self.bytes_sent = 0
        self.total_bytes = 0
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None
        self.lock = threading.RLock()

    def to_dict(self):
        with self.lock:
            return {
                "id": self.id,
                "site": self.site,
                "source_path": self.source_path,
                "source_name": self.source_name,
                "dest_folder_id": self.dest_folder_id,
                "dest_folder_name": self.dest_folder_name,
                "is_temp_source": self.is_temp_source,
                "status": self.status,
                "error": self.error,
                "url": self.url,
                "folder_url": self.folder_url,
                "batch_id": self.batch_id,
                "batch_label": self.batch_label,
                "bytes_sent": self.bytes_sent,
                "total_bytes": self.total_bytes,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }

    def to_persist_dict(self):
        d = self.to_dict()
        d["guest_token"] = self.guest_token
        return d

    @classmethod
    def from_dict(cls, d):
        job = cls(d["id"], d["site"], d.get("source_path"), d["source_name"],
                   d.get("dest_folder_id"), d.get("dest_folder_name"), d.get("is_temp_source", False),
                   guest_token=d.get("guest_token"), batch_id=d.get("batch_id"), batch_label=d.get("batch_label"))
        job.status = d.get("status", "error")
        job.error = d.get("error")
        job.url = d.get("url")
        job.folder_url = d.get("folder_url")
        job.bytes_sent = d.get("bytes_sent", 0)
        job.total_bytes = d.get("total_bytes", 0)
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
                "account_optional": info.get("account_optional", False),
                "has_folders": info["has_folders"],
                "configured": bool(creds),
                "account_label": (creds or {}).get("label"),
            })
        return out

    def set_account(self, site, token):
        info = upload_sites.SITES.get(site)
        if not info:
            raise ValueError("Sitio desconocido")
        if not info["needs_account"] and not info.get("account_optional"):
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

    def create_guest_folder(self, site, name):
        """Mints a throwaway anonymous account and a named folder under it,
        no login involved -- for grouping a multi-file batch upload to a
        site whose account is optional (today: only Gofile) into one temp
        folder instead of each file landing in its own independent one."""
        info = upload_sites.SITES.get(site)
        if not info or not info.get("create_guest_token"):
            raise ValueError("Este sitio no soporta carpetas de invitado")
        if not name or not name.strip():
            raise ValueError("Falta el nombre")
        token, root_id = info["create_guest_token"]()
        folder_id, folder_name = info["create_folder"](token, root_id, name.strip())
        return {"token": token, "folder_id": folder_id, "folder_name": folder_name}

    def make_public(self, job_id):
        """Retroactively fixes a folder created before gofile_create_folder()
        started doing this on its own -- an already-finished job still has
        everything needed: its own guest_token if this was an anonymous
        batch, or the site's current account token otherwise, either way
        pointing at the same dest_folder_id every other file in that batch
        shares (so fixing it from any one of them fixes the whole folder)."""
        job = self.jobs.get(job_id)
        if not job:
            raise ValueError("Job not found")
        info = upload_sites.SITES.get(job.site)
        if not info or not info.get("make_public"):
            raise ValueError("Este sitio no lo necesita/soporta")
        if not job.dest_folder_id:
            raise ValueError("Este trabajo no subió a una carpeta")
        token = job.guest_token
        if not token:
            creds = site_prefs.get_upload_account(job.site)
            if not creds:
                raise ValueError("No hay token disponible para esta carpeta")
            token = creds["token"]
        info["make_public"](token, job.dest_folder_id)

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
    def create_job(self, site, source_path, source_name, dest_folder_id=None,
                    dest_folder_name=None, is_temp_source=False, guest_token=None,
                    batch_id=None, batch_label=None):
        if site not in upload_sites.SITES:
            raise ValueError("Sitio desconocido")
        job_id = uuid.uuid4().hex[:12]
        job = UploadJob(job_id, site, str(source_path), source_name,
                         dest_folder_id, dest_folder_name, is_temp_source, guest_token=guest_token,
                         batch_id=batch_id, batch_label=batch_label)
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
        self._cleanup_source(job)
        self._persist()
        return True

    def clear_finished(self):
        with self._meta_lock:
            to_remove = [jid for jid in self.order
                         if jid in self.jobs and self.jobs[jid].status in TERMINAL_STATUSES]
            removed_jobs = [self.jobs[jid] for jid in to_remove]
            for jid in to_remove:
                del self.jobs[jid]
            self.order = [jid for jid in self.order if jid not in to_remove]
        for job in removed_jobs:
            self._cleanup_source(job)
        self._persist()
        return len(to_remove)

    def retry_job(self, job_id):
        """Re-submits a failed upload as a new job with the same
        site/source/destination. Ownership of a temp (device-uploaded)
        source file moves to the new job — the old failed entry is marked
        as no longer owning it, so deleting either the old or the new job
        from history can never race against the other still reading/
        writing the same file."""
        src = self.jobs.get(job_id)
        if not src:
            raise ValueError("Job not found")
        with src.lock:
            if src.status != "error":
                raise ValueError("Solo se puede reintentar un trabajo que falló")
            source_path = src.source_path
            is_temp_source = src.is_temp_source
            guest_token = src.guest_token
            batch_id, batch_label = src.batch_id, src.batch_label
        if not source_path or not Path(source_path).exists():
            raise ValueError("El archivo original ya no está disponible — subilo de nuevo")

        job = self.create_job(src.site, source_path, src.source_name,
                               dest_folder_id=src.dest_folder_id, dest_folder_name=src.dest_folder_name,
                               is_temp_source=is_temp_source, guest_token=guest_token,
                               batch_id=batch_id, batch_label=batch_label)
        with src.lock:
            src.is_temp_source = False
        self._persist()
        return job

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
                    succeeded = job.status == "done"
                self._persist()
                # A failed upload keeps its temp (device-uploaded) source
                # file around so "Reintentar" has something to resubmit —
                # it only gets cleaned up once the job succeeds, or once
                # its history entry is deleted/cleared.
                if succeeded:
                    self._cleanup_source(job)

    def _run_job(self, job):
        info = upload_sites.SITES[job.site]
        try:
            job.total_bytes = Path(job.source_path).stat().st_size
        except OSError:
            pass

        last_persist = [0.0]

        def progress_cb(sent, total):
            with job.lock:
                job.bytes_sent = sent
                job.total_bytes = total
            now = time.time()
            if now - last_persist[0] > 1:
                last_persist[0] = now
                self._persist()

        try:
            token = None
            if info["needs_account"] or info.get("account_optional"):
                creds = site_prefs.get_upload_account(job.site)
                if info["needs_account"] and not creds:
                    raise upload_sites.UploadError("La cuenta de este sitio ya no está configurada")
                if creds:
                    token = creds["token"]
                elif job.guest_token:
                    # No real account configured, but this job belongs to an
                    # anonymous-folder batch (see create_guest_folder()) --
                    # use its shared guest token so it lands in that batch's
                    # dest_folder_id instead of an independent one-file folder.
                    token = job.guest_token
            url, folder_url = info["upload"](token, job.source_path, job.dest_folder_id, progress_cb=progress_cb)
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
            job.folder_url = folder_url
            if job.total_bytes:
                job.bytes_sent = job.total_bytes

    def _cleanup_source(self, job):
        if not job.is_temp_source:
            return
        try:
            Path(job.source_path).unlink(missing_ok=True)
        except OSError:
            pass
