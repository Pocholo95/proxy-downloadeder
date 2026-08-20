"""Disk-backed cache of known-working / known-bad proxies. Site-agnostic."""
import json
import os
import time

from ..config import CACHE_FILE, CACHE_MAX_AGE, MIN_CACHE_SIZE
from ..ui import console


class ProxyCache:
    def __init__(self, cache_file=CACHE_FILE):
        self.cache_file = cache_file
        self.working    = []
        self.failed     = set()
        self.slow       = set()
        self.timestamp  = 0
        self._load()

    def _load(self):
        try:
            if os.path.exists(self.cache_file):
                with open(self.cache_file) as f:
                    data = json.load(f)
                self.timestamp = data.get("timestamp", 0)
                age = time.time() - self.timestamp
                if age > CACHE_MAX_AGE:
                    console.print(f"[yellow]⚠  Cache too old ({age/60:.1f} min), discarding[/yellow]")
                    try: os.remove(self.cache_file)
                    except: pass
                    return
                self.working = data.get("proxies", [])
                self.failed  = set(data.get("failed", []))
                self.slow    = set(data.get("slow", []))
                console.print(f"[dim]📦 Cache: {len(self.working)} proxies ({age/60:.1f} min old)[/dim]")
        except Exception as e:
            console.print(f"[yellow]⚠  Error reading cache: {e}[/yellow]")

    def save(self):
        try:
            with open(self.cache_file, "w") as f:
                json.dump({"proxies": self.working, "failed": list(self.failed),
                           "slow": list(self.slow), "timestamp": time.time()}, f, indent=2)
        except: pass

    def add(self, proxy):
        if proxy not in self.working:
            self.working.append(proxy)
        self.failed.discard(proxy)
        self.slow.discard(proxy)
        self.save()

    def mark_failed(self, proxy):
        if proxy in self.working: self.working.remove(proxy)
        self.failed.add(proxy)
        self.save()

    def mark_slow(self, proxy):
        if proxy in self.working: self.working.remove(proxy)
        self.slow.add(proxy)
        self.save()

    def is_blacklisted(self, proxy):
        return proxy in self.failed or proxy in self.slow

    def get_all(self):
        return self.working.copy()

    def has_proxies(self):
        return len(self.working) >= MIN_CACHE_SIZE

    def is_fresh(self):
        return self.timestamp > 0 and (time.time() - self.timestamp) <= CACHE_MAX_AGE

    def clear_blacklists(self):
        self.failed.clear()
        self.slow.clear()
        self.save()
