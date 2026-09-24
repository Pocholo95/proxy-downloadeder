"""Splits a pasted single URL/ID or a multi-line batch into the lines
JobManager can handle and the ones no registered SiteProvider recognizes,
so POST /api/downloads can report unsupported lines back instead of
silently dropping them or failing the whole submission.

gallery-dl was tried as a second engine for Bunkr/Gofile/Filester/Pixeldrain
and then dropped -- too many real-world download failures in testing (see
sites/__init__.py). Every supported site is back on the original
SiteProvider/core/downloader.py path via JobManager, so this module no
longer fans lines out to two engines, just filters them.
"""
import re

from ..core import registry

_FOLDER_LABEL_RE = re.compile(r'^folder\s*:\s*(.*)$', re.I)


def split_batch(value):
    """Splits a pasted single URL or multi-line batch into
    (supported_text, unsupported_lines).

    supported_text keeps blank lines/comments/`folder: name` labels intact
    (verbatim) so JobManager's own batch parser -- which already understands
    that syntax for grouping subsequent lines into a named subdirectory --
    sees exactly what it already expects. A label line is only kept if at
    least one supported URL actually follows it before the next label (or
    EOF).
    """
    lines = []
    unsupported = []

    pending_label = None
    label_used = False

    def flush_label():
        nonlocal pending_label, label_used
        if pending_label is not None and not label_used:
            lines.pop()  # the label line was speculatively appended; drop it, unused
        pending_label = None
        label_used = False

    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            lines.append(raw_line)
            continue
        if _FOLDER_LABEL_RE.match(line):
            flush_label()
            lines.append(raw_line)
            pending_label = raw_line
            label_used = False
            continue

        if registry.detect(line):
            lines.append(line)
            label_used = True
        else:
            unsupported.append(line)

    flush_label()
    return "\n".join(lines), unsupported


def route_and_create(value, kind, output_dir, proxy_mode, speed, hold, job_manager):
    """Creates a job for `value` (a single URL/ID or a multi-line batch).
    Returns {"jobs": [...], "unsupported": [...]}."""
    text, unsupported = split_batch(value)

    result = {"jobs": [], "unsupported": unsupported}

    if text.strip():
        is_batch = kind == "batch" or "\n" in text.strip()
        job = job_manager.create_job("batch" if is_batch else "auto", text,
                                      output_dir, proxy_mode, speed, hold)
        result["jobs"].append(job.to_dict())

    return result
