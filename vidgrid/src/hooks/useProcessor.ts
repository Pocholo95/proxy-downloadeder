import { useCallback } from "react";
import type { TaskItem } from "@/types";
import { useProcessorStatus } from "./useProcessorStatus";
import { useFileAnalyzer } from "./useFileAnalyzer";
import { useBatchProcessor } from "./useBatchProcessor";
import { useProcessingStore } from "@/store/processingStore";

/**
 * Orchestrator hook that composes the split service hooks:
 * - useProcessorStatus  (stale detection + status, per-task)
 * - useFileAnalyzer     (metadata reading via ffprobe)
 * - useBatchProcessor   (bounded-concurrency batch grid generation, each
 *   task getting its own NativeFfmpegService instance)
 *
 * @param updateItem - Callback to patch a single TaskItem by id.
 */
export function useProcessor(
  updateItem: (id: string, patch: Partial<TaskItem>) => void,
) {
  // --- Status + stale detection ---
  const {
    isProcessing,
    isStale,
    staleTaskIds,
    status,
    setStatus,
    isProcessingRef,
  } = useProcessorStatus(updateItem);

  // --- Split hooks ---
  const { analyzeFiles } = useFileAnalyzer(updateItem, setStatus);
  const { processAll, requestCancel, forceCancel } = useBatchProcessor();

  /** Reset processing state. */
  const resetState = useCallback(async () => {
    useProcessingStore.getState().resetState();
  }, []);

  return {
    isProcessing,
    isProcessingRef,
    isStale,
    staleTaskIds,
    status,
    setStatus,
    analyzeFiles,
    processAll,
    requestCancel,
    forceCancel,
    resetState,
  };
}
