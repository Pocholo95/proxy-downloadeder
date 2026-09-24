"""Importing this package registers every built-in site provider.

Mediafire and Pixeldrain are the two sites left on this original
SiteProvider/core/downloader.py path -- Bunkr, Gofile and Filester moved to
the gallery-dl-backed engine (see webui/gallery_jobs.py, webui/
gallery_downloader.py, webui/download_router.py), and Mega/1fichier/
FileDitch were dropped outright (gallery-dl doesn't support them either,
and keeping their scraping/decryption code around just for those three
wasn't worth it).

Pixeldrain moved to gallery-dl and then back here: gallery-dl's Pixeldrain
extractor turned out to error out often in practice, while this project's
own hand-rolled provider (plus its proxy-rotation path in
core/downloader.py) had been stable for a long time -- worth the extra
provider to maintain for that one site.

To add a new site here (one gallery-dl itself doesn't support, or one
gallery-dl supports but not reliably enough):
  1. Create proxy_downloader/sites/<yoursite>.py implementing SiteProvider
     (see mediafire.py for a full example, README.md for a walkthrough).
  2. Import it below so `register(...)` runs at startup.
"""
from . import mediafire  # noqa: F401
from . import pixeldrain  # noqa: F401

# Add new site modules here, e.g.:
# from . import example  # noqa: F401
