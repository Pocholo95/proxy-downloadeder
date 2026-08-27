/**
 * GridRenderer Service - encapsulates all grid rendering logic.
 *
 * Depends on IFFmpegService for frame extraction and WebP encoding.
 * Uses gridUtils for layout, headers, VR cropping, and canvas operations.
 */

import type { IFFmpegService, IGridRenderer } from "../types/service";
import type {
  StaticGridRenderOptions,
  AnimatedGridRenderOptions,
  SequenceRenderOptions,
  GridRenderOutput,
  StaticCellCallback,
  AnimatedCellCallback,
  EncodeProgressCallback,
  WarningCallback,
  SequenceSegmentCallback,
  GalleryRenderOptions,
  GalleryFrameCallback,
} from "../types/service";
import type { VideoMetadata, VideoSource, VrMode } from "../types";
import {
  calculateSampleTimes,
  drawErrorPlaceholder,
  drawTimecodeOverlay,
  getEffectiveDimensions,
  getGridLayout,
  getVrCropRect,
  prepareHeader,
  resolveTimestamps,
  seekVideo,
  setupVideoDecoder,
} from "../gridUtils";
import { errlog, formatTime, log, warn, withoutExtension } from "../utils";
import { JPEG_QUALITY } from "@/constants";

/** Returns true if the error looks like an out-of-memory condition. */
const isMemoryError = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  if (isAbortError(e)) return false;
  return /out.of.bounds|memory|unreachable|OOM|heap/i.test(msg);
};

/** Returns true if the error is an abort/cancellation error. */
const isAbortError = (e: unknown): boolean => {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /abort/i.test(msg);
};

/** Floor below which JPEG output looks bad enough that it's not worth going lower. */
const MIN_JPEG_QUALITY = 0.35;
/** Floor below which WebP output looks bad enough that it's not worth going lower. */
const MIN_WEBP_QUALITY = 20;
/** Bounded so a big source (many frames) doesn't re-run ffmpeg encode too many times. */
const MAX_FIT_ATTEMPTS = 6;

/**
 * Binary-searches the highest `quality` in [minQuality, startQuality] for
 * which `encode(quality)` produces a blob ≤ targetBytes. `encode` is called
 * at most `maxAttempts + 1` times. Used to fit both the static JPEG grid
 * (cheap: re-encodes the same already-composed canvas) and the animated
 * WebP grid (more expensive: re-runs ffmpeg over already-written frames,
 * hence the lower attempt cap applied by callers).
 *
 * Returns the best blob found and whether it actually got under the target
 * -- when even `minQuality` doesn't fit, the caller should warn the user
 * rather than pretend it succeeded.
 */
async function fitEncodeToSize(
  encode: (quality: number) => Promise<Blob>,
  targetBytes: number,
  startQuality: number,
  minQuality: number,
  maxAttempts: number,
): Promise<{ blob: Blob; quality: number; underLimit: boolean }> {
  const floorBlob = await encode(minQuality);
  if (floorBlob.size > targetBytes) {
    return { blob: floorBlob, quality: minQuality, underLimit: false };
  }

  let bestBlob = floorBlob;
  let bestQuality = minQuality;
  let lo = minQuality;
  let hi = startQuality;

  for (let i = 0; i < maxAttempts && hi - lo > 0.001 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    const blob = await encode(mid);
    if (blob.size <= targetBytes) {
      bestBlob = blob;
      bestQuality = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { blob: bestBlob, quality: bestQuality, underLimit: true };
}

/** - GridRenderer Implementation */

export class GridRenderer implements IGridRenderer {
  private readonly ffmpeg: IFFmpegService;

  /**
   * Cache to avoid re-uploading the same video file to FFmpeg's virtual
   * filesystem for every frame extraction.
   */
  private _inputFileCache: { key: string } | null = null;

  public constructor(ffmpegService: IFFmpegService) {
    this.ffmpeg = ffmpegService;
  }

  /** - Static JPEG Grid */

  public async renderStaticGrid(
    file: VideoSource,
    meta: VideoMetadata,
    opts: StaticGridRenderOptions,
    isCancelled: () => boolean,
    onCellDone: StaticCellCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput> {
    const duration = Math.max(1, meta.duration || 1);
    const vrActive = opts.vrMode !== "disabled";

    const { headerCanvas, headerHeight } = prepareHeader(opts, file, meta);

    const layoutOpts = {
      width: opts.width,
      cols: opts.cols,
      rows: opts.rows,
      spacing: opts.spacing,
      gridTemplate: opts.gridTemplate,
      vrMode: opts.vrMode,
    };

    const { cellSlots, canvasWidth, canvasHeight } = getGridLayout(
      layoutOpts,
      meta,
      headerHeight,
    );
    const totalCells = cellSlots.length;

    const times =
      opts.customTimestamps && opts.customTimestamps.length > 0
        ? resolveTimestamps(opts.customTimestamps, totalCells, duration)
        : calculateSampleTimes(totalCells, duration);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    ctx.fillStyle = opts.bgColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    if (headerCanvas) {
      ctx.drawImage(headerCanvas, 0, 0);
    }

    const decoder = await setupVideoDecoder(file, meta, onWarning);
    const video = decoder.video;
    const videoCleanup = decoder.videoCleanup;
    let canNativelyPlay = decoder.canNativelyPlay;

    let ffmpegFailedFrames = 0;
    const extractOneFFmpegFrame = async (
      index: number,
      timestamp: number,
      targetW: number,
      targetH: number,
    ): Promise<ImageBitmap | null> => {
      log(
        `  Switching to FFmpeg frame-by-frame extraction ` +
          `for cell ${index + 1}/${totalCells}…`,
      );
      const bitmap = await this.extractFrameViaFFmpeg(
        file,
        timestamp,
        isCancelled,
        targetW,
        targetH,
        meta.rotation,
      );
      if (!bitmap) {
        ffmpegFailedFrames++;
        onWarning(`FFmpeg frame ${index + 1}/${totalCells} failed to decode`);
        if (ffmpegFailedFrames > 2) {
          throw new Error(
            "FFmpeg decoding failed repeatedly — " +
              "likely OOM or unsupported codec.",
          );
        }
      }
      return bitmap;
    };

    for (let i = 0; i < times.length; i++) {
      if (isCancelled()) {
        throw new DOMException("Processing cancelled", "AbortError");
      }
      const tSec = times[i];
      const { x, y, cellW, cellH } = cellSlots[i];

      log(
        `  Cell ${i + 1}/${totalCells} — ` +
          `t=${tSec.toFixed(3)}s (${formatTime(tSec)}) ` +
          `from "${file.name}"`,
      );

      let cellDrawn = false;

      if (canNativelyPlay) {
        try {
          await seekVideo(video, tSec);
          if (vrActive) {
            const vw = video.videoWidth || meta.width;
            const vh = video.videoHeight || meta.height;
            const { sx, sy, sw, sh } = getVrCropRect(
              vw,
              vh,
              opts.vrMode as Exclude<VrMode, "disabled">,
            );
            ctx.drawImage(video, sx, sy, sw, sh, x, y, cellW, cellH);
          } else {
            ctx.drawImage(video, x, y, cellW, cellH);
          }
          cellDrawn = true;
        } catch (seekErr) {
          const msg =
            seekErr instanceof Error ? seekErr.message : String(seekErr);
          warn(`  Native seek failed at cell ${i + 1}: ${msg}`);
          onWarning(
            `Native seek failed at cell ${i + 1} (${msg}) ` +
              `— switching to FFmpeg`,
          );
          canNativelyPlay = false;
        }
      }

      if (!canNativelyPlay) {
        try {
          const bitmap = await extractOneFFmpegFrame(i, tSec, cellW, cellH);
          if (bitmap) {
            if (vrActive) {
              const { sx, sy, sw, sh } = getVrCropRect(
                bitmap.width,
                bitmap.height,
                opts.vrMode as Exclude<VrMode, "disabled">,
              );
              ctx.drawImage(bitmap, sx, sy, sw, sh, x, y, cellW, cellH);
            } else {
              ctx.drawImage(bitmap, x, y, cellW, cellH);
            }
            bitmap.close();
            cellDrawn = true;
          } else {
            onWarning(
              `FFmpeg returned no image for cell ${i + 1} ` +
                `— cell left blank`,
            );
          }
        } catch (ffErr) {
          if (isAbortError(ffErr)) {
            errlog(`  FFmpeg cell ${i + 1} aborted (propagating):`, ffErr);
            throw ffErr;
          }
          const msg = ffErr instanceof Error ? ffErr.message : String(ffErr);
          errlog(`  FFmpeg cell ${i + 1} error:`, msg);
          onWarning(`FFmpeg error at cell ${i + 1}: ${msg}`);
          if (isMemoryError(ffErr)) {
            onWarning(
              `Out of memory at cell ${i + 1}. ` +
                `Try reducing output width, columns, or rows.`,
            );
          }
        }
      }

      if (!cellDrawn) {
        drawErrorPlaceholder(ctx, x, y, cellW, cellH, opts.bgColor);
      }

      drawTimecodeOverlay(
        ctx,
        tSec,
        x,
        y,
        cellW,
        cellH,
        canvasWidth,
        opts.tcPosition,
        opts.bgColor,
        opts.textColor,
        opts.fontFamily,
        opts.tcFontSizeAuto,
        opts.tcFontSize,
      );

      onCellDone(i + 1, totalCells, tSec);
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    videoCleanup();
    await this.ffmpeg.reset();

    const outputName = `${file.name}.jpg`;
    const encodeJpeg = (quality: number): Promise<Blob> =>
      new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b ?? new Blob()), "image/jpeg", quality);
      });

    let jpgBlob = await encodeJpeg(JPEG_QUALITY);
    if (opts.maxFileSizeBytes && jpgBlob.size > opts.maxFileSizeBytes) {
      const fit = await fitEncodeToSize(
        encodeJpeg,
        opts.maxFileSizeBytes,
        JPEG_QUALITY,
        MIN_JPEG_QUALITY,
        MAX_FIT_ATTEMPTS,
      );
      jpgBlob = fit.blob;
      if (!fit.underLimit) {
        onWarning(
          `Could not get under ${(opts.maxFileSizeBytes / 1_000_000).toFixed(0)}MB ` +
            `even at the lowest quality (${Math.round(fit.quality * 100)}%) — ` +
            `result: ${(jpgBlob.size / 1_000_000).toFixed(1)}MB. ` +
            `Reduce width, columns, or rows to shrink it further.`,
        );
      }
    }
    canvas.width = 0;
    canvas.height = 0;
    return { outputName, outputSize: jpgBlob.size, outputBlob: jpgBlob };
  }

  /** - Animated WebP Grid */

  public async renderAnimatedGrid(
    file: VideoSource,
    meta: VideoMetadata,
    opts: AnimatedGridRenderOptions,
    isCancelled: () => boolean,
    onCellDone: AnimatedCellCallback,
    onEncodeProgress: EncodeProgressCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput> {
    const duration = Math.max(1, meta.duration || 1);
    const vrActive = opts.vrMode !== "disabled";

    const { headerCanvas, headerHeight } = prepareHeader(opts, file, meta);

    const layoutOpts = {
      width: opts.width,
      cols: opts.cols,
      rows: opts.rows,
      spacing: opts.spacing,
      gridTemplate: opts.gridTemplate,
      vrMode: opts.vrMode,
    };

    const { cellSlots, canvasWidth, canvasHeight } = getGridLayout(
      layoutOpts,
      meta,
      headerHeight,
    );
    const totalCells = cellSlots.length;

    const totalAnimFrames = Math.max(
      1,
      Math.ceil(opts.animDuration * opts.animFps),
    );
    const frameDuration = 1 / opts.animFps;

    const baseTimes =
      opts.customTimestamps && opts.customTimestamps.length > 0
        ? resolveTimestamps(opts.customTimestamps, totalCells, duration)
        : calculateSampleTimes(totalCells, duration);

    const decoder = await setupVideoDecoder(file, meta, onWarning);
    const video = decoder.video;
    const videoCleanup = decoder.videoCleanup;

    if (!decoder.canNativelyPlay) {
      videoCleanup();
      throw new Error(
        "Animated WebP mode requires native browser video support. " +
          "This format is not natively decodable — " +
          "FFmpeg fallback is unavailable for animated output. " +
          "Disable animated mode to use the FFmpeg fallback " +
          "for static JPEG generation.",
      );
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    const frameNames: string[] = [];
    let framesWritten = 0;

    try {
      for (let f = 0; f < totalAnimFrames; f++) {
        if (isCancelled()) {
          throw new DOMException("Processing cancelled", "AbortError");
        }

        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        ctx.fillStyle = opts.bgColor;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        if (headerCanvas) {
          ctx.drawImage(headerCanvas, 0, 0);
        }

        for (let i = 0; i < totalCells; i++) {
          const tSec = Math.min(
            baseTimes[i] + f * frameDuration,
            duration - 0.001,
          );
          const { x, y, cellW, cellH } = cellSlots[i];

          log(
            `  [AnimWebP] Anim frame ${f + 1}/${totalAnimFrames}, ` +
              `cell ${i + 1}/${totalCells} @ t=${formatTime(tSec)}s`,
          );

          try {
            await seekVideo(video, tSec);
            if (vrActive) {
              const vw = video.videoWidth || meta.width;
              const vh = video.videoHeight || meta.height;
              const { sx, sy, sw, sh } = getVrCropRect(
                vw,
                vh,
                opts.vrMode as Exclude<VrMode, "disabled">,
              );
              ctx.drawImage(video, sx, sy, sw, sh, x, y, cellW, cellH);
            } else {
              ctx.drawImage(video, x, y, cellW, cellH);
            }
          } catch (seekErr) {
            const msg =
              seekErr instanceof Error ? seekErr.message : String(seekErr);
            errlog(
              `  [AnimWebP] seek failed — ` +
                `anim frame ${f + 1}, cell ${i + 1}:`,
              msg,
            );
            onWarning(
              `Seek failed at animation frame ${f + 1}, ` +
                `cell ${i + 1}: ${msg}`,
            );
            drawErrorPlaceholder(ctx, x, y, cellW, cellH, opts.bgColor);
          }

          drawTimecodeOverlay(
            ctx,
            tSec,
            x,
            y,
            cellW,
            cellH,
            canvasWidth,
            opts.tcPosition,
            opts.bgColor,
            opts.textColor,
            opts.fontFamily,
            opts.tcFontSizeAuto,
            opts.tcFontSize,
          );
        }

        const frameBlob = await new Promise<Blob>((resolve) => {
          canvas.toBlob((b) => resolve(b ?? new Blob()), "image/png");
        });
        const name = `anim_${String(f).padStart(5, "0")}.png`;
        frameNames.push(name);
        await this.ffmpeg.writeData(
          name,
          new Uint8Array(await frameBlob.arrayBuffer()),
        );
        framesWritten++;

        canvas.width = 0;
        canvas.height = 0;

        onCellDone(f + 1, totalAnimFrames);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    } finally {
      videoCleanup();
    }

    if (isCancelled() || framesWritten === 0) {
      for (const name of frameNames) {
        try {
          await this.ffmpeg.deleteFile(name);
        } catch {
          /* ignore cleanup errors */
        }
      }
      throw new DOMException(
        "Processing cancelled before any frames were composed.",
        "AbortError",
      );
    }

    log(
      `  [AnimGrid] Compositing done (${framesWritten} frames ` +
        `written to FS). Starting FFmpeg video encoding…`,
    );

    onEncodeProgress({ ratio: 0, phase: "writing frames" });

    let outputBlob: Blob;
    let outputExt: string;

    const encodePhase =
      opts.format === "mp4" ? "encoding MP4" : "encoding WebP";

    if (opts.format === "mp4") {
      outputBlob = await this.encodeMp4FromFS(
        frameNames,
        framesWritten,
        opts.animFps,
        isCancelled,
        (ratio) => onEncodeProgress({ ratio, phase: encodePhase }),
      );
      outputExt = "mp4";
    } else if (opts.maxFileSizeBytes) {
      const fit = await this.fitAnimatedWebPToSize(
        frameNames,
        framesWritten,
        opts.animFps,
        opts.webpQuality,
        opts.webpMethod,
        opts.maxFileSizeBytes,
        isCancelled,
        (ratio) => onEncodeProgress({ ratio, phase: encodePhase }),
      );
      outputBlob = fit.blob;
      if (!fit.underLimit) {
        onWarning(
          `Could not get under ${(opts.maxFileSizeBytes / 1_000_000).toFixed(0)}MB ` +
            `even at the lowest WebP quality (${fit.quality}%) — ` +
            `result: ${(fit.blob.size / 1_000_000).toFixed(1)}MB. ` +
            `Reduce width, columns/rows, or animation duration to shrink it further.`,
        );
      }
      outputExt = "webp";
    } else {
      outputBlob = await this.encodeAnimatedWebPFromFS(
        frameNames,
        framesWritten,
        opts.animFps,
        opts.webpQuality,
        opts.webpMethod,
        isCancelled,
        (ratio) => onEncodeProgress({ ratio, phase: encodePhase }),
      );
      outputExt = "webp";
    }

    return {
      outputName: `${file.name}.${outputExt}`,
      outputSize: outputBlob.size,
      outputBlob,
    };
  }

  /** - Sequence Mode */

  public async renderSequence(
    file: VideoSource,
    meta: VideoMetadata,
    opts: SequenceRenderOptions,
    isCancelled: () => boolean,
    onSegmentDone: SequenceSegmentCallback,
    onEncodeProgress: EncodeProgressCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput> {
    const duration = Math.max(1, meta.duration || 1);
    const vrActive = opts.vrMode !== "disabled";
    const segments = opts.segments;

    /* In sequence mode, grid is always 1 cell (full width). */
    const layoutOpts = {
      width: opts.width,
      cols: 1,
      rows: 1,
      spacing: 0,
      gridTemplate: undefined,
      vrMode: opts.vrMode,
    };

    const { headerCanvas, headerHeight } = prepareHeader(opts, file, meta);

    const { cellSlots, canvasWidth, canvasHeight } = getGridLayout(
      layoutOpts,
      meta,
      headerHeight,
    );
    const { x, y, cellW, cellH } = cellSlots[0];

    /*
     * Use custom timestamps from the Timestamp Editor if provided,
     * otherwise calculate evenly-spaced timestamps across the video duration.
     */
    const timestamps =
      opts.customTimestamps && opts.customTimestamps.length > 0
        ? resolveTimestamps(
            opts.customTimestamps,
            opts.customTimestamps.length,
            duration,
          )
        : calculateSampleTimes(segments, duration);

    /* Each segment is displayed for animDuration seconds at animFps fps. */
    const framesPerSegment = Math.max(
      1,
      Math.ceil(opts.animDuration * opts.animFps),
    );
    const frameDuration = 1 / opts.animFps;
    /* Dispatch to video_with_audio pipeline when selected. */
    if (opts.sequenceMode === "video_with_audio") {
      return this.renderSequenceWithAudio(
        file,
        meta,
        opts,
        isCancelled,
        onSegmentDone,
        onEncodeProgress,
        onWarning,
      );
    }

    const isVideoMode = opts.sequenceMode === "video";

    const decoder = await setupVideoDecoder(file, meta, onWarning);
    const video = decoder.video;
    const videoCleanup = decoder.videoCleanup;

    if (!decoder.canNativelyPlay) {
      videoCleanup();
      throw new Error(
        "Sequence mode requires native browser video support. " +
          "This format is not natively decodable — " +
          "FFmpeg fallback is unavailable for animated output.",
      );
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    const frameNames: string[] = [];
    let framesWritten = 0;

    /* When custom timestamps are provided, use their count as the segment count. */
    const actualSegments = timestamps.length;

    try {
      let globalFrameIdx = 0;
      for (let seg = 0; seg < actualSegments; seg++) {
        if (isCancelled()) {
          throw new DOMException("Processing cancelled", "AbortError");
        }

        const segStart = timestamps[seg];

        /* Render `framesPerSegment` frames for this segment. */
        for (let f = 0; f < framesPerSegment; f++) {
          /*
           * In video mode, advance the seek time frame-by-frame so the video
           * plays through the segment duration. In static mode, always seek to
           * the segment start time so the same frame is held.
           */
          const tSec = isVideoMode
            ? Math.min(segStart + f * frameDuration, duration - 0.001)
            : segStart;

          /* Seek to the target timestamp. */
          try {
            await seekVideo(video, tSec);
          } catch (seekErr) {
            const msg =
              seekErr instanceof Error ? seekErr.message : String(seekErr);
            errlog(`  [Sequence] seek failed at segment ${seg + 1}:`, msg);
            onWarning(`Seek failed at segment ${seg + 1}: ${msg}`);
          }

          canvas.width = canvasWidth;
          canvas.height = canvasHeight;
          ctx.fillStyle = opts.bgColor;
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
          if (headerCanvas) {
            ctx.drawImage(headerCanvas, 0, 0);
          }

          /* Draw the video frame. */
          try {
            if (vrActive) {
              const vw = video.videoWidth || meta.width;
              const vh = video.videoHeight || meta.height;
              const { sx, sy, sw, sh } = getVrCropRect(
                vw,
                vh,
                opts.vrMode as Exclude<VrMode, "disabled">,
              );
              ctx.drawImage(video, sx, sy, sw, sh, x, y, cellW, cellH);
            } else {
              ctx.drawImage(video, x, y, cellW, cellH);
            }
          } catch (drawErr) {
            const msg =
              drawErr instanceof Error ? drawErr.message : String(drawErr);
            errlog(
              `  [Sequence] draw failed at frame ${globalFrameIdx + 1}:`,
              msg,
            );
            onWarning(`Draw failed at frame ${globalFrameIdx + 1}: ${msg}`);
            drawErrorPlaceholder(ctx, x, y, cellW, cellH, opts.bgColor);
          }

          /* Draw timecode overlay. */
          drawTimecodeOverlay(
            ctx,
            tSec,
            x,
            y,
            cellW,
            cellH,
            canvasWidth,
            opts.tcPosition,
            opts.bgColor,
            opts.textColor,
            opts.fontFamily,
            opts.tcFontSizeAuto,
            opts.tcFontSize,
          );

          /* Write frame to FFmpeg FS. */
          const frameBlob = await new Promise<Blob>((resolve) => {
            canvas.toBlob((b) => resolve(b ?? new Blob()), "image/png");
          });
          const name = `seq_${String(globalFrameIdx).padStart(5, "0")}.png`;
          frameNames.push(name);
          await this.ffmpeg.writeData(
            name,
            new Uint8Array(await frameBlob.arrayBuffer()),
          );
          framesWritten++;
          globalFrameIdx++;

          canvas.width = 0;
          canvas.height = 0;
        }

        /* Report segment progress. */
        onSegmentDone(seg + 1, actualSegments, segStart);
        log(
          `  [Sequence] Segment ${seg + 1}/${actualSegments} completed ` +
            `@ t=${formatTime(segStart)}s`,
        );
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    } finally {
      videoCleanup();
    }

    if (isCancelled() || framesWritten === 0) {
      for (const name of frameNames) {
        try {
          await this.ffmpeg.deleteFile(name);
        } catch {
          /* ignore cleanup errors */
        }
      }
      throw new DOMException(
        "Processing cancelled before any frames were composed.",
        "AbortError",
      );
    }

    log(
      `  [Sequence] Compositing done (${framesWritten} frames ` +
        `written to FS). Starting FFmpeg encode…`,
    );

    onEncodeProgress({ ratio: 0, phase: "writing frames" });

    /* Encode based on format. */
    let outputBlob: Blob;
    let outputName: string;

    const seqEncodePhase =
      opts.format === "mp4" ? "encoding MP4" : "encoding WebP";

    if (opts.format === "mp4") {
      outputBlob = await this.encodeMp4FromFS(
        frameNames,
        framesWritten,
        opts.animFps,
        isCancelled,
        (ratio) => onEncodeProgress({ ratio, phase: seqEncodePhase }),
      );
      outputName = `${file.name}.mp4`;
    } else {
      outputBlob = await this.encodeAnimatedWebPFromFS(
        frameNames,
        framesWritten,
        opts.animFps,
        opts.webpQuality,
        opts.webpMethod,
        isCancelled,
        (ratio) => onEncodeProgress({ ratio, phase: seqEncodePhase }),
      );
      outputName = `${file.name}.webp`;
    }

    return { outputName, outputSize: outputBlob.size, outputBlob };
  }

  /**
   * Sequence mode with audio: cuts segments by timestamps with scaling,
   * preserves audio tracks, and merges them into a single MP4.
   * Header/timecode overlays are disabled in this mode.
   *
   * Uses per-segment cuts (not filter_complex) because the FFmpeg WASM
   * build (5.1.4) crashes on complex filter graphs with trim+concat.
   * Scaling is applied via -vf scale for optimized output resolution.
   */
  private async renderSequenceWithAudio(
    file: VideoSource,
    meta: VideoMetadata,
    opts: SequenceRenderOptions,
    isCancelled: () => boolean,
    _onSegmentDone: SequenceSegmentCallback,
    onEncodeProgress: EncodeProgressCallback,
    onWarning: WarningCallback,
  ): Promise<GridRenderOutput> {
    /*
     * Reset FFmpeg WASM instance for a clean virtual FS and clear the input
     * file cache so the file is re-written to the fresh FFmpeg filesystem.
     */
    onEncodeProgress({ ratio: 0, phase: "preparing FFmpeg…" });
    await this.ffmpeg.reset();
    await this.ffmpeg.reinit();
    this._inputFileCache = null;
    this.ffmpeg.appendLog("[FFmpeg WASM] FFmpeg initialized");

    const duration = Math.max(1, meta.duration || 1);
    const segments = opts.segments;

    /*
     * Use custom timestamps from the Timestamp Editor if provided,
     * otherwise calculate evenly-spaced timestamps across the video duration.
     */
    const timestamps =
      opts.customTimestamps && opts.customTimestamps.length > 0
        ? resolveTimestamps(
            opts.customTimestamps,
            opts.customTimestamps.length,
            duration,
          )
        : calculateSampleTimes(segments, duration);

    const actualSegments = timestamps.length;

    /* Ensure input file is in FFmpeg FS. */
    onEncodeProgress({ ratio: 0, phase: "writing input file…" });
    await this._ensureInputFileInFs(file);
    this.ffmpeg.appendLog(
      `[FFmpeg WASM] Writing "${file.name}" (${file.size.toLocaleString()} bytes) into FFmpeg FS…`,
    );
    this.ffmpeg.appendLog("[FFmpeg WASM] FS write complete.");

    /*
     * Each segment extracts `animDuration` seconds of video starting from
     * its timestamp.
     */
    const segDuration = Math.max(0.1, opts.animDuration);

    /*
     * Compute target resolution: scale to fit opts.width while preserving
     * aspect ratio. This significantly reduces encoding work for large
     * source videos (e.g. 4K -> 1280px wide).
     */
    // Use effective dimensions that account for video rotation metadata
    const { width: srcW, height: srcH } = getEffectiveDimensions(meta);
    const targetW = opts.width;
    const targetH = Math.round((targetW * srcH) / srcW);

    log(
      `  [SeqAudio] Scaling ${srcW}x${srcH} -> ${targetW}x${targetH} ` +
        `for ${actualSegments} segments x ${segDuration}s`,
    );

    /* Temporary segment file names for cleanup. */
    const segmentFiles: string[] = [];

    /*
     * Disable FFmpeg WASM log events during segment cutting to avoid
     * expensive JS-WASM boundary crossings that can break processing.
     */
    this.ffmpeg.setLoggingEnabled(false);
    this.ffmpeg.appendLog(
      "[FFmpeg WASM] Logging disabled during segment cutting",
    );

    try {
      /*
       * Track maximum progress reported so far. FFmpeg progress callbacks
       * can accumulate on the same instance, so a stale handler from a
       * previous segment might fire and report a lower ratio than what
       * was already shown. We guard against this by never allowing the
       * reported ratio to decrease.
       */
      let maxProgress = 0;

      for (let i = 0; i < actualSegments; i++) {
        if (isCancelled()) {
          throw new DOMException("Processing cancelled", "AbortError");
        }

        const segStart = timestamps[i];
        const segOutName = `seg_${String(i).padStart(3, "0")}.mp4`;
        segmentFiles.push(segOutName);

        /*
         * Progress for this segment spans from
         * (i / actualSegments) * 0.5 to ((i + 1) / actualSegments) * 0.5
         */
        const segProgressStart = (i / actualSegments) * 0.5;
        const segProgressEnd = ((i + 1) / actualSegments) * 0.5;
        const segProgressRange = segProgressEnd - segProgressStart;

        const segProgressHandler = ({ progress }: { progress: number }) => {
          const clamped = Math.min(Math.max(progress, 0), 1);
          const rawRatio = segProgressStart + clamped * segProgressRange;
          /* Only update if this is higher than what was already reported. */
          if (rawRatio > maxProgress) {
            maxProgress = rawRatio;
            onEncodeProgress({
              ratio: maxProgress,
              phase: `cutting segment ${i + 1}/${actualSegments}`,
            });
          }
        };
        this.ffmpeg.onProgress(segProgressHandler);

        log(
          `  [SeqAudio] Cutting segment ${i + 1}/${actualSegments} ` +
            `@ t=${formatTime(segStart)}s, duration=${segDuration.toFixed(3)}s`,
        );

        /*
         * Cut each segment with scaling and FPS reduction applied.
         * -vf transpose: apply rotation correction for portrait videos
         * -vf scale: reduce resolution to target width (saves encode time)
         * -vf fps: reduce frame rate to target FPS (saves encode time & size)
         * -r: force output frame rate for correct duration
         * -movflags +faststart: write moov atom at beginning so file is valid
         *   even if FFmpeg is interrupted (prevents "moov atom not found" errors)
         */

        // Build video filter chain: rotation + scaling + fps
        const vfFilters: string[] = [];
        if (meta.rotation === 90) vfFilters.push("transpose=1");
        else if (meta.rotation === 270) vfFilters.push("transpose=2");
        else if (meta.rotation === 180) vfFilters.push("transpose=1");
        vfFilters.push(`scale=${targetW}:${targetH}`);
        vfFilters.push(`fps=${opts.animFps}`);
        const vfChain = vfFilters.join(",");

        try {
          await this.ffmpeg.exec([
            "-loglevel",
            "warning",
            "-ss",
            String(segStart),
            "-i",
            "input.mp4",
            "-t",
            String(segDuration),
            "-vf",
            vfChain,
            "-r",
            String(opts.animFps),
            "-fps_mode",
            "cfr",
            "-c:v",
            "libx264",
            "-preset",
            "superfast",
            "-g",
            String(Math.ceil(opts.animFps)),
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-b:a",
            "128k",
            "-pix_fmt",
            "yuv420p",
            "-shortest",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            segOutName,
          ]);
        } catch (segErr) {
          this.ffmpeg.offProgress(segProgressHandler);
          const msg = segErr instanceof Error ? segErr.message : String(segErr);
          errlog(`  [SeqAudio] Segment ${i + 1} cut failed:`, msg);
          onWarning(`Segment ${i + 1} cut failed: ${msg}`);
          throw new Error(`FFmpeg segment cut failed: ${msg}`);
        }

        this.ffmpeg.offProgress(segProgressHandler);

        /*
         * Validate that the segment file was actually written and has content.
         * FFmpeg WASM can silently produce empty/corrupt files under memory
         * pressure or with certain input formats.
         */
        try {
          const segData = await this.ffmpeg.readData(segOutName);
          if (segData.length < 100) {
            throw new Error(
              `Segment ${i + 1} file is too small (${segData.length} bytes) ` +
                `— likely corrupted`,
            );
          }
          log(
            `  [SeqAudio] Segment ${i + 1} validated ` +
              `(${segData.length.toLocaleString()} bytes)`,
          );
        } catch (valErr) {
          const msg = valErr instanceof Error ? valErr.message : String(valErr);
          errlog(`  [SeqAudio] Segment ${i + 1} validation failed:`, msg);
          onWarning(`Segment ${i + 1} validation failed: ${msg}`);
          throw new Error(`Segment ${i + 1} produced invalid output: ${msg}`);
        }
        /*
         * Report segment completion progress. Do NOT call onSegmentDone here
         * because the batch processor's onSegmentDone callback maps progress
         * to 0→70% (ANIMATED_COMPOSE_PCT) while onEncodeProgress maps to
         * 70→100% (ANIMATED_ENCODE_PCT). Calling both causes the progress bar
         * to jump forward then backward as they overwrite each other.
         * For audio mode, all progress goes through onEncodeProgress only.
         */
        if (segProgressEnd > maxProgress) {
          maxProgress = segProgressEnd;
          onEncodeProgress({
            ratio: maxProgress,
            phase: `cutting segment ${i + 1}/${actualSegments}`,
          });
        }

        log(`  [SeqAudio] Segment ${i + 1}/${actualSegments} cut completed`);
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      /* Re-enable logging for merge phase. */
      this.ffmpeg.setLoggingEnabled(true);

      /*
       * Concat all segments into the final output using the concat demuxer.
       */
      const concatList = segmentFiles.map((f) => `file '${f}'`).join("\n");

      await this.ffmpeg.writeData(
        "concat_list.txt",
        new TextEncoder().encode(concatList),
      );

      const outputName = "sequence_output.mp4";

      const progressHandler = ({ progress }: { progress: number }) => {
        const rawRatio = 0.5 + Math.min(Math.max(progress, 0), 1) * 0.5;
        /* Only update if this is higher than what was already reported. */
        if (rawRatio > maxProgress) {
          maxProgress = rawRatio;
          onEncodeProgress({
            ratio: maxProgress,
            phase: "merging segments",
          });
        }
      };
      this.ffmpeg.onProgress(progressHandler);

      try {
        log(`  [SeqAudio] Merging ${actualSegments} segments into MP4…`);

        /* Segments are already encoded with libx264+yuv420p+aac. */
        await this.ffmpeg.exec([
          "-fflags",
          "+genpts",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          "concat_list.txt",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          outputName,
        ]);

        const data = await this.ffmpeg.readData(outputName);
        log(`  [SeqAudio] Merge complete.`);
        onEncodeProgress({ ratio: 1.0, phase: "merging segments" });

        try {
          await this.ffmpeg.deleteFile(outputName);
        } catch {
          /* ignore */
        }

        return {
          outputName: `${file.name}.mp4`,
          outputSize: new Blob([new Uint8Array(data)]).size,
          outputBlob: new Blob([new Uint8Array(data)], { type: "video/mp4" }),
        };
      } catch (mergeErr) {
        const msg =
          mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        errlog(`  [SeqAudio] Merge failed:`, msg);
        onWarning(`Merge failed: ${msg}`);
        throw new Error(`FFmpeg merge failed: ${msg}`);
      } finally {
        this.ffmpeg.offProgress(progressHandler);
      }
    } finally {
      /* Clean up segment files and concat list. */
      for (const name of segmentFiles) {
        try {
          await this.ffmpeg.deleteFile(name);
        } catch {
          /* ignore cleanup errors */
        }
      }
      try {
        await this.ffmpeg.deleteFile("concat_list.txt");
      } catch {
        /* ignore */
      }
    }
  }

  /** - Lifecycle */

  public async destroy(): Promise<void> {
    try {
      await this.ffmpeg.deleteFile("input.mp4");
    } catch {
      /* ignore */
    }
    this._inputFileCache = null;
  }

  /** - Private Helpers */

  private _getFileKey(file: VideoSource): string {
    return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
  }

  private async _ensureInputFileInFs(file: VideoSource): Promise<void> {
    const fileKey = this._getFileKey(file);
    if (this._inputFileCache?.key === fileKey) return;
    await this.ffmpeg.bindInputPath(file.path);
    this._inputFileCache = { key: fileKey };
  }

  private async extractFrameViaFFmpeg(
    file: VideoSource,
    timestamp: number,
    isCancelled: () => boolean,
    targetW: number,
    targetH: number,
    rotation: number | undefined,
  ): Promise<ImageBitmap | null> {
    if (isCancelled()) return null;

    await this.ffmpeg.setAbortController();
    await this._ensureInputFileInFs(file);

    const name = "frame_temp.jpg";
    const args: string[] = ["-ss", String(timestamp), "-i", "input.mp4"];

    // Build filter chain: rotation transpose + scaling
    const filters: string[] = [];

    // Apply rotation via transpose filter
    if (rotation === 90) filters.push("transpose=1");
    else if (rotation === 270) filters.push("transpose=2");
    else if (rotation === 180) filters.push("transpose=1,transpose=1");

    if (targetW && targetH) {
      filters.push(`scale=${targetW}:${targetH}`);
    }

    if (filters.length > 0) {
      args.push("-vf", filters.join(","));
    }

    args.push(
      "-update",
      "1",
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-loglevel",
      "info",
      name,
    );

    log(
      `  [FFmpeg] Single frame at t=${timestamp.toFixed(3)}s` +
        (targetW ? ` -> ${targetW}x${targetH}` : ""),
    );

    let bitmap: ImageBitmap | null = null;
    try {
      await this.ffmpeg.exec(args);

      if (isCancelled()) {
        throw new DOMException("Processing cancelled", "AbortError");
      }

      const data = await this.ffmpeg.readData(name);
      const blob = new Blob([new Uint8Array(data)], {
        type: "image/jpeg",
      });
      bitmap = await createImageBitmap(blob);

      try {
        await this.ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }

      return bitmap;
    } catch (e) {
      bitmap?.close();
      const msg = e instanceof Error ? e.message : String(e);
      errlog(`  [FFmpeg] Single frame extraction failed:`, msg);

      if (isAbortError(e)) {
        throw new Error(`FFmpeg operation aborted: ${msg}`);
      }

      try {
        await this.ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }

      return null;
    }
  }

  /**
   * Encode PNG frame sequence into an MP4 using FFmpeg (libx264).
   */
  private async encodeMp4FromFS(
    frameNames: string[],
    totalFrames: number,
    fps: number,
    isCancelled: () => boolean,
    onProgress: (ratio: number) => void,
  ): Promise<Blob> {
    if (isCancelled()) {
      log(`  [FFmpeg/MP4] Cancel requested before encoding. Cleaning up.`);
      for (const name of frameNames) {
        try {
          await this.ffmpeg.deleteFile(name);
        } catch {
          /* ignore */
        }
      }
      throw new Error("Encoding cancelled by user before encode phase.");
    }

    const outputName = "seq_output.mp4";

    const firstFrame = frameNames[0];
    const padWidth = firstFrame.match(/_(\d+)\./)?.[1]?.length || 5;
    const prefix = firstFrame.substring(
      0,
      firstFrame.indexOf(`_${"0".repeat(padWidth)}`),
    );
    const ext = firstFrame.substring(firstFrame.lastIndexOf("."));
    const inputPattern = `${prefix}_%0${padWidth}d${ext}`;

    const progressHandler = ({ progress }: { progress: number }) => {
      onProgress(Math.min(Math.max(progress, 0), 1));
    };
    this.ffmpeg.onProgress(progressHandler);

    try {
      log(
        `  [FFmpeg/MP4] Encoding ${totalFrames} frames ` +
          `at ${fps} fps with libx264…`,
      );
      log(`  [FFmpeg/MP4] Input pattern: ${inputPattern}`);

      await this.ffmpeg.exec([
        "-framerate",
        String(fps),
        "-i",
        inputPattern,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        outputName,
      ]);

      const data = await this.ffmpeg.readData(outputName);
      log(`  [FFmpeg/MP4] Encoding complete.`);
      onProgress(1.0);

      for (const name of frameNames) {
        try {
          await this.ffmpeg.deleteFile(name);
        } catch {
          /* ignore */
        }
      }
      try {
        await this.ffmpeg.deleteFile(outputName);
      } catch {
        /* ignore */
      }

      return new Blob([new Uint8Array(data)], { type: "video/mp4" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errlog(`  [FFmpeg/MP4] encode failed:`, msg);

      if (isAbortError(e)) {
        throw new Error(`FFmpeg operation aborted: ${msg}`);
      }

      throw new Error(`FFmpeg MP4 encoding failed: ${msg}`);
    } finally {
      this.ffmpeg.offProgress(progressHandler);
    }
  }

  /** - Gallery Mode */

  public async renderGallery(
    file: VideoSource,
    meta: VideoMetadata,
    opts: GalleryRenderOptions,
    isCancelled: () => boolean,
    onFrameDone: GalleryFrameCallback,
    onWarning: WarningCallback,
  ): Promise<{ blob: Blob; filename: string }[]> {
    const duration = Math.max(1, opts.duration || 1);
    const count = Math.max(1, opts.count);
    const vrActive = opts.vrMode !== "disabled";

    const times =
      opts.customTimestamps && opts.customTimestamps.length > 0
        ? resolveTimestamps(opts.customTimestamps, count, duration)
        : calculateSampleTimes(count, duration);

    const decoder = await setupVideoDecoder(file, meta, onWarning);
    const video = decoder.video;
    const videoCleanup = decoder.videoCleanup;
    let canNativelyPlay = decoder.canNativelyPlay;

    const baseName = withoutExtension(file.name);
    const results: { blob: Blob; filename: string }[] = [];

    let ffmpegFailedFrames = 0;
    const extractOneFFmpegFrame = async (
      index: number,
      timestamp: number,
      targetW: number,
      targetH: number,
    ): Promise<ImageBitmap | null> => {
      log(
        `  [Gallery] Switching to FFmpeg frame extraction ` +
          `for frame ${index + 1}/${count}…`,
      );
      const bitmap = await this.extractFrameViaFFmpeg(
        file,
        timestamp,
        isCancelled,
        targetW,
        targetH,
        meta.rotation,
      );
      if (!bitmap) {
        ffmpegFailedFrames++;
        onWarning(`FFmpeg frame ${index + 1}/${count} failed to decode`);
        if (ffmpegFailedFrames > 2) {
          throw new Error(
            "FFmpeg decoding failed repeatedly — " +
              "likely OOM or unsupported codec.",
          );
        }
      }
      return bitmap;
    };

    for (let i = 0; i < times.length; i++) {
      if (isCancelled()) {
        // Already-captured frame blobs will be garbage collected.
        throw new DOMException("Processing cancelled", "AbortError");
      }

      const tSec = times[i];
      log(
        `  [Gallery] Frame ${i + 1}/${count} — ` +
          `t=${tSec.toFixed(3)}s (${formatTime(tSec)}) ` +
          `from "${file.name}"`,
      );

      // Determine target dimensions
      let targetW: number;
      let targetH: number;
      if (opts.originalResolution) {
        targetW = meta.width;
        targetH = meta.height;
      } else {
        // Use configured width, derive height from aspect ratio
        targetW = opts.width;
        targetH = Math.round(targetW * (meta.height / meta.width));
      }

      let frameBlob: Blob | null = null;

      // Try native capture first
      if (canNativelyPlay) {
        try {
          await seekVideo(video, tSec);
          const tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = targetW;
          tmpCanvas.height = targetH;
          const tmpCtx = tmpCanvas.getContext("2d")!;
          tmpCtx.fillStyle = opts.bgColor;
          tmpCtx.fillRect(0, 0, targetW, targetH);
          if (vrActive) {
            const vw = video.videoWidth || meta.width;
            const vh = video.videoHeight || meta.height;
            const { sx, sy, sw, sh } = getVrCropRect(
              vw,
              vh,
              opts.vrMode as Exclude<VrMode, "disabled">,
            );
            tmpCtx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
          } else {
            tmpCtx.drawImage(video, 0, 0, targetW, targetH);
          }
          // Draw timecode overlay
          if (opts.tcPosition !== "disabled") {
            drawTimecodeOverlay(
              tmpCtx,
              tSec,
              0,
              0,
              targetW,
              targetH,
              targetW,
              opts.tcPosition,
              opts.bgColor,
              opts.textColor,
              opts.fontFamily,
              opts.tcFontSizeAuto,
              opts.tcFontSize,
            );
          }
          const dataUrl = tmpCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
          const resp = await fetch(dataUrl);
          frameBlob = await resp.blob();
        } catch (seekErr) {
          const msg =
            seekErr instanceof Error ? seekErr.message : String(seekErr);
          warn(`  [Gallery] Native seek failed at frame ${i + 1}: ${msg}`);
          onWarning(
            `Native seek failed at frame ${i + 1} (${msg}) ` +
              `— switching to FFmpeg`,
          );
          canNativelyPlay = false;
        }
      }

      // FFmpeg fallback
      if (!frameBlob && !canNativelyPlay) {
        try {
          const bitmap = await extractOneFFmpegFrame(i, tSec, targetW, targetH);
          if (bitmap) {
            const tmpCanvas = document.createElement("canvas");
            tmpCanvas.width = targetW;
            tmpCanvas.height = targetH;
            const tmpCtx = tmpCanvas.getContext("2d")!;
            tmpCtx.fillStyle = opts.bgColor;
            tmpCtx.fillRect(0, 0, targetW, targetH);
            if (vrActive) {
              const { sx, sy, sw, sh } = getVrCropRect(
                bitmap.width,
                bitmap.height,
                opts.vrMode as Exclude<VrMode, "disabled">,
              );
              tmpCtx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
            } else {
              tmpCtx.drawImage(bitmap, 0, 0, targetW, targetH);
            }
            bitmap.close();
            // Draw timecode overlay
            if (opts.tcPosition !== "disabled") {
              drawTimecodeOverlay(
                tmpCtx,
                tSec,
                0,
                0,
                targetW,
                targetH,
                targetW,
                opts.tcPosition,
                opts.bgColor,
                opts.textColor,
                opts.fontFamily,
                opts.tcFontSizeAuto,
                opts.tcFontSize,
              );
            }
            const dataUrl = tmpCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
            const resp = await fetch(dataUrl);
            frameBlob = await resp.blob();
          } else {
            onWarning(
              `FFmpeg returned no image for frame ${i + 1} ` +
                `— frame skipped`,
            );
          }
        } catch (ffErr) {
          const msg = ffErr instanceof Error ? ffErr.message : String(ffErr);
          errlog(
            `  [Gallery] FFmpeg extraction failed at frame ${i + 1}:`,
            msg,
          );
          onWarning(`FFmpeg extraction failed at frame ${i + 1} (${msg})`);
        }
      }

      if (frameBlob) {
        const frameNum = String(i + 1).padStart(3, "0");
        const filename = `${baseName}_${frameNum}.jpg`;
        results.push({ blob: frameBlob, filename });
        onFrameDone(i, count, tSec);
      }
    }

    videoCleanup();
    log(`  [Gallery] Complete: ${results.length}/${count} frames captured`);
    return results;
  }

  /**
   * Encodes the already-written frame sequence into a single WebP blob at
   * the given quality, WITHOUT deleting the source frame files -- so a
   * caller fitting to a size target can call this again at a different
   * quality without re-extracting/re-composing anything.
   */
  private async encodeAnimatedWebPOnce(
    frameNames: string[],
    totalFrames: number,
    fps: number,
    quality: number,
    method: number,
    isCancelled: () => boolean,
    onProgress: (ratio: number) => void,
  ): Promise<Blob> {
    if (isCancelled()) {
      log(
        `  [FFmpeg/AnimWebP] Cancel requested before ` +
          `encoding. Cleaning up.`,
      );
      for (const name of frameNames) {
        try {
          await this.ffmpeg.deleteFile(name);
        } catch {
          /* ignore */
        }
      }
      throw new Error("Encoding cancelled by user before encode phase.");
    }

    const outputName = "anim_output.webp";

    const firstFrame = frameNames[0];
    const padWidth = firstFrame.match(/_(\d+)\./)?.[1]?.length || 5;
    const prefix = firstFrame.substring(
      0,
      firstFrame.indexOf(`_${"0".repeat(padWidth)}`),
    );
    const ext = firstFrame.substring(firstFrame.lastIndexOf("."));
    const inputPattern = `${prefix}_%0${padWidth}d${ext}`;

    const progressHandler = ({ progress }: { progress: number }) => {
      onProgress(Math.min(Math.max(progress, 0), 1));
    };
    this.ffmpeg.onProgress(progressHandler);

    try {
      log(
        `  [FFmpeg/AnimWebP] Encoding ${totalFrames} frames ` +
          `at ${fps} fps, quality=${quality}, method=${method}…`,
      );
      log(`  [FFmpeg/AnimWebP] Input pattern: ${inputPattern}`);

      await this.ffmpeg.exec([
        "-framerate",
        String(fps),
        "-i",
        inputPattern,
        "-c:v",
        "libwebp",
        "-lossless",
        "0",
        "-quality",
        String(quality),
        "-method",
        String(method),
        "-loop",
        "0",
        "-an",
        outputName,
      ]);

      const data = await this.ffmpeg.readData(outputName);
      log(`  [FFmpeg/AnimWebP] Encoding complete.`);
      onProgress(1.0);

      try {
        await this.ffmpeg.deleteFile(outputName);
      } catch {
        /* ignore */
      }

      return new Blob([new Uint8Array(data)], { type: "image/webp" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errlog(`  [FFmpeg/AnimWebP] encode failed:`, msg);

      if (isAbortError(e)) {
        throw new Error(`FFmpeg operation aborted: ${msg}`);
      }

      throw new Error(`FFmpeg WebP encoding failed: ${msg}`);
    } finally {
      this.ffmpeg.offProgress(progressHandler);
    }
  }

  /** Encodes once at a fixed quality, then deletes the source frame files. Unchanged existing behavior for callers that don't need to retry at another quality. */
  private async encodeAnimatedWebPFromFS(
    frameNames: string[],
    totalFrames: number,
    fps: number,
    quality: number,
    method: number,
    isCancelled: () => boolean,
    onProgress: (ratio: number) => void,
  ): Promise<Blob> {
    const blob = await this.encodeAnimatedWebPOnce(
      frameNames,
      totalFrames,
      fps,
      quality,
      method,
      isCancelled,
      onProgress,
    );
    for (const name of frameNames) {
      try {
        await this.ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }
    return blob;
  }

  /**
   * Binary-searches WebP quality (bounded to a handful of ffmpeg re-encodes,
   * since unlike the static JPEG case each attempt re-runs a real encode
   * over the already-written frames rather than a cheap canvas re-draw) to
   * fit the animated grid under maxFileSizeBytes. Always cleans up the
   * source frame files itself once done, whichever quality was chosen.
   */
  private async fitAnimatedWebPToSize(
    frameNames: string[],
    totalFrames: number,
    fps: number,
    startQuality: number,
    method: number,
    targetBytes: number,
    isCancelled: () => boolean,
    onProgress: (ratio: number) => void,
  ): Promise<{ blob: Blob; quality: number; underLimit: boolean }> {
    const encode = (q: number): Promise<Blob> =>
      this.encodeAnimatedWebPOnce(
        frameNames,
        totalFrames,
        fps,
        Math.round(q),
        method,
        isCancelled,
        onProgress,
      );

    const fit = await fitEncodeToSize(
      encode,
      targetBytes,
      startQuality,
      MIN_WEBP_QUALITY,
      4,
    );

    for (const name of frameNames) {
      try {
        await this.ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }

    return { ...fit, quality: Math.round(fit.quality) };
  }
}

/** - Factory */

export function createGridRenderer(
  ffmpegService: IFFmpegService,
): IGridRenderer {
  return new GridRenderer(ffmpegService);
}
