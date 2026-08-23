import { PROJECT_NAME, UPLOAD_TIMEOUT_MS } from "@/constants";
import type { UploadDestination, UploadResult } from "@/types";
import type { UploadProvider, ProviderOptionSchema } from "./providers";
import {
  CORSError,
  isCORSError,
  proxyFetch,
  detectCORSTunnelAvailable,
  getCORSStatus,
} from "@/lib/cors-tunnel";

// -- API response types --

interface ImgeUploadSuccess {
  success: true;
  data: {
    code: string;
    direct_url: string;
    viewer_url: string;
    thumb_url: string;
    delete_url: string;
  };
}

interface ImgeUploadError {
  success: false;
  error: {
    message: string;
    code: string;
  };
}

type ImgeUploadResponse = ImgeUploadSuccess | ImgeUploadError;

// -- Options schema --

const OPTIONS_SCHEMA: ProviderOptionSchema[] = [
  {
    key: "nsfw",
    label: "NSFW",
    description: "Mark uploads as Not-Safe-For-Work content.",
    type: "boolean",
    defaultValue: true,
  },
];

// -- Provider --

/**
 * Upload a Blob to im.ge using the /api/v1/upload endpoint.
 * Uses multipart/form-data with the "image" field per the OpenAPI spec.
 * Auth via Authorization: Bearer header.
 * Falls back to the CORS tunnel userscript when a cross-origin error occurs.
 */
async function upload(
  blob: Blob,
  filename: string,
  dest: UploadDestination,
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  const uploadEndpoint = `${dest.url}/api/v1/upload`;

  const nsfw = (dest.options?.nsfw as boolean) ?? false;

  const formData = new FormData();
  formData.append("image", blob, filename);

  if (nsfw) {
    formData.append("nsfw", "true");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    onProgress(10);

    const headers: Record<string, string> = {};

    if (dest.apiKey) {
      headers["Authorization"] = `Bearer ${dest.apiKey}`;
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

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `im.ge HTTP ${response.status}${errorText ? ` — ${errorText}` : ""}`,
      );
    }

    const json: ImgeUploadResponse = await response.json();
    onProgress(100);

    if (!json.success) {
      throw new Error(json.error?.message ?? "im.ge upload failed");
    }

    const directUrl = json.data.direct_url;
    const pageUrl = json.data.viewer_url;
    const thumbUrl = json.data.thumb_url;
    const code = json.data.code;

    // Extract the delete token from the delete_url returned by the API.
    // Format: https://im.ge/i/{code}/delete/{token}
    const deleteUrlParts = json.data.delete_url.split("/delete/");
    const deleteToken = deleteUrlParts[1] || undefined;

    return {
      directUrl,
      pageUrl,
      thumbUrl,
      deleteUrl: code,
      deleteToken,
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
 * Permanently delete an image from im.ge using the public delete endpoint.
 * Uses /api/v1/delete/:code/:delete_token which does not require API key
 * permissions. The delete_token is provided in the upload response.
 * Uses CORS tunnel when available to avoid cross-origin restrictions.
 */
async function deleteFile(
  result: UploadResult,
  dest: UploadDestination,
): Promise<void> {
  const code = result.deleteUrl;
  if (!code) {
    throw new Error("Cannot delete: image code not available");
  }

  const deleteToken = result.deleteToken;
  if (!deleteToken) {
    throw new Error("Cannot delete: delete token not available");
  }

  const deleteEndpoint = `${dest.url}/api/v1/delete/${code}/${deleteToken}`;

  // Use proxy directly if CORS tunnel is already detected, otherwise try native fetch
  let response: Response;
  if (getCORSStatus().available) {
    response = await proxyFetch(deleteEndpoint, { method: "DELETE" });
  } else {
    try {
      response = await fetch(deleteEndpoint, { method: "DELETE" });
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
      response = await proxyFetch(deleteEndpoint, { method: "DELETE" });
    }
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `im.ge delete failed: HTTP ${response.status}${errorText ? ` — ${errorText}` : ""}`,
    );
  }
}

export const imgeProvider: UploadProvider = {
  type: "imge",
  optionsSchema: OPTIONS_SCHEMA,
  upload,
  delete: deleteFile,
  canDelete: (_result: UploadResult, dest: UploadDestination): boolean =>
    !!dest.apiKey,
};
