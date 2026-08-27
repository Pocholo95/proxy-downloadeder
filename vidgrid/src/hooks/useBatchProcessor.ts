import { useCallback, useRef } from "react";
import {
  ANIMATED_COMPOSE_PCT,
  ANIMATED_ENCODE_PCT,
  DECODE_CONCURRENCY_CAP,
  DEFAULTS,
} from "../constants";
import type { IFFmpegService } from "../types/service";
import type { TaskItem, SavedOptions, AnimationEstimate } from "../types";
import { computeAnimationEstimate } from "../gridUtils";
import { probeMetadata } from "../services/probeMetadata";
import { nativeApi } from "../services/nativeApi";
import { NativeFfmpegService } from "../services/nativeFfmpeg.service";
import { createGridRenderer } from "../services/gridRenderer.service";
import {
  buildStaticGridOptions,
  buildAnimatedGridOptions,
  buildSequenceOptions,
  buildGalleryOptions,
} from "../gridOptions";
import {
  errlog,
  formatElapsed,
  formatTime,
  hasUsableMetadata,
  log,
  warn,
  withoutExtension,
} from "../utils";
import { useTaskStore } from "@/store/taskStore";
import {
  useProcessingStore,
  getProcessingGuard,
  setProcessingGuard,
} from "@/store/processingStore";

/**
 * True for output modes whose heavy lifting is the browser's <video>
 * element seeking (static/animated grid composition, gallery, sequence in
 * static/video render mode) rather than a real ffmpeg subprocess. Only
 * "sequence" + "video_with_audio" hands off to ffmpeg to cut segments
 * directly -- everything else seeks around in-browser to sample frames.
 */
function isDecodeHeavy(opts: SavedOptions): boolean {
  const mode = opts.outputMode ?? DEFAULTS.outputMode;
  return !(mode === "sequence" && opts.sequenceMode === "video_with_audio");
}

/** Best-effort: defaults to 1 (sequential) if the backend is unreachable. */
async function resolveConcurrency(
  itemCount: number,
  decodeHeavy: boolean,
): Promise<number> {
  let cpuCount = 1;
  try {
    cpuCount = await nativeApi.getCpuCount();
  } catch {
    /* default to sequential */
  }
  // Concurrent <video> seeks share one hardware decode pipeline in a
  // single renderer process, so high concurrency here causes contention
  // that makes each seek slower instead of giving real parallelism --
  // unlike real ffmpeg subprocesses (separate OS processes), which scale
  // with CPU cores properly.
  const cap = decodeHeavy ? Math.min(cpuCount, DECODE_CONCURRENCY_CAP) : cpuCount;
  return Math.max(1, Math.min(cap, itemCount));
}

/**
 * Hook that handles batch processing: dispatching a bounded pool of workers
 * over the queued items (sized to CPU core count for real ffmpeg-subprocess
 * modes, or a lower cap for browser-decode-heavy modes -- see
 * resolveConcurrency), each with its own NativeFfmpegService/GridRenderer
 * instance, tracking progress and handling errors/cancels.
 */
export function useBatchProcessor() {
  const cancelRef = useRef(false);
  const forceCancelledIds = useRef<Set<string>>(new Set());
  const activeFfmpegs = useRef<Map<string, IFFmpegService>>(new Map());

  const processAll = useCallback(
    async (items: TaskItem[], opts: SavedOptions) => {
      if (getProcessingGuard() || !items.length) return;

      // Set the guard and reset cancel state synchronously, before any
      // `await` below yields control back to the caller -- otherwise a
      // requestCancel() racing the output-folder dialog could be silently
      // wiped out by a later `cancelRef.current = false`.
      setProcessingGuard(true);
      useProcessingStore.getState().setIsProcessing(true);
      cancelRef.current = false;
      forceCancelledIds.current.clear();

      const concurrency = await resolveConcurrency(
        items.length,
        isDecodeHeavy(opts),
      );

      const outputMode = opts.outputMode ?? DEFAULTS.outputMode;

      let succeeded = 0;
      let errored = 0;
      let cancelled = 0;
      const batchStartTime = Date.now();

      useProcessingStore.getState().setStatus({
        text: "Starting…",
        currentPct: 0,
        batchDone: 0,
        batchTotal: items.length,
        batchStartTime,
        batchDurationMs: null,
      });

      // Dynamic queue: starts with the initial items, but new queued items
      // added during processing are picked up automatically.
      const queue: TaskItem[] = [...items];
      const queuedIds = new Set(queue.map((q) => q.id));
      let nextIdx = 0;

      /** Claims the next processable item, folding in newly-queued items and
       *  marking cancelled-while-waiting items along the way. Synchronous
       *  (no awaits) so concurrent workers can't race each other on it. */
      const claimNext = (): TaskItem | null => {
        const storeItems = useTaskStore.getState().items;
        for (const it of storeItems) {
          if (it.status === "queued" && !queuedIds.has(it.id)) {
            queue.push(it);
            queuedIds.add(it.id);
          }
        }
        while (nextIdx < queue.length) {
          const candidate = queue[nextIdx++];
          const stillExists = storeItems.find((i) => i.id === candidate.id);
          if (!stillExists) continue;
          if (candidate.status !== "queued") continue;
          if (cancelRef.current) {
            useTaskStore
              .getState()
              .updateItem(candidate.id, { status: "cancelled" });
            cancelled++;
            continue;
          }
          return candidate;
        }
        return null;
      };

      const processOneItem = async (item: TaskItem): Promise<void> => {
        const ffmpeg = new NativeFfmpegService(item.id);
        const gridRenderer = createGridRenderer(ffmpeg);
        activeFfmpegs.current.set(item.id, ffmpeg);
        useProcessingStore.getState().addActiveTask(item.id);

        const itemStartTime = Date.now();
        ffmpeg.setAbortController();
        useTaskStore.getState().updateItem(item.id, {
          status: "processing",
          error: undefined,
          processingStartedAt: itemStartTime,
          ffmpegLogs: [],
        });

        useProcessingStore.getState().setStatus((prev) => ({
          ...prev,
          text: `"${item.source.name}" — opening…`,
          currentPct: 0,
          batchDone: succeeded + errored,
          batchTotal: items.length,
          batchStartTime,
          batchDurationMs: null,
        }));

        log(`Starting "${item.source.name}"`);

        const onWarning = (message: string) => {
          useTaskStore.getState().updateItem(item.id, { warning: message });
          warn(`[${item.source.name}] ${message}`);
        };
        const isCancelled = () =>
          cancelRef.current || forceCancelledIds.current.has(item.id);

        try {
          let meta = item.metadata;
          if (!meta) {
            useProcessingStore.getState().setStatus((prev) => ({
              ...prev,
              text: `"${item.source.name}" — reading metadata…`,
            }));
            meta = await probeMetadata(item.source.path);
            useTaskStore.getState().updateItem(item.id, { metadata: meta });
          }

          if (!hasUsableMetadata(meta)) {
            throw new Error(
              "ffprobe could not determine video dimensions or duration. " +
                "The file may be corrupt or in an unrecognized format.",
            );
          }

          const gridOpts = buildStaticGridOptions(opts, item, meta);
          const animGridOpts = buildAnimatedGridOptions(opts, item, meta);
          const seqOpts = buildSequenceOptions(opts, item, meta);
          const galleryOpts = buildGalleryOptions(opts, item, meta);

          const isGallery = opts.outputMode === "gallery";

          if (isGallery) {
            /* ---- Gallery Mode ---- */
            const galleryBlobs = await gridRenderer.renderGallery(
              item.source,
              meta,
              galleryOpts,
              isCancelled,
              (frameIdx, totalFrames, tSec) => {
                useProcessingStore.getState().setStatus((prev) => ({
                  ...prev,
                  text: `"${item.source.name}" — frame ${frameIdx}/${totalFrames} @ ${formatTime(tSec)}`,
                  currentPct: ((frameIdx - 1) / totalFrames) * 100,
                  batchDone: succeeded + errored,
                  batchTotal: items.length,
                }));
                useProcessingStore.getState().touchProgress(item.id);
              },
              onWarning,
            );

            const totalSize = galleryBlobs.reduce(
              (sum, b) => sum + b.blob.size,
              0,
            );

            const ffmpegLogs = ffmpeg.getAndClearLogs(item.id);
            const itemCancelledMidProcessing = isCancelled();

            useTaskStore.getState().updateItem(item.id, {
              outputName: withoutExtension(item.source.name),
              outputSize: totalSize,
              outputBlob: galleryBlobs[0]?.blob,
              galleryImages: galleryBlobs.map((b) => b.blob),
              galleryImageNames: galleryBlobs.map((b) => b.filename),
              galleryCurrentIndex: 0,
              completedOutputMode: opts.outputMode,
              status: itemCancelledMidProcessing ? "cancelled" : "done",
              error: undefined,
              processingDurationMs: Date.now() - itemStartTime,
              ffmpegLogs,
            });

            if (!itemCancelledMidProcessing) {
              succeeded++;
            } else {
              cancelled++;
            }

            log(
              `Finished "${item.source.name}" (${galleryBlobs.length} frames)`,
            );
            useProcessingStore.getState().setStatus((prev) => ({
              ...prev,
              currentPct: 100,
              batchDone: succeeded + errored,
            }));
            return;
          }

          let res;
          if (outputMode === "sequence") {
            /* ---- Sequence Mode ---- */
            const onSegmentDone = (
              segIdx: number,
              totalSegs: number,
              tSec: number,
            ) => {
              useProcessingStore.getState().setStatus((prev) => ({
                ...prev,
                text: `"${item.source.name}" — segment ${segIdx}/${totalSegs} @ ${formatTime(tSec)}`,
                currentPct: (segIdx / totalSegs) * ANIMATED_COMPOSE_PCT,
                batchDone: succeeded + errored,
                batchTotal: items.length,
              }));
              useProcessingStore.getState().touchProgress(item.id);
            };

            const onEncodeProgress = (data: {
              ratio: number;
              phase: string;
            }) => {
              const { ratio, phase } = data;
              const pct = ANIMATED_COMPOSE_PCT + ratio * ANIMATED_ENCODE_PCT;
              const pctLabel = Math.round(ratio * 100);
              useProcessingStore.getState().setStatus((prev) => ({
                ...prev,
                text: `"${item.source.name}" — ${phase} (${pctLabel}%)`,
                currentPct: pct,
                batchDone: succeeded + errored,
                batchTotal: items.length,
              }));
              useProcessingStore.getState().touchProgress(item.id);
            };

            res = await gridRenderer.renderSequence(
              item.source,
              meta,
              seqOpts,
              isCancelled,
              onSegmentDone,
              onEncodeProgress,
              onWarning,
            );
          } else if (outputMode === "animated") {
            const onAnimCellDone = (
              composedCell: number,
              totalCells: number,
            ) => {
              useProcessingStore.getState().setStatus((prev) => ({
                ...prev,
                text: `"${item.source.name}" — composing cell ${composedCell}/${totalCells}`,
                currentPct: (composedCell / totalCells) * ANIMATED_COMPOSE_PCT,
                batchDone: succeeded + errored,
                batchTotal: items.length,
              }));
              useProcessingStore.getState().touchProgress(item.id);
            };

            const onEncodeProgress = (data: {
              ratio: number;
              phase: string;
            }) => {
              const { ratio, phase } = data;
              const pct = ANIMATED_COMPOSE_PCT + ratio * ANIMATED_ENCODE_PCT;
              const pctLabel = Math.round(ratio * 100);
              useProcessingStore.getState().setStatus((prev) => ({
                ...prev,
                text: `"${item.source.name}" — ${phase} (${pctLabel}%)`,
                currentPct: pct,
                batchDone: succeeded + errored,
                batchTotal: items.length,
              }));
              useProcessingStore.getState().touchProgress(item.id);
            };

            res = await gridRenderer.renderAnimatedGrid(
              item.source,
              meta,
              animGridOpts,
              isCancelled,
              onAnimCellDone,
              onEncodeProgress,
              onWarning,
            );
          } else {
            const onCellDone = (
              cellIdx: number,
              totalCells: number,
              tSec: number,
            ) => {
              useProcessingStore.getState().setStatus((prev) => ({
                ...prev,
                text: `"${item.source.name}" — cell ${cellIdx}/${totalCells} @ ${formatTime(tSec)}`,
                currentPct: (cellIdx / totalCells) * 100,
                batchDone: succeeded + errored,
                batchTotal: items.length,
              }));
              useProcessingStore.getState().touchProgress(item.id);
            };

            res = await gridRenderer.renderStaticGrid(
              item.source,
              meta,
              gridOpts,
              isCancelled,
              onCellDone,
              onWarning,
            );
          }

          const ffmpegLogs = ffmpeg.getAndClearLogs(item.id);
          const itemCancelledMidProcessing = isCancelled();
          // Estimated from settings rather than re-probed from the output
          // blob (ffprobe needs a real file path, not an in-memory Blob).
          let outputAnimationInfo: AnimationEstimate | undefined;
          if (
            (outputMode === "animated" || outputMode === "sequence") &&
            res.outputBlob
          ) {
            // Use the width the renderer actually used (animGridOpts.width
            // for "animated" may be narrower than opts.width when Fit to
            // upload limits clamped it -- seqOpts.width is never clamped,
            // Sequence isn't in scope for that feature), so this summary
            // matches the real output instead of the pre-clamp settings.
            const actualWidth =
              (outputMode === "animated" ? animGridOpts.width : seqOpts.width) ??
              opts.width ??
              DEFAULTS.width!;
            outputAnimationInfo = item.metadata
              ? (computeAnimationEstimate(item.metadata, {
                  outputMode,
                  animSegments: opts.animSegments ?? DEFAULTS.animSegments!,
                  animDuration: opts.animDuration ?? DEFAULTS.animDuration!,
                  animFps: opts.animFps ?? DEFAULTS.animFps!,
                  width: actualWidth,
                  cols: opts.cols ?? DEFAULTS.cols!,
                  rows: opts.rows ?? DEFAULTS.rows!,
                  spacing: opts.spacing ?? DEFAULTS.spacing!,
                  header: Boolean(opts.header),
                  vrMode: opts.vrMode ?? DEFAULTS.vrMode!,
                  gridTemplate: opts.gridTemplate,
                  headerFontSizeAuto: Boolean(opts.headerFontSizeAuto),
                  headerFontSize:
                    opts.headerFontSize ?? DEFAULTS.headerFontSize!,
                }) ?? undefined)
              : undefined;
          }

          useTaskStore.getState().updateItem(item.id, {
            outputName: res.outputName,
            outputSize: res.outputSize,
            outputBlob: res.outputBlob,
            completedOutputMode: opts.outputMode,
            status: itemCancelledMidProcessing ? "cancelled" : "done",
            error: undefined,
            processingDurationMs: Date.now() - itemStartTime,
            ffmpegLogs,
            outputAnimationInfo,
          });

          if (!itemCancelledMidProcessing) {
            succeeded++;
          } else {
            cancelled++;
          }

          log(`Finished "${item.source.name}"`);
          useProcessingStore.getState().setStatus((prev) => ({
            ...prev,
            currentPct: 100,
            batchDone: succeeded + errored,
          }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          const ffmpegLogs = ffmpeg.getAndClearLogs(item.id);
          const wasForceCancelled = forceCancelledIds.current.has(item.id);
          const wasUserCancelled = cancelRef.current;
          const itemErrored = !(wasUserCancelled || wasForceCancelled);
          useTaskStore.getState().updateItem(item.id, {
            status:
              wasUserCancelled || wasForceCancelled ? "cancelled" : "error",
            error: msg,
            processingDurationMs: Date.now() - itemStartTime,
            ffmpegLogs,
          });
          if (itemErrored) {
            errored++;
          } else {
            cancelled++;
          }
          errlog(`Failed "${item.source.name}":`, e);
          useProcessingStore.getState().setStatus((prev) => ({
            ...prev,
            text: `Error on "${item.source.name}": ${msg}`,
            textKind: wasForceCancelled ? "cancelled" : undefined,
            batchDone: succeeded + errored,
          }));
        } finally {
          forceCancelledIds.current.delete(item.id);
          activeFfmpegs.current.delete(item.id);
          useProcessingStore.getState().removeActiveTask(item.id);
          await ffmpeg.destroy();
        }
      };

      const worker = async () => {
        let item = claimNext();
        while (item) {
          await processOneItem(item);
          item = claimNext();
        }
      };

      try {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      } finally {
        const batchDurationMs = Date.now() - batchStartTime;
        setProcessingGuard(false);
        useProcessingStore.getState().setIsProcessing(false);
        const total = items.length;
        const parts = [`${succeeded} succeeded`, `${errored} failed`];
        if (cancelled > 0) {
          parts.push(`${cancelled} cancelled`);
        }
        const breakdown = parts.join(", ");
        const label = cancelRef.current ? "Cancelled" : "Done";

        useProcessingStore.getState().setStatus({
          currentPct: 0,
          batchDone: succeeded + errored,
          batchTotal: 0,
          batchStartTime: null,
          batchDurationMs,
          text: `${label}. ${breakdown}. (${total} total, ${formatElapsed(batchDurationMs)})`,
          textKind: cancelRef.current ? "cancelled" : "success",
        });
      }
    },
    [],
  );

  /** Signal the running batch to stop starting new items after in-flight ones finish. */
  const requestCancel = useCallback(() => {
    cancelRef.current = true;
    useProcessingStore.getState().setStatus((prev) => ({
      ...prev,
      text: "Cancelling…",
    }));
    warn("Cancel requested by user");
  }, []);

  /** Force-kill every currently in-flight native ffmpeg task immediately. */
  const forceCancel = useCallback(async () => {
    const ids = Array.from(activeFfmpegs.current.keys());
    if (ids.length === 0) {
      useProcessingStore.getState().setStatus((prev) => ({
        ...prev,
        text: "Nothing running to force-cancel.",
        textKind: "info",
      }));
      return;
    }
    useProcessingStore.getState().setStatus((prev) => ({
      ...prev,
      text: `Force-killing ${ids.length} active task(s)…`,
      textKind: "warning",
    }));
    warn(
      `Force cancel: terminating ${ids.length} active native ffmpeg task(s)`,
    );
    for (const id of ids) {
      forceCancelledIds.current.add(id);
      activeFfmpegs.current.get(id)?.abortCurrent();
    }
    useProcessingStore.getState().setStatus((prev) => ({
      ...prev,
      text: "Force-kill requested — affected tasks will be marked cancelled.",
      textKind: "info",
    }));
  }, []);

  return { processAll, requestCancel, forceCancel };
}
