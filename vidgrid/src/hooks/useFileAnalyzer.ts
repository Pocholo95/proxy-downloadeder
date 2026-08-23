import { useCallback } from "react";
import type { TaskItem, ProcessorStatus, VideoSource } from "../types";
import { canNativelyPlayFile } from "../gridUtils";
import { probeMetadata } from "../services/probeMetadata";
import { hasUsableMetadata, makeId, warn } from "../utils";

type Updater = (id: string, patch: Partial<TaskItem>) => void;
type StatusSetter = (
  status: ProcessorStatus | ((prev: ProcessorStatus) => ProcessorStatus),
) => void;

/**
 * Hook that handles file analysis: reading video metadata via real ffprobe
 * (through the Python bridge) for each selected source, updating items
 * in-place, and notifying callers.
 *
 * @param updateItem - Callback to patch a single TaskItem by id.
 * @param setStatus - Callback to update the processor UI status.
 */
export function useFileAnalyzer(updateItem: Updater, setStatus: StatusSetter) {
  /**
   * Analyze newly selected sources with ffprobe to populate metadata.
   * Updates each item in-place and calls updateItem after each file.
   * Calls onItemReady callback after each file is analyzed so the caller
   * can add items one-by-one (triggering enter animations).
   *
   * @param sources - The VideoSource entries selected via native dialogs.
   * @param onItemReady - Optional callback called after each file is analyzed.
   * @returns A fully-populated TaskItem array ready for processing.
   */
  const analyzeFiles = useCallback(
    async (
      sources: VideoSource[],
      onItemReady?: (item: TaskItem) => void | Promise<void>,
    ): Promise<TaskItem[]> => {
      setStatus({
        text: `Analyzing ${sources.length} file(s)…`,
        currentPct: 0,
        batchDone: 0,
        batchTotal: sources.length,
        batchStartTime: null,
        batchDurationMs: null,
      });

      const items: TaskItem[] = sources.map((source) => ({
        id: makeId(),
        source,
        status: "queued",
      }));

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const progress = ((i + 1) / sources.length) * 100;
        setStatus({
          text: `Analyzing "${item.source.name}"…`,
          currentPct: progress,
          batchDone: i + 1,
          batchTotal: sources.length,
          batchStartTime: null,
          batchDurationMs: null,
        });

        try {
          const meta = await probeMetadata(item.source.path);
          item.metadata = meta;
          if (!hasUsableMetadata(meta)) {
            item.warning =
              "Could not read required metadata from this file. Processing may fail or produce incorrect output.";
          }

          // Detect native playback capability at analysis time so the
          // warning is shown immediately rather than only at render time.
          const canPlay = await canNativelyPlayFile(item.source);
          item.canNativelyPlay = canPlay;
          if (!canPlay) {
            const nativeWarning =
              "Native decoder unavailable — processing will use the FFmpeg fallback.";
            item.warning = item.warning
              ? `${item.warning} ${nativeWarning}`
              : nativeWarning;
          }

          updateItem(item.id, {
            metadata: item.metadata,
            warning: item.warning,
            canNativelyPlay: item.canNativelyPlay,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Metadata read failed";
          item.warning = `Metadata analysis failed: ${msg}`;
          updateItem(item.id, { warning: item.warning });
          warn(`Metadata failed for "${item.source.name}":`, e);
        }

        // Notify caller so the item can be added to state one-by-one
        if (onItemReady) {
          await onItemReady(item);
        }
      }

      setStatus({
        text: `${sources.length} new file(s) analyzed. Set your options/preset and press Start Processing.`,
        currentPct: 0,
        batchDone: 0,
        batchTotal: 0,
        batchStartTime: null,
        batchDurationMs: null,
      });

      return items;
    },
    [updateItem, setStatus],
  );

  return { analyzeFiles };
}
