"""Proxy-rotation hook for gallery-dl's HTTP downloader.

gallery-dl has no built-in mid-download proxy rotation (same single-static-
proxy limitation as this project's yt-dlp integration) -- but its
HttpDownloader already retries a failed read with HTTP Range-based resume, so
swapping the proxy and raising a RequestException from inside its per-chunk
read loop makes that retry resume the same file through a new proxy for
free, mirroring core/downloader.py's download_file() speed-based rotation
without reimplementing HTTP fetching from scratch.

Verified live against real downloads (small real files uploaded to a Gofile
guest folder, pulled through real proxies from this project's own pool)
before writing this for real. Two non-obvious things that testing caught:

  - HttpDownloader.__init__ rebinds `self.receive = self._receive_rate`
    whenever progress reporting is on (the default) -- a subclass override
    of receive() gets silently shadowed by that instance-level rebind. The
    hook that's actually called is _receive_rate().
  - DownloadJob.run()'s return value can't be trusted to detect a
    cancellation raised from receive() -- it can come back reporting
    "success" even though the current file was cut short. GalleryJob's own
    cancel_event is the source of truth for whether a run was cancelled,
    checked by gallery_jobs.py after run() returns, not gallery-dl's status
    bitmask.
  - A proxy that's slow-but-connected gets rotated fine by this hook (it
    only ever runs once a response has started streaming), but a proxy
    that's dead outright (connection refused/timeout/bad TLS -- common on
    free lists) fails before ever reaching receive(), so this hook alone
    can't recover from it; gallery_jobs.py additionally retries the whole
    job with a fresh proxy a few times on a hard failure, verified to work.

One gallery-dl job runs at a time on one dedicated worker thread (same
pattern jobs.py/ytdlp_jobs.py/upload_jobs.py already use for their own
single engines), so a module-level "active job" pointer is enough context-
passing -- no thread-local needed.
"""
import logging
import time

import requests
import gallery_dl.downloader as gdl_downloader
from gallery_dl.downloader.http import HttpDownloader
from gallery_dl import exception as gdl_exception

from ..config import MIN_SPEED_KB

SPEED_CHECK_WINDOW = 30  # seconds between speed checks -- same cadence core/downloader.py uses


class JobCancelled(gdl_exception.ControlException):
    """Raised from _receive_rate() when the active job's cancel_event fires
    -- stops the current file immediately (confirmed live: a 0-byte .part
    is left instead of a partial/full one). Not relied on to make
    DownloadJob.run() itself report the cancellation -- see module docstring."""


_active_job = None  # the GalleryJob currently being downloaded, or None


def set_active_job(job):
    global _active_job
    _active_job = job


def install():
    """Point gallery-dl's http/https downloader lookup at our subclass.
    Call once at process startup, before any DownloadJob runs -- there's no
    public "register a downloader" API; pre-populating the module's own
    scheme->class cache (gallery_dl.downloader.find()'s lookup table) is the
    sanctioned-enough way."""
    gdl_downloader._cache["http"] = RotatingHttpDownloader
    gdl_downloader._cache["https"] = RotatingHttpDownloader


def install_logging():
    """gallery-dl logs via stdlib logging (job.get_logger()), not a duck-
    typed logger object the way yt-dlp's integration in this app does --
    attach once to its top-level logger; per-extractor child loggers
    propagate up to it by default."""
    logger = logging.getLogger("gallery-dl")
    logger.setLevel(logging.INFO)
    logger.addHandler(_JobLogHandler())


class RotatingHttpDownloader(HttpDownloader):
    def _receive_rate(self, fp, content, bytes_total, bytes_start):
        ctx = _active_job
        min_speed_kb = ctx.min_speed_kb if ctx else MIN_SPEED_KB

        bytes_dl = bytes_start
        now = time.time()
        last_check_time = now
        last_check_bytes = bytes_start
        last_report_time = now

        for data in content:
            if ctx and ctx.cancel_event.is_set():
                raise JobCancelled("cancelled by user")
            if not data:
                continue
            fp.write(data)
            bytes_dl += len(data)

            now = time.time()
            if ctx and now - last_report_time >= 1:
                inst_speed = ((bytes_dl - last_check_bytes) / 1024) / max(now - last_check_time, 0.001)
                ctx.report_progress(fp.name, bytes_dl, bytes_total, inst_speed)
                last_report_time = now

            if (ctx and ctx.proxy_pool and bytes_dl > bytes_start
                    and now - last_check_time >= SPEED_CHECK_WINDOW):
                speed = ((bytes_dl - last_check_bytes) / 1024) / (now - last_check_time)
                if speed < min_speed_kb:
                    self._rotate_proxy(ctx)
                    raise requests.exceptions.RequestException(
                        "speed below threshold, rotating proxy")
                last_check_time, last_check_bytes = now, bytes_dl

        # Final report guaranteed regardless of the 1s throttle above -- a
        # small file can finish transferring in well under a second (very
        # common for anything under a few MB on a fast connection), in
        # which case the throttled report inside the loop never fires at
        # all and the job would otherwise show zero items despite having
        # actually downloaded the file. Confirmed live: without this, a
        # multi-file job of small files completed with job.items == [].
        if ctx:
            elapsed = max(time.time() - last_check_time, 0.001)
            inst_speed = ((bytes_dl - last_check_bytes) / 1024) / elapsed
            ctx.report_progress(fp.name, bytes_dl, bytes_total, inst_speed)

    def _rotate_proxy(self, ctx):
        new_proxy = ctx.proxy_pool.get_next()
        if not new_proxy:
            return
        # This instance is cached and reused for every file in the job (see
        # DownloadJob.get_downloader()), so updating the plain instance
        # attribute here is enough -- confirmed live across a real 3-file
        # folder download that a later file picks up the rotated proxy.
        self.proxies = {"http": new_proxy, "https": new_proxy}
        ctx.log(f"↻ Proxy lento, rotando a {new_proxy}")


class _JobLogHandler(logging.Handler):
    def emit(self, record):
        if _active_job is None:
            return
        try:
            _active_job.log(self.format(record))
        except Exception:
            pass
