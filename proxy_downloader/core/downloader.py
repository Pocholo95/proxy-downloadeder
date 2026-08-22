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
            if total_size == 0:
                raise DownloadError("Server sent no Content-Length — cannot verify completeness, keeping .part")
            if final != total_size:
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


def download_direct(provider, file_id, output_dir, hint_name=None, progress_cb=None, cancel_event=None):
    """Download without a proxy pool (--no-proxy mode), with resume and integrity check.

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

        if total_size > 0 and resume_from == total_size:
            # Nothing left to fetch — a Range request starting exactly at EOF
            # would just get a 416 from most servers. Skip straight to the
            # size-check/postprocess/finalize step below with what's on disk.
            console.print(f"  [cyan]↻ .part already fully downloaded, skipping fetch[/cyan]")
        else:
            dl_headers = headers.copy()
            if resume_from > 0:
                dl_headers["Range"] = f"bytes={resume_from}-"
                console.print(f"  [cyan]↻ Resuming from {resume_from/(1024*1024):.2f} MB[/cyan]")

            r = requests.get(url, headers=dl_headers, stream=True, timeout=TIMEOUT)
            if r.status_code not in (200, 206):
                console.print(f"  [red]✗ HTTP {r.status_code}[/red]")
                return False, r.status_code

            bytes_dl = resume_from
            last_report_time = 0.0
            last_check_time  = time.time()
            last_check_bytes = resume_from
            report("downloading", filename=fname, bytes_done=bytes_dl, total=total_size, speed_kb=0)

            with Progress("[cyan]{task.description}[/cyan]", BarColumn(),
                          DownloadColumn(), TransferSpeedColumn(), TimeRemainingColumn(),
                          console=console) as bar:
                task = bar.add_task(fname[:40], total=total_size, completed=resume_from)
                write_mode = "ab" if resume_from > 0 else "wb"
                with open(tmp, write_mode) as f:
                    for chunk in r.iter_content(chunk_size=262144):
                        if cancel_event is not None and cancel_event.is_set():
                            raise Cancelled()
                        if chunk:
                            f.write(chunk)
                            bar.advance(task, len(chunk))
                            bytes_dl += len(chunk)

                            now = time.time()
                            if now - last_report_time >= 1:
                                inst_speed = ((bytes_dl - last_check_bytes) / 1024) / max(now - last_check_time, 0.001)
                                report("downloading", filename=fname, bytes_done=bytes_dl,
                                       total=total_size, speed_kb=inst_speed)
                                last_report_time = last_check_time = now
                                last_check_bytes = bytes_dl

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
