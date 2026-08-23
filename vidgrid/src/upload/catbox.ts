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

// -- Upload --

/**
 * Upload a Blob to Catbox (catbox.moe) using the binary upload API.
 * Falls back to the CORS tunnel userscript when a cross-origin error occurs.
 */
async function upload(
  blob: Blob,
  filename: string,
  dest: UploadDestination,
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  const url = dest.url;
  const userhash = dest.apiKey;

  const extension = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1)
    : "jpg";

  const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
  const CRLF = "\r\n";

  let bodyParts = "";
  bodyParts += `${CRLF}--${boundary}${CRLF}`;
  bodyParts += `Content-Disposition: form-data; name="reqtype"${CRLF}${CRLF}`;
  bodyParts += "fileupload";
  bodyParts += `${CRLF}--${boundary}${CRLF}`;

  if (userhash) {
    bodyParts += `Content-Disposition: form-data; name="userhash"${CRLF}${CRLF}`;
    bodyParts += userhash;
    bodyParts += `${CRLF}--${boundary}${CRLF}`;
  }

  bodyParts += `Content-Disposition: form-data; name="fileToUpload"; filename="file.${extension}"${CRLF}`;
  bodyParts += `Content-Type: ${blob.type || "application/octet-stream"}${CRLF}${CRLF}`;

  const headerBytes = new TextEncoder().encode(bodyParts);
  const footerBytes = new TextEncoder().encode(`${CRLF}--${boundary}--${CRLF}`);
  const totalSize = headerBytes.length + blob.size + footerBytes.length;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(headerBytes);
      const chunk = await blob.slice(0, blob.size).arrayBuffer();
      controller.enqueue(new Uint8Array(chunk));
      controller.enqueue(footerBytes);
      controller.close();
    },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    let loaded = 0;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(Math.round((loaded / totalSize) * 100));
    }

    const bodyBuffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      bodyBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    // Use proxy directly if CORS tunnel is already detected, otherwise try native fetch
    let response: Response;
    if (getCORSStatus().available) {
      response = await proxyFetch(url, {
        method: "POST",
        body: bodyBuffer,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      });
    } else {
      try {
        response = await fetch(url, {
          method: "POST",
          body: bodyBuffer,
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
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
            url,
          );
        }
        response = await proxyFetch(url, {
          method: "POST",
          body: bodyBuffer,
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
        });
      }
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Catbox HTTP ${response.status}`);
    }

    const catboxUrl = (await response.text()).trim();

    if (!catboxUrl.includes("files.catbox.moe/")) {
      throw new Error(`Catbox returned an invalid URL: ${catboxUrl}`);
    }

    onProgress(100);

    return {
      directUrl: catboxUrl,
      pageUrl: catboxUrl,
      thumbUrl: catboxUrl,
      deleteUrl: catboxUrl,
      deleteToken: userhash || undefined,
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

// -- Delete --

async function deleteFile(
  result: UploadResult,
  dest: UploadDestination,
): Promise<void> {
  const userhash = result.deleteToken || dest.apiKey;
  if (!userhash) {
    throw new Error("Cannot delete: no userhash available");
  }

  const filename = result.deleteUrl.split("/").pop() || result.deleteUrl;

  const params = new URLSearchParams();
  params.append("reqtype", "deletefiles");
  params.append("userhash", userhash);
  params.append("files", filename);

  // Use proxy directly if CORS tunnel is already detected, otherwise try native fetch
  let response: Response;
  if (getCORSStatus().available) {
    response = await proxyFetch(dest.url, {
      method: "POST",
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } else {
    try {
      response = await fetch(dest.url, {
        method: "POST",
        body: params.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
          dest.url,
        );
      }
      response = await proxyFetch(dest.url, {
        method: "POST",
        body: params.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }
  }

  if (!response.ok) {
    throw new Error(`Catbox delete failed: HTTP ${response.status}`);
  }

  const text = (await response.text()).trim();
  if (!text.includes("successfully deleted")) {
    throw new Error(`Catbox delete failed: ${text}`);
  }
}

// -- Provider export --

export const catboxProvider: UploadProvider = {
  type: "catbox",
  optionsSchema: [],
  upload,
  delete: deleteFile,
  canDelete: (result: UploadResult, dest: UploadDestination): boolean =>
    !!result.deleteUrl && !!(result.deleteToken || dest.apiKey),
};
