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


class UnsafePath(ValueError):
    pass


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
