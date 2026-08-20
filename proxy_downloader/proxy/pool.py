"""Proxy validation + rotation. Knows nothing about any download site —
it only fetches/validates raw host:port proxies and hands them out."""
import random
import threading
import time

import requests
from rich.progress import Progress, BarColumn
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..config import VALIDATION_TIMEOUT, MAX_VAL_THREADS, PROXY_REFRESH_WAIT
from ..ui import console
from ..utils import normalize_proxy

VALIDATION_URL = "http://httpbin.org/get"


def fetch_proxy_list(proxies_url):
    """Download and normalize the raw proxy list. Returns a shuffled list or None on failure."""
    console.print("[cyan]📥 Fetching proxy list...[/cyan]")
    try:
        r = requests.get(proxies_url, timeout=15)
        r.raise_for_status()
        proxies = [p for line in r.text.splitlines() if (p := normalize_proxy(line))]
        random.shuffle(proxies)
        console.print(f"[green]✓ {len(proxies)} proxies loaded[/green]")
        return proxies
    except Exception as e:
        console.print(f"[red]✗ Error fetching proxies: {e}[/red]")
        return None


class ProxyPool:
    def __init__(self, proxies, proxies_url, cache):
        self.all_proxies      = proxies
        self.proxies_url      = proxies_url
        self.cache            = cache
        self.available        = []
        self.lock             = threading.Lock()
        self.reload_count     = 0
        self.last_reload_time = time.time()
        self.tested_count     = 0
        self.working_count    = 0
        self.last_working     = None

    def _validate_one(self, proxy):
        try:
            r = requests.head(VALIDATION_URL,
                              proxies={"http": proxy, "https": proxy},
                              timeout=VALIDATION_TIMEOUT, allow_redirects=False)
            return r.status_code in (200, 301, 302, 405)
        except:
            return False

    def _validate_batch(self, proxies_to_test):
        proxies_to_test = [p for p in proxies_to_test if not self.cache.is_blacklisted(p)]
        if not proxies_to_test:
            return []
        console.print(f"[cyan]🔍 Validating {len(proxies_to_test)} proxies...[/cyan]")
        working = []
        with Progress("[progress.description]{task.description}", BarColumn(),
                      "[progress.percentage]{task.percentage:>3.0f}%", console=console) as bar:
            task = bar.add_task("Validating proxies", total=len(proxies_to_test))
            with ThreadPoolExecutor(max_workers=MAX_VAL_THREADS) as ex:
                futures = {ex.submit(self._validate_one, p): p for p in proxies_to_test}
                for future in as_completed(futures):
                    self.tested_count += 1
                    try:
                        if future.result():
                            p = futures[future]
                            working.append(p)
                            self.working_count += 1
                            self.cache.add(p)
                    except: pass
                    bar.advance(task)
        rate = len(working) / len(proxies_to_test) * 100 if proxies_to_test else 0
        console.print(f"[green]✓ {len(working)}/{len(proxies_to_test)} working ({rate:.1f}%)[/green]")
        return working

    def initial_load(self):
        if self.cache.has_proxies() and self.cache.is_fresh():
            cached = self.cache.get_all()
            random.shuffle(cached)
            with self.lock:
                self.available = cached.copy()
            console.print(f"[green]⚡ {len(cached)} proxies from cache (no re-validation)[/green]")
            return len(cached)
        working = self._validate_batch(self.all_proxies)
        with self.lock:
            self.available = working
        return len(working)

    def _reload(self):
        wait = PROXY_REFRESH_WAIT - (time.time() - self.last_reload_time)
        if wait > 0:
            console.print(f"[yellow]⏳ Waiting {wait:.0f}s before reloading...[/yellow]")
            time.sleep(wait)
        try:
            r = requests.get(self.proxies_url, timeout=15)
            r.raise_for_status()
            new = [p for line in r.text.splitlines() if (p := normalize_proxy(line))]
            if not new: return False
            self.cache.clear_blacklists()
            cached = set(self.cache.get_all())
            to_test = [p for p in new if p not in cached]
            with self.lock:
                self.all_proxies = new
                self.available.clear()
            if self.last_working and self.last_working in new:
                with self.lock: self.available.append(self.last_working)
            working = self._validate_batch(to_test)
            with self.lock:
                self.available.extend(working)
                others = [p for p in cached if p != self.last_working]
                random.shuffle(others)
                self.available.extend(others)
            self.reload_count += 1
            self.last_reload_time = time.time()
            return True
        except Exception as e:
            console.print(f"[red]✗ Error reloading proxies: {e}[/red]")
            return False

    def get_next(self):
        with self.lock:
            if self.available:
                return self.available.pop(0)
        console.print("[yellow]⚠  No proxies available, reloading...[/yellow]")
        if self._reload():
            with self.lock:
                if self.available:
                    return self.available.pop(0)
        return None

    def mark_working(self, proxy):
        self.cache.add(proxy)
        self.last_working = proxy

    def mark_failed(self, proxy):
        self.cache.mark_failed(proxy)

    def mark_slow(self, proxy):
        self.cache.mark_slow(proxy)
