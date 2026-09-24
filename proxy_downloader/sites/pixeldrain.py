"""Pixeldrain site provider: https://pixeldrain.com"""
import re

import requests

from ..core.base import SiteProvider
from ..core.registry import register
from ..ui import console

FILE_URL_RE   = re.compile(r'pixeldrain\.com/(?:u|api/file)/(?P<id>[a-zA-Z0-9_-]+)', re.I)
FOLDER_URL_RE = re.compile(r'pixeldrain\.com/l/(?P<id>[a-zA-Z0-9_-]+)', re.I)
BARE_ID_RE    = re.compile(r'^[a-zA-Z0-9_-]+$')


class PixeldrainProvider(SiteProvider):
    name       = "pixeldrain"
    domains    = ["pixeldrain.com"]
    is_default = True  # accepts bare IDs / "l:ID" with no domain in the line

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FILE_URL_RE.search(line)
        if m:
            return m.group("id")
        if "pixeldrain.com" in line.lower():
            return None  # a pixeldrain.com URL we don't recognize (e.g. a folder link)
        if BARE_ID_RE.match(line):
            return line
        return None

    def extract_folder_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FOLDER_URL_RE.search(line)
        if m:
            return m.group("id")
        if line.lower().startswith("l:"):
            return line[2:].strip()
        return None

    def resolve_folder(self, folder_id):
        url = f"https://pixeldrain.com/api/list/{folder_id}"
        try:
            r = requests.get(url, timeout=15)
            r.raise_for_status()
            files = r.json().get("files", [])
            return [(f["id"], f.get("name", f["id"])) for f in files]
        except Exception as e:
            console.print(f"[red]✗ Error resolving folder {folder_id}: {e}[/red]")
            return []

    def download_url(self, file_id, proxies=None):
        return f"https://pixeldrain.com/api/file/{file_id}"

    def request_headers(self, file_id):
        return {"Referer": f"https://pixeldrain.com/u/{file_id}", "User-Agent": "Mozilla/5.0"}

    def expected_hash(self, file_id):
        try:
            r = requests.get(f"https://pixeldrain.com/api/file/{file_id}/info", timeout=8)
            r.raise_for_status()
            return r.json().get("hash_sha256", None)
        except Exception:
            return None


register(PixeldrainProvider())
