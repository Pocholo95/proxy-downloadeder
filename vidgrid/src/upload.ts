import type { UploadDestination, UploadResult } from "./types";
import { getProvider, registerProvider } from "./upload/providers";
import { cheveretoProvider } from "./upload/chevereto";
import { catboxProvider } from "./upload/catbox";
import { imgeProvider } from "./upload/imge";
import { filesterProvider } from "./upload/filester";

// Register all available providers at module load time
registerProvider(cheveretoProvider);
registerProvider(catboxProvider);
registerProvider(imgeProvider);
registerProvider(filesterProvider);

/**
 * Upload a Blob to the given destination, dispatching to the correct
 * provider implementation. Throws on failure so the caller can record the error.
 *
 * @param blob        - Image data to upload.
 * @param filename    - Suggested filename for the host.
 * @param destination - Target upload destination config.
 * @param onProgress  - Called with 0-100 during upload.
 */
export const uploadBlob = (
  blob: Blob,
  filename: string,
  destination: UploadDestination,
  onProgress: (pct: number) => void,
): Promise<UploadResult> => {
  let provider: ReturnType<typeof getProvider>;
  try {
    provider = getProvider(destination.type);
  } catch (err) {
    return Promise.reject(err);
  }
  return provider.upload(blob, filename, destination, onProgress);
};

/**
 * Check whether the provider supports deletion for the given upload result.
 */
export const canDeleteFromDestination = (
  result: UploadResult,
  destination: UploadDestination,
): boolean => {
  const provider = getProvider(destination.type);
  if (provider.canDelete) {
    return provider.canDelete(result, destination);
  }
  // Default: if provider has a delete method, deletion is possible
  return !!provider.delete;
};

/**
 * Delete a previously uploaded file via the provider's delete method (if any).
 * Returns undefined for providers that do not support deletion.
 */
export const deleteFromDestination = async (
  result: UploadResult,
  destination: UploadDestination,
): Promise<void> => {
  const provider = getProvider(destination.type);
  if (provider.delete) {
    await provider.delete(result, destination);
  }
};
