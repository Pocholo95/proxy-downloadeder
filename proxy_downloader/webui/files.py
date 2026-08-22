"""Browse/delete/download files under the web UI's output directory.

Every path that comes in from a request is a string relative to `root`
(the download dir) and MUST be resolved through `safe_path()` before any
filesystem operation — that's what stops `../../etc/passwd`-style requests
from ever touching anything outside the mounted downloads volume.
"""
import os
import tempfile
import zipfile
from pathlib import Path

from ..utils import sanitize_filename
from . import video_optimize

# Raster/binary media only — no .svg (can carry scripts) and no formats a
# browser would try to render as markup. Whitelisted server-side too, not
# just client-side, since this gates what gets served with an *inline*
# Content-Disposition (rendered/played in-page) instead of forced download.
VIDEO_EXTS = {".mp4", ".webm", ".ogv", ".mov", ".m4v", ".mkv", ".avi"}
AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


class UnsafePath(ValueError):
    pass


def media_kind(name):
    """"video"/"audio"/"image" for a previewable file, else None."""
    ext = Path(name).suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    return None


def safe_path(root, rel):
    """Resolve `rel` (untrusted, relative) against `root` and guarantee the
    result is `root` itself or somewhere underneath it. Raises UnsafePath
    otherwise (absolute escapes, `..` traversal, symlinks pointing out)."""
    root = Path(root).resolve()
    rel = (rel or "").strip().strip("/\\")
    target = (root / rel).resolve() if rel else root
    if target != root and root not in target.parents:
        raise UnsafePath(f"Path escapes the download directory: {rel!r}")
    return target


def list_dir(root, rel):
    target = safe_path(root, rel)
    if not target.is_dir():
        raise NotADirectoryError(str(target))
    root = Path(root).resolve()
    entries = []
    for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        try:
            st = p.stat()
        except OSError:
            continue
        entries.append({
            "name": p.name,
            "is_dir": p.is_dir(),
            "size": None if p.is_dir() else st.st_size,
            "mtime": st.st_mtime,
            "partial": p.suffix == ".part",
            "kind": None if p.is_dir() else media_kind(p.name),
            # needs_optimization() short-circuits on the extension check
            # before touching the file, so this is cheap for non-video entries.
            "optimizable": (not p.is_dir()) and video_optimize.needs_optimization(p),
        })
    rel_norm = "" if target == root else str(target.relative_to(root))
    return rel_norm, entries


def delete_path(root, rel):
    target = safe_path(root, rel)
    root = Path(root).resolve()
    if target == root:
        raise UnsafePath("Refusing to delete the download directory itself")
    if not target.exists():
        raise FileNotFoundError(str(target))
    if target.is_dir():
        import shutil
        shutil.rmtree(target)
    else:
        target.unlink()


def rename_path(root, rel, new_name):
    """Rename the file/folder at `rel` to `new_name`. `new_name` is always
    treated as a bare filename, never a path: sanitize_filename() strips
    any "/" it contains, and "."/".." are rejected explicitly — otherwise
    a rename could be (ab)used to move a file into a parent directory
    (Path.rename() doesn't stop ".." from working the way the OS normally
    would). Returns (new_rel_path, new_name)."""
    target = safe_path(root, rel)
    root = Path(root).resolve()
    if target == root:
        raise UnsafePath("Refusing to rename the download directory itself")
    if not target.exists():
        raise FileNotFoundError(str(target))
    if target.suffix == ".part":
        raise ValueError("No se puede renombrar una descarga en curso")

    raw = (new_name or "").strip()
    if not raw:
        raise ValueError("Falta el nombre nuevo")
    clean_name = sanitize_filename(raw)
    if clean_name == "download.bin" and raw != "download.bin":
        raise ValueError("El nombre no tiene caracteres válidos")
    if clean_name in (".", ".."):
        raise ValueError("Nombre inválido")

    new_target = target.parent / clean_name
    if new_target == target:
        return str(target.relative_to(root)), clean_name  # no-op, same name
    if new_target.exists():
        raise FileExistsError(f'Ya existe algo llamado "{clean_name}" ahí')

    target.rename(new_target)
    return str(new_target.relative_to(root)), clean_name


def prepare_preview(root, rel):
    """Returns (path, kind) for a previewable file — never a directory, and
    only for the video/audio/image extensions in media_kind()."""
    target = safe_path(root, rel)
    if not target.is_file():
        raise FileNotFoundError(str(target))
    kind = media_kind(target.name)
    if kind is None:
        raise ValueError(f"Unsupported file type for preview: {target.name!r}")
    return target, kind


def prepare_download(root, rel):
    """Returns (path_to_send, download_name, is_temp). For a directory, zips
    it into a temp file first — caller is responsible for deleting it
    (is_temp=True) once the response has been sent."""
    target = safe_path(root, rel)
    if not target.exists():
        raise FileNotFoundError(str(target))
    if target.is_file():
        return target, target.name, False

    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in target.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(target))
    return Path(tmp_path), f"{target.name}.zip", True
