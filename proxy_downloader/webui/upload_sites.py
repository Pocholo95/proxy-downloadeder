"""Upload clients for the 3 sites that support it from the web UI: Gofile
and Bunkr (real user account + folder/album selection) and FileDitch
(anonymous, no account, no folders — see its section for why).

Every function takes credentials explicitly rather than reading site_prefs
itself — the caller (upload_jobs.py) owns persistence, this stays a plain
HTTP client. Raises UploadError with a message that's safe to show the user
directly; anything else (network blip, unexpected JSON shape) is left to
the caller to catch and report generically.
"""
import hashlib
import mimetypes
import re
import time
import uuid
from pathlib import Path

import requests

TIMEOUT = 20
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

_SIZE_RE = re.compile(r'^([\d.]+)\s*([KMGT]?i?B)$', re.I)
_SIZE_UNITS = {
    "B": 1,
    "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4,
    "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3, "TIB": 1024**4,
}


class UploadError(Exception):
    pass


def _parse_size(value):
    """"95MB"/"25.5MiB"/raw int -> bytes. Bunkr's /check returns human-
    readable strings (decimal MB, not binary MiB) for chunk/file size
    limits — this has to match that convention or the size comparisons
    that decide direct-vs-chunked upload silently misfire."""
    if isinstance(value, (int, float)):
        return int(value)
    m = _SIZE_RE.match(str(value).strip())
    if not m:
        raise UploadError(f"Bunkr: tamaño con formato inesperado: {value!r}")
    return int(float(m.group(1)) * _SIZE_UNITS[m.group(2).upper()])


# ── Gofile ──────────────────────────────────────────────────────────────
# Same account/anti-scraping-token mechanics as proxy_downloader/sites/
# gofile.py (see that module's docstring for how "X-Website-Token" was
# reverse-engineered) — duplicated rather than shared because this side
# always authenticates with the *user's own* persistent account token
# instead of a fresh throwaway guest one.
_GOFILE_API = "https://api.gofile.io"
_GOFILE_UPLOAD = "https://upload.gofile.io/uploadfile"
_GOFILE_WT_SECRET = "12af056dacea0b"


def _gofile_wt(account_token):
    time_slot = int(time.time()) // 14400
    raw = f"{USER_AGENT}::en-US::{account_token}::{time_slot}::{_GOFILE_WT_SECRET}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _gofile_headers(token):
    return {
        "X-Website-Token": _gofile_wt(token),
        "X-BL": "en-US",
        "Authorization": f"Bearer {token}",
        "User-Agent": USER_AGENT,
    }


def _gofile_call(method, path, token, **kwargs):
    r = requests.request(method, f"{_GOFILE_API}{path}", headers=_gofile_headers(token),
                          timeout=TIMEOUT, **kwargs)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"gofile: respuesta inesperada (HTTP {r.status_code})")
    if data.get("status") != "ok":
        raise UploadError(f"gofile: {data.get('status', 'error desconocido')}")
    return data["data"]


def gofile_verify(token):
    """Returns (label, root_folder_id) on a valid token, raises UploadError otherwise."""
    try:
        info = _gofile_call("GET", "/accounts/getid", token)
    except UploadError:
        raise UploadError("Token inválido o vencido")
    account = _gofile_call("GET", f"/accounts/{info['id']}", token)
    label = f"{info.get('email', info['id'])} ({info.get('tier', '?')})"
    return label, account["rootFolder"]


def gofile_list_folders(token, root_folder_id):
    """Flat list of {id, name} for every folder directly under root — good
    enough for a single-level picker; nested folders can still be reached
    by creating a new one inside via gofile_create_folder(parent_id=...)."""
    content = _gofile_call("GET", f"/contents/{root_folder_id}", token)
    folders = [{"id": root_folder_id, "name": "(raíz)"}]
    for child in content.get("children", {}).values():
        if child.get("type") == "folder":
            folders.append({"id": child["id"], "name": child.get("name", child["id"])})
    return folders


def gofile_create_folder(token, parent_id, name):
    data = _gofile_call("POST", "/contents/createFolder", token,
                         json={"parentFolderId": parent_id, "folderName": name})
    return data["id"], data.get("name", name)


def gofile_upload(token, path, folder_id=None):
    fields = {}
    if folder_id:
        fields["folderId"] = (None, folder_id)
    with open(path, "rb") as f:
        fields["file"] = (Path(path).name, f, mimetypes.guess_type(path)[0] or "application/octet-stream")
        r = requests.post(_GOFILE_UPLOAD, files=fields,
                           headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
                           timeout=None)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"gofile: respuesta inesperada al subir (HTTP {r.status_code})")
    if data.get("status") != "ok":
        raise UploadError(f"gofile: {data.get('status', 'error al subir')}")
    d = data["data"]
    return f"https://gofile.io/d/{d.get('parentFolderCode') or d['code']}"


# ── Bunkr ───────────────────────────────────────────────────────────────
# Account dashboard API, distinct from the public download mirrors in
# proxy_downloader/sites/bunkr.py — reverse-engineered from
# https://github.com/NTFSvolume/bunkr (their own upload CLI). Token comes
# from the user's dash.bunkr.cr account settings.
_BUNKR_API = "https://dash.bunkr.cr/api"


def _bunkr_headers(token):
    return {"User-Agent": USER_AGENT, "Referer": "https://dash.bunkr.cr/",
            "Origin": "https://dash.bunkr.cr", "token": token}


def _bunkr_call(method, path, token, **kwargs):
    r = requests.request(method, f"{_BUNKR_API}/{path}", headers=_bunkr_headers(token),
                          timeout=TIMEOUT, **kwargs)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"Bunkr: respuesta inesperada (HTTP {r.status_code})")
    if data.get("success") is False:
        raise UploadError(f"Bunkr: {data.get('description') or 'error desconocido'}")
    return data


def bunkr_verify(token):
    data = _bunkr_call("POST", "tokens/verify", token, json={"token": token})
    return f"{data.get('username', '?')} ({data.get('group', '?')})", None


def bunkr_list_folders(token, _root=None):
    albums, page = [], 0
    while True:
        data = _bunkr_call("GET", f"albums/{page}", token)
        page_albums = data.get("albums", [])
        albums.extend({"id": a["id"], "name": a["name"]} for a in page_albums)
        if len(page_albums) < 50:
            break
        page += 1
    return albums


def bunkr_create_folder(token, _parent_id, name):
    data = _bunkr_call("POST", "albums", token,
                        json={"name": name, "description": "", "public": True, "download": True})
    return data["id"], name


def _bunkr_upload_server(token):
    data = _bunkr_call("GET", "node", token)
    return data["url"].rstrip("/") + "/api"


def bunkr_upload(token, path, album_id=None):
    info = _bunkr_call("GET", "check", token)
    max_direct = _parse_size(info["chunkSize"]["max"])
    size = Path(path).stat().st_size
    max_size = _parse_size(info["maxSize"])
    if size > max_size:
        raise UploadError(f"Bunkr: el archivo ({size / 1e6:.0f} MB) supera el máximo permitido ({info['maxSize']})")
    server = _bunkr_upload_server(token)
    headers = {"albumid": str(album_id)} if album_id else {}
    filename = Path(path).name
    mimetype = mimetypes.guess_type(path)[0] or "application/octet-stream"

    if size <= max_direct:
        with open(path, "rb") as f:
            r = requests.post(f"{server}/upload", files={"files[]": (filename, f, mimetype)},
                               headers={**_bunkr_headers(token), **headers}, timeout=None)
        result = _json_or_raise(r, "Bunkr")
    else:
        file_uuid = str(uuid.uuid4())
        chunk_size = _parse_size(info["chunkSize"]["default"]) if info["chunkSize"].get("default") else max_direct
        total = (size + chunk_size - 1) // chunk_size
        with open(path, "rb") as f:
            for index in range(total):
                chunk = f.read(chunk_size)
                r = requests.post(f"{server}/upload", headers=_bunkr_headers(token), timeout=None,
                                   data={"dzuuid": file_uuid, "dzchunkindex": str(index),
                                         "dztotalfilesize": str(size), "dzchunksize": str(chunk_size),
                                         "dztotalchunkcount": str(total), "dzchunkbyteoffset": str(index * chunk_size)},
                                   files={"files[]": (filename, chunk, "application/octet-stream")})
                _json_or_raise(r, "Bunkr", context=f"chunk {index + 1}/{total}")
        r = requests.post(f"{server}/upload/finishchunks", headers={**_bunkr_headers(token), "Content-Type": "application/json"},
                           timeout=TIMEOUT, json={"files": [{"uuid": file_uuid, "original": filename,
                                                              "type": mimetype, "albumid": album_id,
                                                              "filelength": None, "age": None}]})
        result = _json_or_raise(r, "Bunkr")

    files = result.get("files") or []
    if not files or not files[0].get("url"):
        raise UploadError("Bunkr: la subida no devolvió un link")
    return files[0]["url"]


def _json_or_raise(response, site, context=None):
    try:
        data = response.json()
    except ValueError:
        raise UploadError(f"{site}: respuesta inesperada (HTTP {response.status_code})" + (f" [{context}]" if context else ""))
    if data.get("success") is False:
        raise UploadError(f"{site}: {data.get('description') or 'error al subir'}" + (f" [{context}]" if context else ""))
    return data


# ── FileDitch ───────────────────────────────────────────────────────────
# No accounts, no folders — every upload is anonymous and independent (see
# proxy_downloader/sites/fileditch.py's docstring). Kept here anyway since
# it's still "upload to a site", just without the account/folder step.
_FILEDITCH_UPLOAD = "https://new.fileditch.com/upload.php"


def fileditch_upload(path):
    with open(path, "rb") as f:
        r = requests.post(f"{_FILEDITCH_UPLOAD}?filename={Path(path).name}", data=f,
                           headers={"User-Agent": USER_AGENT, "Content-Type": "application/octet-stream"},
                           timeout=None)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"FileDitch: respuesta inesperada (HTTP {r.status_code})")
    if not data.get("success"):
        raise UploadError(f"FileDitch: {data.get('error') or 'error al subir'}")
    return data["url"]


# ── registry ────────────────────────────────────────────────────────────
SITES = {
    "gofile": {
        "label": "Gofile",
        "needs_account": True,
        "has_folders": True,
        "verify": gofile_verify,
        "list_folders": gofile_list_folders,
        "create_folder": gofile_create_folder,
        "upload": gofile_upload,
    },
    "bunkr": {
        "label": "Bunkr",
        "needs_account": True,
        "has_folders": True,
        "verify": bunkr_verify,
        "list_folders": bunkr_list_folders,
        "create_folder": bunkr_create_folder,
        "upload": bunkr_upload,
    },
    "fileditch": {
        "label": "FileDitch",
        "needs_account": False,
        "has_folders": False,
        "verify": None,
        "list_folders": None,
        "create_folder": None,
        "upload": lambda _token, path, _folder_id=None: fileditch_upload(path),
    },
}
