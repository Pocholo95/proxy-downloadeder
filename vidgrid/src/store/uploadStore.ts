import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { uploadBlob } from "@/upload";
import { UPLOAD_DELAY_MS } from "@/constants";
import { isItemUploadEligible } from "@/uploadUtils";
import {
  CORSError,
  shouldShowCORSModal,
  markModalShown,
  detectCORSTunnelAvailable,
  resetBatchState,
  hasVersionMismatch,
  getCORSStatus,
} from "@/lib/cors-tunnel";
import type {
  DestinationUploadState,
  FileUploadResult,
  TaskItem,
  UploadDestination,
  UploadResult,
} from "@/types";
import { useTaskStore } from "./taskStore";

/**
 * Zustand store for upload state.
 * Replaces: src/context/uploadContext.tsx (state portion)
 *
 * Upload mutations on TaskItem.uploads[] are performed via taskStore.setItems()
 * so the upload store itself tracks only progress counters and the uploading flag.
 */
interface UploadState {
  isUploadingAll: boolean;
  uploadProgress: { attempted: number; total: number };
  /** When true the CORS help modal should be displayed. */
  showCORSHelpModal: boolean;
  /** When true the CORS outdated modal should be displayed. */
  showCORSOutdatedModal: boolean;

  resetUploadState: () => void;

  /** Close the CORS outdated modal. */
  handleCloseCORSOutdatedModal: () => void;

  /** Close the CORS help modal. */
  handleCloseCORSHelpModal: () => void;

  /**
   * Upload a single task item to a single destination.
   * Mutates taskStore items directly via setItems().
   */
  uploadItemToDest: (itemId: string, dest: UploadDestination) => Promise<void>;

  /**
   * Upload a single task item to all enabled destinations that haven't
   * already received it.
   */
  uploadItem: (
    itemId: string,
    destinations: UploadDestination[],
  ) => Promise<void>;

  /**
   * Upload all completed, not-yet-uploaded items to all enabled destinations.
   */
  uploadAll: (destinations: UploadDestination[]) => Promise<void>;

  /**
   * Remove a file result from the array entirely (used after delete).
   */
  removeFileResult: (itemId: string, destId: string, fileIndex: number) => void;

  /**
   * Remove the upload result for a specific destination on a task item.
   * Optional fileIndex to clear only one file's result.
   */
  clearUploadResult: (
    itemId: string,
    destId: string,
    fileIndex?: number,
  ) => void;

  /**
   * Retry all failed files for a specific destination on a task item.
   */
  retryFailedFiles: (itemId: string, destId: string) => Promise<void>;

  /**
   * Retry a single failed file at the given index.
   */
  retrySingleFile: (
    itemId: string,
    destId: string,
    fileIndex: number,
  ) => Promise<void>;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Patch the destination-level upload state on a task item.
 */
function patchUpload(
  prev: TaskItem[],
  id: string,
  destId: string,
  patch: Partial<DestinationUploadState>,
): TaskItem[] {
  return prev.map((item) => {
    if (item.id !== id) return item;
    const current: DestinationUploadState = item.uploads?.[destId] ?? {
      status: "idle",
      progress: 0,
    };
    return {
      ...item,
      uploads: {
        ...item.uploads,
        [destId]: { ...current, ...patch },
      },
    };
  });
}

/**
 * Patch a single file result within a destination upload state.
 */
function patchFileResult(
  prev: TaskItem[],
  itemId: string,
  destId: string,
  fileIndex: number,
  patch: Partial<FileUploadResult>,
): TaskItem[] {
  return prev.map((item) => {
    if (item.id !== itemId) return item;
    const uploads = item.uploads;
    if (!uploads) return item;
    const fileResults = uploads[destId]?.fileResults;
    if (!fileResults) return item;
    const destState = uploads[destId];
    if (!destState) return item;
    const updated = [...fileResults];
    updated[fileIndex] = { ...updated[fileIndex], ...patch };
    return {
      ...item,
      uploads: {
        ...uploads,
        [destId]: {
          ...destState,
          fileResults: updated,
        },
      },
    };
  });
}

/**
 * Get files to upload for a task (gallery images or single output file).
 */
function getUploadFiles(item: TaskItem): Array<{ blob: Blob; name: string }> {
  // Gallery mode: return all frame images
  if (item.galleryImages && item.galleryImages.length > 0) {
    return item.galleryImages.map((blob, i) => ({
      blob,
      name: item.galleryImageNames?.[i] ?? `${item.outputName}_${i}.jpg`,
    }));
  }
  // Single file mode (video, image, etc.): return the output blob
  if (item.outputBlob && item.outputName) {
    return [{ blob: item.outputBlob, name: item.outputName }];
  }
  return [];
}

/**
 * Derive destination-level status from fileResults (skips deleted files).
 */
function deriveDestState(fileResults: FileUploadResult[]) {
  const active = fileResults.filter((f) => f.status !== "deleted");

  if (active.length === 0) {
    return { status: "idle" as const, progress: 0, error: undefined };
  }

  const allDone = active.every((f) => f.status === "done");
  const anyError = active.some((f) => f.status === "error");
  const anyUploading = active.some((f) => f.status === "uploading");

  let status: DestinationUploadState["status"];
  if (allDone) status = "done";
  else if (anyUploading) status = "uploading";
  else if (anyError) status = "error";
  else status = "idle";

  const progress =
    active.reduce((sum, f) => sum + f.progress, 0) / active.length;

  const firstError = active.find((f) => f.status === "error")?.error;

  return { status, progress, error: firstError };
}

/**
 * Update file progress AND re-derive destination-level progress.
 */
function updateFileProgress(
  itemId: string,
  destId: string,
  fileIndex: number,
  pct: number,
) {
  useTaskStore.getState().setItems((prev) => {
    const updated = patchFileResult(prev, itemId, destId, fileIndex, {
      progress: pct,
    });
    // Also re-derive destination-level progress from updated fileResults
    const item = updated.find((i) => i.id === itemId);
    const fr = item?.uploads?.[destId]?.fileResults;
    if (fr) {
      const avg = fr.reduce((s, f) => s + f.progress, 0) / fr.length;
      return patchUpload(updated, itemId, destId, { progress: avg });
    }
    return updated;
  });
}

/**
 * Upload a single file to a destination, tracking progress in fileResults.
 */
async function uploadSingleFile(
  itemId: string,
  dest: UploadDestination,
  fileIndex: number,
  blob: Blob,
  filename: string,
): Promise<void> {
  // Set file to uploading
  useTaskStore.getState().setItems((prev) =>
    patchFileResult(prev, itemId, dest.id, fileIndex, {
      status: "uploading",
      progress: 0,
      error: undefined,
      filename,
    }),
  );

  try {
    const result: UploadResult = await uploadBlob(blob, filename, dest, (pct) =>
      updateFileProgress(itemId, dest.id, fileIndex, pct),
    );

    useTaskStore.getState().setItems((prev) =>
      patchFileResult(prev, itemId, dest.id, fileIndex, {
        status: "done",
        progress: 100,
        result,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    useTaskStore.getState().setItems((prev) =>
      patchFileResult(prev, itemId, dest.id, fileIndex, {
        status: "error",
        error: msg,
      }),
    );
    // If this was a CORS error, signal the modal (only if not dismissed)
    if (e instanceof CORSError && shouldShowCORSModal()) {
      markModalShown();
      useUploadStore.setState(() => ({ showCORSHelpModal: true }));
    }
    throw e; // Re-throw so caller knows this file failed
  }
}

export const useUploadStore = create<UploadState>()(
  immer((set) => ({
    isUploadingAll: false,
    uploadProgress: { total: 0, attempted: 0 },
    showCORSHelpModal: false,
    showCORSOutdatedModal: false,

    resetUploadState: () => {
      // Reset CORS tunnel batch tracking so the modal can show again
      // on the next upload attempt.
      resetBatchState();
      set(() => ({
        uploadProgress: { total: 0, attempted: 0 },
        isUploadingAll: false,
        showCORSHelpModal: false,
        showCORSOutdatedModal: false,
      }));
    },

    handleCloseCORSHelpModal: () => set(() => ({ showCORSHelpModal: false })),

    handleCloseCORSOutdatedModal: () =>
      set(() => ({ showCORSOutdatedModal: false })),

    uploadItemToDest: async (itemId, dest) => {
      const items = useTaskStore.getState().items;
      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const files = getUploadFiles(item);
      if (files.length === 0) return;

      // Detect CORS tunnel availability before any upload attempt so the
      // proxy can be used immediately, avoiding a doomed native fetch that
      // would succeed server-side but be blocked by the browser's CORS policy.
      // Skip the ping if tunnel state is already known (available or mismatch)
      // to avoid redundant 3-second pings when called from uploadAll's loop.
      const status = getCORSStatus();
      if (!status.available && !status.versionMismatch) {
        await detectCORSTunnelAvailable();

        // If the userscript responded but with an outdated version, show the
        // outdated modal instead of proceeding with the upload.
        if (hasVersionMismatch()) {
          set(() => ({ showCORSOutdatedModal: true }));
          return;
        }
      }

      // Initialize fileResults array only if not already present.
      // Preserve existing state (done/deleted/error) so re-uploads skip those.
      useTaskStore.getState().setItems((prev) => {
        const existing = prev.find((i) => i.id === itemId)?.uploads?.[dest.id]
          ?.fileResults;
        if (existing && existing.length === files.length) {
          // Already initialized; just update dest status to uploading
          return patchUpload(prev, itemId, dest.id, {
            status: "uploading",
            error: undefined,
          });
        }
        // Fresh upload: initialize all as idle
        return patchUpload(prev, itemId, dest.id, {
          status: "uploading",
          progress: 0,
          error: undefined,
          fileResults: files.map((f) => ({
            status: "idle",
            progress: 0,
            filename: f.name,
          })),
        });
      });

      // Upload each file sequentially (skip only already-done files)
      for (let i = 0; i < files.length; i++) {
        // Read current state to check file status
        const currentItems = useTaskStore.getState().items;
        const currentItem = currentItems.find((it) => it.id === itemId);
        const fr = currentItem?.uploads?.[dest.id]?.fileResults?.[i];
        // Skip files already uploaded successfully (deleted/errored/idle files will be uploaded)
        if (fr?.status === "done") continue;

        try {
          await uploadSingleFile(itemId, dest, i, files[i].blob, files[i].name);
        } catch {
          // File failed; continue to next file
        }

        // After each file, derive destination-level state from fileResults
        const updatedItems = useTaskStore.getState().items;
        const updatedItem = updatedItems.find((it) => it.id === itemId);
        const fileResults = updatedItem?.uploads?.[dest.id]?.fileResults;
        if (fileResults) {
          const {
            status: derivedStatus,
            progress: derivedProgress,
            error: derivedError,
          } = deriveDestState(fileResults);
          // Also set result to first successful upload for backward compat
          const firstDone = fileResults.find((f) => f.status === "done");
          const patch: Partial<DestinationUploadState> = {
            status: derivedStatus,
            progress: derivedProgress,
            error: derivedError,
          };
          if (firstDone) patch.result = firstDone.result;
          useTaskStore
            .getState()
            .setItems((prev) => patchUpload(prev, itemId, dest.id, patch));
        }
      }
    },

    uploadItem: async (itemId, destinations) => {
      const enabled = destinations.filter((d) => d.enabled);
      const uploadToDest = useUploadStore.getState().uploadItemToDest;
      for (const dest of enabled) {
        const items = useTaskStore.getState().items;
        const item = items.find((i) => i.id === itemId);
        const state = item?.uploads?.[dest.id];
        // Skip if every file is done (i.e. nothing needs upload)
        // Also skip if any file is currently uploading
        if (state?.fileResults) {
          const allFullyDone = state.fileResults.every(
            (f) => f.status === "done",
          );
          const anyUploading = state.fileResults.some(
            (f) => f.status === "uploading",
          );
          if (allFullyDone || anyUploading) continue;
        } else if (state?.status === "done" || state?.status === "uploading") {
          continue;
        }
        // Skip destinations that don't accept this task's files
        if (!item || !isItemUploadEligible(item, dest)) continue;
        await uploadToDest(itemId, dest);
      }
    },

    uploadAll: async (destinations) => {
      const state = useUploadStore.getState();
      if (state.isUploadingAll) return;
      const enabled = destinations.filter((d) => d.enabled);
      if (!enabled.length) return;

      const items = useTaskStore.getState().items;
      const pending = items.filter(
        (i) =>
          i.status === "done" &&
          i.outputName &&
          (i.outputBlob || (i.galleryImages && i.galleryImages.length > 0)),
      );
      if (!pending.length) return;

      // Count total file uploads across all tasks and destinations
      const totalUploads =
        pending.reduce((sum, item) => {
          const fileCount = getUploadFiles(item).length;
          return sum + fileCount;
        }, 0) * enabled.length;

      // Start attempted from already-done uploads so the counter doesn't
      // jump back to 0 on subsequent "Upload All" clicks
      const alreadyDone = pending.reduce((sum, item) => {
        let count = 0;
        for (const dest of enabled) {
          const destState = item.uploads?.[dest.id];
          if (destState?.fileResults) {
            count += destState.fileResults.filter(
              (fr) => fr.status === "done",
            ).length;
          } else if (destState?.status === "done") {
            count += getUploadFiles(item).length;
          }
        }
        return sum + count;
      }, 0);

      set(() => ({
        uploadProgress: { total: totalUploads, attempted: alreadyDone },
        isUploadingAll: true,
      }));

      // Detect CORS tunnel availability at the start of the upload batch
      // so the proxy can be used immediately if the userscript is installed.
      await detectCORSTunnelAvailable();

      // If the userscript responded but with an outdated version, show the
      // outdated modal instead of proceeding with uploads.
      if (hasVersionMismatch()) {
        set(() => ({ showCORSOutdatedModal: true }));
        return;
      }

      try {
        let attempted = 0;
        const uploadToDest = useUploadStore.getState().uploadItemToDest;
        for (const item of pending) {
          for (const dest of enabled) {
            const currentItems = useTaskStore.getState().items;
            const currentItem = currentItems.find((i) => i.id === item.id);
            const uploadState = currentItem?.uploads?.[dest.id];

            // Skip only if every file is done
            if (uploadState?.fileResults) {
              const allFullyDone = uploadState.fileResults.every(
                (f) => f.status === "done",
              );
              if (allFullyDone) continue;
            } else if (uploadState?.status === "done") {
              continue;
            }

            // Skip destinations that don't accept this task's files
            if (!currentItem || !isItemUploadEligible(currentItem, dest))
              continue;

            if (attempted > 0) await sleep(UPLOAD_DELAY_MS);

            await uploadToDest(item.id, dest);
            attempted++;

            set(() => ({
              uploadProgress: {
                total: totalUploads,
                attempted: alreadyDone + attempted,
              },
            }));
          }
        }
      } finally {
        set(() => ({ isUploadingAll: false }));
      }
    },

    removeFileResult: (itemId, destId, fileIndex) => {
      // Mark the file as deleted (keeps its slot so frame numbering stays stable)
      useTaskStore.getState().setItems((prev) => {
        const items = prev;
        const taskIdx = items.findIndex((t) => t.id === itemId);
        if (taskIdx === -1) return items;
        const task = items[taskIdx];
        const destState = task.uploads?.[destId];
        if (!destState?.fileResults) return items;
        const newResults = destState.fileResults.map((fr, i) => {
          if (i === fileIndex) {
            return {
              ...fr,
              status: "deleted" as const,
              progress: 0,
              result: undefined,
              error: undefined,
            };
          }
          return fr;
        });
        // Re-derive dest state from non-deleted files
        const { status, progress } = deriveDestState(newResults);
        const firstDone = newResults.find((f) => f.status === "done");
        return patchUpload(items, itemId, destId, {
          status,
          progress,
          result: firstDone?.result,
          fileResults: newResults,
        });
      });
    },

    clearUploadResult: (itemId, destId, fileIndex) => {
      if (fileIndex != null) {
        // Clear only one file's result
        useTaskStore.getState().setItems((prev) =>
          patchFileResult(prev, itemId, destId, fileIndex, {
            status: "idle",
            progress: 0,
            result: undefined,
            error: undefined,
          }),
        );
        // Re-derive destination-level state after clearing one file
        const items = useTaskStore.getState().items;
        const item = items.find((i) => i.id === itemId);
        const fileResults = item?.uploads?.[destId]?.fileResults;
        if (fileResults) {
          const { status, progress } = deriveDestState(fileResults);
          const firstDone = fileResults.find((f) => f.status === "done");
          useTaskStore.getState().setItems((prev) =>
            patchUpload(prev, itemId, destId, {
              status,
              progress,
              result: firstDone?.result,
            }),
          );
        }
      } else {
        // Clear entire destination upload state
        useTaskStore.getState().setItems((prev) =>
          patchUpload(prev, itemId, destId, {
            status: "idle",
            progress: 0,
            result: undefined,
            error: undefined,
            fileResults: undefined,
          }),
        );
      }
    },

    retryFailedFiles: async (itemId, destId) => {
      const items = useTaskStore.getState().items;
      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const destState = item.uploads?.[destId];
      if (!destState?.fileResults) return;

      // Find the matching destination config from settings
      const settingsStore = await import("./settingsStore");
      const settings = settingsStore.useSettingsStore.getState().settings;
      const dest = settings?.destinations?.find(
        (d: UploadDestination) => d.id === destId,
      );
      if (!dest) return;

      const files = getUploadFiles(item);

      for (let i = 0; i < destState.fileResults.length; i++) {
        const fr = destState.fileResults[i];
        if (fr.status !== "error") continue;
        if (!files[i]) continue;

        try {
          await uploadSingleFile(itemId, dest, i, files[i].blob, files[i].name);
        } catch {
          // File failed again; leave error state
        }

        // Re-derive destination-level state
        const currentItems = useTaskStore.getState().items;
        const currentItem = currentItems.find((it) => it.id === itemId);
        const updatedResults = currentItem?.uploads?.[destId]?.fileResults;
        if (updatedResults) {
          const { status, progress } = deriveDestState(updatedResults);
          const firstDone = updatedResults.find((f) => f.status === "done");
          useTaskStore.getState().setItems((prev) =>
            patchUpload(prev, itemId, destId, {
              status,
              progress,
              result: firstDone?.result,
            }),
          );
        }
      }
    },

    retrySingleFile: async (itemId, destId, fileIndex) => {
      const items = useTaskStore.getState().items;
      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const destState = item.uploads?.[destId];
      if (!destState?.fileResults) return;

      const settingsStore2 = await import("./settingsStore");
      const settings2 = settingsStore2.useSettingsStore.getState().settings;
      const dest = settings2?.destinations?.find(
        (d: UploadDestination) => d.id === destId,
      );
      if (!dest) return;

      const files = getUploadFiles(item);
      if (!files[fileIndex]) return;

      // Reset the file to idle so it can be re-uploaded
      useTaskStore.getState().setItems((prev) =>
        patchFileResult(prev, itemId, destId, fileIndex, {
          status: "idle",
          progress: 0,
          result: undefined,
          error: undefined,
        }),
      );

      try {
        await uploadSingleFile(
          itemId,
          dest,
          fileIndex,
          files[fileIndex].blob,
          files[fileIndex].name,
        );
      } catch {
        // File failed again; leave error state
      }

      // Re-derive destination-level state
      const currentItems = useTaskStore.getState().items;
      const currentItem = currentItems.find((it) => it.id === itemId);
      const updatedResults = currentItem?.uploads?.[destId]?.fileResults;
      if (updatedResults) {
        const { status, progress } = deriveDestState(updatedResults);
        const firstDone = updatedResults.find((f) => f.status === "done");
        useTaskStore.getState().setItems((prev) =>
          patchUpload(prev, itemId, destId, {
            status,
            progress,
            result: firstDone?.result,
          }),
        );
      }
    },
  })),
);
