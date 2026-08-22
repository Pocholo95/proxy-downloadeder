"""Faststart remux for MP4-family videos.

MP4's index (the "moov" atom) can end up at the end of the file depending
on how it was written — fine for a full download, but it means a player
can't determine duration/seek points until the whole file has arrived,
even though our own /api/files/preview already serves Range requests just
fine. `ffmpeg -c copy -movflags +faststart` moves moov to the front: a
pure remux (stream copy, no re-encoding) that's fast and lossless, not a
transcode.

Doesn't apply to WebM/MKV/etc — those containers don't have this
front-vs-back moov distinction, so `+faststart` is an MP4-muxer-specific
flag and would be a no-op or error on anything else.
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

FASTSTART_EXTS = {".mp4", ".m4v", ".mov"}


class OptimizeError(Exception):
    pass


def is_optimizable(name):
    return Path(name).suffix.lower() in FASTSTART_EXTS


def ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def optimize_video(path, timeout=1800):
    """Remux `path` in place with +faststart. On any failure the original
    file is left untouched (the failed temp output is discarded, never
    swapped in)."""
    path = Path(path)
    if not ffmpeg_available():
        raise OptimizeError("ffmpeg no está disponible en este contenedor")
    if not is_optimizable(path.name):
        raise OptimizeError(f"No aplica faststart a este tipo de archivo: {path.suffix}")
    if not path.is_file():
        raise OptimizeError("El archivo no existe")

    original_mode = path.stat().st_mode
    fd, tmp_name = tempfile.mkstemp(suffix=path.suffix, dir=str(path.parent))
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-c", "copy", "-movflags", "+faststart", str(tmp_path)],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0 or tmp_path.stat().st_size == 0:
            detail = (result.stderr or "").strip().splitlines()
            raise OptimizeError(detail[-1] if detail else "ffmpeg falló")
        # mkstemp creates the file 0600 — restore the original's permissions
        # rather than silently tightening them on every optimized video.
        os.chmod(tmp_path, original_mode)
        tmp_path.replace(path)
    finally:
        tmp_path.unlink(missing_ok=True)
