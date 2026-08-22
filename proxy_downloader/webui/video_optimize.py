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


def is_faststart(path):
    """True if `moov` shows up before `mdat` as top-level boxes (already
    optimized), False if `mdat` comes first, None if the structure couldn't
    be determined (unusual/corrupt file — callers should treat that as "we
    don't know, offer to optimize anyway" rather than as either answer).

    Walks top-level ISO-BMFF boxes by their declared sizes (seeking past
    each payload rather than scanning bytes) so a `moov`/`mdat` string that
    happened to appear *inside* some other box's payload can't produce a
    false match.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            pos = 0
            while pos + 8 <= size:
                f.seek(pos)
                header = f.read(8)
                if len(header) < 8:
                    break
                box_size = int.from_bytes(header[0:4], "big")
                box_type = header[4:8]
                header_len = 8
                if box_size == 1:
                    ext = f.read(8)
                    if len(ext) < 8:
                        break
                    box_size = int.from_bytes(ext, "big")
                    header_len = 16
                if box_type == b"mdat":
                    return False
                if box_type == b"moov":
                    return True
                if box_size == 0:
                    break  # box runs to EOF — nothing follows it
                if box_size < header_len:
                    break  # malformed
                pos += box_size
    except OSError:
        return None
    return None


def needs_optimization(path):
    """Whether the "🚀 Optimizar" button is worth showing for `path`:
    right extension, and not already confirmed faststart. An
    undetermined state (None) still counts as "offer it" — worst case
    the user reruns a remux that was already a no-op."""
    return is_optimizable(Path(path).name) and is_faststart(path) is not True


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
