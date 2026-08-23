import { PROJECT_NAME, UPLOAD_TIMEOUT_MS } from "@/constants";
import type { UploadDestination, UploadResult } from "@/types";
import type { UploadProvider } from "./providers";
import {
  CORSError,
  isCORSError,
  proxyFetch,
  detectCORSTunnelAvailable,
  getCORSStatus,
} from "@/lib/cors-tunnel";

// -- API response types --

interface FilesterUploadSuccess {
  success: true;
  message: string;
  slug: string;
  url?: string;
  file_id: number;
  thumbnail_url?: string;
}

interface FilesterUploadError {
  success: false;
  error: {
    message: string;
    code: string;
  };
}

type FilesterUploadResponse = FilesterUploadSuccess | FilesterUploadError;

// -- Provider --

/**
 * Upload a Blob to Filester using the /api/v1/upload endpoint.
 * Uses multipart/form-data with the "file" field.
 * Auth via Authorization: Bearer header (optional – guest uploads allowed).
 * Falls back to the CORS tunnel userscript when a cross-origin error occurs.
 */
async function upload(
  blob: Blob,
  filename: string,
  dest: UploadDestination,
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  const uploadEndpoint = `${dest.url}/api/v1/upload`;

  const formData = new FormData();
  formData.append("file", blob, filename);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    onProgress(10);

    const headers: Record<string, string> = {};
    if (dest.apiKey) {
      headers.Authorization = `Bearer ${dest.apiKey}`;
    }

    // Use proxy directly if CORS tunnel is already detected, otherwise try native fetch
    let response: Response;
    if (getCORSStatus().available) {
      response = await proxyFetch(uploadEndpoint, {
        method: "POST",
        body: formData,
        headers,
      });
    } else {
      try {
        response = await fetch(uploadEndpoint, {
          method: "POST",
          body: formData,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeoutId);
        if (controller.signal.aborted) {
          throw new Error("Upload timed out");
        }
        if (!isCORSError(error)) {
          throw error;
        }
        // CORS blocked – fall back to userscript proxy
        const available = await detectCORSTunnelAvailable();
        if (!available) {
          throw new CORSError(
            "CORS blocked and no userscript proxy is available. " +
              `Please install the ${PROJECT_NAME} CORS Tunnel userscript.`,
            uploadEndpoint,
          );
        }
        response = await proxyFetch(uploadEndpoint, {
          method: "POST",
          body: formData,
          headers,
        });
      }
    }

    clearTimeout(timeoutId);
    onProgress(90);

    // Read body as text first so we can handle non-JSON responses properly
    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Filester HTTP ${response.status}${bodyText ? ` — ${bodyText}` : ""}`,
      );
    }

    // Parse JSON and validate response structure
    let json: FilesterUploadResponse;
    try {
      json = JSON.parse(bodyText) as FilesterUploadResponse;
    } catch {
      throw new Error(`Filester returned non-JSON response: ${bodyText}`);
    }

    // Validate that the response has the expected structure
    if (
      typeof json !== "object" ||
      json === null ||
      "success" in json === false
    ) {
      throw new Error(`Filester returned an invalid response: ${bodyText}`);
    }

    onProgress(100);

    if (!json.success) {
      throw new Error(
        json.error?.message ?? json.error?.code ?? "Filester upload failed",
      );
    }

    const slug = json.slug;
    if (!slug) {
      throw new Error(
        `Filester upload succeeded but no slug returned: ${bodyText}`,
      );
    }

    // url field may be missing in some responses – construct from slug as fallback
    const baseUrl = "https://filester.me";
    const directUrl = json.url ?? `${baseUrl}/d/${slug}`;
    const pageUrl = directUrl;

    // thumbnail_url is optional – fall back to directUrl for display.
    // However, for .webp files Filester returns a thumbnail_url that points to a 404
    // (no thumbnail generated for animated WEBP), so we use pageUrl instead.
    const isWebp = filename.toLowerCase().endsWith(".webp");
    let thumbUrl: string;
    if (isWebp) {
      thumbUrl = pageUrl;
    } else {
      thumbUrl = json.thumbnail_url
        ? json.thumbnail_url.startsWith("http")
          ? json.thumbnail_url
          : `${baseUrl}${json.thumbnail_url}`
        : directUrl;
    }

    return {
      directUrl,
      pageUrl,
      thumbUrl,
      deleteUrl: slug,
      deleteToken: slug,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new Error("Upload timed out");
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Network error during upload");
  }
}

/**
 * Permanently delete a file from Filester using POST /file/delete.
 * The slug is sent in the "identifiers" JSON array.
 * Auth via Authorization: Bearer header (mandatory).
 * Uses CORS tunnel when available to avoid cross-origin restrictions.
 */
async function deleteFile(
  result: UploadResult,
  dest: UploadDestination,
): Promise<void> {
  const slug = result.deleteUrl;
  if (!slug) {
    throw new Error("Cannot delete: file slug not available");
  }

  const deleteEndpoint = `${dest.url}/file/delete`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${dest.apiKey}`,
    "Content-Type": "application/json",
  };

  // Use proxy directly if CORS tunnel is already detected, otherwise try native fetch
  let response: Response;
  if (getCORSStatus().available) {
    response = await proxyFetch(deleteEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ identifiers: [slug] }),
    });
  } else {
    try {
      response = await fetch(deleteEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ identifiers: [slug] }),
      });
    } catch (error) {
      if (!isCORSError(error)) {
        throw error;
      }
      // CORS blocked – fall back to userscript proxy
      const available = await detectCORSTunnelAvailable();
      if (!available) {
        throw new CORSError(
          "CORS blocked and no userscript proxy is available. " +
            `Please install the ${PROJECT_NAME} CORS Tunnel userscript.`,
          deleteEndpoint,
        );
      }
      response = await proxyFetch(deleteEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ identifiers: [slug] }),
      });
    }
  }

  // Read body as text first so we can handle non-JSON responses properly
  const bodyText = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(
      `Filester delete failed: HTTP ${response.status}${bodyText ? ` — ${bodyText}` : ""}`,
    );
  }

  // Delete endpoint returns JSON on success – validate it
  if (bodyText.trim()) {
    let json: { success: boolean; error?: { message?: string; code?: string } };
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new Error(
        `Filester delete returned non-JSON response: ${bodyText}`,
      );
    }

    if (typeof json !== "object" || json === null || !("success" in json)) {
      throw new Error(
        `Filester delete returned an invalid response: ${bodyText}`,
      );
    }

    if (!json.success) {
      throw new Error(
        `Filester delete failed: ${json.error?.message ?? json.error?.code ?? "unknown error"}`,
      );
    }
  }
}

export const filesterProvider: UploadProvider = {
  type: "filester",
  optionsSchema: [],
  upload,
  delete: deleteFile,
  canDelete: (_result: UploadResult, dest: UploadDestination): boolean =>
    !!dest.apiKey,
};
