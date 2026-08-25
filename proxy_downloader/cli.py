#!/usr/bin/env python3
"""Multi-site downloader CLI: proxy rotation, resume, and batch mode.

The site is auto-detected from the URL/ID you pass in (see core/registry.py).
Use --list-sites to see every site module currently registered.
"""
import re
import sys
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from rich.panel import Panel
from rich.table import Table
from rich import box

from . import sites  # noqa: F401  (import triggers site provider registration)
from . import site_prefs
from . import proxy_sources
from .config import MIN_SPEED_KB, MAX_CHECK_THREADS, CACHE_FILE
from .core import registry
from .core.downloader import download_file, download_direct
from .ui import console
from .utils import sanitize_filename, comment_batch_line


def _ensure_config_files():
    """Make sure config/<site>.json exists for every registered site, so the
    folder is discoverable/editable even before anyone touches --enable-proxy.
    Also keeps the informational "_site_default_use_proxy" field current."""
    for p in registry.all_providers():
        site_prefs.sync_config_file(p.name, p.use_proxy_by_default)


def _proxy_state_label(provider):
    override = site_prefs.get_override(provider.name)
    if override is None:
        return "✓" if provider.use_proxy_by_default else "[dim]desactivado[/dim]"
    return "✓ [dim](override)[/dim]" if override else "[dim]desactivado (override)[/dim]"


def _list_sites():
    t = Table(title="Sitios soportados", box=box.SIMPLE_HEAD, header_style="bold cyan")
    t.add_column("Nombre")
    t.add_column("Dominios")
    t.add_column("Por defecto")
    t.add_column("Proxy")
    for p in registry.all_providers():
        t.add_row(p.name, ", ".join(p.domains) or "-",
                  "✓" if p.is_default else "",
                  _proxy_state_label(p))
    console.print(t)


def _resolve_site_names(names_arg):
    """Split a comma-separated --enable-proxy/--disable-proxy/--reset-proxy
    argument, validate against registered sites, and print a warning for
    anything unrecognized (without stopping the rest)."""
    names = [n.strip() for n in names_arg.split(",") if n.strip()]
    known = {p.name for p in registry.all_providers()}
    valid = []
    for n in names:
        if n in known:
            valid.append(n)
        else:
            console.print(f"[yellow]⚠  Sitio desconocido: {n} (probá --list-sites)[/yellow]")
    return valid


def _apply_proxy_overrides(args):
    """Handle --enable-proxy/--disable-proxy/--reset-proxy as one-shot
    management actions: apply, print the result, and let main() exit."""
    if args.enable_proxy:
        for name in _resolve_site_names(args.enable_proxy):
            site_prefs.set_override(name, True)
            console.print(f"[green]✓ {name}: proxy activado (persistido)[/green]")
    if args.disable_proxy:
        for name in _resolve_site_names(args.disable_proxy):
            site_prefs.set_override(name, False)
            console.print(f"[green]✓ {name}: proxy desactivado (persistido)[/green]")
    if args.reset_proxy:
        for name in _resolve_site_names(args.reset_proxy):
            site_prefs.clear_override(name)
            console.print(f"[green]✓ {name}: vuelve al default del sitio[/green]")


FOLDER_LABEL_RE = re.compile(r'^folder\s*:\s*(.*)$', re.I)


def _job_uses_proxy(provider, args):
    """--no-proxy/--proxy (this run only) beat everything; then a persisted
    per-site override (--enable-proxy/--disable-proxy, sticky across runs);
    then the site's own built-in default."""
    if args.no_proxy:
        return False
    if args.proxy:
        return True
    override = site_prefs.get_override(provider.name)
    if override is not None:
        return override
    return provider.use_proxy_by_default


def _resolve_folder_jobs(provider, folder_id, output_dir):
    """Resolve a folder into jobs, showing a table + doing a corrupt-file check
    against each provider's reported size. Returns (jobs, output_subdir)."""
    console.print(f"[cyan]📁 Resolving folder {folder_id} ({provider.name})...[/cyan]")
    folder_files = provider.resolve_folder(folder_id)
    if not folder_files:
        console.print("[red]✗ No files found in folder[/red]")
        return [], output_dir

    sub_dir = output_dir / folder_id
    sub_dir.mkdir(parents=True, exist_ok=True)
    console.print(f"[green]✓ {len(folder_files)} files found → {sub_dir}[/green]\n")

    t = Table(title="Folder contents", box=box.SIMPLE_HEAD, header_style="bold cyan")
    t.add_column("#", style="dim", width=4)
    t.add_column("ID")
    t.add_column("Name")
    t.add_column("Status")

    jobs = []
    skipped = recovered = 0
    to_check = [fid for fid, fname in folder_files if (sub_dir / sanitize_filename(fname)).exists()]
    size_cache = {}
    if to_check:
        with console.status(f"[dim]Checking {len(to_check)} existing file(s)...[/dim]"):
            with ThreadPoolExecutor(max_workers=min(MAX_CHECK_THREADS, len(to_check))) as ex:
                futures = {ex.submit(provider.check_size, fid): fid for fid in to_check}
                for future in as_completed(futures):
                    fid = futures[future]
                    try:
                        size_cache[fid] = future.result()
                    except Exception:
                        size_cache[fid] = 0

    for i, (fid, fname) in enumerate(folder_files, 1):
        local_path = sub_dir / sanitize_filename(fname)
        part_path  = Path(str(local_path) + ".part")
        if local_path.exists():
            expected = size_cache.get(fid, 0)
            actual   = local_path.stat().st_size
            if expected and actual != expected:
                local_path.rename(part_path)
                part_mb = part_path.stat().st_size / (1024 * 1024)
                exp_mb  = expected / (1024 * 1024)
                t.add_row(str(i), fid, fname,
                          f"[red]corrupt ({part_mb:.1f}/{exp_mb:.1f} MB) → resuming[/red]")
                jobs.append((provider, fid, fname, None, sub_dir))
                recovered += 1
            else:
                t.add_row(str(i), fid, fname, "[dim]already exists[/dim]")
                skipped += 1
        elif part_path.exists():
            part_mb = part_path.stat().st_size / (1024 * 1024)
            t.add_row(str(i), fid, fname, f"[yellow]resuming ({part_mb:.1f} MB)[/yellow]")
            jobs.append((provider, fid, fname, None, sub_dir))
        else:
            t.add_row(str(i), fid, fname, "[cyan]pending[/cyan]")
            jobs.append((provider, fid, fname, None, sub_dir))

    console.print(t)
    if skipped:
        console.print(f"[dim]⏭  {skipped} file(s) already complete[/dim]")
    if recovered:
        console.print(f"[yellow]⚠  {recovered} corrupt file(s) demoted to .part and re-queued[/yellow]")
    console.print()
    return jobs, sub_dir


def main():
    p = ArgumentParser(description="Multi-site downloader with proxies, resume, and folder support")
    group = p.add_mutually_exclusive_group()
    group.add_argument("-f", "--file",   help="File ID or URL")
    group.add_argument("-F", "--folder", help="Folder ID or URL")
    group.add_argument("-b", "--batch",  help="Text file with IDs/URLs, one per line (can mix sites)")
    p.add_argument("-o", "--output", default=str(Path.home() / "Downloads"),
                   help="Output directory (default: ~/Downloads)")
    p.add_argument("--speed", type=int, default=MIN_SPEED_KB,
                   help=f"Minimum speed in KB/s before rotating proxy (default: {MIN_SPEED_KB})")
    proxy_group = p.add_mutually_exclusive_group()
    proxy_group.add_argument("--no-proxy", action="store_true",
                   help="Never use proxies this run, even for sites that default to using them")
    proxy_group.add_argument("--proxy", action="store_true",
                   help="Force proxies on this run, even for sites that default to not using them")
    p.add_argument("--enable-proxy", metavar="SITIO[,SITIO...]",
                   help="Persist proxy=on for these sites (by name, see --list-sites) and exit")
    p.add_argument("--disable-proxy", metavar="SITIO[,SITIO...]",
                   help="Persist proxy=off for these sites and exit")
    p.add_argument("--reset-proxy", metavar="SITIO[,SITIO...]",
                   help="Remove the persisted override for these sites (back to the site's own default) and exit")
    p.add_argument("--list-sites", action="store_true", help="List registered site providers and exit")
    args = p.parse_args()

    _ensure_config_files()

    if args.list_sites:
        _list_sites()
        return

    if args.enable_proxy or args.disable_proxy or args.reset_proxy:
        _apply_proxy_overrides(args)
        return

    console.print(Panel(
        "[bold cyan]Multi-Site Downloader[/bold cyan]\n[dim]proxies · resume · folders · batch[/dim]",
        style="cyan", expand=False
    ))

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    console.print(f"[dim]📂 Output: {output_dir}[/dim]\n")

    # ── Build job list: [(provider, file_id, hint_name, original_batch_line)] ──
    # Done before the proxy pool so we know, per job, whether it actually needs
    # one — sites can opt out of proxies by default (see SiteProvider.use_proxy_by_default),
    # and there's no reason to pay the fetch/validation cost otherwise.
    jobs = []

    if args.file:
        provider = registry.detect(args.file)
        if not provider:
            console.print("[red]✗ No se reconoce el sitio para ese ID/URL (probá --list-sites)[/red]")
            sys.exit(1)
        fid = provider.extract_file_id(args.file)
        if not fid:
            console.print("[red]✗ Invalid file ID or URL[/red]")
            sys.exit(1)
        jobs.append((provider, fid, None, None, output_dir))

    elif args.folder:
        provider = registry.detect(args.folder) or registry.default_provider()
        if not provider:
            console.print("[red]✗ No se reconoce el sitio para esa carpeta (probá --list-sites)[/red]")
            sys.exit(1)
        folder_id = provider.extract_folder_id(args.folder) or args.folder.strip()
        jobs, output_dir = _resolve_folder_jobs(provider, folder_id, output_dir)
        if not jobs:
            sys.exit(1)

    elif args.batch:
        batch_path = Path(args.batch)
        if not batch_path.exists():
            console.print(f"[red]✗ Batch file not found: {args.batch}[/red]")
            sys.exit(1)
        lines = batch_path.read_text(encoding="utf-8").splitlines()
        current_dir = output_dir
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            label = FOLDER_LABEL_RE.match(line)
            if label:
                name = label.group(1).split("#", 1)[0].strip()
                if name:
                    current_dir = output_dir / sanitize_filename(name)
                    current_dir.mkdir(parents=True, exist_ok=True)
                    console.print(f"[cyan]📁 {name} → {current_dir}[/cyan]")
                else:
                    current_dir = output_dir
                continue
            provider = registry.detect(line)
            if not provider:
                continue
            folder_id = provider.extract_folder_id(line)
            if folder_id:
                folder_jobs, _ = _resolve_folder_jobs(provider, folder_id, current_dir)
                jobs.extend(folder_jobs)
                continue
            fid = provider.extract_file_id(line)
            if fid:
                jobs.append((provider, fid, None, line, current_dir))
        if not jobs:
            console.print("[red]✗ No valid IDs found in batch file[/red]")
            sys.exit(1)
        console.print(f"[green]✓ {len(jobs)} files in batch[/green]\n")

    else:
        raw = console.input("[cyan]Enter file ID, file URL, or folder URL: [/cyan]").strip()
        if not raw:
            sys.exit(0)
        provider = registry.detect(raw)
        if not provider:
            console.print("[red]✗ No se reconoce el sitio para eso (probá --list-sites)[/red]")
            sys.exit(1)
        folder_id = provider.extract_folder_id(raw)
        if folder_id:
            jobs, output_dir = _resolve_folder_jobs(provider, folder_id, output_dir)
            if not jobs:
                sys.exit(1)
        else:
            fid = provider.extract_file_id(raw)
            if not fid:
                console.print("[red]✗ Invalid ID or URL[/red]")
                sys.exit(1)
            jobs.append((provider, fid, None, None, output_dir))

    # ── Proxy pool (only built if some job actually needs it) ──
    needs_proxy = any(_job_uses_proxy(provider, args) for provider, _, _, _, _ in jobs)
    proxy_pool = None
    if needs_proxy:
        proxy_pool, error = proxy_sources.build_pool(CACHE_FILE)
        if not proxy_pool:
            console.print(f"[red]✗ {error}[/red]")
            sys.exit(1)
        console.print()
    elif args.no_proxy:
        console.print("[yellow]⚠  Proxy-free mode enabled[/yellow]\n")

    # ── Run downloads ──
    success = failed = 0

    for idx, (provider, fid, hint, orig_line, dest_dir) in enumerate(jobs, 1):
        use_proxy = proxy_pool is not None and _job_uses_proxy(provider, args)
        mode = "proxy" if use_proxy else "direct"
        console.rule(f"[bold][{idx}/{len(jobs)}][/bold] {provider.name}:{fid} [dim]({mode})[/dim]")

        if use_proxy:
            ok, code = download_file(provider, fid, proxy_pool, dest_dir, args.speed, hint)
        else:
            ok, code = download_direct(provider, fid, dest_dir, hint)

        if ok:
            success += 1
            if orig_line and args.batch:
                comment_batch_line(args.batch, orig_line, "OK")
        else:
            failed += 1
            status = f"HTTP {code}" if code else "FAILED"
            if orig_line and args.batch:
                comment_batch_line(args.batch, orig_line, status)
            console.print(f"  [red]✗ Marked as {status}[/red]")

    # ── Summary ──
    console.print()
    t = Table(title="Summary", box=box.ROUNDED, header_style="bold")
    t.add_column("Status")
    t.add_column("Files", justify="right")
    t.add_row("[green]✓ Successful[/green]", str(success))
    t.add_row("[red]✗ Failed[/red]",         str(failed))
    t.add_row("Total",                        str(len(jobs)))
    if proxy_pool:
        t.add_row("[dim]Proxies tested[/dim]",   str(proxy_pool.tested_count))
        t.add_row("[dim]Proxies working[/dim]",  str(proxy_pool.working_count))
        t.add_row("[dim]Proxy reloads[/dim]",    str(proxy_pool.reload_count))
    console.print(t)
    console.print()


def run():
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠  Interrupted[/yellow]")
        sys.exit(0)
    except Exception as e:
        console.print(f"\n[red bold]FATAL ERROR: {e}[/red bold]")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    run()
