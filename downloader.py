#!/usr/bin/env python3
"""Entry point. Site is auto-detected from the URL/ID you pass in — see
proxy_downloader/sites/ for the list of supported sites and
proxy_downloader/core/base.py for how to add a new one."""
from proxy_downloader.cli import run

if __name__ == "__main__":
    run()
