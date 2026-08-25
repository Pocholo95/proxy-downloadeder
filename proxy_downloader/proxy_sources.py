"""Named, swappable proxy sources. Exactly one is "active" at a time (a
global setting, same as everything else in config/) and feeds whichever
job needs a proxy pool — see build_pool() below, the one thing every
caller (cli.py, webui/jobs.py, webui/ytdlp_jobs.py) should use instead of
talking to proxy_downloader.proxy directly.

Two source *types*:
- "list": a URL to a plain-text list of raw host:port proxies — the
  original/only behavior before this module existed. Fetched, validated,
  rotated and blacklisted via proxy.ProxyPool exactly as always.
- "gateway": a single pre-authenticated endpoint from a paid rotating-
  proxy provider (e.g. Decodo — dashboard.decodo.com/residential-proxies,
  or any similarly-shaped service: one endpoint:port + username/password,
  where the provider itself rotates the exit IP server-side per request
  or per sticky session). There's nothing to fetch or validate for this
  type — see proxy.GatewayProxyPool for why.

Stored in config/proxy_sources.json (gitignored like every other
config/*.json here). list_sources() is the only thing the webui API
should ever return to a client — it never includes a gateway's password.
"""
import json
import uuid
from pathlib import Path
from urllib.parse import quote

from .config import PROXIES_URL
from .proxy import GatewayProxyPool, ProxyCache, ProxyPool, fetch_proxy_list

CONFIG_DIR = Path("config")
SOURCES_FILE = CONFIG_DIR / "proxy_sources.json"

_DEFAULT_ID = "default"


def _defaults():
    return {
        "active": _DEFAULT_ID,
        "sources": [
            {
                "id": _DEFAULT_ID,
                "name": "Lista pública (default)",
                "type": "list",
                "url": PROXIES_URL,
            }
        ],
    }


def _load():
    if SOURCES_FILE.exists():
        try:
            data = json.loads(SOURCES_FILE.read_text())
            if data.get("sources"):
                return data
        except Exception:
            pass
    return _defaults()


def _save(data):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SOURCES_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(SOURCES_FILE)


def _find(data, source_id):
    for s in data["sources"]:
        if s["id"] == source_id:
            return s
    return None


# ── public, client-safe view ──

def list_sources():
    """Never includes a gateway's password — has_password says whether
    one is set, nothing more."""
    data = _load()
    out = []
    for s in data["sources"]:
        item = {"id": s["id"], "name": s["name"], "type": s["type"], "active": s["id"] == data["active"]}
        if s["type"] == "list":
            item["url"] = s["url"]
        else:
            item["scheme"] = s.get("scheme", "http")
            item["host"] = s["host"]
            item["port"] = s["port"]
            item["username"] = s["username"]
            item["has_password"] = bool(s.get("password"))
        out.append(item)
    return out


def get_active_source():
    data = _load()
    return _find(data, data["active"]) or data["sources"][0]


def set_active(source_id):
    data = _load()
    if not _find(data, source_id):
        raise ValueError("Fuente desconocida")
    data["active"] = source_id
    _save(data)


# ── managing sources ──

def add_list_source(name, url):
    name = (name or "").strip()
    url = (url or "").strip()
    if not name:
        raise ValueError("Falta el nombre")
    if not url:
        raise ValueError("Falta la URL")
    data = _load()
    source_id = uuid.uuid4().hex[:8]
    data["sources"].append({"id": source_id, "name": name, "type": "list", "url": url})
    _save(data)
    return source_id


def add_gateway_source(name, host, port, username, password, scheme="http"):
    name = (name or "").strip()
    host = (host or "").strip()
    username = (username or "").strip()
    password = (password or "").strip()
    if not name:
        raise ValueError("Falta el nombre")
    if not host:
        raise ValueError("Falta el host")
    if not port:
        raise ValueError("Falta el puerto")
    if not username or not password:
        raise ValueError("Faltan usuario y/o contraseña")
    if scheme not in ("http", "https", "socks5", "socks4"):
        raise ValueError("Esquema inválido")
    data = _load()
    source_id = uuid.uuid4().hex[:8]
    data["sources"].append({
        "id": source_id, "name": name, "type": "gateway",
        "scheme": scheme, "host": host, "port": int(port),
        "username": username, "password": password,
    })
    _save(data)
    return source_id


def delete_source(source_id):
    data = _load()
    if not _find(data, source_id):
        raise ValueError("Fuente desconocida")
    if len(data["sources"]) == 1:
        raise ValueError("No se puede borrar la única fuente configurada")
    data["sources"] = [s for s in data["sources"] if s["id"] != source_id]
    if data["active"] == source_id:
        data["active"] = data["sources"][0]["id"]
    _save(data)


# ── building the actual pool a download job uses ──

def _gateway_proxy_url(source):
    scheme = source.get("scheme", "http")
    user = quote(source["username"], safe="")
    pw = quote(source["password"], safe="")
    return f"{scheme}://{user}:{pw}@{source['host']}:{source['port']}"


def build_pool(cache_file):
    """Returns (pool, error_message) for the currently active source —
    pool is None on failure, with error_message safe to show the user
    directly (mirrors the fetch_proxy_list()+ProxyPool()+initial_load()
    boilerplate every call site used to duplicate)."""
    source = get_active_source()
    if source["type"] == "gateway":
        return GatewayProxyPool(_gateway_proxy_url(source)), None

    raw = fetch_proxy_list(source["url"])
    if not raw:
        return None, f'No se pudo obtener la lista de proxies ("{source["name"]}")'
    cache = ProxyCache(cache_file)
    pool = ProxyPool(raw, source["url"], cache)
    if pool.initial_load() == 0:
        return None, f'No se encontraron proxies funcionando en "{source["name"]}"'
    return pool, None
