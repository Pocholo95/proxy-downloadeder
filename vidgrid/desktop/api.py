"""API surface called from desktop/media_server.py's /api/* HTTP routes
(the frontend used to call this as window.pywebview.api.*; it's now a
plain HTTP JSON API since the UI runs in a regular browser tab)."""

import base64
import os
import threading

from .ffmpeg_runner import TaskSession, get_worker_count
from .media_server import register_media as _register_media
from .paths import ffmpeg_exe, ffprobe_exe
from .probe import probe_metadata as _probe_metadata

VIDEO_EXTENSIONS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".m4v",
    ".ts", ".flv", ".mpg", ".mpeg", ".3gp", ".ogv", ".vob",
}


class Api:
    def __init__(self) -> None:
        self._sessions: dict[str, TaskSession] = {}
        self._lock = threading.Lock()

    # --- Startup / capability ---

    def check_ffmpeg(self) -> dict:
        return {
            "ffmpeg": ffmpeg_exe().is_file(),
            "ffprobe": ffprobe_exe().is_file(),
        }

    def get_cpu_count(self) -> int:
        return get_worker_count()

    def shared_dir(self) -> str:
        """A folder the frontend can offer as a one-click scan_path shortcut
        (e.g. another app's shared downloads volume in a combined deploy) --
        empty by default, so a plain desktop install shows nothing extra."""
        return os.environ.get("VIDGRID_SHARED_DIR", "")

    # --- File/folder input by typed path (no browser upload -- the app and
    # the files are on the same machine, so this just reads them directly) ---

    def scan_path(self, path: str) -> list[dict]:
        path = os.path.expanduser(path.strip().strip('"'))
        if os.path.isfile(path):
            return [self._describe_file(path)]
        if os.path.isdir(path):
            found: list[str] = []
            for root, _dirs, files in os.walk(path):
                for name in files:
                    if os.path.splitext(name)[1].lower() in VIDEO_EXTENSIONS:
                        found.append(os.path.join(root, name))
            found.sort()
            return [self._describe_file(p) for p in found]
        raise FileNotFoundError(f"No such file or directory: {path}")

    def list_shared_dir(self, subpath: str = "") -> dict:
        """Non-recursive, single-level listing scoped under VIDGRID_SHARED_DIR
        -- lets the picker navigate folder by folder instead of scan_path's
        full recursive flatten, which finds every video under a path in one
        shot but discards any sense of directory structure once they're all
        in one flat list (fine for "scan this whole tree", not for browsing
        it -- a shared downloads volume organized into per-batch/per-site
        subfolders turned into one giant same-looking list of basenames).
        Returns the folders and video files directly inside `subpath`, plus
        the actual relative path resolved to (== subpath normally, but lets
        the caller detect if e.g. a trailing garbage segment got dropped)."""
        root = self.shared_dir()
        if not root:
            raise ValueError("No shared directory is configured")
        root = os.path.realpath(root)
        rel = (subpath or "").strip().strip("/\\")
        target = os.path.realpath(os.path.join(root, rel)) if rel else root
        if target != root and not target.startswith(root + os.sep):
            raise ValueError("Path escapes the shared directory")
        if not os.path.isdir(target):
            raise NotADirectoryError(target)

        dirs: list[dict] = []
        files: list[dict] = []
        with os.scandir(target) as it:
            for entry in it:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append({
                            "name": entry.name,
                            "path": os.path.relpath(entry.path, root).replace(os.sep, "/"),
                        })
                    elif os.path.splitext(entry.name)[1].lower() in VIDEO_EXTENSIONS:
                        files.append(self._describe_file(entry.path))
                except OSError:
                    continue
        dirs.sort(key=lambda d: d["name"].lower())
        files.sort(key=lambda f: f["name"].lower())
        resolved_rel = os.path.relpath(target, root).replace(os.sep, "/")
        return {
            "path": "" if resolved_rel == "." else resolved_rel,
            "dirs": dirs,
            "files": files,
        }

    def _describe_file(self, path: str) -> dict:
        st = os.stat(path)
        return {
            "name": os.path.basename(path),
            "path": path,
            "size": st.st_size,
            "lastModified": int(st.st_mtime * 1000),
            "token": _register_media(path),
        }

    # --- Metadata ---

    def probe_metadata(self, path: str) -> dict:
        return _probe_metadata(path)

    # --- Media serving (native <video> decode/seeking) ---

    def register_media(self, path: str) -> dict:
        return {"token": _register_media(path)}

    # --- Per-task ffmpeg execution (IFFmpegService bridge) ---

    def _get_session(self, task_id: str) -> TaskSession:
        with self._lock:
            session = self._sessions.get(task_id)
            if session is None:
                session = TaskSession(task_id)
                self._sessions[task_id] = session
            return session

    def bind_input_path(self, task_id: str, path: str) -> None:
        self._get_session(task_id).bind_input(path)

    def exec_ffmpeg(
        self, task_id: str, args: list[str], duration_hint: float | None = None
    ) -> None:
        self._get_session(task_id).exec(args, duration_hint)

    def write_task_file(self, task_id: str, filename: str, data_b64: str) -> None:
        self._get_session(task_id).write_file(filename, base64.b64decode(data_b64))

    def read_task_file(self, task_id: str, filename: str) -> str:
        data = self._get_session(task_id).read_file(filename)
        return base64.b64encode(data).decode("ascii")

    def list_task_dir(self, task_id: str, subpath: str = "") -> list[str]:
        return self._get_session(task_id).list_dir(subpath)

    def delete_task_file(self, task_id: str, filename: str) -> None:
        self._get_session(task_id).delete_file(filename)

    def abort_task(self, task_id: str) -> None:
        session = self._sessions.get(task_id)
        if session is not None:
            session.abort()

    def reset_task(self, task_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(task_id, None)
        if session is not None:
            session.cleanup()

    # --- Idle cleanup (see desktop/idle_sweeper.py) ---

    def sweep_idle_sessions(self, timeout_seconds: float) -> int:
        """Cleans up (temp dir + in-memory entry) any task session nobody's
        touched in timeout_seconds -- e.g. the browser tab was closed, or
        the task was removed client-side, without ever calling reset_task
        (the frontend's normal cleanup path). Without this, a long-running
        server accumulates one abandoned temp directory + dict entry per
        such session forever. Returns how many were cleaned, for logging."""
        with self._lock:
            idle_ids = [tid for tid, s in self._sessions.items() if s.is_idle(timeout_seconds)]
            sessions = [self._sessions.pop(tid) for tid in idle_ids]
        for session in sessions:
            session.cleanup()
        return len(sessions)
