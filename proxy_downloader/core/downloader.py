"""Generic download engine: resume, speed-based proxy rotation, integrity check.

Knows nothing about any particular site — everything site-specific is asked
of the `provider` (a SiteProvider instance).
"""
import re
import time
from pathlib import Path

import requests
from rich.progress import Progress, BarColumn, DownloadColumn, TransferSpeedColumn, TimeRemainingColumn

from ..config import TIMEOUT, PERMANENT_FAIL, MIN_SPEED_KB
from ..ui import console
from ..utils import sanitize_filename, filename_from_header, sha256_file
from . import aria2
from .base import FileUnavailable, RateLimited


class DownloadError(Exception):
    pass


class Cancelled(Exception):
    """Raised internally when `cancel_event` is set mid-download, to unwind
    straight out of the retry loop without being treated as a transient
    failure (which would penalize a perfectly good proxy and keep retrying)."""


def download_file(provider, file_id, proxy_pool, output_dir, min_speed_kb=MIN_SPEED_KB, hint_name=None,
                   progress_cb=None, cancel_event=None):
    """Download a file through the rotating proxy pool, with unlimited retries,
    resume support, and speed monitoring.

    `progress_cb`, if given, is called as progress_cb(status, **info) at key
    points (status in "resolving"/"downloading"/"retry"/"done"/"failed"/
    "cancelled") so a non-terminal caller (e.g. the web UI) can track
    progress without parsing the rich console output. Purely additive — the
    CLI never passes it.

    `cancel_event`, if given, is a threading.Event checked between attempts
    and periodically while streaming — once set, the function stops (leaving
    the .part file as-is for a later resume) and returns (False, "cancelled")
    instead of retrying forever. Also purely additive."""
    def report(status, **info):
        if progress_cb:
            progress_cb(status, **info)

    attempt = 0

    fname    = sanitize_filename(hint_name) if hint_name else None
    filepath = (Path(output_dir) / fname) if fname else None
    tmp      = Path(str(filepath) + ".part") if filepath else None

    if filepath and filepath.exists():
        console.print(f"  [green]✓ Already complete: {fname}[/green]")
        report("done", filename=fname, path=str(filepath))
        return True, None

    resume_from = tmp.stat().st_size if (tmp and tmp.exists()) else 0
    if resume_from:
        console.print(f"  [cyan]↻ Found .part — will resume from {resume_from/(1024*1024):.2f} MB[/cyan]")

    while True:
        if cancel_event is not None and cancel_event.is_set():
            report("cancelled", filename=fname)
            return False, "cancelled"
        attempt += 1
        if tmp:
            resume_from = tmp.stat().st_size if tmp.exists() else 0
        proxy = proxy_pool.get_next()
        if not proxy:
            console.print(f"  [yellow]⚠  No proxies available (attempt {attempt}), retrying in 10s...[/yellow]")
            time.sleep(10)
            continue

        console.print(f"  [dim]→ [Attempt {attempt}] {proxy}[/dim]")
        report("resolving", attempt=attempt, proxy=proxy, filename=fname)
        proxies = {"http": proxy, "https": proxy}

        try:
            url = provider.download_url(file_id, proxies=proxies)
            if not url:
                raise DownloadError("El sitio no devolvió un link de descarga")
            headers = provider.request_headers(file_id)

            r = requests.head(url, headers=headers, proxies=proxies, timeout=TIMEOUT, allow_redirects=True)

            if r.status_code in PERMANENT_FAIL:
                console.print(f"  [red]✗ File unavailable (HTTP {r.status_code})[/red]")
                report("failed", message=f"HTTP {r.status_code}")
                return False, r.status_code

            if r.status_code not in (200, 206):
                console.print(f"  [red]✗ HTTP {r.status_code}[/red]")
                continue

            total_size = int(r.headers.get("Content-Length", 0))
            if r.status_code == 206:
                cr = r.headers.get("Content-Range", "")
                m  = re.search(r"/(\d+)$", cr)
                if m:
                    total_size = int(m.group(1))
            cd = r.headers.get("Content-Disposition", "")

            if not fname:
                fname    = sanitize_filename(provider.suggest_filename(file_id) or filename_from_header(cd) or f"{file_id}.bin")
                filepath = Path(output_dir) / fname
                tmp      = Path(str(filepath) + ".part")
                resume_from = tmp.stat().st_size if tmp.exists() else 0
                if resume_from:
                    console.print(f"  [cyan]↻ Found .part — will resume from {resume_from/(1024*1024):.2f} MB[/cyan]")

            if filepath.exists() and filepath.stat().st_size >= total_size:
                console.print(f"  [green]✓ Already complete: {fname}[/green]")
                report("done", filename=fname, path=str(filepath))
                return True, None

            if filepath.exists():
                filepath.rename(tmp)
                resume_from = tmp.stat().st_size

            if total_size > 0 and resume_from == total_size:
                if not provider.postprocess(tmp, file_id):
                    tmp.unlink(missing_ok=True)
                    resume_from = 0
                    raise DownloadError("Postprocessing failed on existing .part — retrying from scratch")
                tmp.replace(filepath)
                console.print(f"  [green]✓ .part file complete, finalized: {fname}[/green]")
                proxy_pool.mark_working(proxy)
                report("done", filename=fname, path=str(filepath))
                return True, None
            elif total_size > 0 and resume_from > total_size:
                console.print(f"  [yellow]⚠  .part is larger than expected ({resume_from/(1024*1024):.1f} vs {total_size/(1024*1024):.1f} MB) — discarding and restarting[/yellow]")
                tmp.unlink(missing_ok=True)
                resume_from = 0

            dl_headers = headers.copy()
            if resume_from > 0:
                dl_headers["Range"] = f"bytes={resume_from}-"

            r = requests.get(url, headers=dl_headers, proxies=proxies, stream=True, timeout=TIMEOUT)
            if r.status_code not in (200, 206):
                console.print(f"  [red]✗ HTTP {r.status_code}[/red]")
                continue

            bytes_dl         = resume_from
            last_check_time  = time.time()
            last_check_bytes = resume_from
            last_report_time = 0.0

            report("downloading", filename=fname, bytes_done=bytes_dl, total=total_size, speed_kb=0)

            with Progress(
                "[cyan]{task.description}[/cyan]",
                BarColumn(),
                DownloadColumn(),
                TransferSpeedColumn(),
                TimeRemainingColumn(),
                console=console,
            ) as bar:
                task = bar.add_task(fname[:40], total=total_size, completed=resume_from)
                try:
                    write_mode = "ab" if resume_from > 0 else "wb"
                    with open(tmp, write_mode) as f:
                        for chunk in r.iter_content(chunk_size=262144):
                            if cancel_event is not None and cancel_event.is_set():
                                raise Cancelled()
                            if chunk:
                                f.write(chunk)
                                bytes_dl += len(chunk)
                                bar.advance(task, len(chunk))

                                now = time.time()
                                if now - last_report_time >= 1:
                                    inst_speed = ((bytes_dl - last_check_bytes) / 1024) / max(now - last_check_time, 0.001)
                                    report("downloading", filename=fname, bytes_done=bytes_dl,
                                           total=total_size, speed_kb=inst_speed)
                                    last_report_time = now

                                if now - last_check_time >= 30 and bytes_dl > resume_from:
                                    speed = ((bytes_dl - last_check_bytes) / 1024) / (now - last_check_time)
                                    if speed < min_speed_kb:
                                        raise DownloadError("Speed too low")
                                    last_check_time  = now
                                    last_check_bytes = bytes_dl
                except KeyboardInterrupt:
                    console.print("  [yellow]⚠  Interrupted — progress saved to .part[/yellow]")
                    raise

            final = tmp.stat().st_size
            # total_size == 0: the server never sent Content-Length (a
            # chunked/streamed response -- seen in practice on some CDN
            # nodes, e.g. Bunkr's), so there's nothing to cross-check the
            # final size against. That's not the same as incomplete: the
            # chunked-encoding read loop above only exits without raising
            # once it's actually seen the stream's real end marker (`requests`
            # raises ChunkedEncodingError on a connection that drops mid-
            # chunk), so reaching here at all already means the transfer
            # finished cleanly -- trust it instead of discarding a real,
            # complete file over a header the server just didn't send.
            if total_size > 0 and final != total_size:
                tmp.unlink(missing_ok=True)
                resume_from = 0
                raise DownloadError(f"Size mismatch ({final/(1024*1024):.1f} MB vs expected {total_size/(1024*1024):.1f} MB) — retrying from scratch")

            expected_hash = provider.expected_hash(file_id)
            if expected_hash:
                console.print(f"  [dim]🔍 Verifying integrity...[/dim]")
                actual_hash = sha256_file(tmp)
                if actual_hash != expected_hash:
                    tmp.unlink(missing_ok=True)
                    resume_from = 0
                    raise DownloadError("SHA-256 mismatch — file corrupted, retrying from scratch")
                console.print(f"  [dim]✓ SHA-256 OK[/dim]")

            if not provider.postprocess(tmp, file_id):
                tmp.unlink(missing_ok=True)
                resume_from = 0
                raise DownloadError("Postprocessing/integrity check failed — retrying from scratch")

            tmp.replace(filepath)
            console.print(f"  [green]✓ Saved: {filepath}[/green]")
            proxy_pool.mark_working(proxy)
            report("done", filename=fname, path=str(filepath))
            return True, None

        except Cancelled:
            console.print("  [yellow]⚠  Cancelled — progress saved to .part[/yellow]")
            report("cancelled", filename=fname)
            return False, "cancelled"
        except DownloadError as e:
            if "Speed" in str(e):
                proxy_pool.mark_slow(proxy)
            else:
                console.print(f"  [yellow]⚠  {e}[/yellow]")
            report("retry", filename=fname, message=str(e))
        except FileUnavailable as e:
            console.print(f"  [red]✗ File unavailable: {e}[/red]")
            report("failed", filename=fname, message=str(e))
            return False, None
        except RateLimited as e:
            console.print(f"  [yellow]⚠  {e} — probando con otro proxy[/yellow]")
        except KeyboardInterrupt:
            raise
        except requests.exceptions.Timeout:
            console.print("  [red]✗ Timeout[/red]")
            proxy_pool.mark_failed(proxy)
        except requests.exceptions.ConnectionError:
            console.print("  [red]✗ Connection error[/red]")
            proxy_pool.mark_failed(proxy)
        except Exception as e:
            console.print(f"  [red]✗ {type(e).__name__}: {e}[/red]")
            proxy_pool.mark_failed(proxy)

        time.sleep(0.3)


DIRECT_MAX_ATTEMPTS = 5


def download_direct_requests(provider, file_id, output_dir, min_speed_kb=MIN_SPEED_KB, hint_name=None,
                              progress_cb=None, cancel_event=None):
    """Same resume/integrity contract as download_file() (Range resume,
    size check, SHA-256, postprocess) but a single direct `requests`
    connection -- no proxy pool, no rotation, and no aria2 multi-connection
    splitting either (see sites/bunkr.py's use_aria2_by_default=False: a
    CDN whose signed link doesn't seem to tolerate several simultaneous
    connections on the same token is the whole reason this exists instead
    of just calling download_direct() below).

    Retries are bounded by *consecutive stalls* (DIRECT_MAX_ATTEMPTS), not
    a flat attempt count -- confirmed live that some CDNs (Bunkr's) throttle
    every single connection to a small byte cap regardless of the real file
    size and just expect the client to reconnect (Range-resume) for more,
    which needs many attempts that are each legitimate forward progress,
    not failures. A flat cap treated that exact pattern as 5 failures and
    gave up with a fraction of the file downloaded. Only an attempt that
    makes zero forward progress counts against the limit -- there's no
    other IP to fall back to here, so one that's *truly* stuck isn't going
    to start working on attempt 6."""
    def report(status, **info):
        if progress_cb:
            progress_cb(status, **info)

    attempt = 0
    stall = 0

    fname    = sanitize_filename(hint_name) if hint_name else None
    filepath = (Path(output_dir) / fname) if fname else None
    tmp      = Path(str(filepath) + ".part") if filepath else None

    if filepath and filepath.exists():
        console.print(f"  [green]✓ Already complete: {fname}[/green]")
        report("done", filename=fname, path=str(filepath))
        return True, None

    resume_from = tmp.stat().st_size if (tmp and tmp.exists()) else 0
    if resume_from:
        console.print(f"  [cyan]↻ Found .part — will resume from {resume_from/(1024*1024):.2f} MB[/cyan]")

    while stall < DIRECT_MAX_ATTEMPTS:
        if cancel_event is not None and cancel_event.is_set():
            report("cancelled", filename=fname)
            return False, "cancelled"
        attempt += 1
        if tmp:
            resume_from = tmp.stat().st_size if tmp.exists() else 0

        console.print(f"  [dim]→ [Attempt {attempt}] direct[/dim]")
        report("resolving", attempt=attempt, filename=fname)

        try:
            url = provider.download_url(file_id)
            if not url:
                raise DownloadError("El sitio no devolvió un link de descarga")
            headers = provider.request_headers(file_id)

            r = requests.head(url, headers=headers, timeout=TIMEOUT, allow_redirects=True)

            if r.status_code in PERMANENT_FAIL:
                console.print(f"  [red]✗ File unavailable (HTTP {r.status_code})[/red]")
                report("failed", message=f"HTTP {r.status_code}")
                return False, r.status_code

            if r.status_code not in (200, 206):
                console.print(f"  [red]✗ HTTP {r.status_code}[/red]")
                stall += 1
                continue

            total_size = int(r.headers.get("Content-Length", 0))
            if r.status_code == 206:
                cr = r.headers.get("Content-Range", "")
                m  = re.search(r"/(\d+)$", cr)
                if m:
                    total_size = int(m.group(1))
            cd = r.headers.get("Content-Disposition", "")

            if not fname:
                fname    = sanitize_filename(provider.suggest_filename(file_id) or filename_from_header(cd) or f"{file_id}.bin")
                filepath = Path(output_dir) / fname
                tmp      = Path(str(filepath) + ".part")
                resume_from = tmp.stat().st_size if tmp.exists() else 0
                if resume_from:
                    console.print(f"  [cyan]↻ Found .part — will resume from {resume_from/(1024*1024):.2f} MB[/cyan]")

            if filepath.exists() and filepath.stat().st_size >= total_size:
                console.print(f"  [green]✓ Already complete: {fname}[/green]")
                report("done", filename=fname, path=str(filepath))
                return True, None

            if filepath.exists():
                filepath.rename(tmp)
                resume_from = tmp.stat().st_size

            if total_size > 0 and resume_from == total_size:
                if not provider.postprocess(tmp, file_id):
                    tmp.unlink(missing_ok=True)
                    resume_from = 0
                    raise DownloadError("Postprocessing failed on existing .part — retrying from scratch")
                tmp.replace(filepath)
                console.print(f"  [green]✓ .part file complete, finalized: {fname}[/green]")
                report("done", filename=fname, path=str(filepath))
                return True, None
            elif total_size > 0 and resume_from > total_size:
                console.print(f"  [yellow]⚠  .part is larger than expected ({resume_from/(1024*1024):.1f} vs {total_size/(1024*1024):.1f} MB) — discarding and restarting[/yellow]")
                tmp.unlink(missing_ok=True)
                resume_from = 0

            dl_headers = headers.copy()
            if resume_from > 0:
                dl_headers["Range"] = f"bytes={resume_from}-"

            r = requests.get(url, headers=dl_headers, stream=True, timeout=TIMEOUT)
            if r.status_code not in (200, 206):
                console.print(f"  [red]✗ HTTP {r.status_code}[/red]")
                stall += 1
                continue

            # Asked for a Range continuation but got a full 200 back instead
            # of 206 -- this resource doesn't honor Range at all, so the
            # response is the *whole* file again, not just what's missing.
            # Appending it to the existing .part would duplicate content;
            # start over instead.
            if resume_from > 0 and r.status_code == 200:
                console.print("  [yellow]⚠  Server ignored Range — restarting from scratch[/yellow]")
                resume_from = 0

            bytes_dl         = resume_from
            last_check_time  = time.time()
            last_check_bytes = resume_from
            last_report_time = 0.0

            report("downloading", filename=fname, bytes_done=bytes_dl, total=total_size, speed_kb=0)

            with Progress(
                "[cyan]{task.description}[/cyan]",
                BarColumn(),
                DownloadColumn(),
                TransferSpeedColumn(),
                TimeRemainingColumn(),
                console=console,
            ) as bar:
                task = bar.add_task(fname[:40], total=total_size, completed=resume_from)
                try:
                    write_mode = "ab" if resume_from > 0 else "wb"
                    with open(tmp, write_mode) as f:
                        for chunk in r.iter_content(chunk_size=262144):
                            if cancel_event is not None and cancel_event.is_set():
                                raise Cancelled()
                            if chunk:
                                f.write(chunk)
                                bytes_dl += len(chunk)
                                bar.advance(task, len(chunk))

                                now = time.time()
                                if now - last_report_time >= 1:
                                    inst_speed = ((bytes_dl - last_check_bytes) / 1024) / max(now - last_check_time, 0.001)
                                    report("downloading", filename=fname, bytes_done=bytes_dl,
                                           total=total_size, speed_kb=inst_speed)
                                    last_report_time = now

                                if now - last_check_time >= 30 and bytes_dl > resume_from:
                                    speed = ((bytes_dl - last_check_bytes) / 1024) / (now - last_check_time)
                                    if speed < min_speed_kb:
                                        raise DownloadError("Speed too low")
                                    last_check_time  = now
                                    last_check_bytes = bytes_dl
                except KeyboardInterrupt:
                    console.print("  [yellow]⚠  Interrupted — progress saved to .part[/yellow]")
                    raise

            final = tmp.stat().st_size
            if total_size > 0:
                if final != total_size:
                    tmp.unlink(missing_ok=True)
                    resume_from = 0
                    raise DownloadError(f"Size mismatch ({final/(1024*1024):.1f} MB vs expected {total_size/(1024*1024):.1f} MB) — retrying from scratch")
            else:
                # No Content-Length -- can't verify directly against a known
                # size. Confirmed live (Bunkr) that some CDNs throttle every
                # single connection to a small byte cap regardless of the
                # real file size, closing it "normally" (no exception) well
                # short of the actual end -- so a clean read loop exit here
                # does NOT by itself mean done, only that *this* connection
                # is over. Any forward progress this attempt means there
                # could well be more: loop back for a Range-continuation
                # instead of finalizing early. Only settle once a
                # continuation attempt comes back with truly nothing new --
                # that's the one condition a throttled-but-real transfer
                # can't produce, only a genuinely finished one can.
                if final > resume_from:
                    stall = 0
                    console.print(f"  [dim]↻ +{(final-resume_from)/1024:.0f} KB, no Content-Length — continuing[/dim]")
                    time.sleep(0.3)
                    continue
                if resume_from == 0:
                    # Fresh attempt, zero bytes received at all -- a real
                    # failure, not "done" (nothing to confirm completion
                    # against yet).
                    raise DownloadError("No se recibieron datos (sin Content-Length)")
                # final == resume_from and resume_from > 0: a Range-
                # continuation attempt got nothing new -- genuinely done.

            expected_hash = provider.expected_hash(file_id)
            if expected_hash:
                console.print(f"  [dim]🔍 Verifying integrity...[/dim]")
                actual_hash = sha256_file(tmp)
                if actual_hash != expected_hash:
                    tmp.unlink(missing_ok=True)
                    resume_from = 0
                    raise DownloadError("SHA-256 mismatch — file corrupted, retrying from scratch")
                console.print(f"  [dim]✓ SHA-256 OK[/dim]")

            if not provider.postprocess(tmp, file_id):
                tmp.unlink(missing_ok=True)
                resume_from = 0
                raise DownloadError("Postprocessing/integrity check failed — retrying from scratch")

            tmp.replace(filepath)
            console.print(f"  [green]✓ Saved: {filepath}[/green]")
            report("done", filename=fname, path=str(filepath))
            return True, None

        except Cancelled:
            console.print("  [yellow]⚠  Cancelled — progress saved to .part[/yellow]")
            report("cancelled", filename=fname)
            return False, "cancelled"
        except DownloadError as e:
            stall += 1
            console.print(f"  [yellow]⚠  {e}[/yellow]")
            report("retry", filename=fname, message=str(e))
        except FileUnavailable as e:
            console.print(f"  [red]✗ File unavailable: {e}[/red]")
            report("failed", filename=fname, message=str(e))
            return False, None
        except RateLimited as e:
            # No proxy pool here to fall back to -- surface it as a plain
            # bounded retry instead of a branch that implies "try a
            # different IP", since there isn't one.
            stall += 1
            console.print(f"  [yellow]⚠  {e}[/yellow]")
            report("retry", filename=fname, message=str(e))
        except KeyboardInterrupt:
            raise
        except requests.exceptions.Timeout:
            stall += 1
            console.print("  [red]✗ Timeout[/red]")
            report("retry", filename=fname, message="Timeout")
        except requests.exceptions.ConnectionError:
            stall += 1
            console.print("  [red]✗ Connection error[/red]")
            report("retry", filename=fname, message="Connection error")
        except Exception as e:
            stall += 1
            console.print(f"  [red]✗ {type(e).__name__}: {e}[/red]")
            report("retry", filename=fname, message=str(e))

        time.sleep(1.5)

    console.print(f"  [red]✗ Giving up after {DIRECT_MAX_ATTEMPTS} attempts with no progress[/red]")
    report("failed", filename=fname, message=f"Falló tras {DIRECT_MAX_ATTEMPTS} intentos sin avance")
    return False, None


def download_direct(provider, file_id, output_dir, hint_name=None, progress_cb=None, cancel_event=None):
    """Download without a proxy pool (--no-proxy mode), via aria2 (resumable,
    multi-connection) -- see download_direct_requests() above for the
    single-connection alternative some sites need instead. Has its own
    resume and integrity check.

    See `download_file` for what `progress_cb`/`cancel_event` do — both
    purely additive, the CLI never passes them."""
    def report(status, **info):
        if progress_cb:
            progress_cb(status, **info)

    try:
        if cancel_event is not None and cancel_event.is_set():
            report("cancelled", filename=hint_name)
            return False, "cancelled"
        url = provider.download_url(file_id)
        if not url:
            console.print("  [red]✗ El sitio no devolvió un link de descarga[/red]")
            report("failed", message="No download URL")
            return False, None
        headers = provider.request_headers(file_id)
        report("resolving", filename=hint_name)
        r = requests.head(url, headers=headers, timeout=TIMEOUT, allow_redirects=True)
        if r.status_code in PERMANENT_FAIL:
            console.print(f"  [red]✗ HTTP {r.status_code}[/red]")
            report("failed", message=f"HTTP {r.status_code}")
            return False, r.status_code
        total_size = int(r.headers.get("Content-Length", 0))
        cd    = r.headers.get("Content-Disposition", "")
        fname = sanitize_filename(hint_name or provider.suggest_filename(file_id) or filename_from_header(cd) or f"{file_id}.bin")
        fpath = Path(output_dir) / fname
        tmp   = Path(str(fpath) + ".part")

        if fpath.exists() and total_size > 0 and fpath.stat().st_size == total_size:
            console.print(f"  [green]✓ Already exists: {fname}[/green]")
            report("done", filename=fname, path=str(fpath))
            return True, None
        if fpath.exists() and total_size > 0 and fpath.stat().st_size != total_size:
            console.print(f"  [yellow]⚠  Existing file size mismatch — re-downloading[/yellow]")
            fpath.rename(tmp)

        resume_from = tmp.stat().st_size if tmp.exists() else 0
        if resume_from > total_size > 0:
            console.print(f"  [yellow]⚠  .part larger than expected — discarding[/yellow]")
            tmp.unlink(missing_ok=True)
            resume_from = 0
        if resume_from > 0:
            console.print(f"  [cyan]↻ Resuming from {resume_from/(1024*1024):.2f} MB[/cyan]")

        report("downloading", filename=fname, bytes_done=resume_from, total=total_size, speed_kb=0)

        # aria2 does its own resume (via a .aria2 control file next to `tmp`)
        # and multi-connection splitting -- no need to compute Range headers
        # or stream chunks ourselves the way the proxy-rotation path still
        # does (aria2 can't hop proxies mid-download the way that path can).
        with Progress("[cyan]{task.description}[/cyan]", BarColumn(),
                      DownloadColumn(), TransferSpeedColumn(), TimeRemainingColumn(),
                      console=console) as bar:
            task = bar.add_task(fname[:40], total=total_size or None, completed=resume_from)
            known_total = [total_size]

            def on_progress(done, total, speed_kb):
                if total and not known_total[0]:
                    known_total[0] = total
                    bar.update(task, total=total)
                bar.update(task, completed=done)
                report("downloading", filename=fname, bytes_done=done,
                       total=known_total[0], speed_kb=speed_kb)

            status, msg = aria2.fetch(url, tmp, headers=headers, on_progress=on_progress,
                                       cancel_event=cancel_event)

        if status == "cancelled":
            raise Cancelled()
        if status != "done":
            console.print(f"  [red]✗ aria2: {msg}[/red]")
            report("failed", message=msg or "aria2 download failed")
            return False, None

        final = tmp.stat().st_size
        if total_size > 0 and final != total_size:
            tmp.unlink(missing_ok=True)
            console.print(f"  [red]✗ Size mismatch ({final/(1024*1024):.1f} vs {total_size/(1024*1024):.1f} MB) — deleted[/red]")
            report("failed", message="Size mismatch")
            return False, None

        expected_hash = provider.expected_hash(file_id)
        if expected_hash:
            console.print(f"  [dim]🔍 Verifying integrity...[/dim]")
            actual_hash = sha256_file(tmp)
            if actual_hash != expected_hash:
                tmp.unlink(missing_ok=True)
                console.print(f"  [red]✗ SHA-256 mismatch — deleted[/red]")
                report("failed", message="SHA-256 mismatch")
                return False, None
            console.print(f"  [dim]✓ SHA-256 OK[/dim]")

        if not provider.postprocess(tmp, file_id):
            tmp.unlink(missing_ok=True)
            console.print(f"  [red]✗ Postprocessing/integrity check failed — deleted[/red]")
            report("failed", message="Postprocessing failed")
            return False, None

        tmp.replace(fpath)
        console.print(f"  [green]✓ Saved: {fpath}[/green]")
        report("done", filename=fname, path=str(fpath))
        return True, None
    except Cancelled:
        console.print("  [yellow]⚠  Cancelled — progress saved to .part[/yellow]")
        report("cancelled", filename=hint_name)
        return False, "cancelled"
    except FileUnavailable as e:
        console.print(f"  [red]✗ File unavailable: {e}[/red]")
        report("failed", message=str(e))
        return False, None
    except RateLimited as e:
        console.print(f"  [red]✗ {e} — sin --proxy no hay otra IP para probar[/red]")
        report("failed", message=str(e))
        return False, None
    except Exception as e:
        console.print(f"  [red]✗ {e}[/red]")
        report("failed", message=str(e))
        return False, None
