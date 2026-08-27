"""Upload clients for the sites that support it from the web UI: Bunkr and
Filester (real user account required, folder/album selection), Gofile
(account optional — anonymous guest upload works, a token additionally
unlocks folder targeting and makes the upload permanent instead of
expiring after ~10 days of inactivity), and FileDitch (always anonymous,
no account, no folders — see its section for why).

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
from urllib.parse import urlsplit

import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder, MultipartEncoderMonitor

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


class _ProgressFile:
    """Wraps a binary file object so its .read() calls report cumulative
    bytes read to progress_cb(sent, total) — for FileDitch, the one site
    that posts a raw file body instead of multipart (MultipartEncoder
    doesn't apply there)."""

    def __init__(self, fileobj, total, progress_cb):
        self._f = fileobj
        self._total = total
        self._cb = progress_cb
        self._read = 0

    def read(self, size=-1):
        chunk = self._f.read(size)
        if chunk:
            self._read += len(chunk)
            self._cb(self._read, self._total)
        return chunk

    def __len__(self):
        return self._total

    def __getattr__(self, name):
        return getattr(self._f, name)


def _post_multipart(url, fields, headers, progress_cb, timeout=None):
    """POST a multipart/form-data body, optionally reporting bytes sent as
    it streams (rather than requests' default of handing the whole
    encoded body to the socket in one call with no visibility)."""
    encoder = MultipartEncoder(fields=fields)
    body = encoder
    if progress_cb:
        body = MultipartEncoderMonitor(encoder, lambda m: progress_cb(m.bytes_read, encoder.len))
    headers = {**headers, "Content-Type": encoder.content_type}
    return requests.post(url, data=body, headers=headers, timeout=timeout)


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


def gofile_create_guest_token():
    """Mints a temporary anonymous Gofile account -- exactly what an
    anonymous upload already gets implicitly server-side (its response
    includes a "guestToken"), just obtained explicitly and upfront so a
    whole batch of files can share it (and one folder created under it)
    via the exact same token-based calls a real account uses below, no
    login involved. Returns (guest_token, root_folder_id)."""
    r = requests.post(f"{_GOFILE_API}/accounts", json={},
                       headers={"X-Website-Token": _gofile_wt(""), "X-BL": "en-US", "User-Agent": USER_AGENT},
                       timeout=TIMEOUT)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"gofile: respuesta inesperada creando cuenta invitada (HTTP {r.status_code})")
    if data.get("status") != "ok":
        raise UploadError("gofile: no se pudo crear una cuenta invitada")
    d = data["data"]
    return d["token"], d["rootFolder"]


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
    folder_id = data["id"]
    # A freshly created folder defaults to private ("public": false) --
    # completely undocumented, only found by creating one and checking its
    # own /contents response, and confirmed against a second, unrelated
    # guest account that it really is "This content is not publicly
    # accessible" until this call. Every share link this app hands out is
    # meant to be immediately open to whoever has it, same as every other
    # site here, so this always flips it right after creating it -- for
    # both the guest-folder batch flow and the regular "crear carpeta"
    # one, since both go through this same function.
    _gofile_call("PUT", f"/contents/{folder_id}/update", token,
                 json={"attribute": "public", "attributeValue": "true"})
    return folder_id, data.get("name", name)


def gofile_upload(token, path, folder_id=None, progress_cb=None):
    """`token` is optional — without one this uploads to a temporary guest
    account (link works, but expires after ~10 days of inactivity and can't
    target a folder). Passing a token makes it permanent and folder-aware.

    Returns (file_url, folder_url) -- folder_url is None unless this landed
    in a folder, in which case both the file's own link (its own "code",
    always distinct from the folder's) and the folder's link
    ("parentFolderCode") are real, independently-working share links, so
    both are worth surfacing rather than just one silently swallowing the
    other (this used to only return the folder link when there was one,
    losing the file's own)."""
    fields = {}
    if folder_id and token:
        fields["folderId"] = (None, folder_id)
    headers = {"User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with open(path, "rb") as f:
        fields["file"] = (Path(path).name, f, mimetypes.guess_type(path)[0] or "application/octet-stream")
        r = _post_multipart(_GOFILE_UPLOAD, fields, headers, progress_cb)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"gofile: respuesta inesperada al subir (HTTP {r.status_code})")
    if data.get("status") != "ok":
        raise UploadError(f"gofile: {data.get('status', 'error al subir')}")
    d = data["data"]
    file_url = f"https://gofile.io/d/{d['code']}"
    folder_code = d.get("parentFolderCode")
    folder_url = f"https://gofile.io/d/{folder_code}" if folder_code else None
    return file_url, folder_url


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
    """The node's own URL can carry any path (or none) — the reference
    client (NTFSvolume/bunkr) discards it entirely and hits "/api" at that
    origin, rather than appending "/api" to whatever path was returned.
    Concatenating instead of replacing was producing a wrong, 404ing path
    for at least some nodes."""
    data = _bunkr_call("GET", "node", token)
    parts = urlsplit(data["url"])
    return f"{parts.scheme}://{parts.netloc}/api"


def bunkr_upload(token, path, album_id=None, progress_cb=None):
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
            fields = {"files[]": (filename, f, mimetype)}
            r = _post_multipart(f"{server}/upload", fields, {**_bunkr_headers(token), **headers}, progress_cb)
        result = _json_or_raise(r, "Bunkr")
    else:
        file_uuid = str(uuid.uuid4())
        # The reference client splits into chunks of chunkSize.max (not
        # .default) unless the user explicitly overrides it — match that so
        # dzchunksize matches what the node actually expects per chunk.
        chunk_size = max_direct
        total = (size + chunk_size - 1) // chunk_size
        with open(path, "rb") as f:
            for index in range(total):
                chunk = f.read(chunk_size)
                offset = index * chunk_size
                fields = {"dzuuid": file_uuid, "dzchunkindex": str(index),
                          "dztotalfilesize": str(size), "dzchunksize": str(chunk_size),
                          "dztotalchunkcount": str(total), "dzchunkbyteoffset": str(offset),
                          "files[]": (filename, chunk, "application/octet-stream")}
                chunk_cb = None
                if progress_cb:
                    chunk_cb = lambda sent, _t, _offset=offset: progress_cb(min(_offset + sent, size), size)
                r = _post_multipart(f"{server}/upload", fields, _bunkr_headers(token), chunk_cb)
                _json_or_raise(r, "Bunkr", context=f"chunk {index + 1}/{total}")
        r = requests.post(f"{server}/upload/finishchunks", headers={**_bunkr_headers(token), "Content-Type": "application/json"},
                           timeout=TIMEOUT, json={"files": [{"uuid": file_uuid, "original": filename,
                                                              "type": mimetype, "albumid": album_id,
                                                              "filelength": None, "age": None}]})
        result = _json_or_raise(r, "Bunkr")

    files = result.get("files") or []
    if not files or not files[0].get("url"):
        raise UploadError("Bunkr: la subida no devolvió un link")
    # No folder_url here (unlike Gofile) -- constructing the album's public
    # /a/<id> URL from the dashboard API's own internal album id would be
    # guessing whether that id is really the same public slug, and this
    # module doesn't have a real Bunkr account to verify it against (same
    # reasoning as sites/filester.py's own folder-listing caveat).
    return files[0]["url"], None


def _json_or_raise(response, site, context=None):
    try:
        data = response.json()
    except ValueError:
        raise UploadError(f"{site}: respuesta inesperada (HTTP {response.status_code})" + (f" [{context}]" if context else ""))
    if data.get("success") is False:
        raise UploadError(f"{site}: {data.get('description') or 'error al subir'}" + (f" [{context}]" if context else ""))
    return data


# ── Filester ────────────────────────────────────────────────────────────
# Documented API (https://filester.gg/api-docs), unlike Gofile/Bunkr — no
# reverse-engineering needed here. Same platform as proxy_downloader/sites/
# filester.py's *download* side, but the account/upload API lives on a
# different host (u1.filester.me) and is entirely separate from that
# module's public, unauthenticated download-resolve flow.
_FILESTER_API = "https://u1.filester.me/api/v1"


def _filester_headers(token):
    headers = {"User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _filester_call(method, path, token, **kwargs):
    r = requests.request(method, f"{_FILESTER_API}{path}", headers=_filester_headers(token),
                          timeout=TIMEOUT, **kwargs)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"Filester: respuesta inesperada (HTTP {r.status_code})")
    if not data.get("success"):
        raise UploadError(f"Filester: {data.get('message') or data.get('error') or 'error desconocido'}")
    return data


def filester_verify(token):
    try:
        data = _filester_call("GET", "/account", token)
    except UploadError:
        raise UploadError("Token inválido o vencido")
    info = data["data"]
    return f"{info.get('username', '?')} (#{info.get('id', '?')})", None


def filester_list_folders(token, _root=None):
    data = _filester_call("GET", "/folders", token)
    return [{"id": f["id"], "name": f["name"]} for f in data.get("data", [])]


def filester_create_folder(token, parent_id, name):
    body = {"name": name}
    if parent_id:
        body["parent"] = parent_id
    data = _filester_call("POST", "/folder", token, json=body)
    d = data["data"]
    return d["identifier"], d.get("name", name)


def filester_upload(token, path, folder_id=None, progress_cb=None):
    headers = _filester_headers(token)
    if folder_id:
        headers["X-Folder-ID"] = str(folder_id)
    mimetype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        fields = {"file": (Path(path).name, f, mimetype)}
        r = _post_multipart(f"{_FILESTER_API}/upload", fields, headers, progress_cb)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"Filester: respuesta inesperada al subir (HTTP {r.status_code})")
    if not data.get("success"):
        raise UploadError(f"Filester: {data.get('message') or 'error al subir'}")
    # No folder_url -- same reasoning as bunkr_upload() above.
    return data["url"], None


# ── FileDitch ───────────────────────────────────────────────────────────
# No accounts, no folders — every upload is anonymous and independent (see
# proxy_downloader/sites/fileditch.py's docstring). Kept here anyway since
# it's still "upload to a site", just without the account/folder step.
_FILEDITCH_UPLOAD = "https://new.fileditch.com/upload.php"


def fileditch_upload(path, progress_cb=None):
    size = Path(path).stat().st_size
    with open(path, "rb") as f:
        body = _ProgressFile(f, size, progress_cb) if progress_cb else f
        r = requests.post(f"{_FILEDITCH_UPLOAD}?filename={Path(path).name}", data=body,
                           headers={"User-Agent": USER_AGENT, "Content-Type": "application/octet-stream"},
                           timeout=None)
    try:
        data = r.json()
    except ValueError:
        raise UploadError(f"FileDitch: respuesta inesperada (HTTP {r.status_code})")
    if not data.get("success"):
        raise UploadError(f"FileDitch: {data.get('error') or 'error al subir'}")
    return data["url"], None  # no folders on FileDitch at all


# ── registry ────────────────────────────────────────────────────────────
SITES = {
    "gofile": {
        "label": "Gofile",
        "needs_account": False,
        "account_optional": True,
        "has_folders": True,
        "verify": gofile_verify,
        "list_folders": gofile_list_folders,
        "create_folder": gofile_create_folder,
        "upload": gofile_upload,
        # Only Gofile has this: a temp folder that groups several anonymous
        # uploads together without ever requiring a real account. Sites
        # that need_account (Bunkr/Filester) have no anonymous-folder
        # concept at all; FileDitch has no folders, period.
        "create_guest_token": gofile_create_guest_token,
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
        "upload": lambda _token, path, _folder_id=None, progress_cb=None: fileditch_upload(path, progress_cb=progress_cb),
    },
    "filester": {
        "label": "Filester",
        "needs_account": True,
        "has_folders": True,
        "verify": filester_verify,
        "list_folders": filester_list_folders,
        "create_folder": filester_create_folder,
        "upload": filester_upload,
    },
}
