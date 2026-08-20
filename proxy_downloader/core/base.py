"""Base class every site module implements.

To add a new site: create proxy_downloader/sites/<yoursite>.py, subclass
SiteProvider, fill in the fields/methods below, and register an instance
in proxy_downloader/sites/__init__.py. See sites/pixeldrain.py for a
complete example and sites/README.md for a step-by-step guide.
"""
from abc import ABC, abstractmethod
from urllib.parse import urlparse


class FileUnavailable(Exception):
    """Raise from download_url() (or any resolution step) when the site has
    positively confirmed the file is gone (deleted, private, quota-expired) —
    not a network hiccup. The engine treats this as permanent: it stops
    immediately instead of burning through the proxy pool retrying."""


class RateLimited(Exception):
    """Raise from download_url() when the SITE is temporarily refusing this
    specific proxy's IP (e.g. a per-IP cooldown window, or a CAPTCHA
    challenge we have no way to solve) — not a broken/dead proxy. The engine
    moves on to the next proxy without blacklisting this one, since it's
    still perfectly fine for other sites or after the cooldown passes."""


class SiteProvider(ABC):
    #: Short unique identifier, e.g. "pixeldrain". Used for --site and logs.
    name = None

    #: Domains this provider recognizes, e.g. ["pixeldrain.com"]. Used for
    #: auto-detecting which provider owns a given URL/line.
    domains = []

    #: If True, this provider is used as the fallback when a batch/CLI line
    #: has no recognizable domain (e.g. a bare file ID). Only one provider
    #: should set this.
    is_default = False

    #: Whether downloads for this site go through the rotating proxy pool
    #: when the user hasn't explicitly passed --proxy/--no-proxy. Sites that
    #: aren't rate-limited/blocked without proxies can set this to False so
    #: users don't pay the proxy fetch/validation cost by default; --proxy
    #: still forces it on, --no-proxy still forces it off for everyone.
    use_proxy_by_default = True

    def owns(self, line):
        """Return True if this provider recognizes the given line (URL or ID).

        Matches on the actual hostname, not a raw substring search — a domain
        appearing inside a longer lookalike host (e.g. "pixeldrain.com.evil.ru",
        or a future site named "drain.com" colliding with "pixeldrain.com")
        must NOT match.
        """
        low = line.strip().lower()
        netloc = urlparse(low if "://" in low else f"//{low}").netloc
        host = netloc.split("@")[-1].split(":")[0]  # strip userinfo and port
        if not host:
            return False
        return any(host == d or host.endswith(f".{d}") for d in self.domains)

    @abstractmethod
    def extract_file_id(self, line):
        """Parse a single-file URL or bare ID out of `line`. Return None if not applicable."""
        raise NotImplementedError

    def extract_folder_id(self, line):
        """Parse a folder/album URL out of `line`. Return None if the site has no folders
        or the line isn't one."""
        return None

    def resolve_folder(self, folder_id):
        """Return a list of (file_id, filename) tuples for a folder. Only needed if
        extract_folder_id is implemented."""
        return []

    @abstractmethod
    def download_url(self, file_id, proxies=None):
        """Return the direct URL to GET/HEAD for downloading file_id.

        Called fresh on EVERY attempt (not cached by the engine), because some
        sites hand out short-lived/one-shot links that must be re-resolved
        each time — through the same `proxies` dict (a requests-style
        {"http": ..., "https": ...} mapping, or None for no-proxy mode) that
        will be used for the actual download, so a resolution step that has
        to make its own HTTP request goes out from the same egress IP.
        Sites with a stable, formula-based URL (e.g. Pixeldrain) can just
        ignore `proxies` and return a plain f-string with no network call.

        Raise FileUnavailable if the site confirms the file is gone. Raise
        RateLimited if the site is blocking this proxy specifically (not the
        file). Any other exception is treated as transient and retried with
        a new proxy the same way RateLimited is, but WILL blacklist the
        proxy — use RateLimited when you know the proxy itself is fine.
        """
        raise NotImplementedError

    def request_headers(self, file_id):
        """Extra headers to send with every request for this file (Referer, UA,
        Cookie, etc.). Called AFTER download_url() on every attempt, so it's
        safe to depend on state (e.g. session cookies) that download_url()
        just cached for this same file_id/attempt — see 1fichier.py, whose
        resolved link requires the cookies from the session that resolved it."""
        return {"User-Agent": "Mozilla/5.0"}

    def expected_hash(self, file_id):
        """Return the expected SHA-256 hex digest for integrity checking, or None
        if the site doesn't expose one / verification should be skipped."""
        return None

    def check_size(self, file_id):
        """Return the expected file size in bytes (used to detect corrupt/partial
        files already on disk before queuing a folder download). Default: HEAD
        the download URL directly (no proxy)."""
        import requests
        try:
            r = requests.head(self.download_url(file_id), headers=self.request_headers(file_id),
                               timeout=8, allow_redirects=True)
            return int(r.headers.get("Content-Length", 0))
        except Exception:
            return 0

    def suggest_filename(self, file_id):
        """Return a filename for file_id if the site can supply one without an
        extra request (e.g. it already fetched it while resolving download_url
        and cached it) — used before falling back to the HTTP
        Content-Disposition header. Return None to skip straight to that
        fallback. Sites whose real filename isn't in any HTTP header (e.g. it's
        inside encrypted metadata, like Mega) should implement this."""
        return None

    def postprocess(self, tmp_path, file_id):
        """Called once the raw download is complete and its size matches the
        server-reported size, before it's moved to its final filename. Use
        this to transform what was downloaded — the paradigm case is
        client-side decryption (Mega: the bytes on the wire are ciphertext:
        this decrypts tmp_path in place and verifies the site's own integrity
        scheme). Return True on success/nothing-to-do, False on a verification
        failure — the engine wipes tmp_path and retries the whole download
        from scratch, the same as a checksum mismatch. Default: no-op."""
        return True
