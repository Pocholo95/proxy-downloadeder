import { DEFAULTS, MIN_CELL_WIDTH } from "./constants";
import {
  computeAnimationEstimate,
  estimateHeaderHeight,
  findMaxWidthWithinLimits,
  getGridLayout,
} from "./gridUtils";
import type { SavedOptions, TaskItem, VideoMetadata } from "./types";
import type {
  StaticGridRenderOptions,
  AnimatedGridRenderOptions,
  CellExtractionOptions,
  SequenceRenderOptions,
  GalleryRenderOptions,
} from "./types/service";

/**
 * When limitFitEnabled is on, reduces `desiredWidth` (never increases it)
 * so the resulting canvas stays within limitMaxSidePx and, depending on
 * `isAnimated`, either limitMaxMegapixels (static: width × height) or
 * limitMaxAnimMegapixels (animated: width × height × total frames --
 * matches how upload hosts describe "megapixels across frames" for
 * animated images). Reuses the same layout functions the renderers
 * themselves use (getGridLayout / computeAnimationEstimate) as the
 * ground truth instead of re-deriving the cell geometry math here.
 */
export function clampWidthForUploadLimits(
  opts: SavedOptions,
  meta: VideoMetadata,
  desiredWidth: number,
  isAnimated: boolean,
): number {
  if (!opts.limitFitEnabled) return desiredWidth;

  const maxSide = Math.max(1, opts.limitMaxSidePx ?? DEFAULTS.limitMaxSidePx!);
  const layoutBase = {
    cols: Math.max(1, opts.cols || DEFAULTS.cols),
    rows: Math.max(1, opts.rows || DEFAULTS.rows),
    spacing: Math.max(0, opts.spacing || DEFAULTS.spacing),
    gridTemplate:
      opts.gridTemplate && opts.gridTemplate.cells.length > 0
        ? opts.gridTemplate
        : undefined,
    vrMode: opts.vrMode ?? DEFAULTS.vrMode,
  };
  const headerBase = {
    header: opts.header ?? DEFAULTS.header,
    vrMode: opts.vrMode ?? DEFAULTS.vrMode,
    headerFontSizeAuto: opts.headerFontSizeAuto ?? DEFAULTS.headerFontSizeAuto,
    headerFontSize: opts.headerFontSize ?? DEFAULTS.headerFontSize,
  };

  const fits = (w: number): boolean => {
    if (isAnimated) {
      const est = computeAnimationEstimate(meta, {
        outputMode: "animated",
        animSegments: 0,
        animDuration: Math.max(1, opts.animDuration ?? DEFAULTS.animDuration),
        animFps: Math.max(1, opts.animFps ?? DEFAULTS.animFps),
        width: w,
        ...layoutBase,
        header: headerBase.header,
        headerFontSizeAuto: headerBase.headerFontSizeAuto,
        headerFontSize: headerBase.headerFontSize,
      });
      if (!est) return true;
      const maxPixels =
        Math.max(1, opts.limitMaxAnimMegapixels ?? DEFAULTS.limitMaxAnimMegapixels!) *
        1_000_000;
      return (
        est.canvasWidth <= maxSide &&
        est.canvasHeight <= maxSide &&
        est.totalPixels <= maxPixels
      );
    }

    const headerHeight = estimateHeaderHeight({ ...headerBase, width: w }, meta);
    const { canvasWidth, canvasHeight } = getGridLayout(
      { width: w, ...layoutBase },
      meta,
      headerHeight,
    );
    const maxPixels =
      Math.max(1, opts.limitMaxMegapixels ?? DEFAULTS.limitMaxMegapixels!) *
      1_000_000;
    return (
      canvasWidth <= maxSide &&
      canvasHeight <= maxSide &&
      canvasWidth * canvasHeight <= maxPixels
    );
  };

  return findMaxWidthWithinLimits(desiredWidth, MIN_CELL_WIDTH, fits);
}

/**
 * Resolves the max output file size in bytes for the fit-to-limit encode
 * loop, or undefined when the feature is off (renderer treats undefined as
 * "no target, use the fixed default quality" -- unchanged existing behavior).
 */
function resolveMaxFileSizeBytes(opts: SavedOptions): number | undefined {
  if (!opts.limitFitEnabled) return undefined;
  const mb = Math.max(1, opts.limitMaxFileSizeMB ?? DEFAULTS.limitMaxFileSizeMB!);
  return mb * 1_000_000;
}

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
    width: clampWidthForUploadLimits(opts, meta, cellOpts.width, false),
    maxFileSizeBytes: resolveMaxFileSizeBytes(opts),
    customTimestamps,
    duration: Math.max(1, meta.duration || 1),
  };
}

/**
 * Build animated grid render options for a single task item.
 * Builds its own cell options rather than delegating to
 * buildStaticGridOptions, since the two modes clamp width against
 * different pixel budgets (limitMaxMegapixels vs limitMaxAnimMegapixels).
 */
export function buildAnimatedGridOptions(
  opts: SavedOptions,
  item: TaskItem,
  meta: VideoMetadata,
): AnimatedGridRenderOptions {
  const cellOpts = buildCellOptions(opts);
  const customTimestamps =
    item.timestampMode === "custom" &&
    item.customTimestamps &&
    item.customTimestamps.length > 0
      ? item.customTimestamps
      : undefined;

  return {
    ...cellOpts,
    width: clampWidthForUploadLimits(opts, meta, cellOpts.width, true),
    maxFileSizeBytes: resolveMaxFileSizeBytes(opts),
    customTimestamps,
    duration: Math.max(1, meta.duration || 1),
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
