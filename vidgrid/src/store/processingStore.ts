import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ProcessorStatus } from "@/types";

/**
 * Zustand store for processing lifecycle state.
 *
 * Progress/stale tracking is keyed per-task (lastProgressTimeByTask,
 * activeTaskIds, staleTaskIds) rather than a single "current task" --
 * required once the batch processor runs N tasks concurrently, so one
 * slow file can't falsely flag its siblings as stale (or mask a
 * genuinely stuck one).
 */
interface ProcessingState {
  // --- Core state ---
  isProcessing: boolean;
  isStale: boolean;
  staleTaskIds: string[];
  status: ProcessorStatus;

  // --- Per-task tracking (not refs - Immer makes those read-only) ---
  lastProgressTimeByTask: Record<string, number>;
  activeTaskIds: string[];

  // --- Actions ---
  setIsProcessing: (v: boolean) => void;
  setStatus: (
    status: ProcessorStatus | ((prev: ProcessorStatus) => ProcessorStatus),
  ) => void;
  setStale: (id: string, stale: boolean) => void;
  clearStale: () => void;
  requestCancel: () => void;
  forceCancel: () => void;
  touchProgress: (taskId: string) => void;
  addActiveTask: (id: string) => void;
  removeActiveTask: (id: string) => void;

  // --- Reset ---
  resetState: () => void;
}

const INITIAL_STATUS: ProcessorStatus = {
  text: "",
  currentPct: 0,
  batchDone: 0,
  batchTotal: 0,
  batchStartTime: null,
  batchDurationMs: null,
};

export const useProcessingStore = create<ProcessingState>()(
  immer((set) => ({
    // --- Initial state ---
    isProcessing: false,
    isStale: false,
    staleTaskIds: [],
    status: INITIAL_STATUS,
    lastProgressTimeByTask: {},
    activeTaskIds: [],

    // --- Actions ---
    setIsProcessing: (v) =>
      set((state) => {
        state.isProcessing = v;
      }),

    setStatus: (status) =>
      set((state) => {
        const next =
          typeof status === "function" ? status(state.status) : status;
        state.status = next;
      }),

    setStale: (id, stale) =>
      set((state) => {
        const idx = state.staleTaskIds.indexOf(id);
        if (stale && idx === -1) {
          state.staleTaskIds.push(id);
        } else if (!stale && idx !== -1) {
          state.staleTaskIds.splice(idx, 1);
        }
        state.isStale = state.staleTaskIds.length > 0;
      }),

    clearStale: () =>
      set((state) => {
        state.isStale = false;
        state.staleTaskIds = [];
      }),

    /**
     * Signal a graceful cancellation request.
     * The actual cancel logic is handled in useBatchProcessor hook.
     */
    requestCancel: () =>
      set((state) => {
        state.status = {
          ...state.status,
          textKind: "cancelled",
          text: "Cancellation requested…",
        };
      }),

    /**
     * Signal a force cancellation.
     * The actual FFmpeg kill logic is handled in useBatchProcessor hook.
     */
    forceCancel: () =>
      set((state) => {
        state.status = {
          ...state.status,
          textKind: "cancelled",
          text: "Force cancellation requested…",
        };
      }),

    /** Record that progress was made on a specific task (for stale detection). */
    touchProgress: (taskId) =>
      set((state) => {
        state.lastProgressTimeByTask[taskId] = Date.now();
      }),

    /** Mark a task as actively processing. */
    addActiveTask: (id) =>
      set((state) => {
        if (!state.activeTaskIds.includes(id)) {
          state.activeTaskIds.push(id);
        }
        state.lastProgressTimeByTask[id] = Date.now();
      }),

    /** Mark a task as no longer processing (done/error/cancelled). */
    removeActiveTask: (id) =>
      set((state) => {
        const idx = state.activeTaskIds.indexOf(id);
        if (idx !== -1) state.activeTaskIds.splice(idx, 1);
        delete state.lastProgressTimeByTask[id];
        const staleIdx = state.staleTaskIds.indexOf(id);
        if (staleIdx !== -1) {
          state.staleTaskIds.splice(staleIdx, 1);
          state.isStale = state.staleTaskIds.length > 0;
        }
      }),

    // --- Reset ---
    resetState: () =>
      set((state) => {
        state.isProcessing = false;
        state.isStale = false;
        state.staleTaskIds = [];
        state.status = INITIAL_STATUS;
        state.lastProgressTimeByTask = {};
        state.activeTaskIds = [];
      }),
  })),
);

/**
 * Module-level guard to prevent concurrent batch processing.
 * Kept outside the Zustand store to avoid Immer proxy read-only issues.
 */
let _isProcessingGuard = false;

export function getProcessingGuard(): boolean {
  return _isProcessingGuard;
}

export function setProcessingGuard(v: boolean): void {
  _isProcessingGuard = v;
}
