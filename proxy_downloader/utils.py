"""Generic helpers with no site-specific or proxy-specific knowledge."""
import hashlib
import os
import re
from pathlib import Path
from urllib.parse import unquote

from .config import IP_PORT_RE, INVALID_CHARS
from .ui import console


def normalize_proxy(line):
    line = line.strip().split("#")[0].strip()
    if not line:
        return None
    m = IP_PORT_RE.match(line)
    if not m:
        return None
    scheme = (m.group("scheme") or "http").lower()
    return f"{scheme}://{m.group('host')}:{m.group('port')}"


def sanitize_filename(name, max_len=150):
    if not name:
        return "download.bin"
    clean = INVALID_CHARS.sub("", name)
    clean = "".join(c for c in clean if ord(c) >= 32)
    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) > max_len:
        base, ext = os.path.splitext(clean)
        clean = base[:max_len - len(ext)] + ext
    return clean or "download.bin"


def filename_from_header(header):
    if not header:
        return None
    for pat in [r'filename\*=(?:UTF-8\'\')?([^;]+)',
                r'filename\s*=\s*"([^"]+)"',
                r'filename\s*=\s*([^;\s]+)']:
        m = re.search(pat, header, re.I)
        if m:
            val = unquote(m.group(1).strip().strip('"').strip("'"))
            if val:
                return val
    return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def comment_batch_line(batch_file, original_line, status="OK"):
    try:
        lines = Path(batch_file).read_text(encoding="utf-8").splitlines(keepends=True)
        for i, line in enumerate(lines):
            if line.strip() == original_line and not line.strip().startswith("#"):
                lines[i] = f"# [{status}] {original_line}\n"
                break
        Path(batch_file).write_text("".join(lines), encoding="utf-8")
    except Exception as e:
        console.print(f"[yellow]⚠  Could not update {batch_file}: {e}[/yellow]")
