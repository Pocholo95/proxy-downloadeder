"""Mediafire site provider: https://mediafire.com

Unlike Pixeldrain, Mediafire has no stable "GET this URL to download" endpoint —
the real CDN link is embedded in the file's HTML page and can expire, so
download_url() re-scrapes it on every attempt (see SiteProvider.download_url
docstring for why that's safe/cheap). File/folder metadata (size, sha256) comes
from Mediafire's public JSON API, which works anonymously for public files —
no session_token/login needed.
"""
import re

import requests

from ..config import TIMEOUT
from ..core.base import SiteProvider, FileUnavailable
from ..core.registry import register
from ..ui import console

FILE_URL_RE   = re.compile(r'mediafire\.com/file/(?P<id>[a-zA-Z0-9]+)', re.I)
FOLDER_URL_RE = re.compile(r'mediafire\.com/folder/(?P<id>[a-zA-Z0-9]+)', re.I)

API_BASE = "https://www.mediafire.com/api/1.5"

# The download page's markup order isn't guaranteed (href before or after id=),
# so grab the whole <a ...> tag containing id="downloadButton" and pull href
# out of that, rather than assuming attribute order.
DOWNLOAD_BTN_RE = re.compile(r'<a\s[^>]*id="downloadButton"[^>]*>', re.I | re.S)
HREF_RE         = re.compile(r'href="([^"]+)"', re.I)

# Mediafire's "hash" field is SHA-256 for modern files but MD5 for very old
# ones (per their docs) — we only ever compute SHA-256 locally, so an MD5
# value here must be ignored rather than compared (it would never match and
# would wrongly flag every such file as corrupt).
_SHA256_RE = re.compile(r'^[0-9a-f]{64}$', re.I)


class MediafireProvider(SiteProvider):
    name    = "mediafire"
    domains = ["mediafire.com"]

    # Mediafire's CDN links aren't rate-limited/blocked the way Pixeldrain's
    # are, so most users don't need proxy rotation here by default.
    # --proxy still forces it on for this site when wanted.
    use_proxy_by_default = False

    def __init__(self):
        self._info_cache = {}

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FILE_URL_RE.search(line)
        return m.group("id") if m else None

    def extract_folder_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FOLDER_URL_RE.search(line)
        return m.group("id") if m else None

    def resolve_folder(self, folder_id):
        files = []
        chunk = 1
        try:
            while True:
                r = requests.get(f"{API_BASE}/folder/get_content.php", params={
                    "folder_key": folder_id, "content_type": "files",
                    "chunk": chunk, "response_format": "json",
                }, timeout=TIMEOUT)
                r.raise_for_status()
                resp = r.json().get("response", {})
                if resp.get("result") != "Success":
                    console.print(f"[red]✗ Mediafire folder {folder_id}: {resp.get('message', 'error')}[/red]")
                    break
                content = resp.get("folder_content", {})
                for f in content.get("files", []):
                    files.append((f["quickkey"], f.get("filename", f["quickkey"])))
                    self._info_cache[f["quickkey"]] = f
                if content.get("more_chunks") != "yes":
                    break
                chunk += 1
        except Exception as e:
            console.print(f"[red]✗ Error resolving Mediafire folder {folder_id}: {e}[/red]")
        return files

    def _get_info(self, file_id):
        """Fetch (and cache) file/get_info.php for file_id. Returns None on error
        or if the file doesn't exist / isn't accessible."""
        if file_id in self._info_cache:
            return self._info_cache[file_id]
        info = None
        try:
            r = requests.get(f"{API_BASE}/file/get_info.php", params={
                "quick_key": file_id, "response_format": "json",
            }, timeout=TIMEOUT)
            r.raise_for_status()
            resp = r.json().get("response", {})
            if resp.get("result") == "Success":
                info = resp.get("file_info")
        except Exception:
            pass
        self._info_cache[file_id] = info
        return info

    def download_url(self, file_id, proxies=None):
        info = self._get_info(file_id)
        page_url = (info or {}).get("links", {}).get("normal_download") \
            or f"https://www.mediafire.com/file/{file_id}/file"

        r = requests.get(page_url, headers=self.request_headers(file_id),
                          proxies=proxies, timeout=TIMEOUT)
        if r.status_code == 404 or "/error.php" in r.url:
            raise FileUnavailable(f"{file_id} ya no está disponible en Mediafire (eliminado o privado)")

        m = DOWNLOAD_BTN_RE.search(r.text)
        href = HREF_RE.search(m.group(0)) if m else None
        # No button found but not a confirmed "gone" page either — could be a
        # transient anti-bot/interstitial page on this particular proxy's IP.
        # Return None: the engine treats that as retryable with a new proxy.
        return href.group(1) if href else None

    def request_headers(self, file_id):
        return {"User-Agent": "Mozilla/5.0"}

    def expected_hash(self, file_id):
        info = self._get_info(file_id)
        h = info.get("hash") if info else None
        return h if h and _SHA256_RE.match(h) else None

    def check_size(self, file_id):
        info = self._get_info(file_id)
        return int(info["size"]) if info and "size" in info else 0


register(MediafireProvider())
