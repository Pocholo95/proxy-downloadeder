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
  - Folders: a folder link's key is a *plain* 128-bit AES key (4 a32 words,
    no XOR-folding -- that folding is specific to the 256-bit blob a file's
    OWN key packs together with its CTR nonce and meta-MAC). Listing a
    folder is the `f` API action, called with the folder's handle as the
    `n` query-string parameter (not in the JSON body -- that's how Mega
    scopes the request to a shared folder's node tree instead of the
    caller's own account). Each returned node's `k` field is that node's
    own key, AES-CBC-encrypted (zero IV) with the folder key; once
    decrypted, a file node's key is the exact same 8-word blob shape as a
    standalone file URL's key, so it folds into k/iv/meta_mac the same way
    and every download/decrypt/MAC-verify method below is reused unchanged
    for folder files -- only download_url's own API call needs to know to
    reference the file by `n` (its node handle inside the folder) instead
    of `p` (a standalone file's own public handle), which is why
    file_id gets a "<folder_handle>/" prefix for folder-sourced files.
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

# New-style https://mega.nz/folder/<handle>#<key>  and legacy https://mega.nz/#F!<handle>!<key>
# (a folder link can also carry a trailing /file/<h> or /folder/<h> deep-link
# into a specific item, which this intentionally ignores -- resolve_folder()
# below always lists the whole folder from its root)
FOLDER_URL_RE = re.compile(
    r'mega\.(?:nz|co\.nz)/(?:folder/(?P<h1>[\w-]+)#(?P<k1>[\w-]+)|#F!(?P<h2>[\w-]+)!(?P<k2>[\w-]+))',
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


def _b64url_encode(b):
    return base64.b64encode(b).decode().replace('+', '-').replace('/', '_').rstrip('=')


def _str_to_a32(b):
    if len(b) % 4:
        b += b'\0' * (4 - len(b) % 4)
    return struct.unpack('>%dI' % (len(b) // 4), b)


def _a32_to_str(a):
    return struct.pack('>%dI' % len(a), *a)


def _aes_cbc_encrypt_a32(data, key):
    enc = AES.new(_a32_to_str(key), AES.MODE_CBC, b'\0' * 16)
    return _str_to_a32(enc.encrypt(_a32_to_str(data)))


def _aes_cbc_decrypt_a32(data, key):
    dec = AES.new(_a32_to_str(key), AES.MODE_CBC, b'\0' * 16)
    return _str_to_a32(dec.decrypt(_a32_to_str(data)))


def _decrypt_node_key(key_b64, folder_key):
    """A folder node's `k` field, decrypted with the folder's own key --
    AES-CBC (zero IV) over each 16-byte/4-word block in turn, concatenated.
    A subfolder's key is 4 words (a plain AES key, same shape as the folder
    key itself); a file's key is 8 words (the same key+nonce+mac blob a
    standalone file URL's key decodes to)."""
    a = _str_to_a32(_b64url_decode(key_b64))
    out = ()
    for i in range(0, len(a) - len(a) % 4, 4):
        out += _aes_cbc_decrypt_a32(a[i:i + 4], folder_key)
    return out


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
        self._key_cache  = {}   # file_id -> (folder_handle_or_None, handle, k, iv, meta_mac)
        self._info_cache = {}   # (folder_handle_or_None, handle) -> last api 'g' response (s, at, ...)

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

    def extract_folder_id(self, line):
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        m = FOLDER_URL_RE.search(line)
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
        folder_handle = None
        rest = file_id
        if "/" in file_id:
            folder_handle, rest = file_id.split("/", 1)
        handle, url_key = rest.split("!", 1)
        a = _str_to_a32(_b64url_decode(url_key))
        if len(a) < 8:
            raise FileUnavailable(f"{handle}: link de Mega con clave inválida")
        k        = (a[0] ^ a[4], a[1] ^ a[5], a[2] ^ a[6], a[3] ^ a[7])
        iv       = a[4:6] + (0, 0)
        meta_mac = a[6:8]
        parsed = (folder_handle, handle, k, iv, meta_mac)
        self._key_cache[file_id] = parsed
        return parsed

    def _parse_folder_key(self, folder_id):
        handle, url_key = folder_id.split("!", 1)
        key_a32 = _str_to_a32(_b64url_decode(url_key))
        if len(key_a32) < 4:
            raise FileUnavailable(f"{handle}: link de carpeta de Mega con clave inválida")
        return handle, key_a32[:4]

    def _api_get(self, handle, folder_handle=None, proxies=None):
        body = {"a": "g", "g": 1, "ssl": 1}
        params = f"id={_next_id()}"
        if folder_handle:
            # Folder-scoped: reference the file by its node handle (`n` in
            # both the body and the query string, the latter establishing
            # which shared folder's tree "n" is resolved against) instead of
            # `p`, which only works for a file's own standalone public link.
            body["n"] = handle
            params += f"&n={folder_handle}"
        else:
            body["p"] = handle
        r = requests.post(f"{API_URL}?{params}",
                           json=[body],
                           proxies=proxies, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        item = data[0] if isinstance(data, list) else data
        if isinstance(item, int):
            if item in _PERMANENT_ERRORS:
                raise FileUnavailable(f"{handle}: Mega error {item} (eliminado, privado o inválido)")
            raise Exception(f"Mega API error {item} (posible rate-limit, reintentando)")
        self._info_cache[(folder_handle, handle)] = item
        return item

    def resolve_folder(self, folder_id):
        try:
            folder_handle, folder_key = self._parse_folder_key(folder_id)
            r = requests.post(f"{API_URL}?id={_next_id()}&n={folder_handle}",
                               json=[{"a": "f", "c": 1, "r": 1, "ca": 1}],
                               timeout=TIMEOUT)
            r.raise_for_status()
            data = r.json()
            item = data[0] if isinstance(data, list) else data
            if isinstance(item, int):
                console.print(f"[red]✗ Error resolving Mega folder {folder_id}: API error {item}[/red]")
                return []

            out = []
            for node in item.get("f", []):
                if node.get("t") != 0:  # only files -- subfolders (t=1) are flattened in
                    continue
                raw_key = node.get("k", "")
                # A node's "k" can carry several "<handle>:<key>" pairs
                # (one per share context it's reachable through) separated
                # by "/" -- a plain folder link (the only case handled
                # here, not a node re-shared across multiple folders) only
                # ever has one, so just take whatever follows the colon.
                key_part = raw_key.split("/")[0]
                if ":" in key_part:
                    key_part = key_part.split(":", 1)[1]
                if not key_part:
                    continue
                node_key = _decrypt_node_key(key_part, folder_key)
                if len(node_key) < 8:
                    continue
                k = (node_key[0] ^ node_key[4], node_key[1] ^ node_key[5],
                     node_key[2] ^ node_key[6], node_key[3] ^ node_key[7])
                try:
                    attrs = _dec_attr(_b64url_decode(node["a"]), _a32_to_str(k))
                except Exception:
                    continue
                name = attrs.get("n")
                if not name:
                    continue

                handle = node["h"]
                key_b64 = _b64url_encode(_a32_to_str(node_key))
                file_id = f"{folder_handle}/{handle}!{key_b64}"
                iv = node_key[4:6] + (0, 0)
                meta_mac = node_key[6:8]
                self._key_cache[file_id] = (folder_handle, handle, k, iv, meta_mac)
                # Pre-seed size/attrs from the listing so check_size() can
                # avoid an extra round-trip; download_url() still does its
                # own fresh _api_get() when the download actually starts,
                # which naturally refreshes this with the real "g" URL too.
                self._info_cache[(folder_handle, handle)] = {"s": node.get("s", 0), "at": node["a"]}
                out.append((file_id, name))
            return out
        except Exception as e:
            console.print(f"[red]✗ Error resolving Mega folder {folder_id}: {e}[/red]")
            return []

    def download_url(self, file_id, proxies=None):
        folder_handle, handle, k, iv, meta_mac = self._parse_key(file_id)
        item = self._api_get(handle, folder_handle=folder_handle, proxies=proxies)
        return item.get("g")

    def suggest_filename(self, file_id):
        folder_handle, handle, k, iv, meta_mac = self._parse_key(file_id)
        item = self._info_cache.get((folder_handle, handle))
        if not item:
            return None
        try:
            attrs = _dec_attr(_b64url_decode(item["at"]), _a32_to_str(k))
            return attrs.get("n")
        except Exception:
            return None

    def check_size(self, file_id):
        folder_handle, handle, k, iv, meta_mac = self._parse_key(file_id)
        item = self._info_cache.get((folder_handle, handle))
        if not item:
            try:
                item = self._api_get(handle, folder_handle=folder_handle)
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
        folder_handle, handle, k, iv, meta_mac = self._parse_key(file_id)
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
