"""Classifies pasted URLs/IDs into the two download engines this app has
left after the gallery-dl migration: the original SiteProvider/
core/downloader.py path (Mediafire, Pixeldrain -- see sites/__init__.py for
why Pixeldrain moved back here) via JobManager, or one of the three
gallery-dl-backed sites (Bunkr, Gofile, Filester) via GalleryJobManager.
Anything else is reported back as unsupported rather than silently handed to
gallery-dl's full ~300-site catalog -- a mistakenly pasted Twitter/Reddit/etc.
link should not quietly start a job for a site this app never asked to
support.

Site detection has always lived server-side here (SiteProvider.owns()/
registry.detect()), so POST /api/downloads keeps that: the frontend just
posts whatever the user typed, in any mix, and this module sorts it out --
same one-box-for-anything UX the old "batch" textarea already had, now
spanning two engines instead of one registry.
"""
import re

import gallery_dl.extractor as gdl_extractor

from ..core import registry

GALLERY_CATEGORIES = {"bunkr", "gofile", "filester"}

_FOLDER_LABEL_RE = re.compile(r'^folder\s*:\s*(.*)$', re.I)


def classify_line(line):
    """Returns ("provider" | "gallery" | None, resolved_line)."""
    line = line.strip()
    if not line:
        return None, line
    # registry.detect() covers every site still on the original SiteProvider
    # path (Mediafire, Pixeldrain) -- including Pixeldrain's bare-ID/"l:ID"
    # shorthand, via its is_default flag, so no separate bare-ID handling is
    # needed here.
    provider = registry.detect(line)
    if provider:
        return "provider", line
    ext = gdl_extractor.find(line)
    if ext and ext.category in GALLERY_CATEGORIES:
        return "gallery", line
    return None, line


def split_batch(value):
    """Splits a pasted single URL or multi-line batch into
    (provider_text, gallery_urls, unsupported_lines).

    provider_text keeps blank lines/comments/`folder: name` labels intact
    (verbatim) so JobManager's own batch parser -- which already understands
    that syntax for grouping subsequent lines into a named subdirectory --
    sees exactly what it already expects. A label line is only kept if at
    least one provider URL actually follows it before the next label (or
    EOF); gallery-dl jobs have no such grouping concept in this app, so
    labels are never forwarded to the gallery list.
    """
    provider_lines = []
    gallery_urls = []
    unsupported = []

    pending_label = None
    label_used = False

    def flush_label():
        nonlocal pending_label, label_used
        if pending_label is not None and not label_used:
            provider_lines.pop()  # the label line was speculatively appended; drop it, unused
        pending_label = None
        label_used = False

    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            provider_lines.append(raw_line)
            continue
        if _FOLDER_LABEL_RE.match(line):
            flush_label()
            provider_lines.append(raw_line)
            pending_label = raw_line
            label_used = False
            continue

        engine, resolved = classify_line(line)
        if engine == "provider":
            provider_lines.append(resolved)
            label_used = True
        elif engine == "gallery":
            gallery_urls.append(resolved)
        else:
            unsupported.append(line)

    flush_label()
    return "\n".join(provider_lines), gallery_urls, unsupported


def route_and_create(value, kind, output_dir, proxy_mode, speed, hold,
                      job_manager, gallery_manager):
    """Creates jobs on whichever engine(s) `value` (a single URL/ID or a
    multi-line batch) resolves to. Returns
    {"jobs": [...], "gallery_jobs": [...], "unsupported": [...]}."""
    provider_text, gallery_urls, unsupported = split_batch(value)

    result = {"jobs": [], "gallery_jobs": [], "unsupported": unsupported}

    if provider_text.strip():
        is_batch = kind == "batch" or "\n" in provider_text.strip()
        job = job_manager.create_job("batch" if is_batch else "auto", provider_text,
                                      output_dir, proxy_mode, speed, hold)
        result["jobs"].append(job.to_dict())

    if gallery_urls:
        # hold (Linkgrabber) only applies to the provider/JobManager path --
        # gallery-dl jobs have no held state in this migration (see
        # gallery_jobs.py). A gallery URL submitted alongside hold=True still
        # queues immediately; surfaced to the caller via this flag rather
        # than silently ignored.
        result["hold_not_applied"] = bool(hold)
        if len(gallery_urls) == 1:
            job = gallery_manager.create_job(gallery_urls[0], output_dir, proxy_mode, speed)
            result["gallery_jobs"].append(job.to_dict())
        else:
            jobs = gallery_manager.create_batch(gallery_urls, output_dir, proxy_mode, speed)
            result["gallery_jobs"].extend(j.to_dict() for j in jobs)

    return result
