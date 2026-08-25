"""1fichier provider: https://1fichier.com

Free/anonymous downloads on 1fichier go through a same-page "wait, then
submit" flow. Verified live end-to-end (including the actual byte content
matching) against a file uploaded through 1fichier's own public
anonymous-upload form, from a plain unproxied (residential-ish) request:

  1. GET the file page. It embeds a countdown ("var ct = 60") before the
     free-download button un-disables in the browser; the server enforces
     this too — submitting before the countdown elapses gets a capacity/
     limit page back, not the file.
  2. POST that same URL (with the cookies from step 1) once the countdown
     has elapsed. The response embeds the real, direct CDN download link.
  3. GET that link WITH the same cookies — in testing it 410s without them.
     From there it's a normal streamable download (Content-Disposition,
     Accept-Ranges: bytes all present), so resume works for free.

IMPORTANT, also verified live: 1fichier fingerprints and outright blocks any
IP it identifies as datacenter/hosting/VPN ("professional infrastructure
detected") at step 1, before any wait or captcha — and that's what free
public proxy lists are made of. So proxy rotation, which helps on every other
site here, mostly just burns through the pool hitting that same block on
this one; see use_proxy_by_default below. A real residential IP (your own
connection via --no-proxy, or a residential-proxy gateway source added via
proxy_sources.py/the webui's "Fuentes de proxy" section) is what actually
gets past it. 1fichier's own pricing page also
documents a reCAPTCHA for guest downloads (didn't happen in our live tests,
but it's real) — we can't solve that either. Both cases raise RateLimited so
the engine moves to the next proxy without blacklisting a perfectly fine
proxy for other sites, instead of guessing at a bypass or hanging forever.

No folder support (1fichier doesn't expose one anonymously in a comparable
way) and no anonymous checksum for files we didn't upload ourselves —
expected_hash() is intentionally None, same tradeoff as Mediafire.
"""
import re
import time

import requests

from ..config import TIMEOUT
from ..core.base import SiteProvider, FileUnavailable, RateLimited
from ..core.registry import register
from ..ui import console

FILE_URL_RE = re.compile(r'1fichier\.com/\?(?P<id>[a-zA-Z0-9]+)', re.I)

_DEAD_RE = re.compile(
    r"requested file does not exist|n['’]existe pas|has been deleted|file not found",
    re.I,
)
_WAIT_RE = re.compile(
    r"you must wait|vous devez attendre|guest slots are currently in use|temporarily limited",
    re.I,
)
_BLOCKED_RE = re.compile(
    r"professional infrastructure detected|accès restreint|belonging to a server, proxy, vpn",
    re.I,
)
_CAPTCHA_RE   = re.compile(r"recaptcha|g-recaptcha|h-captcha|hcaptcha", re.I)
_COUNTDOWN_RE = re.compile(r"var\s+ct\s*=\s*(\d+)")
_LINK_RE      = re.compile(r'https://(?!img\.)[a-z0-9-]+\.1fichier\.com/[^\s"\'<>]+', re.I)


class FichierProvider(SiteProvider):
    name    = "1fichier"
    domains = ["1fichier.com"]

    # Free tier is throttled to ~1 download per IP per hour, which sounds
    # like the textbook case for proxy rotation — but 1fichier outright
    # blocks any IP it fingerprints as datacenter/hosting/VPN ("professional
    # infrastructure detected"), which is exactly what free public proxy
    # lists are made of. In practice that means proxy mode here burns
    # through the whole pool hitting the same block rather than helping, so
    # it defaults off (like Mediafire) — a real residential IP (--no-proxy,
    # or a residential-proxy gateway source added via proxy_sources.py) is
    # what actually gets past it. --proxy still forces it on if you have one.
    use_proxy_by_default = False

    def __init__(self):
        self._cookie_cache = {}   # file_id -> "Cookie:" header value from the resolving session

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FILE_URL_RE.search(line)
        return m.group("id") if m else None

    def download_url(self, file_id, proxies=None):
        page_url = f"https://1fichier.com/?{file_id}"
        session = requests.Session()
        session.proxies = proxies or {}
        ua = {"User-Agent": "Mozilla/5.0"}

        r = session.get(page_url, headers=ua, timeout=TIMEOUT)
        if _DEAD_RE.search(r.text):
            raise FileUnavailable(f"{file_id}: 1fichier dice que el archivo no existe o fue borrado")
        if _BLOCKED_RE.search(r.text):
            raise RateLimited(f"{file_id}: 1fichier bloqueó esta IP por ser de datacenter/proxy/VPN")
        if _CAPTCHA_RE.search(r.text):
            raise RateLimited(f"{file_id}: 1fichier pidió un CAPTCHA con este proxy")

        m = _COUNTDOWN_RE.search(r.text)
        wait = int(m.group(1)) if m else 0
        if wait > 0:
            console.print(f"  [dim]⏳ Esperando el countdown de 1fichier ({wait}s)...[/dim]")
            time.sleep(wait + 1)

        r = session.post(page_url, headers=ua, data={"dl_no_ssl": "", "dlinline": ""}, timeout=TIMEOUT)
        if _DEAD_RE.search(r.text):
            raise FileUnavailable(f"{file_id}: 1fichier dice que el archivo no existe o fue borrado")
        if _BLOCKED_RE.search(r.text):
            raise RateLimited(f"{file_id}: 1fichier bloqueó esta IP por ser de datacenter/proxy/VPN")
        if _CAPTCHA_RE.search(r.text):
            raise RateLimited(f"{file_id}: 1fichier pidió un CAPTCHA con este proxy")
        if _WAIT_RE.search(r.text):
            raise RateLimited(f"{file_id}: 1fichier todavía limita este proxy (probablemente se usó hace poco)")

        m = _LINK_RE.search(r.text)
        if not m:
            console.print(f"  [yellow]⚠  1fichier devolvió una página que no reconozco para {file_id} (¿cambiaron el sitio?)[/yellow]")
            return None  # unrecognized page state — treat as transient, engine retries with a new proxy

        self._cookie_cache[file_id] = "; ".join(f"{c.name}={c.value}" for c in session.cookies)
        return m.group(0)

    def request_headers(self, file_id):
        headers = {"User-Agent": "Mozilla/5.0"}
        cookie = self._cookie_cache.get(file_id)
        if cookie:
            headers["Cookie"] = cookie
        return headers

    def expected_hash(self, file_id):
        return None  # not exposed anonymously for files we didn't upload ourselves


register(FichierProvider())
