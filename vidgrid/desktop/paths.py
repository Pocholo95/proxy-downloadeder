"""Resource path resolution for dev vs. PyInstaller-frozen runs."""

import shutil
import sys
from pathlib import Path

# Bundled binaries are named ffmpeg.exe/ffprobe.exe on Windows and plain
# ffmpeg/ffprobe elsewhere (Linux/macOS).
_EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""


def app_root() -> Path:
    """Directory containing bundled data (frozen) or the repo root (dev).

    sys._MEIPASS is set in both --onefile and --onedir frozen builds --
    for --onedir (what this app uses) it's the static "_internal" folder
    PyInstaller 6.x collects `datas`/`binaries` into, not a temp extraction
    dir, so this is stable and correct (not just a onefile-only concept).
    """
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def dist_dir() -> Path:
    return app_root() / "dist"


def bin_dir() -> Path:
    return app_root() / "bin"


def _resolve_tool(name: str) -> Path:
    """Bundled bin/<name>[.exe] if present, else the same tool on PATH.

    Distro ffmpeg/ffprobe builds on Linux commonly already include AV1
    support, so falling back to PATH lets Linux users skip bundling their
    own binaries under bin/ entirely.
    """
    bundled = bin_dir() / f"{name}{_EXE_SUFFIX}"
    if bundled.is_file():
        return bundled
    on_path = shutil.which(name)
    return Path(on_path) if on_path else bundled


def ffmpeg_exe() -> Path:
    return _resolve_tool("ffmpeg")


def ffprobe_exe() -> Path:
    return _resolve_tool("ffprobe")
