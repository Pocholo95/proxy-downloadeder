import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { autoAnimate } from "@formkit/auto-animate";
import { saveAs } from "file-saver";
import JSZip from "jszip";
import { DEFAULTS, PROJECT_NAME } from "@/constants";
import { makeUniqueName } from "@/utils";
import type { SavedOptions } from "@/types";
import { useTaskStore } from "./taskStore";
import { useProcessingStore } from "./processingStore";
import { useSettingsStore } from "./settingsStore";

/**
 * Zustand store for UI-layer state: ZIP, preview, options, DOM refs.
 * Replaces: src/context/uiContext.tsx (state portion only).
 *
 * The actual file handling and processing coordination stays in App.tsx
 * because it needs to bridge multiple stores and WASM service hooks.
 */
interface UiState {
  // --- Core state ---
  opts: SavedOptions;
  previewUrl: string | null;
  isZipping: boolean;

  // --- Gallery preview state ---
  galleryPreviewTaskId: string | null;
  galleryPreviewIndex: number;

  // --- Actions ---
  setOpts: (
    updater: SavedOptions | ((prev: SavedOptions) => SavedOptions),
  ) => void;
  setPreviewUrl: (url: string | null) => void;
  downloadAll: () => Promise<void>;
  downloadGallery: (taskId: string) => Promise<void>;
  setGalleryPreview: (taskId: string | null, index?: number) => void;

  // --- Derived ---
  totalCells: number;
}

export const useUiStore = create<UiState>()(
  immer((set) => ({
    // --- Initial state ---
    opts: (() => {
      // Load from presets if available, otherwise use defaults
      const { settings } = useSettingsStore.getState();
      const { lastUsed, entries } = settings.presets;
      if (lastUsed && entries[lastUsed]) {
        return structuredClone(entries[lastUsed]);
      }
      return structuredClone(DEFAULTS);
    })(),
    previewUrl: null,
    isZipping: false,
    galleryPreviewTaskId: null,
    galleryPreviewIndex: 0,

    // --- Actions ---
    setOpts: (updater) =>
      set((state) => {
        state.opts =
          typeof updater === "function" ? updater(state.opts) : updater;
      }),

    setPreviewUrl: (url) =>
      set((state) => {
        state.previewUrl = url;
      }),

    setGalleryPreview: (taskId, index = 0) =>
      set((state) => {
        state.galleryPreviewTaskId = taskId;
        state.galleryPreviewIndex = index;
      }),

    downloadAll: async () => {
      const items = useTaskStore.getState().items;
      const done = items.filter(
        (i) => i.status === "done" && i.outputBlob && i.outputName,
      );
      if (!done.length) return;

      set((state) => {
        state.isZipping = true;
      });

      try {
        const zip = new JSZip();
        const existingNames = new Set<string>();

        for (const item of done) {
          // For gallery tasks, include all gallery images
          // outputName is already extension-stripped for gallery mode
          if (item.galleryImages && item.galleryImages.length > 0) {
            const baseName = item.outputName!;
            for (let i = 0; i < item.galleryImages.length; i++) {
              const fileName =
                item.galleryImageNames?.[i] ??
                `${baseName}_${String(i + 1).padStart(3, "0")}.jpg`;
              const uniqueName = makeUniqueName(fileName, existingNames);
              existingNames.add(uniqueName);
              zip.file(uniqueName, item.galleryImages[i]);
            }
          } else {
            const uniqueName = makeUniqueName(item.outputName!, existingNames);
            existingNames.add(uniqueName);
            zip.file(uniqueName, item.outputBlob!);
          }
        }

        const blob = await zip.generateAsync({ type: "blob" });
        saveAs(blob, `${PROJECT_NAME.toLowerCase()}-outputs.zip`);
      } finally {
        set((state) => {
          state.isZipping = false;
        });
      }
    },

    downloadGallery: async (taskId: string) => {
      const item = useTaskStore.getState().items.find((i) => i.id === taskId);
      if (!item || !item.galleryImages || item.galleryImages.length === 0) {
        return;
      }

      // If only one image, download it directly
      if (item.galleryImages.length === 1) {
        const fileName =
          item.galleryImageNames?.[0] ?? item.outputName ?? "gallery_001.jpg";
        saveAs(item.galleryImages[0], fileName);
        return;
      }

      set((state) => {
        state.isZipping = true;
      });

      try {
        const zip = new JSZip();
        // outputName is already extension-stripped for gallery mode
        const baseName = item.outputName ?? "gallery";

        for (let i = 0; i < item.galleryImages.length; i++) {
          const fileName =
            item.galleryImageNames?.[i] ??
            `${baseName}_${String(i + 1).padStart(3, "0")}.jpg`;
          zip.file(fileName, item.galleryImages[i]);
        }

        const blob = await zip.generateAsync({ type: "blob" });
        saveAs(blob, `${baseName}.zip`);
      } finally {
        set((state) => {
          state.isZipping = false;
        });
      }
    },

    // --- Derived ---
    totalCells: 0,
  })),
);

/**
 * Computed: total cells from current opts.
 * Use this selector for reactive access.
 */
export const selectTotalCells = (state: UiState) => {
  /* In gallery mode, total cells = number of gallery images. */
  if (state.opts.outputMode === "gallery") {
    return Math.max(1, state.opts.galleryCount ?? 1);
  }
  /* In sequence mode, total cells = number of segments. */
  if (state.opts.outputMode === "sequence") {
    return Math.max(1, state.opts.animSegments ?? 1);
  }
  if (state.opts.gridTemplate && state.opts.gridTemplate.cells.length > 0) {
    return state.opts.gridTemplate.cells.length;
  }
  return Math.max(1, state.opts.cols) * Math.max(1, state.opts.rows);
};

/**
 * Initialize main container with auto-animate.
 */
export function initMainContainer(el: HTMLDivElement | null) {
  if (el) autoAnimate(el);
}

/**
 * Convenience hook: derived values that depend on opts.
 */
export function useUiDerived() {
  return useUiStore((state) => ({
    totalCells: selectTotalCells(state),
    effectiveBatchTotal: computeEffectiveBatchTotal(),
  }));
}

/**
 * Compute effective batch total from processing + task stores.
 */
function computeEffectiveBatchTotal() {
  const { isProcessing } = useProcessingStore.getState();
  const items = useTaskStore.getState().items;

  const effectiveBatchDone = items.filter(
    (i) => i.status === "done" || i.status === "error",
  ).length;
  const cancelledCount = items.filter((i) => i.status === "cancelled").length;
  const inFlight = items.filter(
    (i) => i.status === "queued" || i.status === "processing",
  ).length;

  if (isProcessing) {
    return effectiveBatchDone + cancelledCount + inFlight;
  }
  return effectiveBatchDone + cancelledCount;
}
