/**
 * Global cache for ObjectURLs created from Blobs.
 *
 * Problem: URL.createObjectURL() creates a string reference that must be
 * revoked with URL.revokeObjectURL() when no longer needed. However, the
 * blob itself may still be in use (for download, upload, ZIP generation).
 *
 * Solution: Cache ObjectURLs per Blob so:
 * - The same blob never gets multiple URLs
 * - URLs are only revoked when explicitly requested (task removal) or on app unload
 * - Components can safely get/revoke URLs without managing lifecycle themselves
 */

const cache = new Map<Blob, string>();

/**
 * Get a cached ObjectURL for a blob, or create one if it doesn't exist.
 */
export function getOrCreateUrl(blob: Blob): string {
  let url = cache.get(blob);
  if (url === undefined) {
    url = URL.createObjectURL(blob);
    cache.set(blob, url);
  }
  return url;
}

/**
 * Release (revoke) the ObjectURL for a specific blob.
 * Call this when a task item is removed from the list.
 */
export function releaseByBlob(blob: Blob): void {
  const url = cache.get(blob);
  if (url !== undefined) {
    URL.revokeObjectURL(url);
    cache.delete(blob);
  }
}

/**
 * Release ALL cached ObjectURLs.
 * Call this on page unload to prevent memory leaks.
 */
export function releaseAll(): void {
  cache.forEach((url) => {
    URL.revokeObjectURL(url);
  });
  cache.clear();
}

/**
 * Get the cached URL for a blob without creating one.
 * Returns undefined if the blob is not cached.
 */
export function getUrl(blob: Blob): string | undefined {
  return cache.get(blob);
}
