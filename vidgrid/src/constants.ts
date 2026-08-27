import { Grid3x3, Clapperboard, Scissors, Images } from "lucide-react";
import type { DestinationType, OutputMode, SavedOptions } from "./types";

export const PROJECT_NAME = import.meta.env.VITE_PROJECT_NAME || "VidGrid-HTML";
export const PROJECT_URL =
  import.meta.env.VITE_PROJECT_URL ||
  "https://gitlab.com/aknott001/vidgrid-html";
export const AUTHOR_URL =
  import.meta.env.VITE_AUTHOR_URL || "https://gitlab.com/aknott00";
export const AUTHOR_NAME = import.meta.env.VITE_AUTHOR_NAME || "aknott";

/** Available font families for timecode overlay and header text. */
export const FONT_FACES = [
  "system-ui, Arial, sans-serif",
  "Arial, Helvetica, sans-serif",
  "Georgia, serif",
  "Courier New, Courier, monospace",
  "Verdana, Geneva, sans-serif",
  "Tahoma, Geneva, sans-serif",
  "Trebuchet MS, sans-serif",
  "Impact, Charcoal, sans-serif",
  "Comic Sans MS, cursive, sans-serif",
] as const;

/** Hard limits for font size sliders (pixels). */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 72;

export const DEFAULTS: SavedOptions = {
  width: 1920,
  cols: 3,
  rows: 4,
  spacing: 0,
  tcPosition: "top-left",
  bgColor: "#000000",
  textColor: "#ffffff",
  header: true,
  outputMode: "static",
  animSegments: 6,
  sequenceMode: "video",
  animFormat: "webp",
  animDuration: 3,
  animFps: 10,
  webpMethod: 5,
  webpQuality: 85,
  vrMode: "disabled",
  fontFamily: FONT_FACES[0],
  tcFontSizeAuto: true,
  tcFontSize: 14,
  headerFontSizeAuto: true,
  headerFontSize: 24,
  sectionStates: { grid: true, style: true, modes: true, overlays: true },
  gridTemplate: undefined,
  galleryCount: 8,
  galleryOriginalResolution: true,
  limitFitEnabled: false,
  limitMaxSidePx: 12_000,
  limitMaxMegapixels: 100,
  limitMaxAnimMegapixels: 50,
  limitMaxFileSizeMB: 25,
};

// Header layout
export const HEADER_PADDING_LEFT = 12;

export const SEEK_TIMEOUT_MS = 10_000;

/** Timeout for the native video element to become ready for decoding. */
export const VIDEO_OPEN_TIMEOUT_MS = 15_000;

/**
 * Max concurrent batch workers for output modes that rely on the browser's
 * <video> element seeking (static/animated grid, gallery, sequence in
 * static/video render mode). These all share one hardware decode pipeline
 * within a single renderer process, so running many at once causes
 * contention that makes each seek slower rather than giving real
 * parallelism -- unlike real ffmpeg subprocess work (separate OS
 * processes, one per core), which scales with CPU core count properly.
 */
export const DECODE_CONCURRENCY_CAP = 3;

/**
 * Timeout for a single FFmpeg WASM exec() call (e.g., frame extraction,
 * encoding, segment cutting with audio). Operations just log a warning at
 * this threshold — they are NOT aborted. The user can Force Kill via the UI
 * if the operation seems stuck.
 */
export const FFMPEG_EXEC_TIMEOUT_MS = 300_000;

/**
 * If per-file progress does not advance for longer than this threshold,
 * the UI considers the operation stale and offers a Force Kill button.
 */
export const FFMPEG_STALE_THRESHOLD_MS = 30_000;

/** localStorage key for all persisted app settings (presets, destinations, …) */
export const APP_STORAGE_KEY = "vidgrid_settings";

export const PRESETS_DEFAULT_VALUE = "__default__";

/** Minimum allowed cell width for grid rendering */
export const MIN_CELL_WIDTH = 240;

/** JPEG Quality for grid outpus */
export const JPEG_QUALITY = 0.95;

/** Current schema version for stored settings (used by migration system) */
export const STORAGE_SCHEMA_VERSION = 6;

/**
 * Default configuration per upload-destination provider type.
 * Used to pre-fill form fields, drive UI labels, and validate inputs
 * when creating or editing a destination.
 */
export const UPLOAD_DESTINATION_PROVIDERS: Record<
  DestinationType,
  {
    /** Human-readable provider label for the type selector. */
    label: string;
    defaultUrl: string;
    defaultAllowedExtensions: string;
    defaultMaxSizeMb: number;
    /** Label shown for the API key / auth field. */
    apiKeyLabel: string;
    /** Is the API key field required? */
    apiKeyRequired: boolean;
    /** Placeholder text for the API key input. */
    apiKeyPlaceholder: string;
    /** Title shown in the info popover about the API key. */
    apiKeyHelpTitle: string;
    /** Description shown in the info popover about the API key. */
    apiKeyHelpDescription: string;
    /** Help text shown below the URL input. */
    urlHelpText: string;
    /** If true, the URL must contain a {key} placeholder. */
    requiresKeyPlaceholder: boolean;
    /** If false, direct hotlinking to uploaded files is not supported. */
    canHotlink?: boolean;
  }
> = {
  chevereto: {
    label: "Chevereto",
    defaultUrl: "https://api.imgbb.com/1/upload?key={key}",
    defaultAllowedExtensions: "jpg,webp",
    defaultMaxSizeMb: 32,
    apiKeyLabel: "API Key",
    apiKeyRequired: true,
    apiKeyPlaceholder: "Paste your API key",
    apiKeyHelpTitle: "API Key",
    apiKeyHelpDescription:
      "Usually found in the host's dashboard or account settings. Required to authenticate your uploads.",
    urlHelpText: "Use {key} as a placeholder for the API key. HTTPS required.",
    requiresKeyPlaceholder: true,
  },
  catbox: {
    label: "Catbox",
    defaultUrl: "https://catbox.moe/user/api.php",
    defaultAllowedExtensions: "jpg,webp,mp4",
    defaultMaxSizeMb: 200,
    apiKeyLabel: "Userhash (optional)",
    apiKeyRequired: false,
    apiKeyPlaceholder: "Leave empty for anonymous uploads",
    apiKeyHelpTitle: "Catbox Userhash",
    apiKeyHelpDescription:
      "Usually found in the host's dashboard or account settings. Optional on Catbox — provide a token to associate uploads with your account (required for deletion).",
    urlHelpText: "Uses a fixed upload endpoint. HTTPS required.",
    requiresKeyPlaceholder: false,
  },
  imge: {
    label: "im.ge",
    defaultUrl: "https://im.ge",
    defaultAllowedExtensions: "jpg,webp",
    defaultMaxSizeMb: 100,
    apiKeyLabel: "API Key",
    apiKeyRequired: true,
    apiKeyPlaceholder: "Paste your API key",
    apiKeyHelpTitle: "API Key",
    apiKeyHelpDescription:
      "Usually found in the host's dashboard or account settings. Required to authenticate your uploads.",
    urlHelpText: "Base API URL (e.g. https://im.ge). HTTPS required.",
    requiresKeyPlaceholder: false,
  },
  filester: {
    label: "Filester",
    defaultUrl: "https://u1.filester.me",
    defaultAllowedExtensions: "jpg,webp",
    defaultMaxSizeMb: 10_240,
    apiKeyLabel: "API Key (optional)",
    apiKeyRequired: false,
    apiKeyPlaceholder: "Leave empty for guest uploads",
    apiKeyHelpTitle: "Filester API Key",
    apiKeyHelpDescription:
      "Found in your Filester dashboard at filester.me. Optional — provide a key to enable file deletion. Guest uploads work without a key but uploaded files cannot be deleted later.",
    urlHelpText: "Base API URL (e.g. https://u1.filester.me). HTTPS required.",
    requiresKeyPlaceholder: false,
    canHotlink: false,
  },
};

/**
 * Global fallback defaults for upload destinations.
 * Used by migrations and as a safety net. Individual providers override these.
 */
export const DEFAULT_DEST_ALLOWED_EXTENSIONS = "jpg,webp";
export const DEFAULT_DEST_MAX_SIZE_MB = 32;

/** Upload requests timeout/delay in milliseconds */
export const UPLOAD_TIMEOUT_MS = 30_000;
export const UPLOAD_DELAY_MS = 1200;

/** Animated WebP composition quality percentage */
export const ANIMATED_COMPOSE_PCT = 70;
export const ANIMATED_ENCODE_PCT = 100 - ANIMATED_COMPOSE_PCT;

/** Enable verbose console logging. Controlled via VITE_DEBUG env variable. */
export const DEBUG = import.meta.env.VITE_DEBUG === "true";

/** Default max frames for animation estimation threshold. */
export const ESTIMATION_MAX_FRAMES = 120;

/** Default max total pixels for animation estimation threshold (50 million). */
export const ESTIMATION_MAX_PIXELS = 50_000_000;

/** Default color swatch palette used by the ColorPicker component. */
export const COLOR_SWATCHES = [
  "#000000",
  "#737373",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#a3a3a3",
  "#ffffff",
] as const;

/**
 * Shared output mode metadata — used by OutputModeCards, preset grouping,
 * summaries, and any other UI that displays mode labels.
 */
export const OUTPUT_MODES: {
  value: OutputMode;
  title: string;
  description: string;
  icon: typeof Grid3x3;
}[] = [
  {
    value: "static",
    title: "Static Grid",
    description: "Grid of thumbnails (JPG)",
    icon: Grid3x3,
  },
  {
    value: "animated",
    title: "Animated Grid",
    description: "Animated grid (WebP/MP4)",
    icon: Clapperboard,
  },
  {
    value: "sequence",
    title: "Sequence",
    description: "Video segments (WebP/MP4)",
    icon: Scissors,
  },
  {
    value: "gallery",
    title: "Gallery",
    description: "Individual frames (JPG)",
    icon: Images,
  },
];
