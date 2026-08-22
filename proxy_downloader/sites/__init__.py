"""Importing this package registers every built-in site provider.

To add a new site:
  1. Create proxy_downloader/sites/<yoursite>.py implementing SiteProvider
     (see pixeldrain.py for a full example, README.md for a walkthrough).
  2. Import it below so `register(...)` runs at startup.
"""
from . import pixeldrain  # noqa: F401
from . import mediafire  # noqa: F401
from . import mega  # noqa: F401
from . import fichier  # noqa: F401
from . import gofile  # noqa: F401
from . import fileditch  # noqa: F401
from . import bunkr  # noqa: F401

# Add new site modules here, e.g.:
# from . import example  # noqa: F401
