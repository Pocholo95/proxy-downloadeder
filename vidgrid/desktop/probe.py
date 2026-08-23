"""Video metadata via real ffprobe -- replaces mediainfo.js entirely.

Output shape matches src/types.ts's VideoMetadata exactly so
useFileAnalyzer.ts / useBatchProcessor.ts need no downstream changes,
only the call-site swap.
"""

import json
import subprocess

from .paths import ffprobe_exe

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _parse_rate(rate: str | None) -> float | None:
    if not rate or rate in ("0/0", "N/A"):
        return None
    if "/" in rate:
        num, _, den = rate.partition("/")
        try:
            num_f, den_f = float(num), float(den)
            return num_f / den_f if den_f else None
        except ValueError:
            return None
    try:
        return float(rate)
    except ValueError:
        return None


def _extract_rotation(video: dict | None) -> int | None:
    if not video:
        return None
    for sd in video.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                # ffprobe reports e.g. -90; normalize to a positive 0/90/180/270.
                return int(float(sd["rotation"])) % 360
            except (TypeError, ValueError):
                continue
    tag_rotate = (video.get("tags") or {}).get("rotate")
    if tag_rotate is not None:
        try:
            return int(tag_rotate) % 360
        except ValueError:
            return None
    return None


def probe_metadata(path: str) -> dict:
    out = subprocess.run(
        [
            str(ffprobe_exe()),
            "-v", "error",
            "-show_format",
            "-show_streams",
            "-of", "json",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
        creationflags=_CREATE_NO_WINDOW,
    )
    data = json.loads(out.stdout)
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") or {}

    duration = float(fmt.get("duration") or (video or {}).get("duration") or 0)
    width = int((video or {}).get("width") or 0)
    height = int((video or {}).get("height") or 0)
    video_bitrate = int(
        (video or {}).get("bit_rate") or fmt.get("bit_rate") or 0
    )
    fps = _parse_rate((video or {}).get("r_frame_rate")) if video else None
    codec = (
        (video or {}).get("codec_long_name")
        or (video or {}).get("codec_name")
        if video
        else None
    )
    video_tracks = sum(1 for s in streams if s.get("codec_type") == "video")
    audio_tracks = sum(1 for s in streams if s.get("codec_type") == "audio")
    audio_bitrate = (
        int(audio["bit_rate"]) if audio and audio.get("bit_rate") else None
    )
    audio_codec = audio.get("codec_name") if audio else None
    rotation = _extract_rotation(video)

    return {
        "duration": duration,
        "width": width,
        "height": height,
        "videoBitrate": video_bitrate,
        "fps": fps,
        "codec": codec,
        "videoTracks": video_tracks,
        "audioBitrate": audio_bitrate,
        "audioCodec": audio_codec,
        "audioTracks": audio_tracks,
        "rotation": rotation,
    }
