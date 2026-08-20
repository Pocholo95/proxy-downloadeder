"""Mega provider: https://mega.nz

Mega does client-side (zero-knowledge) encryption: the file on Mega's servers
is ciphertext, and the AES key + integrity MAC are embedded in the URL
fragment, never sent to Mega. So unlike Pixeldrain/Mediafire, downloading
isn't enough — we also have to decrypt locally and verify Mega's own MAC
scheme (their equivalent of the SHA-256 checks the other sites give us for
free). That's what SiteProvider.postprocess() is for.

Protocol notes (reverse-engineered, matches Mega's original open-sourced JS
client and every third-party reimplementation — verified end-to-end here
against a real public file, encrypted bytes -> decrypted -> MAC match):
  - URL key (32 bytes, decoded from the URL fragment as 8 big-endian uint32
    words) XORs its own two halves together to get the real 128-bit AES key;
    words [4:6] are the CTR nonce, words [6:8] are the expected meta-MAC.
  - File info + a short-lived download URL come from an unauthenticated POST
    to the `g` (get) API action — works for any public file link, no login.
  - The real filename is inside `at`, itself AES-CBC encrypted with the same
    derived key (Mega's API never sees plaintext filenames either).
  - No folder support yet: Mega folder links use a different API action and
    a nested per-file key-encrypted-with-folder-key scheme; left as a
    follow-up rather than guessed at.
"""
import base64
import itertools
import json
import re
import struct
import threading

import requests
from Crypto.Cipher import AES

from ..config import TIMEOUT
from ..core.base import SiteProvider, FileUnavailable
from ..core.registry import register
from ..ui import console

API_URL = "https://g.api.mega.co.nz/cs"

# New-style https://mega.nz/file/<handle>#<key>  and legacy https://mega.nz/#!<handle>!<key>
FILE_URL_RE = re.compile(
    r'mega\.(?:nz|co\.nz)/(?:file/(?P<h1>[\w-]+)#(?P<k1>[\w-]+)|#!(?P<h2>[\w-]+)!(?P<k2>[\w-]+))',
    re.I,
)

# Error codes Mega returns in place of a result object that mean "this isn't
# coming back" — anything else (rate limiting, congestion, etc.) is transient
# and the engine will just retry with a different proxy.
_PERMANENT_ERRORS = {-9, -11, -16, -17}

_seqno_lock = threading.Lock()
_seqno = itertools.count(1)


def _next_id():
    with _seqno_lock:
        return next(_seqno)


def _b64url_decode(s):
    s = s.replace('-', '+').replace('_', '/')
    s += '=' * (-len(s) % 4)
    return base64.b64decode(s)


def _str_to_a32(b):
    if len(b) % 4:
        b += b'\0' * (4 - len(b) % 4)
    return struct.unpack('>%dI' % (len(b) // 4), b)


def _a32_to_str(a):
    return struct.pack('>%dI' % len(a), *a)


def _aes_cbc_encrypt_a32(data, key):
    enc = AES.new(_a32_to_str(key), AES.MODE_CBC, b'\0' * 16)
    return _str_to_a32(enc.encrypt(_a32_to_str(data)))


def _dec_attr(attr_bytes, key_bytes):
    dec = AES.new(key_bytes, AES.MODE_CBC, b'\0' * 16)
    raw = dec.decrypt(attr_bytes).rstrip(b'\0')
    if not raw.startswith(b'MEGA'):
        return {}
    try:
        return json.loads(raw[4:])
    except Exception:
        return {}


def _get_chunks(size):
    """Mega's own chunk boundaries (8, 16, 24 ... 1024KB, then 1MB each) —
    the MAC is computed per-chunk over these exact boundaries, independent
    of whatever read/write buffer size we happen to use."""
    chunks = {}
    p = pp = 0
    i = 1
    while i <= 8 and p < size - i * 0x20000:
        chunks[p] = i * 0x20000
        pp = p
        p += chunks[p]
        i += 1
    while p < size:
        chunks[p] = 0x100000
        pp = p
        p += chunks[p]
    chunks[pp] = size - pp
    if not chunks[pp]:
        del chunks[pp]
    return chunks


class MegaProvider(SiteProvider):
    name    = "mega"
    domains = ["mega.nz", "mega.co.nz"]

    # Mega throttles/blocks anonymous API and download traffic aggressively
    # from a single IP — unlike Mediafire, this one benefits from rotation.
    use_proxy_by_default = True

    def __init__(self):
        self._key_cache  = {}   # file_id -> (handle, k, iv, meta_mac)
        self._info_cache = {}   # handle -> last api 'g' response (s, at, ...)

    def extract_file_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FILE_URL_RE.search(line)
        if not m:
            return None
        handle = m.group("h1") or m.group("h2")
        key    = m.group("k1") or m.group("k2")
        if not handle or not key:
            return None
        return f"{handle}!{key}"

    def _parse_key(self, file_id):
        if file_id in self._key_cache:
            return self._key_cache[file_id]
        handle, url_key = file_id.split("!", 1)
        a = _str_to_a32(_b64url_decode(url_key))
        if len(a) < 8:
            raise FileUnavailable(f"{handle}: link de Mega con clave inválida")
        k        = (a[0] ^ a[4], a[1] ^ a[5], a[2] ^ a[6], a[3] ^ a[7])
        iv       = a[4:6] + (0, 0)
        meta_mac = a[6:8]
        parsed = (handle, k, iv, meta_mac)
        self._key_cache[file_id] = parsed
        return parsed

    def _api_get(self, handle, proxies=None):
        r = requests.post(f"{API_URL}?id={_next_id()}",
                           json=[{"a": "g", "g": 1, "p": handle, "ssl": 1}],
                           proxies=proxies, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        item = data[0] if isinstance(data, list) else data
        if isinstance(item, int):
            if item in _PERMANENT_ERRORS:
                raise FileUnavailable(f"{handle}: Mega error {item} (eliminado, privado o inválido)")
            raise Exception(f"Mega API error {item} (posible rate-limit, reintentando)")
        self._info_cache[handle] = item
        return item

    def download_url(self, file_id, proxies=None):
        handle, k, iv, meta_mac = self._parse_key(file_id)
        item = self._api_get(handle, proxies=proxies)
        return item.get("g")

    def suggest_filename(self, file_id):
        handle, k, iv, meta_mac = self._parse_key(file_id)
        item = self._info_cache.get(handle)
        if not item:
            return None
        try:
            attrs = _dec_attr(_b64url_decode(item["at"]), _a32_to_str(k))
            return attrs.get("n")
        except Exception:
            return None

    def check_size(self, file_id):
        handle, k, iv, meta_mac = self._parse_key(file_id)
        item = self._info_cache.get(handle)
        if not item:
            try:
                item = self._api_get(handle)
            except Exception:
                return 0
        return int(item.get("s", 0))

    def expected_hash(self, file_id):
        # Mega's integrity check isn't a SHA-256 — see postprocess().
        return None

    def postprocess(self, tmp_path, file_id):
        """tmp_path currently holds raw ciphertext. Decrypt it (AES-128-CTR)
        into a sibling file, verify Mega's chunked meta-MAC against the one
        embedded in the URL key, and swap it into place. Returns False (not
        an exception) on a MAC mismatch so the engine treats it exactly like
        a checksum failure: wipe and retry the whole download."""
        handle, k, iv, meta_mac = self._parse_key(file_id)
        key_bytes = _a32_to_str(k)
        size = tmp_path.stat().st_size
        initial_ctr = ((iv[0] << 32) + iv[1]) << 64
        cipher = AES.new(key_bytes, AES.MODE_CTR, nonce=b"", initial_value=initial_ctr)

        plain_path = tmp_path.with_name(tmp_path.name + ".dec")
        # Mega's per-block "XOR then AES-encrypt the accumulator" loop is
        # mathematically a CBC-MAC: encrypting a chunk in CBC mode with
        # (iv0,iv1,iv0,iv1) as the IV and keeping only the LAST ciphertext
        # block gives the exact same chunk_mac, in one native C call over the
        # whole (up to 1MB) chunk instead of a Python loop re-creating an AES
        # cipher for every 16 bytes — that loop is what made large files take
        # minutes here; this is the same math, just not hand-rolled per block.
        chunk_mac_iv = _a32_to_str((iv[0], iv[1], iv[0], iv[1]))
        file_mac = [0, 0, 0, 0]
        try:
            with open(tmp_path, "rb") as infile, open(plain_path, "wb") as outfile:
                for start, length in sorted(_get_chunks(size).items()):
                    chunk = cipher.decrypt(infile.read(length))
                    outfile.write(chunk)

                    pad = (-len(chunk)) % 16
                    padded = chunk + b"\0" * pad if pad else chunk
                    mac_cbc = AES.new(key_bytes, AES.MODE_CBC, chunk_mac_iv)
                    chunk_mac = _str_to_a32(mac_cbc.encrypt(padded)[-16:])

                    file_mac = [file_mac[j] ^ chunk_mac[j] for j in range(4)]
                    file_mac = list(_aes_cbc_encrypt_a32(tuple(file_mac), k))
        except Exception as e:
            plain_path.unlink(missing_ok=True)
            console.print(f"  [red]✗ Error al descifrar: {e}[/red]")
            return False

        computed_mac = (file_mac[0] ^ file_mac[1], file_mac[2] ^ file_mac[3])
        if computed_mac != meta_mac:
            plain_path.unlink(missing_ok=True)
            console.print("  [red]✗ MAC de Mega no coincide — archivo corrupto[/red]")
            return False

        console.print("  [dim]✓ Mega MAC OK[/dim]")
        tmp_path.unlink()
        plain_path.replace(tmp_path)
        return True


register(MegaProvider())
