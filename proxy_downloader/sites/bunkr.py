"""Bunkr site provider: https://bunkr.si and its many mirror domains
(bunkr.sk, .ph, .cr, .is, .to, ...) — Bunkr rotates/adds TLDs over time to
dodge blocking, so `owns()` is overridden to match any host whose
second-level domain is "bunkr", rather than a fixed domains list that would
go stale.

Reverse-engineered from https://github.com/Lysagxra/BunkrDownloader
(verified live against real album/file/archive pages while building this,
since Bunkr doesn't publish an API):

  - An album page (`/a/<id>`) lists item pages (`/f|i|v/<slug>`) as anchor
    tags, plus an optional pagination nav for more pages.
  - Each item page usually embeds `var jsCDN = "https://<node>.cdn.cr/storage
    /media/<file>"` in an inline <script> — that's the real (unsigned) CDN
    path. Some asset types (seen on .zip archives in testing) don't have
    that var; those instead carry a `data-file-id` on a <script> tag, which
    resolves via `POST https://dl.bunkr.cr/api/_001_v2 {"id": file_id}` ->
    `{"mediafiles": base_url, "path": path}`.
  - Either way, the resulting path then needs signing:
    `GET https://glb-apisign.cdn.cr/sign?path=<path>` -> `{"token", "ex"}`,
    appended as `?token=...&ex=...` to the CDN URL. That signed link is
    short-lived, so (like Mediafire/FileDitch) it's resolved fresh on every
    download attempt rather than cached.

None of this is bypassing real security — same access a browser gets for a
public link, just automated; no anti-bot/PoW/CAPTCHA was hit in testing.
"""
import re
from urllib.parse import urlparse, urlunparse

import requests

from ..config import TIMEOUT
from ..core.base import SiteProvider, FileUnavailable
from ..core.registry import register
from ..ui import console

SIGN_API         = "https://glb-apisign.cdn.cr/sign"
DOWNLOAD_API     = "https://dl.bunkr.cr/api/_001_v2"
DOWNLOAD_REFERER = "https://dl.bunkrr.cr/"
USER_AGENT       = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0"

# Captures the whole URL (scheme optional) so download_url can re-fetch the
# exact same mirror domain the user linked to.
FILE_URL_RE   = re.compile(r'(?:https?://)?[a-z0-9.-]*bunkr[a-z0-9.-]*\.\w+/(?:f|i|v)/[^\s?#]+', re.I)
# Domain and album id captured separately: folder_id ends up as "domain:id"
# (see extract_folder_id) rather than a raw URL, since the engine joins
# folder_id onto the output path as a subdirectory name — a URL full of "/"
# would explode into a nested "https:/host/a/id" directory tree.
FOLDER_URL_RE = re.compile(r'(?:https?://)?([a-z0-9.-]*bunkr[a-z0-9.-]*\.\w+)/a/([^\s?#]+)', re.I)

JS_CDN_RE     = re.compile(r'var\s+jsCDN\s*=\s*"([^"]+)"')
FILE_ID_RE    = re.compile(r'<script[^>]*\bdata-file-id="(\d+)"')
ITEM_LINK_RE  = re.compile(r'<a[^>]*class="after:absolute after:z-10 after:inset-0"[^>]*href="([^"]+)"')
VALID_HREF_RE = re.compile(r'^/[fiv]/[^\s?#]+$')
PAGINATION_RE = re.compile(r'<nav[^>]*class="[^"]*pagination[^"]*"[^>]*>(.*?)</nav>', re.S)
PAGE_NUM_RE   = re.compile(r'\d+')


def _full_url(u):
    return u if u.startswith(("http://", "https://")) else f"https://{u}"


class BunkrProvider(SiteProvider):
    name    = "bunkr"
    # Representative examples only — owns()/extract_*_id() actually accept
    # any "bunkr<anything>.<tld>" host, see module docstring.
    domains = ["bunkr.si", "bunkr.sk", "bunkr.ph", "bunkr.cr", "bunkr.is", "bunkr.to"]

    # Signed CDN links, no per-IP throttling observed in testing — same
    # reasoning as Mediafire.
    use_proxy_by_default = False

    def owns(self, line):
        low = line.strip().lower()
        netloc = urlparse(low if "://" in low else f"//{low}").netloc
        host = netloc.split("@")[-1].split(":")[0]
        labels = host.split(".")
        return len(labels) >= 2 and labels[-2] == "bunkr"

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#") or not self.owns(line):
            return None
        m = FILE_URL_RE.search(line)
        return _full_url(m.group(0)) if m else None

    def extract_folder_id(self, line):
        line = line.strip()
        if not line or line.startswith("#") or not self.owns(line):
            return None
        m = FOLDER_URL_RE.search(line)
        return f"{m.group(1)}:{m.group(2)}" if m else None

    def resolve_folder(self, folder_id):
        try:
            domain, album_id = folder_id.split(":", 1)
            host_page = f"https://{domain}"
            url = f"{host_page}/a/{album_id}"
            items = []
            page = 1
            max_page = 1

            while page <= max_page:
                page_url = url if page == 1 else f"{url}?page={page}"
                r = requests.get(page_url, headers=self.request_headers(folder_id), timeout=TIMEOUT)
                r.raise_for_status()
                html = r.text

                if page == 1:
                    nav = PAGINATION_RE.search(html)
                    if nav:
                        nums = [int(n) for n in PAGE_NUM_RE.findall(nav.group(1))]
                        if nums:
                            max_page = max(nums)

                for href in ITEM_LINK_RE.findall(html):
                    if VALID_HREF_RE.match(href):
                        item_url = f"{host_page}{href}"
                        name = href.rsplit("/", 1)[-1]
                        items.append((item_url, name))

                page += 1

            return items
        except Exception as e:
            console.print(f"[red]✗ Error resolving Bunkr album {folder_id}: {e}[/red]")
            return []

    def download_url(self, file_id, proxies=None):
        r = requests.get(file_id, headers=self.request_headers(file_id), proxies=proxies, timeout=TIMEOUT)
        if r.status_code == 404:
            raise FileUnavailable("Archivo no encontrado en Bunkr (borrado o link inválido)")
        r.raise_for_status()
        html = r.text

        cdn_match = JS_CDN_RE.search(html)
        if cdn_match:
            cdn_url = cdn_match.group(1).replace(r"\/", "/")
            media_path = urlparse(cdn_url).path
        else:
            id_match = FILE_ID_RE.search(html)
            if not id_match:
                return None  # unexpected page shape — let the engine retry with another proxy

            dl = requests.post(DOWNLOAD_API, json={"id": id_match.group(1)},
                                headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"},
                                proxies=proxies, timeout=TIMEOUT)
            if dl.status_code != 200:
                return None
            data = dl.json()
            base_url, path = data.get("mediafiles"), data.get("path")
            if not base_url or not path:
                return None
            cdn_url = urlunparse(urlparse(base_url)._replace(path=path))
            media_path = path

        sign = requests.get(SIGN_API, params={"path": media_path},
                             headers={"User-Agent": USER_AGENT}, proxies=proxies, timeout=TIMEOUT)
        if sign.status_code != 200:
            return None
        sig = sign.json()
        token, expires = sig.get("token"), sig.get("ex")
        if not token or not expires:
            return cdn_url  # signing failed but we still have a (maybe-unsigned) link
        return f"{cdn_url}?token={token}&ex={expires}"

    def request_headers(self, file_id):
        return {"User-Agent": USER_AGENT, "Referer": DOWNLOAD_REFERER}

    def suggest_filename(self, file_id):
        name = urlparse(file_id).path.rsplit("/", 1)[-1]
        return name or None


register(BunkrProvider())
