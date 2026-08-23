/**
 * CORS Tunnel – proxy upload requests through a userscript to bypass
 * cross-origin restrictions imposed by some image/video hosting APIs.
 *
 * The web app cannot call GM_xmlhttpRequest directly (it exists only inside
 * the userscript sandbox).  Communication happens via window.postMessage.
 */

import { PROJECT_NAME } from "@/constants";
import userscriptTemplate from "./cors-tunnel.template.js?raw";
import { loadAppSettings, persistAppSettings } from "@/presets";

// ─── Public types ────────────────────────────────────────────────────

export interface CORSTunnelFormField {
  key: string;
  value: string;
}

export interface CORSTunnelFormFile {
  key: string;
  data: string; // base64-encoded binary
  filename: string;
  contentType: string;
}

export interface CORSTunnelFormData {
  fields: CORSTunnelFormField[];
  files: CORSTunnelFormFile[];
}

export interface CORSTunnelRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  bodyType?: "formdata" | "arraybuffer" | "formdata-v2";
  formData?: CORSTunnelFormData;
}

export interface CORSTunnelResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

export interface CORSTunnelPong {
  type: "cors-tunnel-pong";
  id: string;
  version: string;
}

/** In-memory state that tracks proxy availability for the current session. */
export interface CORSTunnelState {
  /** Whether a userscript responded to a ping with a matching version. */
  available: boolean;
  /** Version string reported by the userscript (only when available). */
  version?: string;
  /** Whether the CORS help modal was already shown for this upload batch. */
  modalShownThisBatch: boolean;
  /** True when the userscript responded but with an outdated version. */
  versionMismatch: boolean;
  /** The outdated version string reported by the userscript (when mismatched). */
  installedVersion?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Userscript version (must match the template's @version header). */
export const USERSCRIPT_VERSION = "1.0.0";

/** Timeout (ms) for the ping/pong availability check. */
const PING_TIMEOUT_MS = 3000;

/** Timeout (ms) for a proxied request. */
const PROXY_TIMEOUT_MS = 70000;

// ─── State (module-level singleton) ──────────────────────────────────

let tunnelState: CORSTunnelState = {
  available: false,
  modalShownThisBatch: false,
  versionMismatch: false,
};

export function getCORSStatus(): CORSTunnelState {
  return { ...tunnelState };
}

export function setCORSStatus(state: CORSTunnelState) {
  tunnelState = { ...state };
}

/** Reset per-batch tracking (call at the start of a new upload batch). */
export function resetBatchState() {
  tunnelState.modalShownThisBatch = false;
  tunnelState.versionMismatch = false;
  tunnelState.installedVersion = undefined;
}

// ─── CORS error detection ────────────────────────────────────────────

/**
 * Error class that wraps a CORS failure so upstream handlers can
 * reliably identify it without parsing error messages.
 */
export class CORSError extends Error {
  public readonly isCORSError = true;
  public readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = "CORSError";
    this.url = url;
  }
}

/**
 * Heuristic check: does the given error look like a CORS failure?
 *
 * Browsers throw different messages depending on the engine:
 *   Chrome/Firefox:  TypeError: "Failed to fetch" / "NetworkError when attempting to fetch resource"
 *   Safari:         DOMException: "Load failed"
 */
export function isCORSError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Already classified as CORSError
  if (error instanceof CORSError) return true;

  const msg = error.message.toLowerCase();
  const type = error.constructor.name.toLowerCase();

  // Chrome / Firefox
  if (type === "typeerror" && /failed to fetch|networkerror/i.test(msg)) {
    return true;
  }

  // Safari
  if (type === "domexception" && /load failed/i.test(msg)) {
    return true;
  }

  return false;
}

// ─── postMessage communication ───────────────────────────────────────

const DEBUG = import.meta.env.VITE_DEBUG === "true";
const LOGPREFIX = `[${PROJECT_NAME} CORS Tunnel - App]`;

/**
 * Send a message to the userscript and wait for a response matching
 * the given `id`.  Returns `null` if the timeout expires.
 *
 * IMPORTANT: `window.postMessage` delivers messages to the sender itself,
 * so the handler receives the outgoing message before the userscript can
 * respond.  We filter by message type to only accept response messages
 * (pong / response), not the outgoing request messages.
 */
function sendMessage<T>(
  message: Record<string, unknown>,
  timeout = 5000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (DEBUG) console.warn(LOGPREFIX, "sendMessage timeout", message.type);
      window.removeEventListener("message", handler);
      resolve(null);
    }, timeout);

    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;

      // Only accept response-type messages.  `window.postMessage` delivers
      // the outgoing message to the sender itself, so without this guard
      // we would resolve with our own ping/request instead of the reply.
      const type = data.type as string | undefined;
      if (type !== "cors-tunnel-pong" && type !== "cors-tunnel-response") {
        if (DEBUG)
          console.debug(LOGPREFIX, "sendMessage ignoring non-response", type);
        return;
      }

      // Also verify the id matches so we don't accidentally consume a
      // response for a different in-flight request.
      if (data.id !== (message.id as string)) {
        if (DEBUG)
          console.debug(
            LOGPREFIX,
            "sendMessage id mismatch",
            data.id,
            message.id,
          );
        return;
      }

      if (DEBUG)
        console.debug(LOGPREFIX, "sendMessage got response", type, data.id);
      clearTimeout(timeoutId);
      window.removeEventListener("message", handler);
      resolve(data as T);
    };

    if (DEBUG)
      console.debug(LOGPREFIX, "sendMessage sending", message.type, message.id);
    window.addEventListener("message", handler);
    window.postMessage(message, window.location.origin);
  });
}

/**
 * Check whether the userscript is installed and responsive by sending
 * a ping and waiting for a pong.  Also validates the script version –
 * if the userscript responds with an outdated version, the tunnel is
 * treated as unavailable so the outdated-modal can be shown instead.
 */
export async function detectCORSTunnelAvailable(): Promise<boolean> {
  const id = `ping-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pong = await sendMessage<CORSTunnelPong>(
    { type: "cors-tunnel-ping", id },
    PING_TIMEOUT_MS,
  );

  if (pong && pong.type === "cors-tunnel-pong") {
    // Version check: reject outdated userscripts
    if (pong.version !== USERSCRIPT_VERSION) {
      tunnelState.available = false;
      tunnelState.versionMismatch = true;
      tunnelState.installedVersion = pong.version;
      return false;
    }
    tunnelState.available = true;
    tunnelState.version = pong.version;
    tunnelState.versionMismatch = false;
    return true;
  }

  tunnelState.available = false;
  tunnelState.versionMismatch = false;
  return false;
}

/**
 * Return true when the userscript responded but with an outdated version.
 * The outdated modal should be shown instead of the "not installed" modal.
 */
export function hasVersionMismatch(): boolean {
  return tunnelState.versionMismatch;
}

/** Return the version string the outdated userscript reported. */
export function getInstalledVersion(): string | undefined {
  return tunnelState.installedVersion;
}

/**
 * Convert a Blob to a base64-encoded string.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:xxx;base64,XXXXX" → strip prefix
      const commaIdx = result.indexOf(",");
      resolve(commaIdx > -1 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert a Uint8Array to a base64 string safely for large payloads.
 *
 * `String.fromCharCode(...bytes)` fails with "too many function arguments"
 * when the array exceeds ~65536 elements (typical for image/video files).
 * This implementation processes the data in safe-sized chunks.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.slice(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Forward a `fetch`-style request through the userscript.
 * Returns a Response-like object.
 *
 * For FormData with file blobs, reads the binary as base64 and sends
 * structured form data so the userscript can reconstruct the exact
 * multipart body transparently.
 */
export async function proxyFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const id = `proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const headers: Record<string, string> = {};
  if (options.headers instanceof Headers) {
    options.headers.forEach((v, k) => (headers[k] = v));
  } else if (typeof options.headers === "object") {
    Object.assign(headers, options.headers);
  }

  let body: string | undefined;
  let bodyType: "formdata" | "arraybuffer" | "formdata-v2" | undefined;
  let formData: CORSTunnelFormData | undefined;

  if (options.body instanceof FormData) {
    // Transparent FormData proxy: separate text fields from file blobs.
    // File blobs are read as base64 so binary data is preserved across
    // the postMessage boundary.
    const fields: CORSTunnelFormField[] = [];
    const files: CORSTunnelFormFile[] = [];

    for (const [key, value] of options.body.entries()) {
      if (value instanceof Blob) {
        const base64 = await blobToBase64(value);
        files.push({
          key,
          data: base64,
          filename: (value as File).name ?? "blob",
          contentType: value.type || "application/octet-stream",
        });
      } else {
        fields.push({ key, value: String(value) });
      }
    }

    formData = { fields, files };
    bodyType = "formdata-v2";
    // Don't set Content-Type – the userscript will build the multipart
    // body and set the correct Content-Type with boundaries.
    delete headers["Content-Type"];
  } else if (options.body instanceof Uint8Array) {
    // catbox sends Uint8Array (not ArrayBuffer) for multipart bodies
    body = uint8ToBase64(options.body);
    bodyType = "arraybuffer";
  } else if (options.body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(options.body);
    body = uint8ToBase64(bytes);
    bodyType = "arraybuffer";
  } else if (ArrayBuffer.isView(options.body)) {
    // Catch-all for other TypedArrays (Int8Array, Float32Array, etc.)
    const bytes = new Uint8Array(options.body.buffer);
    body = uint8ToBase64(bytes);
    bodyType = "arraybuffer";
  } else if (typeof options.body === "string") {
    body = options.body;
  }

  const msg: CORSTunnelRequest = {
    id,
    url,
    method: options.method || "GET",
    headers,
    body,
    bodyType,
    formData,
  };

  // Log outgoing request details
  const headersOut =
    Object.keys(headers).length > 0 ? JSON.stringify(headers) : "(no headers)";
  const bodyPreviewOut = body
    ? body.slice(0, 300) + (body.length > 300 ? "..." : "")
    : "(no body)";
  console.debug(LOGPREFIX, `📤 ${msg.method} ${url}`);
  console.debug(LOGPREFIX, `   Headers: ${headersOut}`);
  console.debug(LOGPREFIX, `   Body: ${bodyPreviewOut}`);

  const response = await sendMessage<CORSTunnelResponse>(
    { ...msg, type: "cors-tunnel-request" },
    PROXY_TIMEOUT_MS,
  );

  if (!response) {
    throw new CORSError("CORS proxy did not respond in time", url);
  }

  // Log response details for debugging (truncated for large bodies)
  if (response.status >= 400 || response.error) {
    const bodyPreview = response.body?.slice(0, 500) ?? "(empty)";
    const headersStr =
      Object.keys(response.headers).length > 0
        ? JSON.stringify(response.headers)
        : "(no headers)";
    console.warn(LOGPREFIX, `❌ ${options.method || "GET"} ${url}`);
    console.warn(LOGPREFIX, `   Status: ${response.status || "error"}`);
    console.warn(LOGPREFIX, `   Headers: ${headersStr}`);
    console.warn(LOGPREFIX, `   Body: ${bodyPreview}`);
    if (response.error) {
      console.warn(LOGPREFIX, `   Error: ${response.error}`);
    }
  }

  // Also log successful responses when DEBUG is enabled
  if (DEBUG && response.status < 400 && !response.error) {
    const bodyPreview = response.body?.slice(0, 300) ?? "(empty)";
    const headersStr =
      Object.keys(response.headers).length > 0
        ? JSON.stringify(response.headers)
        : "(no headers)";
    console.debug(LOGPREFIX, `✅ ${options.method || "GET"} ${url}`);
    console.debug(LOGPREFIX, `   Status: ${response.status}`);
    console.debug(LOGPREFIX, `   Headers: ${headersStr}`);
    console.debug(LOGPREFIX, `   Body: ${bodyPreview}`);
  }

  if (response.error) {
    throw new CORSError(response.error, url);
  }

  return new Response(response.body, {
    status: response.status,
    headers: new Headers(response.headers),
  });
}

/**
 * Forward an XHR-style request through the userscript.  Used by providers
 * that rely on XMLHttpRequest (e.g. Chevereto).
 */
export async function proxyXHR(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{
  status: number;
  responseText: string;
  headers: Record<string, string>;
}> {
  const id = `xhr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await sendMessage<CORSTunnelResponse>(
    {
      type: "cors-tunnel-request",
      id,
      url,
      method,
      headers,
      body,
    },
    PROXY_TIMEOUT_MS,
  );

  if (!response) {
    throw new CORSError("CORS proxy did not respond in time", url);
  }

  if (response.error) {
    throw new CORSError(response.error, url);
  }

  return {
    status: response.status,
    responseText: response.body,
    headers: response.headers,
  };
}

// ─── Modal state management ──────────────────────────────────────────

/**
 * Should the CORS help modal be shown?
 * Returns false if the user permanently dismissed it (corsModalDismissed
 * setting is true) or if the modal was already shown for this upload batch.
 */
export async function shouldShowCORSModalAsync(): Promise<boolean> {
  // Check the Zustand store's current state (in-memory, always up to date).
  // If the user just toggled the setting in the Settings dialog, the store
  // reflects it immediately even before localStorage is re-read.
  try {
    const { useSettingsStore } = await import("@/store/settingsStore");
    const storeSettings = useSettingsStore.getState().settings;
    if (storeSettings?.corsModalDismissed) return false;

    // If the user re-enabled the modal (corsModalDismissed set to false),
    // reset the per-batch flag so it can show again.
    if (storeSettings?.corsModalDismissed === false) {
      tunnelState.modalShownThisBatch = false;
    }
  } catch {
    // Fall back to localStorage
    try {
      const settings = loadAppSettings();
      if (settings?.corsModalDismissed) return false;
      if (settings?.corsModalDismissed === false) {
        tunnelState.modalShownThisBatch = false;
      }
    } catch {
      // localStorage not available – allow modal
    }
  }

  if (tunnelState.modalShownThisBatch) return false;
  return true;
}

/**
 * Synchronous version for backward compatibility.  Reads from localStorage
 * only (Zustand store requires async import).
 */
export function shouldShowCORSModal(): boolean {
  // Check settings FIRST so that if the user re-enabled the modal (set
  // corsModalDismissed to false), we reset the per-batch flag before checking
  // it.  Otherwise the early return below would block the modal forever.
  try {
    const settings = loadAppSettings();
    if (settings?.corsModalDismissed) return false;
    // User re-enabled: reset the batch flag so the modal can show again
    if (settings?.corsModalDismissed === false) {
      tunnelState.modalShownThisBatch = false;
    }
  } catch {
    // localStorage not available – allow modal
  }

  if (tunnelState.modalShownThisBatch) return false;
  return true;
}

/** Mark the modal as shown for the current batch (doesn't persist). */
export function markModalShown() {
  tunnelState.modalShownThisBatch = true;
}

/**
 * Clear the per-batch modal flag so the modal can show again on the next
 * CORS error.  Called when the user closes the modal WITHOUT checking
 * "Don't show this again".
 */
export function clearModalShown() {
  tunnelState.modalShownThisBatch = false;
}

/**
 * Permanently dismiss the CORS modal by updating the app setting.
 */
export async function dismissModalPermanently() {
  tunnelState.modalShownThisBatch = true;
  // Use the proper settings loader/persister so versioned storage + migrations
  // are respected.  Then update the Zustand store so the in-memory state stays
  // in sync (settings dialog reads from the store, not localStorage).
  try {
    const settings = loadAppSettings();
    settings.corsModalDismissed = true;
    persistAppSettings(settings);

    // Update Zustand store via dynamic import to avoid circular dependency.
    const { useSettingsStore } = await import("@/store/settingsStore");
    useSettingsStore.getState().updateSettings({ corsModalDismissed: true });
  } catch {
    // localStorage not available – in-memory flag still set above
  }
}

// ─── Browser extension detection ─────────────────────────────────────

export interface BrowserExtensionInfo {
  name: string;
  downloadUrl: string;
  detected: boolean;
}

/**
 * Try to detect which userscript manager (if any) is installed.
 */
export function detectBrowserExtension(): BrowserExtensionInfo {
  // Tampermonkey exposes `window.Tampermonkey`
  if ("Tampermonkey" in window) {
    return {
      name: "Tampermonkey",
      downloadUrl: "https://www.tampermonkey.net/",
      detected: true,
    };
  }

  // Violentmonkey / Greasemonkey expose `window.GM_info`
  if ("GM_info" in window) {
    const gmInfo = (window as unknown as Record<string, unknown>).GM_info as {
      script?: { name?: string };
      version?: string;
    };
    // Greasemonkey also sets GM_info, but Tampermonkey is more common
    if (gmInfo?.script?.name?.includes(PROJECT_NAME)) {
      // Our own script is active – could be Violentmonkey or Greasemonkey
      // We can't reliably distinguish, so default to Violentmonkey
      return {
        name: "Violentmonkey / Greasemonkey",
        downloadUrl: "https://violentmonkey.github.io/",
        detected: true,
      };
    }
  }

  // Fallback: recommend Tampermonkey (works on most browsers)
  return {
    name: "Tampermonkey",
    downloadUrl: "https://www.tampermonkey.net/",
    detected: false,
  };
}

// ─── Userscript generation & download ────────────────────────────────

/**
 * Strict origin validation to prevent injection attacks when substituting
 * the origin into the userscript template.
 *
 * A spoofed `window.location.origin` could contain newlines, comment
 * characters, or JavaScript that would break out of the @match directive
 * and inject arbitrary userscript metadata or code. This validator ensures
 * the value is a well-formed origin string before any substitution.
 *
 * Allowed format: scheme://host[:port]
 *   scheme:  http, https, file (letters, digits, +, -, .)
 *   host:    hostname or IP (letters, digits, -, .)
 *   port:    optional digits
 */
const ORIGIN_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/;

export function isValidOrigin(origin: string): boolean {
  return typeof origin === "string" && ORIGIN_REGEX.test(origin);
}

/**
 * Generate the userscript source with placeholders substituted.
 * Throws if the origin fails validation.
 */
export function generateUserscriptContent(origin: string): string {
  if (!isValidOrigin(origin)) {
    throw new Error(
      `Refusing to generate userscript: origin "${origin}" failed validation`,
    );
  }

  const replacements: Record<string, string> = {
    "{{ORIGIN}}": origin,
    "{{PROJECT_NAME}}": PROJECT_NAME,
    "{{PROJECT_NAME_LOWERCASE}}": PROJECT_NAME.toLowerCase().replaceAll(
      /\s/g,
      "-",
    ),
  };

  let result = userscriptTemplate;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(token, value);
  }

  return result;
}

/**
 * Generate the userscript content with the current origin substituted,
 * then trigger a file download so the user can import it into their
 * userscript manager (Tampermonkey, Violentmonkey, etc.).
 *
 * Blob URLs don't work because userscript managers cannot scan them.
 * Instead, we create a downloadable .user.js file that the user drags
 * into their manager or imports via "Import from file".
 */
export function downloadUserscript() {
  const origin = window.location.origin;

  if (!isValidOrigin(origin)) {
    console.error(
      LOGPREFIX,
      "Refusing to download userscript — origin appears tampered",
    );
    return;
  }

  const scriptContent = generateUserscriptContent(origin);

  // Use text/javascript so the file is recognized as a script.
  const blob = new Blob([scriptContent], {
    type: "text/javascript; charset=utf-8",
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `${PROJECT_NAME.toLowerCase()}-cors-tunnel.user.js`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Clean up the blob URL after a short delay
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ─── High-level upload helper ────────────────────────────────────────

/**
 * Fetch with CORS proxy support.  When the userscript proxy is detected
 * as available, ALL requests are sent through the proxy to avoid CORS
 * failures entirely.  When the proxy is unavailable, direct fetch is
 * attempted first; on CORS failure, the proxy is checked again and
 * retried.  If everything fails, the CORS help modal is signalled.
 *
 * @returns `[response, showModal]` – the Response (or null on failure) and
 *          a boolean indicating whether the caller should show the CORS modal.
 */
export async function fetchWithCORSFallback(
  url: string,
  options?: RequestInit,
): Promise<{ response: Response | null; showModal: boolean }> {
  // If proxy is already known to be available, use it for ALL requests
  // to avoid initial CORS failures entirely.
  if (tunnelState.available) {
    try {
      const response = await proxyFetch(url, options);
      return { response, showModal: false };
    } catch {
      // Proxy failed – fall through to availability re-check
    }
  }

  // Try direct fetch first (proxy might not be installed yet)
  try {
    const response = await fetch(url, options);
    return { response, showModal: false };
  } catch (error) {
    if (!isCORSError(error)) {
      throw error; // Not a CORS issue – rethrow
    }
  }

  // CORS failure – check if proxy is now available
  const available = await detectCORSTunnelAvailable();

  if (available) {
    try {
      const response = await proxyFetch(url, options);
      return { response, showModal: false };
    } catch {
      // Proxy still fails
    }
  }

  // Signal modal
  const showModal = shouldShowCORSModal();
  if (showModal) {
    markModalShown();
  }
  return { response: null, showModal };
}
