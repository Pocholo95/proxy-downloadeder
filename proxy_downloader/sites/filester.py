"""Filester site provider: https://filester.me / https://filester.gg
(same platform, filester.gg's own share pages redirect through filester.me).

Previously evaluated and rejected (see README) because the *v1* download-
resolve endpoint (`/api/public/download`) hands out a link on filester's
storage CDN (`fsc1.cdn.cr/d/<signed-token>`) that's gated by DataDome — a
commercial anti-bot WAF, not something solvable with local computation the
way e.g. FileDitch's proof-of-work is.

Revisited after finding https://github.com/sintaxx/filester-downloader,
which uses a *v2* endpoint (`/v2/api/public/download`) instead. It hands
out a link on the same CDN host but shaped differently
(`fsc1.cdn.cr/v2/<file>?token=...&download=true`) that is **not** behind
DataDome at all — verified live end-to-end against a real uploaded file
(HEAD, plain GET, and a Range GET all returned real bytes with no
challenge). Folder listing (`/f/<slug>`, paginated) is adapted from the
same reference repo's regex but could only be checked structurally here —
verifying it against a real multi-file folder would need a paid/registered
filester account, which we don't have. Flag it if a real folder misbehaves.
"""
import re
from urllib.parse import quote

import requests

from ..config import TIMEOUT
from ..core.base import SiteProvider, FileUnavailable
from ..core.registry import register
from ..ui import console

API_V2 = "https://filester.me/v2/api/public/download"
USER_AGENT = "Mozilla/5.0"

FILE_URL_RE   = re.compile(r'filester\.(?:me|gg)/d/([A-Za-z0-9]+)', re.I)
FOLDER_URL_RE = re.compile(r'filester\.(?:me|gg)/f/([A-Za-z0-9]+)', re.I)

# A folder page lists each file as an element carrying data-name/data-size
# plus either a click handler or an inline redirect exposing the file's own
# /d/<slug> — matched loosely since we don't have a live page to pin the
# exact current markup against.
FILE_ITEM_RE = re.compile(
    r'data-name="(?P<name>[^"]+)"[^>]*data-size="(?P<size>\d+)".*?'
    r"(?:window\.location\.href='/d/(?P<slug1>[^']+)'|downloadFile\('(?P<slug2>[^']+)'\))",
    re.S,
)
NEXT_PAGE_RE = re.compile(r'\?page=(\d+)"[^>]*class="page-link"')


class FilesterProvider(SiteProvider):
    name    = "filester"
    domains = ["filester.me", "filester.gg"]

    # No confirmed evidence either way for per-IP throttling on the v2 CDN
    # path — erring toward proxy-on like the other guest/free-tier cloud
    # hosts (Gofile, Pixeldrain, Mega) rather than Mediafire-style CDN.
    use_proxy_by_default = True

    def __init__(self):
        self._name_cache = {}

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FILE_URL_RE.search(line)
        return m.group(1) if m else None

    def extract_folder_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FOLDER_URL_RE.search(line)
        return m.group(1) if m else None

    def resolve_folder(self, folder_id):
        items = []
        try:
            base = f"https://filester.me/f/{folder_id}"
            url, seen, page = base, set(), 1
            while url not in seen:
                seen.add(url)
                r = requests.get(url, headers=self.request_headers(folder_id), timeout=TIMEOUT)
                r.raise_for_status()
                html = r.text
                for m in FILE_ITEM_RE.finditer(html):
                    slug = m.group("slug1") or m.group("slug2")
                    if slug:
                        items.append((slug, m.group("name")))
                next_m = NEXT_PAGE_RE.search(html)
                if not next_m:
                    break
                page += 1
                url = f"{base}?page={page}"
        except Exception as e:
            console.print(f"[red]✗ Error resolving Filester folder {folder_id}: {e}[/red]")
        return items

    def download_url(self, file_id, proxies=None):
        r = requests.post(API_V2, json={"file_slug": file_id},
                           headers={**self.request_headers(file_id),
                                    "Accept": "application/json", "Content-Type": "application/json"},
                           proxies=proxies, timeout=TIMEOUT)
        if r.status_code == 404:
            raise FileUnavailable("Archivo no encontrado en Filester (borrado o link inválido)")
        r.raise_for_status()
        data = r.json()
        if not data.get("success"):
            return None  # unexpected shape — let the engine retry with another proxy

        server = str(data.get("server") or "").rstrip("/")
        file_path = str(data.get("file") or "")
        token = str(data.get("token") or "")
        if not (server and file_path and token):
            return None
        if data.get("name"):
            self._name_cache[file_id] = data["name"]
        return f"{server}/v2/{quote(file_path)}?token={quote(token)}&download=true"

    def request_headers(self, file_id):
        return {"User-Agent": USER_AGENT, "Referer": f"https://filester.me/d/{file_id}"}

    def suggest_filename(self, file_id):
        return self._name_cache.get(file_id)


register(FilesterProvider())
