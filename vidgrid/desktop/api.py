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
