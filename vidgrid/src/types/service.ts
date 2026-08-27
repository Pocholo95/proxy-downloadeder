// Service interfaces for the refactored architecture

import type {
  AppSettings,
  VideoMetadata,
  VideoSource,
  VrMode,
  GridTemplate,
  Position,
} from "../types";

/** Interface for FFmpeg service lifecycle and operations */
export interface IFFmpegService {
  /** Initialize the FFmpeg backend. Resolves when ready. Idempotent. */
  init(): Promise<void>;
  /** Check if instance is loaded and functional */
  isReady(): boolean;
  /**
   * Bind the real input file for this task so subsequent exec() calls that
   * reference the literal filename "input.mp4" resolve to it.
   */
  bindInputPath(path: string): Promise<void>;
  /** Execute an FFmpeg command */
  exec(args: string[]): Promise<void>;
  /** Write data to FFmpeg virtual filesystem */
  writeData(path: string, data: Uint8Array): Promise<void>;
  /** Read data from FFmpeg virtual filesystem */
  readData(path: string): Promise<Uint8Array>;
  /** List files in FFmpeg virtual filesystem */
  listDir(path: string): Promise<unknown[]>;
  /** Delete a file from virtual filesystem */
  deleteFile(path: string): Promise<void>;
  /** Terminate and release all resources */
  destroy(): Promise<void>;
  /** Re-initialize after termination */
  reinit(): Promise<void>;
  /** Register callback for FFmpeg stderr log lines (passes full array with total count) */
  onLog(
    callback:
      ((taskId: string, logs: string[], totalLines: number) => void) | null,
  ): void;
  /** Register callback for FFmpeg progress events ({ progress: number }) */
  onProgress(callback: ((data: { progress: number }) => void) | null): void;
  /** Remove a previously registered progress callback */
  offProgress(callback: ((data: { progress: number }) => void) | null): void;
  /** Terminate FFmpeg instance (for between-task cleanup) */
  reset(): Promise<void>;
  /** Current task ID for log attribution */
  setTaskId(id: string | null): void;
  /** Get accumulated logs for a task and clear them */
  getAndClearLogs(taskId: string): string[];
  /** Check if FFmpeg is currently busy (for stale detection) */
  getBusyState(): boolean;
  /** Set abort controller for current operation; returns the controller */
  setAbortController(): AbortController;
  /** Abort current FFmpeg operation */
  abortCurrent(): void;
  /** Enable or disable FFmpeg log event handling to avoid slow WASM boundary crossings */
  setLoggingEnabled(enabled: boolean): void;
  /** Append a status log line that bypasses the loggingEnabled flag */
  appendLog(line: string): void;
}

/** Interface for persistent storage backend (e.g., localStorage wrapper) */
export interface IStorageProvider {
  /** Retrieve a value by key; returns null if not present */
  getItem(key: string): string | null;
  /** Persist a string value under the given key */
  setItem(key: string, value: string): void;
  /** Remove an entry by key */
  removeItem(key: string): void;
}

/** Wrapper that pairs a schema version with settings data for migration support */
export interface VersionedSettings {
  /** Numeric schema version of the stored settings */
  schemaVersion: number;
  /** Serialized application settings */
  data: AppSettings;
}

/** Accumulator for batch-processing statistics */
export interface BatchState {
  /** Number of files completed in the current batch */
  batchDone: number;
  /** Total number of files in the current batch */
  batchTotal: number;
  /** Timestamp when the batch started (milliseconds), or null if idle */
  batchStartTime: number | null;
  /** Elapsed time for the last batch in milliseconds, or null if none */
  batchDurationMs: number | null;
  /** Count of successfully processed files */
  succeeded: number;
  /** Count of files that failed during processing */
  errored: number;
  /** Count of files the user cancelled */
  cancelled: number;
}

/** UI-facing processor status (separated from processing logic) */
export interface ProcessorUIState {
  /** Status message displayed to the user */
  text: string;
  /** Semantic kind of the status message for styling */
  textKind?: "info" | "success" | "warning" | "cancelled";
  /** Current processing progress as a 0–100 percentage */
  currentPct: number;
  /** Whether the processor is actively working */
  isProcessing: boolean;
  /** Whether the processor appears stuck (no progress for a threshold) */
  isStale: boolean;
  /** Task IDs currently considered stale */
  staleTaskIds: string[];
}

/** Output produced by a single grid render operation */
export interface GridRenderResult {
  /** Suggested file name for the output */
  outputName: string;
  /** Size of the rendered output in bytes */
  outputSize: number;
  /** Binary blob containing the rendered image */
  outputBlob: Blob;
}

/** Common cell rendering callback */
export type CellDoneCallback = (
  cellIdx: number,
  totalCells: number,
  timestampSec: number,
) => void;

/** Common warning callback */
export type WarningCallback = (message: string) => void;

/** Shared options for grid cell extraction (JPEG and WebP) */
export interface CellExtractionOptions {
  /** Output canvas width in pixels */
  width: number;
  /** Number of columns in the grid */
  cols: number;
  /** Number of rows in the grid */
  rows: number;
  /** Spacing in pixels between cells */
  spacing: number;
  /** Position of the timecode overlay on each cell */
  tcPosition: Position;
  /** Whether to render a header bar with file info */
  header: boolean;
  /** Background color of the canvas (hex string) */
  bgColor: string;
  /** Color of timecode and header text (hex string) */
  textColor: string;
  /** 360° VR cropping mode (e.g., left-eye, right-eye, or disabled) */
  vrMode: VrMode;
  /** Font family for timecode overlay and header text. */
  fontFamily: string;
  /** When true, timecode font size scales with canvas width. */
  tcFontSizeAuto: boolean;
  /** Explicit timecode font size in pixels. */
  tcFontSize: number;
  /** When true, header font size scales with canvas width. */
  headerFontSizeAuto: boolean;
  /** Explicit header font size in pixels. */
  headerFontSize: number;
  /** Custom grid layout template, or undefined for uniform grid */
  gridTemplate: GridTemplate | undefined;
  /** User-supplied timestamps to extract frames at, or undefined for auto-spaced */
  customTimestamps: number[] | undefined;
  /**
   * When set, the renderer iteratively lowers JPEG/WebP quality (re-encoding
   * from the already-composed canvas/frames, no re-extraction) to try to
   * bring the output under this many bytes. Ignored for MP4 output, which
   * has no exposed quality knob. Undefined disables the loop entirely.
   */
  maxFileSizeBytes?: number;
}

/** Static JPEG grid rendering options */
export interface StaticGridRenderOptions extends CellExtractionOptions {
  /** Duration of source video in seconds (used for fallback) */
  duration: number;
}

/** Animated grid rendering options (WebP or MP4) */
export interface AnimatedGridRenderOptions extends StaticGridRenderOptions {
  /** Duration in seconds of each cell's animation clip */
  animDuration: number;
  /** Output frame rate of the animated output */
  animFps: number;
  /** WebP compression method (0-6) - used when format is webp */
  webpMethod: number;
  /** WebP output quality (5-100) - used when format is webp */
  webpQuality: number;
  /** Output format: "webp" or "mp4" */
  format: "webp" | "mp4";
}

/**
 * Sequence mode rendering options.
 * In sequence mode, the grid is always 1 cell wide (full width).
 * Frames are extracted sequentially and composed into an animated WebP
 * (or MP4) with the specified number of segments.
 */
export interface SequenceRenderOptions extends StaticGridRenderOptions {
  /** Number of sequential segments (frames) to extract */
  segments: number;
  /**
   * Controls how segments are rendered.
   * "static" = one frame per segment repeated for the duration.
   * "video" = advances playback frame-by-frame during each segment.
   * "video_with_audio" = uses FFmpeg to cut/merge segments preserving audio.
   */
  sequenceMode: "static" | "video" | "video_with_audio";
  /** Duration in seconds of each segment display */
  animDuration: number;
  /** Output frame rate of the animated output */
  animFps: number;
  /** WebP compression method (0-6) - used when format is webp */
  webpMethod: number;
  /** WebP output quality (5-100) - used when format is webp */
  webpQuality: number;
  /** Output format: "webp" or "mp4" */
  format: "webp" | "mp4";
}

/**
 * Gallery mode rendering options.
 * Captures individual JPEG frames at specified timestamps.
 */
export interface GalleryRenderOptions {
  /** Output canvas width in pixels (used when originalResolution is false) */
  width: number;
  /** Number of frames to capture */
  count: number;
  /** Position of the timecode overlay on each cell */
  tcPosition: Position;
  /** Background color of the canvas (hex string) */
  bgColor: string;
  /** Color of timecode text (hex string) */
  textColor: string;
  /** 360° VR cropping mode */
  vrMode: VrMode;
  /** Font family for timecode overlay text */
  fontFamily: string;
  /** When true, timecode font size scales with canvas width */
  tcFontSizeAuto: boolean;
  /** Explicit timecode font size in pixels */
  tcFontSize: number;
  /** Duration of source video in seconds */
  duration: number;
  /** When true, use full native video resolution */
  originalResolution: boolean;
  /** User-supplied timestamps, or undefined for auto-spaced */
  customTimestamps: number[] | undefined;
}

/** Return type for grid rendering methods */
export interface GridRenderOutput {
  /** Suggested file name for the rendered output */
  outputName: string;
  /** Size of the rendered output blob in bytes */
  outputSize: number;
  /** Binary blob of the final rendered image (JPEG or WebP) */
  outputBlob: Blob;
}

/** Callback for static grid cell progress */
export type StaticCellCallback = (
  cellIndex: number,
  totalCells: number,
  timestampSec: number,
) => void;

/** Callback for animated grid cell progress */
export type AnimatedCellCallback = (
  composedCell: number,
  totalCells: number,
) => void;

/** Callback for animated grid encoding progress with phase information */
export type EncodeProgressCallback = (data: {
  /** Overall progress ratio 0→1 */
  ratio: number;
  /** Current phase description (e.g. "writing frames", "encoding MP4") */
  phase: string;
}) => void;

/** Callback for sequence segment progress */
export type SequenceSegmentCallback = (
  segmentIndex: number,
  totalSegments: number,
  timestampSec: number,
) => void;

/** Callback for gallery frame progress */
export type GalleryFrameCallback = (
  frameIndex: number,
  totalFrames: number,
  timestampSec: number,
) => void;

/** Interface for GridRenderer service */
export interface IGridRenderer {
  /**
   * Render a static JPEG contact sheet for a single video file.
   * Tries native browser seeking first, falls back to FFmpeg WASM.
   */
  renderStaticGrid(
    file: VideoSource,
    meta: VideoMetadata,
    opts: StaticGridRenderOptions,
    isCancelled: () => boolean,
    onCellDone: StaticCellCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput>;

  /**
   * Render an animated WebP contact sheet for a single video file.
   * Requires native browser video support.
   */
  renderAnimatedGrid(
    file: VideoSource,
    meta: VideoMetadata,
    opts: AnimatedGridRenderOptions,
    isCancelled: () => boolean,
    onCellDone: AnimatedCellCallback,
    onEncodeProgress: EncodeProgressCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput>;

  /**
   * Render a sequence-mode animated output (single full-width cell per segment).
   * Extracts frames sequentially and composes them into an animated WebP or MP4.
   */
  renderSequence(
    file: VideoSource,
    meta: VideoMetadata,
    opts: SequenceRenderOptions,
    isCancelled: () => boolean,
    onSegmentDone: SequenceSegmentCallback,
    onEncodeProgress: EncodeProgressCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput>;

  /**
   * Render individual JPEG frames for Gallery mode output.
   * Returns an array of {blob, filename} pairs.
   */
  renderGallery(
    file: VideoSource,
    meta: VideoMetadata,
    opts: GalleryRenderOptions,
    isCancelled: () => boolean,
    onFrameDone: GalleryFrameCallback,
    onWarning: WarningCallback,
  ): Promise<{ blob: Blob; filename: string }[]>;

  /** Release resources (async to clean up cached FFmpeg virtual filesystem files) */
  destroy(): Promise<void>;
}
