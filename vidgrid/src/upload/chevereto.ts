import { PROJECT_NAME, UPLOAD_TIMEOUT_MS } from "@/constants";
import { withoutExtension } from "@/utils";
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

interface CheveretoSuccessResponse {
  success: true;
  data: {
    url: string;
    url_viewer: string;
    delete_url: string;
    medium?: { url?: string | null };
    thumb?: { url: string | null };
  };
}

interface CheveretoErrorResponse {
  status_code: number;
  error: {
    message: string;
    code?: number;
  };
  status_txt?: string;
}

type CheveretoResponse = CheveretoSuccessResponse | CheveretoErrorResponse;

// -- Helpers --

/**
 * Builds the upload URL by substituting the `{key}` placeholder with the
 * URL-encoded API key. Throws if the URL is invalid, does not use HTTPS,
 * or does not contain the `{key}` placeholder.
 */
function buildUploadUrl(urlTemplate: string, apiKey: string): string {
  try {
    new URL(urlTemplate);
  } catch {
    throw new Error("Upload URL is not a valid URL.");
  }
  if (!urlTemplate.startsWith("https://")) {
    throw new Error("Upload URL must use HTTPS.");
  }
  if (!urlTemplate.includes("{key}")) {
    throw new Error(
      "Upload URL must contain {key} as a placeholder for the API key.",
    );
  }
  return urlTemplate.replaceAll("{key}", encodeURIComponent(apiKey));
}

/** Read a Blob as a base64 data URL. */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image data"));
    reader.onload = () => {
      const result = (reader.result as string).split(",")[1];
      if (!result) {
        reject(new Error("Empty base64 data"));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

// -- Provider --

/**
 * Upload a Blob to a Chevereto-compatible host using the v1 API.
 * Falls back to the CORS tunnel userscript when a cross-origin error occurs.
 */
async function upload(
  blob: Blob,
  filename: string,
  dest: UploadDestination,
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  const uploadUrl = buildUploadUrl(dest.url, dest.apiKey);
  const b64 = await blobToBase64(blob);

  const formData = new FormData();
  formData.append("image", b64);
  formData.append("name", withoutExtension(filename));

  let status: number;
  let responseText: string;

  if (getCORSStatus().available) {
    // Use proxy directly when tunnel is detected.
    // proxyFetch properly handles FormData by sending structured form data
    // (formdata-v2) so the userscript can reconstruct the multipart body.
    const proxied = await proxyFetch(uploadUrl, {
      method: "POST",
      body: formData,
    });
    status = proxied.status;
    responseText = await proxied.text();
    onProgress(100);
  } else {
    // Try native XHR first - send FormData directly so the browser handles
    // Content-Type (multipart/form-data) and boundaries automatically
    try {
      const xhrResult = await new Promise<{
        status: number;
        responseText: string;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const timeoutId = setTimeout(() => xhr.abort(), UPLOAD_TIMEOUT_MS);

        xhr.open("POST", uploadUrl);
        xhr.timeout = UPLOAD_TIMEOUT_MS;

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };

        xhr.onload = () => {
          clearTimeout(timeoutId);
          resolve({ status: xhr.status, responseText: xhr.responseText });
        };

        xhr.onerror = () => {
          clearTimeout(timeoutId);
          reject(new Error("Network error during upload"));
        };

        xhr.ontimeout = () => {
          clearTimeout(timeoutId);
          reject(new Error("Upload timed out"));
        };

        xhr.onabort = () => {
          clearTimeout(timeoutId);
          reject(new Error("Upload timed out"));
        };

        xhr.send(formData);
      });
      ({ status, responseText } = xhrResult);
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
          uploadUrl,
        );
      }
      const proxied = await proxyFetch(uploadUrl, {
        method: "POST",
        body: formData,
      });
      status = proxied.status;
      responseText = await proxied.text();
      onProgress(100);
    }
  }

  let json: CheveretoResponse;
  try {
    json = JSON.parse(responseText) as CheveretoResponse;
  } catch {
    throw new Error(`Chevereto HTTP ${status} — invalid response`);
  }

  if ("error" in json && json.error?.message) {
    throw new Error(json.error.message);
  }

  if (status !== 200) {
    throw new Error(`Chevereto HTTP ${status}`);
  }

  onProgress(100);

  if ("success" in json && json.success) {
    return {
      directUrl: json.data.url,
      pageUrl: json.data.url_viewer,
      mediumUrl: json.data.medium?.url ?? undefined,
      thumbUrl: json.data.thumb?.url ?? json.data.url,
      deleteUrl: json.data.delete_url,
    };
  }

  throw new Error("Chevereto returned an error");
}

export const cheveretoProvider: UploadProvider = {
  type: "chevereto",
  optionsSchema: [],
  upload,
  canDelete: (result: UploadResult): boolean => !!result.deleteUrl,
};
