"""Gofile site provider: https://gofile.io

Gofile has no plain "GET this and you're done" link — every URL under
gofile.io/d/<id> is a *content id* (an 8-char share code or a UUID) that can
point at either a single file or a folder; you only find out which by asking
the API, so extract_file_id() and extract_folder_id() both accept the same
id and let download_url()/resolve_folder() sort out what it actually is.

Reverse-engineered from https://github.com/ltsdw/gofile-downloader (and
verified live against the real API while building this) since Gofile
doesn't publish a public spec for the free/guest tier:

  - A throwaway "guest" account (POST /accounts, no login) is required to
    get a bearer token — without it, even public files 200 with an HTML
    shell page instead of the actual bytes.
  - Every api.gofile.io call also needs an `X-Website-Token` header, a
    SHA-256 of `{user-agent}::en-US::{account_token}::{4h time slot}::<fixed
    site secret>`. This isn't official API surface — it's baked into
    Gofile's frontend JS to slow down casual scraping, not real auth — but
    it does need to be present and correctly computed or requests are
    rejected.
  - The storage-server download link additionally needs Referer/Origin
    headers set to gofile.io, or it silently 200s with the website's HTML
    shell instead of erroring.

None of this is a security boundary we're defeating — it's the same access
a browser gets for a public link, just automated. Password-protected
content isn't supported (skipped rather than guessed at).
"""
import hashlib
import re
import threading
import time

import requests

from ..core.base import SiteProvider, FileUnavailable, RateLimited
from ..core.registry import register
from ..ui import console

API_BASE     = "https://api.gofile.io"
WEBSITE_HOST = "https://gofile.io/"
WT_SECRET    = "12af056dacea0b"
USER_AGENT   = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

URL_ID_RE = re.compile(r'gofile\.io/d/([A-Za-z0-9]+)', re.I)


class GofileProvider(SiteProvider):
    name    = "gofile"
    domains = ["gofile.io"]

    # Free/guest downloads are speed- and concurrency-capped per IP, same
    # spirit as Pixeldrain/Mega — proxy rotation is on by default here too.
    use_proxy_by_default = True

    def __init__(self):
        self._token = None
        self._token_lock = threading.Lock()

    # ── account / anti-scraping token plumbing ──
    @staticmethod
    def _website_token(account_token=""):
        time_slot = int(time.time()) // 14400
        raw = f"{USER_AGENT}::en-US::{account_token}::{time_slot}::{WT_SECRET}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def _ensure_token(self):
        if self._token:
            return self._token
        with self._token_lock:
            if self._token:
                return self._token
            r = requests.post(
                f"{API_BASE}/accounts", json={},
                headers={"X-Website-Token": self._website_token(), "X-BL": "en-US",
                         "User-Agent": USER_AGENT},
                timeout=15,
            )
            r.raise_for_status()
            data = r.json()
            if data.get("status") != "ok":
                raise FileUnavailable("gofile: no se pudo crear una cuenta guest")
            self._token = data["data"]["token"]
            return self._token

    def _get_content(self, content_id, proxies=None):
        token = self._ensure_token()
        headers = {
            "X-Website-Token": self._website_token(token),
            "X-BL": "en-US",
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
        }
        url = f"{API_BASE}/contents/{content_id}?cache=true&sortField=createTime&sortDirection=1"
        r = requests.get(url, headers=headers, proxies=proxies, timeout=15)
        if r.status_code == 429:
            raise RateLimited("gofile: rate limited")
        r.raise_for_status()
        payload = r.json()
        status = payload.get("status")
        if status == "error-notFound":
            raise FileUnavailable("El contenido no existe o fue borrado")
        if status != "ok":
            raise RateLimited(f"gofile devolvió estado inesperado: {status}")
        content = payload["data"]
        if content.get("passwordStatus") not in (None, "passwordOk"):
            raise FileUnavailable("Contenido protegido con contraseña — no soportado")
        return content

    # ── SiteProvider interface ──
    def extract_file_id(self, line):
        return self._extract_id(line)

    def extract_folder_id(self, line):
        return self._extract_id(line)

    @staticmethod
    def _extract_id(line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = URL_ID_RE.search(line)
        return m.group(1) if m else None

    def resolve_folder(self, folder_id):
        try:
            content = self._get_content(folder_id)
        except (FileUnavailable, RateLimited) as e:
            console.print(f"[red]✗ gofile {folder_id}: {e}[/red]")
            return []
        except Exception as e:
            console.print(f"[red]✗ Error resolving gofile folder {folder_id}: {e}[/red]")
            return []
        return self._flatten(content, "")

    def _flatten(self, content, prefix):
        """Folder listings only expand one level deep — a child that's itself
        a folder needs its own /contents lookup to see what's inside. Nested
        folders get flattened into the single output subdirectory the engine
        creates for this top-level folder_id, with the path baked into the
        filename (sanitize_filename() strips real "/" separators anyway)."""
        if content["type"] != "folder":
            name = f"{prefix} - {content['name']}" if prefix else content["name"]
            return [(content["id"], name)]

        items = []
        for child in content.get("children", {}).values():
            child_prefix = f"{prefix} - {child['name']}" if prefix else child["name"]
            if child["type"] == "folder":
                try:
                    child_content = self._get_content(child["id"])
                except Exception as e:
                    console.print(f"[red]✗ Error resolving gofile subfolder {child['id']}: {e}[/red]")
                    continue
                items.extend(self._flatten(child_content, child_prefix))
            else:
                items.append((child["id"], child_prefix))
        return items

    def download_url(self, file_id, proxies=None):
        content = self._get_content(file_id, proxies=proxies)
        if content["type"] != "file":
            raise FileUnavailable(
                "Ese link de gofile es una carpeta — usá modo carpeta (-F) o pegalo en un batch"
            )
        link = content.get("link")
        if not link:
            raise FileUnavailable("gofile no devolvió un link de descarga para este archivo")
        return link

    def request_headers(self, file_id):
        token = self._ensure_token()
        return {
            "User-Agent": USER_AGENT,
            "Authorization": f"Bearer {token}",
            "Cookie": f"accountToken={token}",
            "Referer": WEBSITE_HOST,
            "Origin": WEBSITE_HOST.rstrip("/"),
        }


register(GofileProvider())
