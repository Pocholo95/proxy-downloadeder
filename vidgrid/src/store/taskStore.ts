import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { TaskItem } from "@/types";

/**
 * Zustand store for task items, mutations, and derived computations.
 * Replaces: src/context/tasksContext.tsx
 */
interface TaskState {
  // --- Core state ---
  items: TaskItem[];

  // --- Actions ---
  setItems: (updater: (prev: TaskItem[]) => TaskItem[]) => void;
  updateItem: (id: string, patch: Partial<TaskItem>) => void;
  handleUpdateTimestamps: (
    id: string,
    mode: "auto" | "custom",
    markers: number[],
  ) => void;
  handleRemoveItem: (id: string) => void;
  handleRequeueItem: (id: string) => void;
  handleRequeueAll: () => void;
  addItem: (item: TaskItem) => void;

  // --- Derived (computed on access via selectors) ---
  hasQueuedFiles: boolean;
  allMetadataReady: boolean;
  hasRequeuableItems: boolean;
  effectiveBatchDone: number;
  cancelledCount: number;
  inFlight: number;
}

export const useTaskStore = create<TaskState>()(
  immer((set) => ({
    // --- Initial state ---
    items: [],

    // --- Actions ---
    setItems: (updater) =>
      set((state) => {
        state.items = updater(state.items);
      }),

    updateItem: (id, patch) =>
      set((state) => {
        const item = state.items.find((it) => it.id === id);
        if (item) Object.assign(item, patch);
      }),

    handleUpdateTimestamps: (id, mode, markers) =>
      set((state) => {
        const item = state.items.find((it) => it.id === id);
        if (item) {
          item.timestampMode = mode;
          item.customTimestamps = markers;
        }
      }),

    handleRemoveItem: (id) =>
      set((state) => {
        state.items = state.items.filter((it) => it.id !== id);
      }),

    handleRequeueItem: (id) =>
      set((state) => {
        const item = state.items.find((it) => it.id === id);
        if (item) {
          item.status = "queued";
          item.error = undefined;
          item.outputBlob = undefined;
          item.outputName = undefined;
          item.outputSize = undefined;
          item.processingStartedAt = undefined;
          item.processingDurationMs = undefined;
          item.outputAnimationInfo = undefined;
          item.uploads = undefined;
          item.ffmpegLogs = [];
          item.ffmpegTotalLines = 0;
          item.galleryImages = undefined;
          item.galleryImageNames = undefined;
          item.galleryCurrentIndex = undefined;
          item.completedOutputMode = undefined;
        }
      }),

    handleRequeueAll: () =>
      set((state) => {
        for (const item of state.items) {
          if (
            item.status === "done" ||
            item.status === "error" ||
            item.status === "cancelled"
          ) {
            item.status = "queued";
            item.error = undefined;
            item.outputBlob = undefined;
            item.outputName = undefined;
            item.outputSize = undefined;
            item.processingStartedAt = undefined;
            item.processingDurationMs = undefined;
            item.outputAnimationInfo = undefined;
            item.uploads = undefined;
            item.ffmpegLogs = [];
            item.ffmpegTotalLines = 0;
            item.galleryImages = undefined;
            item.galleryImageNames = undefined;
            item.galleryCurrentIndex = undefined;
            item.completedOutputMode = undefined;
          }
        }
      }),

    addItem: (item) =>
      set((state) => {
        state.items.push(item);
      }),

    // --- Derived values (always reflect current state) ---
    hasQueuedFiles: false,
    allMetadataReady: false,
    hasRequeuableItems: false,
    effectiveBatchDone: 0,
    cancelledCount: 0,
    inFlight: 0,
  })),
);

// --- Derived selectors (computed fresh on each call) ---
export const selectHasQueuedFiles = (state: TaskState) =>
  state.items.some((i) => i.status === "queued");

export const selectAllMetadataReady = (state: TaskState) =>
  state.items.some((i) => i.status === "queued") &&
  state.items.every((i) => i.status !== "queued" || i.metadata !== undefined);

export const selectHasRequeuableItems = (state: TaskState) =>
  state.items.some(
    (i) =>
      i.status === "done" || i.status === "error" || i.status === "cancelled",
  );

export const selectEffectiveBatchDone = (state: TaskState) =>
  state.items.filter((i) => i.status === "done" || i.status === "error").length;

export const selectCancelledCount = (state: TaskState) =>
  state.items.filter((i) => i.status === "cancelled").length;

export const selectInFlight = (state: TaskState) =>
  state.items.filter((i) => i.status === "queued" || i.status === "processing")
    .length;

/**
 * Convenience hook: get derived values as a single reactive object.
 * Use individual selectors above for fine-grained memoization.
 */
export function useTaskDerived() {
  return useTaskStore((state) => ({
    hasQueuedFiles: selectHasQueuedFiles(state),
    allMetadataReady: selectAllMetadataReady(state),
    hasRequeuableItems: selectHasRequeuableItems(state),
    effectiveBatchDone: selectEffectiveBatchDone(state),
    cancelledCount: selectCancelledCount(state),
    inFlight: selectInFlight(state),
  }));
}
