"""Tracks every file this app has ever successfully downloaded, keyed by
(site, file_id) -- so a link pasted again (e.g. an old batch re-pasted by
mistake, or a folder re-added because a new file was seen) doesn't
re-download something already on disk, and so a link whose file was later
moved/deleted doesn't just silently sit un-flagged.

Stored as one JSON file, same lightweight read-whole/write-whole pattern as
site_prefs.py -- this app only ever has one job worker thread touching it at
a time (see jobs.py's module docstring), so no locking is needed.
"""
import json
import time
from pathlib import Path


def _path(state_dir):
    return Path(state_dir) / "download_history.json"


def _key(site, file_id):
    return f"{site}:{file_id}"


def _load(state_dir):
    path = _path(state_dir)
    try:
        if path.exists():
            return json.loads(path.read_text())
    except Exception:
        pass
    return {}


def _save(state_dir, data):
    try:
        path = _path(state_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(path)
    except Exception:
        pass


def lookup(state_dir, site, file_id):
    """Returns the path this (site, file_id) was saved to last time it
    downloaded successfully, or None if it's never been seen before."""
    entry = _load(state_dir).get(_key(site, file_id))
    return entry.get("path") if entry else None


def record(state_dir, site, file_id, path):
    data = _load(state_dir)
    data[_key(site, file_id)] = {"path": str(path), "recorded_at": time.time()}
    _save(state_dir, data)


def snapshot(state_dir):
    """{site:file_id -> recorded path} for every known download, loaded once
    so a caller checking hundreds of items (the folder watcher) doesn't
    re-read the whole file per lookup."""
    return {k: v.get("path") for k, v in _load(state_dir).items()}


def snapshot_key(site, file_id):
    return _key(site, file_id)
