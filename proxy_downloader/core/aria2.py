"""Thin wrapper around the `aria2c` CLI for fast, resumable, multi-connection
downloads.

Used for every download that doesn't need per-chunk proxy rotation: proxy
downloads (`download_file`) stay on `requests`, since aria2 has no way to
hop to a different proxy mid-download the way this project's own
speed-based rotation does (see PROXY_MODE docs) -- this module only ever
gets used for the "no proxy" paths (`download_direct`, and the
Violentmonkey-userscript-fed jobs, which never go through a proxy at all).

aria2 handles resume, integrity-preserving partial-file continuation and
multi-connection splitting internally (via its own `.aria2` control file
next to the destination), so callers don't need to do any of that
bookkeeping themselves -- just point it at a destination path and it either
resumes what's there or starts fresh.
"""
import re
import subprocess
from collections import deque
from pathlib import Path

ARIA2_BIN = "aria2c"

# aria2's periodic progress line looks like one of:
#   [#2089b0 298KiB/972KiB(30%) CN:1 DL:44KiB ETA:15s]
#   [#2089b0 298KiB DL:44KiB]                            (total size unknown)
_PROGRESS_RE = re.compile(
    r"\[#\S+\s+([\d.]+)(B|[KMGT]iB)(?:/([\d.]+)(B|[KMGT]iB)\(\d+%\))?[^\]]*?DL:([\d.]+)(B|[KMGT]iB)"
)
_UNITS = {"B": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3, "TiB": 1024 ** 4}


def _to_bytes(value, unit):
    if value is None:
        return None
    return int(float(value) * _UNITS.get(unit, 1))


def fetch(url, dest, headers=None, connections=4, on_progress=None, cancel_event=None):
    """Download `url` into the exact path `dest` (a Path), resuming if it
    already partially exists there.

    Returns (status, message): status is "done", "cancelled" or "failed"
    (message is None unless "failed", in which case it's the tail of
    aria2c's own output).

    `on_progress(bytes_done, total_or_None, speed_kb)` is called for every
    progress line aria2c prints (about once a second, via
    --summary-interval below).
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        ARIA2_BIN,
        "--continue=true",
        "--auto-file-renaming=false",
        "--allow-overwrite=true",
        "--file-allocation=none",
        "--max-tries=5",
        "--retry-wait=2",
        "--summary-interval=1",
        "--console-log-level=warn",
        f"--max-connection-per-server={connections}",
        f"--split={connections}",
        "--min-split-size=1M",
    ]
    for k, v in (headers or {}).items():
        cmd.append(f"--header={k}: {v}")
    cmd += ["-o", dest.name, "-d", str(dest.parent), url]

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, bufsize=1)
    except FileNotFoundError:
        return "failed", "aria2c no está instalado"

    tail = deque(maxlen=15)
    try:
        for line in proc.stdout:
            line = line.rstrip("\n")
            if line:
                tail.append(line)
            if cancel_event is not None and cancel_event.is_set():
                proc.terminate()
                break
            m = _PROGRESS_RE.search(line)
            if m and on_progress:
                done = _to_bytes(m.group(1), m.group(2))
                total = _to_bytes(m.group(3), m.group(4)) if m.group(3) else None
                speed_kb = (_to_bytes(m.group(5), m.group(6)) or 0) / 1024
                on_progress(done, total, speed_kb)
    finally:
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    if cancel_event is not None and cancel_event.is_set():
        return "cancelled", None
    if proc.returncode == 0:
        return "done", None
    return "failed", " | ".join(tail) or f"aria2c exit code {proc.returncode}"
