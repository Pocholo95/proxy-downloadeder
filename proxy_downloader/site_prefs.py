"""Per-site config files: config/<site>.json, one independent file per site.

A stub file gets created for every registered site the first time it's
needed, so `config/` is discoverable and directly editable — open
config/mediafire.json and flip "use_proxy" to true/false. Editing by hand and
using --enable-proxy/--disable-proxy/--reset-proxy end up in the same place.

Only `use_proxy` is a real setting today; the file is a plain dict so more
keys can be added later (per-site timeout, retry tuning, etc.) without a
format change. "_site_default_use_proxy" is informational only — it's
refreshed on every run to show what "null" currently resolves to, and is
never read back as a setting.
"""
import json
from pathlib import Path

CONFIG_DIR = Path("config")

_DEFAULTS = {"use_proxy": None}


def _path(name):
    return CONFIG_DIR / f"{name}.json"


def _load(name):
    path = _path(name)
    try:
        if path.exists():
            data = json.loads(path.read_text())
            return {**_DEFAULTS, **data}
    except Exception:
        pass
    return dict(_DEFAULTS)


def _save(name, data):
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _path(name).write_text(json.dumps(data, indent=2) + "\n")
    except Exception:
        pass


def sync_config_file(name, site_default_use_proxy):
    """Create config/<name>.json if missing, and always refresh its
    "_site_default_use_proxy" info field — without ever touching whatever
    "use_proxy" the user has set (including null)."""
    data = _load(name)
    data["_site_default_use_proxy"] = site_default_use_proxy
    _save(name, data)


def get_override(name):
    """True/False if config/<name>.json sets use_proxy explicitly, None
    if the file is missing or has it set to null (= site's own default)."""
    return _load(name).get("use_proxy")


def set_override(name, enabled):
    data = _load(name)
    data["use_proxy"] = enabled
    _save(name, data)


def clear_override(name):
    data = _load(name)
    data["use_proxy"] = None
    _save(name, data)
