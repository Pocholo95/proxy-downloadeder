import { DEFAULTS, MIN_CELL_WIDTH } from "./constants";
import type { SavedOptions, TaskItem, VideoMetadata } from "./types";
import type {
  StaticGridRenderOptions,
  AnimatedGridRenderOptions,
  CellExtractionOptions,
  SequenceRenderOptions,
  GalleryRenderOptions,
} from "./types/service";

/**
 * Build the shared cell extraction options from user settings.
 * These are the options common to both static and animated grids.
 */
export function buildCellOptions(opts: SavedOptions): CellExtractionOptions {
  return {
    width: Math.max(MIN_CELL_WIDTH, opts.width || DEFAULTS.width),
    cols: Math.max(1, opts.cols || DEFAULTS.cols),
    rows: Math.max(1, opts.rows || DEFAULTS.rows),
    spacing: Math.max(0, opts.spacing || DEFAULTS.spacing),
    tcPosition: opts.tcPosition ?? DEFAULTS.tcPosition,
    header: opts.header ?? DEFAULTS.header,
    bgColor: opts.bgColor || DEFAULTS.bgColor,
    textColor: opts.textColor || DEFAULTS.textColor,
    vrMode: opts.vrMode ?? DEFAULTS.vrMode,
    fontFamily: opts.fontFamily ?? DEFAULTS.fontFamily,
    tcFontSizeAuto: opts.tcFontSizeAuto ?? DEFAULTS.tcFontSizeAuto,
    tcFontSize: opts.tcFontSize ?? DEFAULTS.tcFontSize,
    headerFontSizeAuto: opts.headerFontSizeAuto ?? DEFAULTS.headerFontSizeAuto,
    headerFontSize: opts.headerFontSize ?? DEFAULTS.headerFontSize,
    gridTemplate:
      opts.gridTemplate && opts.gridTemplate.cells.length > 0
        ? opts.gridTemplate
        : undefined,
    customTimestamps: undefined,
  };
}

/**
 * Build static grid render options for a single task item.
 * Incorporates per-item custom timestamps and video duration.
 */
export function buildStaticGridOptions(
  opts: SavedOptions,
  item: TaskItem,
  meta: VideoMetadata,
): StaticGridRenderOptions {
  const cellOpts = buildCellOptions(opts);
  const customTimestamps =
    item.timestampMode === "custom" &&
    item.customTimestamps &&
    item.customTimestamps.length > 0
      ? item.customTimestamps
      : undefined;

  return {
    ...cellOpts,
    customTimestamps,
    duration: Math.max(1, meta.duration || 1),
  };
}

/**
 * Build animated grid render options for a single task item.
 * Extends static options with animation-specific settings.
 */
export function buildAnimatedGridOptions(
  opts: SavedOptions,
  item: TaskItem,
  meta: VideoMetadata,
): AnimatedGridRenderOptions {
  const staticOpts = buildStaticGridOptions(opts, item, meta);

  return {
    ...staticOpts,
    animDuration: Math.max(1, opts.animDuration ?? DEFAULTS.animDuration),
    animFps: Math.max(1, opts.animFps ?? DEFAULTS.animFps),
    webpMethod: opts.webpMethod ?? DEFAULTS.webpMethod,
    webpQuality: Math.min(
      100,
      Math.max(5, opts.webpQuality ?? DEFAULTS.webpQuality),
    ),
    format: opts.animFormat ?? DEFAULTS.animFormat,
  };
}

/**
 * Build gallery mode render options for a single task item.
 * Gallery mode captures individual JPEG frames at specified timestamps,
 * returning separate image files instead of a composed grid.
 */
export function buildGalleryOptions(
  opts: SavedOptions,
  item: TaskItem,
  meta: VideoMetadata,
): GalleryRenderOptions {
  const customTimestamps =
    item.timestampMode === "custom" &&
    item.customTimestamps &&
    item.customTimestamps.length > 0
      ? item.customTimestamps
      : undefined;

  return {
    width: Math.max(MIN_CELL_WIDTH, opts.width || DEFAULTS.width),
    count: Math.max(1, opts.galleryCount ?? DEFAULTS.galleryCount ?? 6),
    tcPosition: opts.tcPosition ?? DEFAULTS.tcPosition,
    bgColor: opts.bgColor || DEFAULTS.bgColor,
    textColor: opts.textColor || DEFAULTS.textColor,
    vrMode: opts.vrMode ?? DEFAULTS.vrMode,
    fontFamily: opts.fontFamily ?? DEFAULTS.fontFamily,
    tcFontSizeAuto: opts.tcFontSizeAuto ?? DEFAULTS.tcFontSizeAuto,
    tcFontSize: opts.tcFontSize ?? DEFAULTS.tcFontSize,
    duration: Math.max(1, meta.duration || 1),
    originalResolution:
      opts.galleryOriginalResolution ??
      DEFAULTS.galleryOriginalResolution ??
      true,
    customTimestamps,
  };
}

/**
 * Build sequence mode render options for a single task item.
 * In sequence mode, the grid is always 1 cell wide (full width).
 * Frames are extracted at evenly-spaced intervals across the video duration.
 */
export function buildSequenceOptions(
  opts: SavedOptions,
  item: TaskItem,
  meta: VideoMetadata,
): SequenceRenderOptions {
  const customTimestamps =
    item.timestampMode === "custom" &&
    item.customTimestamps &&
    item.customTimestamps.length > 0
      ? item.customTimestamps
      : undefined;

  return {
    width: Math.max(MIN_CELL_WIDTH, opts.width || DEFAULTS.width),
    cols: 1,
    rows: 1,
    spacing: 0,
    tcPosition: opts.tcPosition ?? DEFAULTS.tcPosition,
    header: opts.header ?? DEFAULTS.header,
    bgColor: opts.bgColor || DEFAULTS.bgColor,
    textColor: opts.textColor || DEFAULTS.textColor,
    vrMode: opts.vrMode ?? DEFAULTS.vrMode,
    fontFamily: opts.fontFamily ?? DEFAULTS.fontFamily,
    tcFontSizeAuto: opts.tcFontSizeAuto ?? DEFAULTS.tcFontSizeAuto,
    tcFontSize: opts.tcFontSize ?? DEFAULTS.tcFontSize,
    headerFontSizeAuto: opts.headerFontSizeAuto ?? DEFAULTS.headerFontSizeAuto,
    headerFontSize: opts.headerFontSize ?? DEFAULTS.headerFontSize,
    gridTemplate: undefined,
    customTimestamps,
    duration: Math.max(1, meta.duration || 1),
    segments: Math.max(1, opts.animSegments ?? DEFAULTS.animSegments),
    sequenceMode: opts.sequenceMode ?? DEFAULTS.sequenceMode,
    animDuration: Math.max(1, opts.animDuration ?? DEFAULTS.animDuration),
    animFps: Math.max(1, opts.animFps ?? DEFAULTS.animFps),
    webpMethod: opts.webpMethod ?? DEFAULTS.webpMethod,
    webpQuality: Math.min(
      100,
      Math.max(5, opts.webpQuality ?? DEFAULTS.webpQuality),
    ),
    format: opts.animFormat ?? DEFAULTS.animFormat,
  };
}
