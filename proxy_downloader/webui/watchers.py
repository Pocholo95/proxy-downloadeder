"""Folder watcher: remembers a folder/album URL and re-checks it on an
interval, downloading only what's new since last time.

A check resolves the folder itself (a cheap listing call, no downloads) and
compares it against download_history -- a file counts as already known if
it was ever downloaded (even if the user later deleted it: a watcher must
not resurrect files on purpose removed) or if it's already sitting complete
on disk. Only the rest becomes a normal download job (JobManager.
create_preset_job), so a check that finds nothing new leaves no trace in
Descargas at all instead of a daily row of skipped items. Files that failed
last time were never recorded in history, so they're retried automatically
on the next check.

One scheduler thread walks the watchers every SCHEDULER_TICK seconds; a
"check now" just wakes it early.
"""
import json
import threading
import time
import uuid
from pathlib import Path

from ..core import registry
from ..ui import console
from ..utils import sanitize_filename
from . import download_history

DEFAULT_INTERVAL_HOURS = 24
MIN_INTERVAL_HOURS = 1
MAX_INTERVAL_HOURS = 24 * 30
SCHEDULER_TICK = 30
STARTUP_DELAY = 10
# A failed check (site down, album deleted/moved, layout changed) retries
# sooner than the normal interval a few times, then falls back to it so a
# permanently dead album isn't hammered forever.
ERROR_RETRY_SECONDS = 3600
ERROR_RETRY_STREAK = 5


def _validate_interval(hours):
    try:
        hours = float(hours)
    except (TypeError, ValueError):
        raise ValueError("El intervalo debe ser un número de horas")
    if hours < MIN_INTERVAL_HOURS or hours > MAX_INTERVAL_HOURS:
        raise ValueError(f"El intervalo debe estar entre {MIN_INTERVAL_HOURS} y {MAX_INTERVAL_HOURS} horas")
    return hours


class WatcherManager:
    def __init__(self, state_dir, job_manager):
        self.state_dir = Path(state_dir)
        self.jobs = job_manager
        self._file = self.state_dir / "watchers.json"
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._watchers = {}
        self._checking = set()
        self._load()
        threading.Thread(target=self._loop, daemon=True, name="folder-watcher").start()

    # ── persistence ──
    def _load(self):
        try:
            if self._file.exists():
                for w in json.loads(self._file.read_text()):
                    self._watchers[w["id"]] = w
        except Exception:
            pass

    def _save_locked(self):
        try:
            tmp = self._file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(list(self._watchers.values())))
            tmp.replace(self._file)
        except Exception:
            pass

    # ── public API ──
    def list(self):
        with self._lock:
            watchers = [dict(w) for w in self._watchers.values()]
        out = []
        for w in watchers:
            job = self.jobs.get(w.get("last_job_id")) if w.get("last_job_id") else None
            w["checking"] = w["id"] in self._checking
            w["job_status"] = job.status if job else None
            out.append(w)
        out.sort(key=lambda w: w["created_at"], reverse=True)
        return out

    def add(self, url, interval_hours=DEFAULT_INTERVAL_HOURS, output_dir=None):
        url = (url or "").strip()
        if not url:
            raise ValueError("Falta la URL de la carpeta")
        provider = registry.detect(url)
        if not provider:
            raise ValueError("No se reconoce el sitio de ese link")
        folder_id = provider.extract_folder_id(url)
        if not folder_id:
            raise ValueError("Solo se pueden vigilar carpetas/álbumes, no archivos sueltos")
        hours = _validate_interval(interval_hours)
        out_dir = str(Path(output_dir).expanduser()) if output_dir else str(self.jobs.base_output_dir)

        with self._lock:
            for w in self._watchers.values():
                if w["site"] == provider.name and w["folder_id"] == folder_id and w["output_dir"] == out_dir:
                    raise ValueError("Esa carpeta ya está siendo vigilada")
            wid = uuid.uuid4().hex[:12]
            w = {
                "id": wid,
                "url": url,
                "site": provider.name,
                "folder_id": folder_id,
                "output_dir": out_dir,
                "interval_hours": hours,
                "enabled": True,
                "created_at": time.time(),
                "last_check": None,
                "next_check": time.time(),
                "last_status": "pending",
                "last_error": None,
                "last_new": 0,
                "remote_count": 0,
                "error_streak": 0,
                "last_job_id": None,
            }
            self._watchers[wid] = w
            self._save_locked()
        self._wake.set()
        return dict(w)

    def update(self, wid, interval_hours=None, enabled=None):
        with self._lock:
            w = self._watchers.get(wid)
            if not w:
                raise ValueError("Watcher no encontrado")
            if interval_hours is not None:
                w["interval_hours"] = _validate_interval(interval_hours)
                if w["last_check"] and w["last_status"] != "error":
                    w["next_check"] = w["last_check"] + w["interval_hours"] * 3600
            if enabled is not None:
                w["enabled"] = bool(enabled)
                if w["enabled"] and w["next_check"] and w["next_check"] < time.time():
                    w["next_check"] = time.time()
            self._save_locked()
            result = dict(w)
        self._wake.set()
        return result

    def check_now(self, wid):
        with self._lock:
            w = self._watchers.get(wid)
            if not w:
                raise ValueError("Watcher no encontrado")
            w["next_check"] = time.time()
            w["enabled"] = True
            self._save_locked()
        self._wake.set()

    def delete(self, wid):
        with self._lock:
            if wid not in self._watchers:
                raise ValueError("Watcher no encontrado")
            del self._watchers[wid]
            self._save_locked()

    # ── scheduler ──
    def _loop(self):
        time.sleep(STARTUP_DELAY)
        while True:
            try:
                self._tick()
            except Exception as e:
                console.print(f"[red]✗ Folder watcher: {type(e).__name__}: {e}[/red]")
            self._wake.wait(SCHEDULER_TICK)
            self._wake.clear()

    def _tick(self):
        now = time.time()
        with self._lock:
            due = [w["id"] for w in self._watchers.values()
                   if w["enabled"] and (w["next_check"] or 0) <= now]
        for wid in due:
            self._check(wid)

    def _job_busy(self, w):
        job = self.jobs.get(w["last_job_id"]) if w.get("last_job_id") else None
        return bool(job) and job.status not in ("done", "done_with_errors", "error", "cancelled")

    def _check(self, wid):
        with self._lock:
            w = self._watchers.get(wid)
            if not w:
                return
            w = dict(w)
        # The previous check's download job is still going (or queued
        # behind other work) -- checking again now would just queue the
        # same not-yet-downloaded files twice. Look again next tick.
        if self._job_busy(w):
            return

        self._checking.add(wid)
        try:
            result = self._resolve_new(w)
        except Exception as e:
            result = {"error": f"{type(e).__name__}: {e}"}
        finally:
            self._checking.discard(wid)

        job_id = w.get("last_job_id")
        new_count = 0
        error = result.get("error")
        if not error and result["new"]:
            try:
                job = self.jobs.create_preset_job(w["url"], w["output_dir"], result["new"])
                job_id = job.id
                new_count = len(result["new"])
            except Exception as e:
                error = f"No se pudo crear la descarga: {e}"

        now = time.time()
        with self._lock:
            cur = self._watchers.get(wid)
            if not cur:
                return
            cur["last_check"] = now
            cur["last_job_id"] = job_id
            if error:
                cur["last_status"] = "error"
                cur["last_error"] = error
                cur["error_streak"] = cur.get("error_streak", 0) + 1
                retry = ERROR_RETRY_SECONDS if cur["error_streak"] < ERROR_RETRY_STREAK else cur["interval_hours"] * 3600
                cur["next_check"] = now + min(retry, cur["interval_hours"] * 3600)
            else:
                cur["last_status"] = "ok"
                cur["last_error"] = None
                cur["error_streak"] = 0
                cur["last_new"] = new_count
                cur["remote_count"] = result["total"]
                cur["next_check"] = now + cur["interval_hours"] * 3600
            self._save_locked()

    def _resolve_new(self, w):
        """Lists the folder and returns {"total": n, "new": [(provider,
        file_id, name, dest_dir), ...]} -- or {"error": msg} if the listing
        came back empty (resolve_folder() swallows its own errors and just
        returns [], so an empty album, a deleted one and a broken site are
        indistinguishable here; all are reported as a failed check rather
        than "nothing new", so a dead watcher shows up instead of looking
        healthy)."""
        provider = registry.get(w["site"])
        if not provider:
            return {"error": f"Sitio '{w['site']}' ya no está disponible"}
        files = provider.resolve_folder(w["folder_id"])
        if not files:
            return {"error": "No se pudieron leer archivos de la carpeta (vacía, borrada o el sitio falló)"}

        history = download_history.snapshot(self.state_dir)
        sub_dir = Path(w["output_dir"]) / w["folder_id"]
        new = []
        for fid, fname in files:
            if download_history.snapshot_key(provider.name, fid) in history:
                continue
            if (sub_dir / sanitize_filename(fname)).exists():
                continue
            new.append((provider, fid, fname, sub_dir))
        return {"total": len(files), "new": new}
