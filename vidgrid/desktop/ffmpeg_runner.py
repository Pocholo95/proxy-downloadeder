"""Per-task real-ffmpeg execution.

Each TaskItem in the frontend gets one TaskSession, which owns a private
temp directory used as the ffmpeg subprocess's cwd. Relative filenames used
throughout src/services/gridRenderer.service.ts (frame_temp.jpg,
seq_%05d.png, anim_%05d.png, concat_list.txt, seg_NNN.mp4, ...) resolve
correctly against that cwd automatically -- no path rewriting needed for
them. The one exception is the literal token "input.mp4", which is
redirected to the real source file path bound via bind_input().
"""

import os
import re
import shutil
import subprocess
import tempfile
import threading

from .events import push_log, push_progress
from .media_server import upload_dir
from .paths import ffmpeg_exe

# Windows-only: suppress the console window that would otherwise flash per
# ffmpeg invocation when running from a windowed (non-console) app.
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def get_worker_count() -> int:
    """Concurrent ffmpeg processes to run at once for batch processing."""
    return min(os.cpu_count() or 4, 8)


class FfmpegError(RuntimeError):
    pass


class TaskSession:
    def __init__(self, task_id: str):
        self.task_id = task_id
        self.dir = tempfile.mkdtemp(prefix=f"vidgrid_{task_id}_")
        self.input_path: str | None = None
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def bind_input(self, path: str) -> None:
        self.input_path = path

    def _path(self, filename: str) -> str:
        return os.path.join(self.dir, filename)

    def exec(self, args: list[str], duration_hint: float | None = None) -> None:
        resolved = [
            self.input_path if (a == "input.mp4" and self.input_path) else a
            for a in args
        ]
        cmd = [
            str(ffmpeg_exe()),
            "-y",
            "-nostdin",
            "-progress",
            "pipe:1",
            "-nostats",
            *resolved,
        ]
        with self._lock:
            self._proc = subprocess.Popen(
                cmd,
                cwd=self.dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                creationflags=_CREATE_NO_WINDOW,
            )
        proc = self._proc
        # stderr is drained on its own thread concurrently with stdout below:
        # ffmpeg can write enough to stderr (warnings, codec info) to fill
        # the OS pipe buffer, and since stdout/stderr are separate pipes,
        # reading them sequentially can deadlock -- ffmpeg blocks on a full
        # stderr pipe while we're still blocked waiting on stdout progress
        # lines that will never come.
        stderr_lines: list[str] = []

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_lines.append(line)

        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                # ffmpeg's "-progress" out_time_ms field is actually
                # microseconds despite the name (long-standing ffmpeg quirk).
                m = re.match(r"out_time_ms=(\d+)", line.strip())
                if m and duration_hint and duration_hint > 0:
                    seconds = int(m.group(1)) / 1_000_000
                    push_progress(self.task_id, min(1.0, seconds / duration_hint))
            stderr_thread.join()
            stderr = "".join(stderr_lines)
            for line in stderr.splitlines():
                if line.strip():
                    push_log(self.task_id, line)
            code = proc.wait()
            if code != 0:
                raise FfmpegError(
                    f"ffmpeg exited with code {code}: {stderr[-2000:]}"
                )
        finally:
            with self._lock:
                self._proc = None

    def abort(self) -> None:
        with self._lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass

    def write_file(self, filename: str, data: bytes) -> None:
        with open(self._path(filename), "wb") as f:
            f.write(data)

    def read_file(self, filename: str) -> bytes:
        with open(self._path(filename), "rb") as f:
            return f.read()

    def list_dir(self, subpath: str = "") -> list[str]:
        target = self._path(subpath) if subpath else self.dir
        if not os.path.isdir(target):
            return []
        return os.listdir(target)

    def delete_file(self, filename: str) -> None:
        path = self._path(filename)
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass

    def cleanup(self) -> None:
        self.abort()
        shutil.rmtree(self.dir, ignore_errors=True)
        # A browser-uploaded source file lives in the shared upload dir and
        # is ours to delete once this task is done with it -- unlike a
        # scan_path()'d file, which lives wherever the user's own
        # filesystem has it (e.g. the shared /downloads volume) and must
        # never be touched here.
        udir = upload_dir()
        if self.input_path and udir:
            try:
                is_uploaded = os.path.commonpath([self.input_path, udir]) == udir
            except ValueError:
                is_uploaded = False  # different drives (Windows) -- can't be inside udir
            if is_uploaded:
                try:
                    os.remove(self.input_path)
                except OSError:
                    pass
