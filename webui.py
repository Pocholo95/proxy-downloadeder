#!/usr/bin/env python3
"""Entry point for the web UI (Docker image's default command). Serves the
same downloader engine as downloader.py, over HTTP instead of a terminal —
see proxy_downloader/webui/ for the Flask app and background job manager."""
from proxy_downloader.webui.app import main

if __name__ == "__main__":
    main()
