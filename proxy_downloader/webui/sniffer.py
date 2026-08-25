"""Generic "what video is on this page" detector — same idea as the Video
DownloadHelper browser extension: load the real page in a headless browser
and watch every network response that looks like a video file, poking the
page's own player (a heuristic "click play") since many sites only
construct/request the actual signed media URL via JS once playback starts,
never putting it in the plain HTML a static fetch would see.

This is the fallback of last resort — yt-dlp (its own site extractors, or
its generic one) and the hand-written SiteProvider file hosts in sites/
are both strictly better when they apply: faster, no browser needed, and
often handle auth/pagination/rotation this can't. Reach for this only for
a page neither of those resolves.
"""
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

_VIDEO_EXT_RE = re.compile(r"\.(mp4|webm|mkv|mov|m3u8|mpd|avi|ts|flv|m4v)$", re.I)

# Heuristics for "the big play button", roughly in order of how common each
# player library is — checked on the main page and inside every iframe
# (most embed-style sites put the actual player in one).
_PLAY_SELECTORS = [
    ".plyr__control--overlaid",       # Plyr
    "button.vjs-big-play-button",     # Video.js
    ".jw-icon-playback",              # JW Player
    ".ytp-large-play-button",         # YouTube-style embeds
    "[class*='play-button' i]",
    "[class*='play_button' i]",
    "video",
    "[class*='play' i]",
    "[id*='play' i]",
]

# Only the handful of headers actually needed to replay a request later —
# the rest of what a browser sends (sec-fetch-*, accept-language, etc.)
# is either not enforced by CDNs in practice or not something we want to
# spoof more of than necessary.
_CAPTURED_HEADER_NAMES = ("referer", "origin", "user-agent", "cookie")


class SniffError(Exception):
    pass


def _looks_like_video_url(url):
    return bool(_VIDEO_EXT_RE.search(urlsplit(url).path))


def _try_click_play(frame_or_page):
    for selector in _PLAY_SELECTORS:
        try:
            el = frame_or_page.query_selector(selector)
            if el:
                el.click(force=True, timeout=2000)
                return True
        except Exception:
            continue
    return False


def sniff_page(url, nav_timeout=25, settle_ms=2000, click_wait_ms=6000):
    """Returns a list of candidate dicts: {url, content_type, size, headers}.
    size is None when the response didn't carry Content-Length. Raises
    SniffError if the page itself never loaded at all (a genuinely bad
    URL/unreachable host) — a page that loaded fine but had no video is
    not an error, it just returns an empty list."""
    candidates = {}

    def on_response(response):
        resp_url = response.url
        if not _looks_like_video_url(resp_url):
            return
        req = response.request
        candidates[resp_url] = {
            "url": resp_url,
            "content_type": response.headers.get("content-type", ""),
            "size": int(cl) if (cl := response.headers.get("content-length", "")).isdigit() else None,
            "headers": {k: v for k, v in req.headers.items() if k.lower() in _CAPTURED_HEADER_NAMES},
        }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            page.on("response", on_response)
            try:
                page.goto(url, timeout=nav_timeout * 1000, wait_until="load")
            except Exception as e:
                if not candidates:
                    raise SniffError(f"No se pudo cargar la página: {e}") from e
            page.wait_for_timeout(settle_ms)

            _try_click_play(page)
            for frame in page.frames:
                if frame is not page.main_frame:
                    _try_click_play(frame)

            page.wait_for_timeout(click_wait_ms)
        finally:
            browser.close()

    return list(candidates.values())
