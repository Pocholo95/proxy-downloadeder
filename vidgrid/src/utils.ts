import { DEBUG, PROJECT_NAME } from "./constants";
import type { TaskItem, VideoMetadata } from "./types";
import { getEffectiveDimensions } from "./gridUtils";
import { resolutionLabel } from "./uploadUtils";

// Logging - all calls are no-ops when DEBUG is false.
export const log = (...a: unknown[]) =>
  DEBUG && console.log(`[${PROJECT_NAME}]`, ...a);
export const warn = (...a: unknown[]) =>
  DEBUG && console.warn(`[${PROJECT_NAME}]`, ...a);
export const errlog = (...a: unknown[]) =>
  DEBUG && console.error(`[${PROJECT_NAME}]`, ...a);

/**
 * Formats a byte count as a human-readable string (B, KB, MB, GB).
 *
 * @param bytes - The raw byte count.
 */
export const humanSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Breaks a duration in seconds into hours, minutes, and raw seconds.
 * Returns `null` for non-finite or negative values.
 *
 * @param seconds - Duration in seconds.
 */
const splitTime = (
  seconds: number,
): { h: number; m: number; s: number } | null => {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return {
    h: Math.floor(seconds / 3600),
    m: Math.floor((seconds % 3600) / 60),
    s: seconds % 60,
  };
};

/**
 * Formats a duration in seconds as `HH:MM:SS`.
 * Returns `"00:00:00"` for non-finite or negative values.
 *
 * @param seconds - Duration in seconds.
 */
export const formatTime = (seconds: number): string => {
  const t = splitTime(seconds);
  if (!t) return "00:00:00";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(t.h)}:${pad(t.m)}:${pad(Math.floor(t.s))}`;
};

/**
 * Formats a duration in seconds as `HH:MM:SS.mmm` (millisecond precision).
 * Useful for marker labels where frame-level precision matters (up to 1000fps).
 *
 * @param seconds - Duration in seconds.
 */
export const formatTimeExact = (seconds: number): string => {
  const t = splitTime(seconds);
  if (!t) return "00:00:00.000";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(t.h)}:${pad(t.m)}:${t.s.toFixed(3).padStart(6, "0")}`;
};

/**
 * Formats elapsed milliseconds in a human-friendly way.
 * - Under 1 minute: "32.235s"
 * - Under 1 hour: "1m 30s"
 * - 1 hour or more: "2h 3m 4s"
 *
 * @param ms - Elapsed time in milliseconds.
 */
export const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s.toFixed(0)}s`;
  }
  if (m > 0) {
    return `${m}m ${s.toFixed(0)}s`;
  }
  return `${s.toFixed(3)}s`;
};

/**
 * Formats a pixel count as a human-readable string (K, M, B).
 *
 * @param pixels - The raw pixel count.
 */
export const humanPixels = (pixels: number): string => {
  const units = ["", "K", "M", "B"];
  let size = pixels;
  let i = 0;
  while (size >= 1000 && i < units.length - 1) {
    size /= 1000;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
};

/** Generates a random UUID string suitable for use as an item ID. */
export const makeId = (): string => crypto.randomUUID();

// Helper to generate unique filename if collision exists
export function makeUniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;

  const lastDot = name.lastIndexOf(".");
  const hasExt = lastDot > -1;
  const base = hasExt ? name.substring(0, lastDot) : name;
  const ext = hasExt ? name.substring(lastDot) : "";

  let i = 1;
  let candidate = `${base}_${i}${ext}`;
  while (existing.has(candidate)) {
    i++;
    candidate = `${base}_${i}${ext}`;
  }
  return candidate;
}

/**
 * Type guard that returns true when `meta` contains valid, usable video dimensions
 * and a positive duration. Use this before passing metadata to grid generation.
 *
 * @param meta - The VideoMetadata object to check (may be undefined).
 */
export const hasUsableMetadata = (
  meta: VideoMetadata | undefined,
): meta is VideoMetadata =>
  meta != null && meta.duration > 0 && meta.width > 0 && meta.height > 0;

/**
 * Converts a RGB Hex code (with or without # prefix) to an RGBA string.
 * Supports shorthand (#rgb) and full (#rrggbb) formats.
 *
 * @param hex - RGB Hex code string (e.g., '#ff0000' or '#f00')
 * @param alpha - Alpha value (0-1, defaults to 1)
 * @returns RGBA string
 * @throws Error for invalid hex
 */
export const hexToRgba = (hex: string, alpha: number = 1): string => {
  if (alpha < 0 || alpha > 1) {
    throw new Error("Alpha must be between 0 and 1");
  }
  const cleaned = hex.replace(/[^#a-fA-F0-9]/g, "").replace(/^#?/, "");
  if (!/^([a-f0-9]{3}){1,2}$/i.test(cleaned)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  let fullHex = cleaned;
  if (fullHex.length === 3) {
    fullHex = fullHex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(fullHex.slice(0, 2), 16);
  const g = parseInt(fullHex.slice(2, 4), 16);
  const b = parseInt(fullHex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Validates and normalizes a hex color string.
 * Returns a valid 7-char hex string (#RRGGBB) or the fallback.
 *
 * @param color - The color value to normalize (string or other type).
 * @param fallback - The fallback color returned when the value is invalid.
 * @returns A normalized 7-char hex string (#rrggbb) or the fallback.
 */
export function normalizeHex(color: unknown, fallback: string): string {
  if (typeof color !== "string") return fallback;
  const cleaned = color.replace(/^#/, "");
  // Strip alpha if present (#rrggbbaa -> #rrggbb)
  const hexPart = cleaned.length > 6 ? cleaned.slice(0, 6) : cleaned;
  if (/^[0-9a-f]{6}$/i.test(hexPart)) {
    return "#" + hexPart.toLowerCase();
  }
  if (/^[0-9a-f]{3}$/i.test(hexPart)) {
    const expanded = hexPart
      .split("")
      .map((c) => c + c)
      .join("");
    return "#" + expanded.toLowerCase();
  }
  return fallback;
}

/**
 * Strip the file extension from a filename (only the last one).
 * Returns the filename unchanged if it contains no dot.
 *
 * @param filename - The filename to strip.
 * @returns The filename without its extension.
 */
export function withoutExtension(filename: string): string {
  return filename.includes(".")
    ? filename.slice(0, filename.lastIndexOf("."))
    : filename;
}

/**
 * Build a BBCode "title + resolution" line from a filename and optional metadata.
 * Uses `resolutionLabel` to derive a standard resolution tag (e.g. "1080p")
 * from the video metadata when available. Falls back to title-only when
 * metadata is missing.
 *
 * @param name - The filename (extension stripped by caller or here).
 * @param metadata - Optional video metadata for resolution label.
 * @returns The formatted BBCode string, e.g. `[b]MyVideo 1080p[/b]`.
 */
export function buildBbcodeTitleLine(
  name: string,
  metadata?: VideoMetadata,
): string {
  const res = metadata ? resolutionLabel(metadata) : "";
  return `[b]${name}${res ? ` ${res}` : ""}[/b]`;
}

/**
 * Build a BBCode "title + resolution" string for a single task item.
 * Uses `resolutionLabel` to derive a standard resolution tag (e.g. "1080p")
 * from the video metadata when available. Falls back to title-only when
 * metadata is missing.
 * Always uses the original video filename (`item.source.name`), never the
 * generated output name, so the BBCode title reflects the source video.
 *
 * @param item - The TaskItem to build a title for.
 * @returns The formatted BBCode string.
 */
export const buildBbcodeTitle = (item: TaskItem): string => {
  return buildBbcodeTitleLine(
    withoutExtension(item.source.name),
    item.metadata,
  );
};

/**
 * Formats a bitrate value into a human-readable string.
 * Uses Mbps for values >= 1 Mbps, otherwise kbps.
 *
 * @param bps - Bitrate in bits per second (0 or undefined returns null).
 */
export const formatBitrate = (bps?: number): string | null => {
  if (!bps || bps <= 0) return null;
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }
  return `${Math.round(bps / 1_000)} kbps`;
};

/**
 * Builds formatted metadata display lines for the canvas header and
 * SourceInfoSection. Both consumers use this same function to ensure
 * identical formatting.
 *
 * @param meta - Video metadata.
 * @param filename - Source filename (optional, omitted when undefined).
 * @param fileSize - Source file size in bytes (optional, omitted when 0/undefined).
 */
export const buildMetadataLines = (
  meta: VideoMetadata,
  filename?: string,
  fileSize?: number,
): string[] => {
  const lines: string[] = [];

  if (filename) lines.push(`Filename: ${filename}`);
  if (fileSize && fileSize > 0) lines.push(`Size: ${humanSize(fileSize)}`);

  // Use effective (rotation-applied) dimensions so portrait videos show
  // the display-correct resolution (e.g. 1080×2400 instead of 2400×1080).
  const { width: effW, height: effH } = getEffectiveDimensions(meta);
  const rotationLabel = meta.rotation ? ` (Rotated ${meta.rotation}°)` : "";
  lines.push(
    `Resolution: ${effW > 0 ? `${effW}×${effH}` : "Unknown"}${rotationLabel}`,
  );
  lines.push(`Duration: ${formatTime(meta.duration)}`);

  // Video bitrate line
  const videoBps = formatBitrate(meta.videoBitrate);
  const videoTrackSuffix =
    meta.videoTracks && meta.videoTracks > 1
      ? ` (${meta.videoTracks} tracks)`
      : "";
  lines.push(
    `Video Bitrate: ${videoBps ?? "Unknown"} @ ${meta.fps ?? "Unknown"}fps - Codec: ${meta.codec ?? "Unknown"}${videoTrackSuffix}`,
  );

  // Audio bitrate line
  if (meta.audioBitrate) {
    const audioBps = formatBitrate(meta.audioBitrate);
    const audioTrackSuffix =
      meta.audioTracks && meta.audioTracks > 1
        ? ` (${meta.audioTracks} tracks)`
        : "";
    lines.push(
      `Audio Bitrate: ${audioBps ?? "Unknown"} - Codec: ${meta.audioCodec ?? "Unknown"}${audioTrackSuffix}`,
    );
  }

  return lines;
};
