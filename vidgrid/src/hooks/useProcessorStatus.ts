import { useEffect, useCallback } from "react";
import { FFMPEG_STALE_THRESHOLD_MS } from "../constants";
import type { TaskItem } from "../types";
import {
  useProcessingStore,
  getProcessingGuard,
} from "@/store/processingStore";
import { useTick } from "@/lib/useTick";
import { setGlobalLogSubscriber } from "@/services/nativeBridgeEvents";

type Updater = (id: string, patch: Partial<TaskItem>) => void;

/**
 * Hook that manages the processor UI status state, stale detection,
 * and live log callbacks — extracted from useProcessor for clarity.
 *
 * Reads all reactive state from the Zustand processingStore, whose
 * progress/stale tracking is per-task (activeTaskIds/
 * lastProgressTimeByTask) so N concurrently-running batch items don't
 * cross-contaminate each other's stale/progress status.
 *
 * Stale detection uses the shared useTick rAF loop instead of a raw
 * setInterval, so it benefits from frame-alignment and tab-hidden pausing.
 */
export function useProcessorStatus(updateItem: Updater) {
  // --- Read all state from Zustand store ---
  const isProcessing = useProcessingStore((s) => s.isProcessing);
  const isStale = useProcessingStore((s) => s.isStale);
  const staleTaskIds = useProcessingStore((s) => s.staleTaskIds);
  const status = useProcessingStore((s) => s.status);
  const setStatus = useProcessingStore((s) => s.setStatus);
  const setStale = useProcessingStore((s) => s.setStale);

  /**
   * Register a single app-wide log subscriber so that whenever any native
   * ffmpeg task appends a log line, the processor updates that task's
   * ffmpegLogs array immediately. Works for both the sequential and
   * N-concurrent batch processor, since Python already tags every line
   * with the right taskId.
   */
  useEffect(() => {
    setGlobalLogSubscriber((taskId, logs, totalLines) => {
      updateItem(taskId, {
        ffmpegLogs: [...logs],
        ffmpegTotalLines: totalLines,
      });
    });
    return () => {
      setGlobalLogSubscriber(null);
    };
  }, [updateItem]);

  /**
   * Stale detection: periodically check whether any currently-active task
   * hasn't reported progress for FFMPEG_STALE_THRESHOLD_MS.
   *
   * Uses useTick (rAF-based) instead of setInterval for frame-aligned
   * execution and automatic tab-hidden pausing.
   */
  const _tick = useTick(isProcessing, 5000);
  const checkStale = useCallback(() => {
    const store = useProcessingStore.getState();
    const now = Date.now();
    for (const taskId of store.activeTaskIds) {
      const lastProgress = store.lastProgressTimeByTask[taskId] ?? now;
      if (now - lastProgress > FFMPEG_STALE_THRESHOLD_MS) {
        console.warn(
          `[Stale Detection] Task ${taskId} has not progressed for ` +
            `${now - lastProgress}ms.`,
        );
        setStale(taskId, true);
      }
    }
  }, [setStale]);

  // Trigger stale check on every _tick increment while processing
  useEffect(() => {
    if (isProcessing) {
      checkStale();
    }
  }, [_tick, isProcessing, checkStale]);

  return {
    isProcessing,
    isProcessingRef: { current: getProcessingGuard() },
    isStale,
    staleTaskIds,
    status,
    setStatus,
  };
}
