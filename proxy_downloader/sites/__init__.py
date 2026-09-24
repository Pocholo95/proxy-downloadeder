"""Importing this package registers every built-in site provider.

All five sites (Mediafire, Pixeldrain, Bunkr, Gofile, Filester) are back on
this original SiteProvider/core/downloader.py path -- the gallery-dl-backed
engine (webui/gallery_jobs.py, webui/gallery_downloader.py) was tried and
then dropped: too many real-world download failures in testing. Mega/
1fichier/FileDitch stay dropped (gallery-dl never supported them either,
and keeping their scraping/decryption code around just for those three
wasn't worth it).

To add a new site here:
  1. Create proxy_downloader/sites/<yoursite>.py implementing SiteProvider
     (see mediafire.py for a full example, README.md for a walkthrough).
  2. Import it below so `register(...)` runs at startup.
"""
from . import mediafire  # noqa: F401
from . import pixeldrain  # noqa: F401
from . import bunkr  # noqa: F401
from . import gofile  # noqa: F401
from . import filester  # noqa: F401

# Add new site modules here, e.g.:
# from . import example  # noqa: F401
