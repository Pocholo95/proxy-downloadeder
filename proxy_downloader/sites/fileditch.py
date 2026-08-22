"""FileDitch site provider: https://new.fileditch.com

Two very different faces:

- **Uploading** is dead simple (POST a file, get back a permanent direct URL
  on fileditchfiles.st — see https://new.fileditch.com/api.html). No API key
  needed. We don't use the upload API at all, only download.
- **Downloading** a fileditchfiles.st share link isn't a plain file GET
  though: it's an HTML landing page gated behind a client-side
  proof-of-work challenge (hashcash-style — find a nonce so
  sha256(f"{challenge}:{nonce}") has N leading zero bits, submit it back as
  a form POST), and the *real*, time-limited CDN link
  (on a different host, e.g. charlie.freakingfileditch.st, with a signed
  ?md5=...&expires=... query string) is embedded in the page as a
  JS string array that gets `.join("")`'d together client-side — plain
  string-splitting obfuscation, not encryption, just enough to defeat a
  naive "grep for a URL" scraper. None of this is bypassing real security:
  the PoW is a cheap, unauthenticated computational puzzle (a few hundred
  thousand SHA-256 hashes, well under a second) meant to throttle mass
  scraping, not an account/paywall — this replicates exactly what a
  browser's JS does, just in Python. Verified end-to-end live: real upload,
  solved PoW, extracted link, downloaded, Range/resume confirmed working.

The share page (and its PoW) has to be re-solved on every download
attempt — see SiteProvider.download_url's docstring for why that's the
right place to do it (fresh proxy each time, short-lived signed link).
"""
import hashlib
import json
import re
from urllib.parse import unquote, urlparse

import requests

from ..config import TIMEOUT
from ..core.base import SiteProvider, FileUnavailable
from ..core.registry import register
from ..ui import console

FILE_URL_RE = re.compile(r'https?://fileditchfiles\.st/\S+', re.I)

POW_CHALLENGE_RE = re.compile(r'name="pow_challenge"\s+value="([^"]+)"')
POW_TS_RE        = re.compile(r'name="pow_ts"\s+value="([^"]+)"')
POW_DIFF_RE      = re.compile(r'name="pow_diff"\s+value="([^"]+)"')
POW_SIG_RE       = re.compile(r'name="pow_sig"\s+value="([^"]+)"')
POW_ORIG_REF_RE  = re.compile(r'name="orig_ref"\s+value="([^"]*)"')

# Any JS `["chunk","chunk",...].join("")` literal — the real signed download
# link is built this way client-side; matching structurally (rather than
# hunting for a specific variable/element name, which changes every load)
# survives them re-obfuscating the surrounding code.
JS_STRING_ARRAY_RE = re.compile(r'\[\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*\s*\]')

USER_AGENT = "Mozilla/5.0"


def _solve_pow(challenge, difficulty_bits):
    """Hashcash: find `nonce` where sha256(f"{challenge}:{nonce}") has
    `difficulty_bits` leading zero bits. ~2**difficulty_bits/2 tries on
    average — at the site's current difficulty (18 bits) that's under a
    second even in pure Python."""
    full, rem = divmod(difficulty_bits, 8)
    mask = (0xFF << (8 - rem)) & 0xFF if rem else 0
    prefix = f"{challenge}:"
    nonce = 0
    while True:
        digest = hashlib.sha256(f"{prefix}{nonce}".encode()).digest()
        if not any(digest[:full]) and (not rem or digest[full] & mask == 0):
            return nonce
        nonce += 1


def _extract_real_link(html):
    for m in JS_STRING_ARRAY_RE.finditer(html):
        try:
            joined = "".join(json.loads(m.group(0)))
        except Exception:
            continue
        if joined.startswith("https://") and "md5=" in joined and "expires=" in joined:
            return joined
    return None


class FileDitchProvider(SiteProvider):
    name    = "fileditch"
    domains = ["fileditchfiles.st"]

    # The PoW gate gets in the way of scraping, not of a single real
    # download — the CDN leg itself showed no per-IP throttling in testing,
    # same reasoning as Mediafire.
    use_proxy_by_default = False

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FILE_URL_RE.search(line)
        return m.group(0) if m else None

    def download_url(self, file_id, proxies=None):
        headers = {"User-Agent": USER_AGENT}
        r = requests.get(file_id, headers=headers, proxies=proxies, timeout=TIMEOUT)
        if r.status_code == 404:
            raise FileUnavailable("Archivo no encontrado en FileDitch")

        html = r.text
        if 'class="gone"' in html:
            raise FileUnavailable("Archivo eliminado o inexistente en FileDitch")

        if 'name="pow_challenge"' in html:
            challenge = POW_CHALLENGE_RE.search(html)
            ts        = POW_TS_RE.search(html)
            diff      = POW_DIFF_RE.search(html)
            sig       = POW_SIG_RE.search(html)
            orig_ref  = POW_ORIG_REF_RE.search(html)
            if not (challenge and ts and diff and sig):
                return None  # unexpected page shape — let the engine retry with another proxy

            nonce = _solve_pow(challenge.group(1), int(diff.group(1)))
            r = requests.post(file_id, data={
                "orig_ref": orig_ref.group(1) if orig_ref else "",
                "pow_challenge": challenge.group(1),
                "pow_ts": ts.group(1),
                "pow_diff": diff.group(1),
                "pow_sig": sig.group(1),
                "pow_nonce": str(nonce),
            }, headers={**headers, "Referer": file_id, "Origin": "https://fileditchfiles.st"},
               proxies=proxies, timeout=TIMEOUT)
            html = r.text
            if 'class="gone"' in html:
                raise FileUnavailable("Archivo eliminado o inexistente en FileDitch")

        return _extract_real_link(html)

    def request_headers(self, file_id):
        return {"User-Agent": USER_AGENT}

    def suggest_filename(self, file_id):
        # file_id is the fileditchfiles.st landing-page URL, shaped like
        # /<node>/<hash>/<filename> — pull the filename out of it directly
        # rather than relying on the resolved CDN link's headers.
        name = urlparse(file_id).path.rsplit("/", 1)[-1]
        return unquote(name) if name else None


register(FileDitchProvider())
