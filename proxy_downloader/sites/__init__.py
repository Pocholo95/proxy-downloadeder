"""Importing this package registers every built-in site provider.

Mediafire is the only site left on this original SiteProvider/
core/downloader.py path -- Pixeldrain, Bunkr, Gofile and Filester moved to
the gallery-dl-backed engine (see webui/gallery_jobs.py, webui/
gallery_downloader.py, webui/download_router.py), and Mega/1fichier/
FileDitch were dropped outright (gallery-dl doesn't support them either,
and keeping their scraping/decryption code around just for those three
wasn't worth it).

To add a new site here (one gallery-dl itself doesn't support):
  1. Create proxy_downloader/sites/<yoursite>.py implementing SiteProvider
     (see mediafire.py for a full example, README.md for a walkthrough).
  2. Import it below so `register(...)` runs at startup.
"""
from . import mediafire  # noqa: F401

# Add new site modules here, e.g.:
# from . import example  # noqa: F401
