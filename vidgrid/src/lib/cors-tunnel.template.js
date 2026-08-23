// ==UserScript==
// @name         {{PROJECT_NAME}} CORS Tunnel
// @namespace    {{PROJECT_NAME_LOWERCASE}}-cors-tunnel
// @version      1.0.0
// @description  Bypass CORS restrictions for {{PROJECT_NAME}} upload destinations by proxying requests through GM_xmlhttpRequest.
// @match        {{ORIGIN}}/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const PONG_VERSION = "1.0.0";
  const LOGPREFIX = `[{{PROJECT_NAME}} CORS Tunnel - Userscript]`;

  /**
   * Send a message back to the web app.
   */
  function sendResponse(data) {
    window.postMessage(data, window.location.origin);
  }

  /**
   * Convert a base64 string to a Blob with the given MIME type.
   */
  function base64ToBlob(base64, contentType) {
    const bytes = atob(base64);
    const array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      array[i] = bytes.charCodeAt(i);
    }
    return new Blob([array], { type: contentType });
  }

  /**
   * Reconstruct a FormData object from structured form data sent by the app.
   */
  function reconstructFormData(formData) {
    const fd = new FormData();
    for (const field of formData.fields) {
      fd.append(field.key, field.value);
    }
    for (const file of formData.files) {
      const blob = base64ToBlob(file.data, file.contentType);
      fd.append(file.key, blob, file.filename);
    }
    return fd;
  }

  /**
   * Handle an incoming request message by forwarding it through GM_xmlhttpRequest.
   * Acts as a transparent proxy – preserving status codes, headers, and body.
   */
  function handleRequest(msg) {
    const { id, url, method, headers, body, bodyType, formData } = msg;

    const options = {
      method: method,
      url: url,
      headers: headers || {},
      timeout: 60000,
    };

    // Attach body when provided
    if (bodyType === "formdata-v2" && formData) {
      // Reconstruct the exact FormData with binary file data intact.
      options.data = reconstructFormData(formData);
      // GM_xmlhttpRequest sets Content-Type with boundaries automatically
      delete options.headers["Content-Type"];
    } else if (body) {
      if (bodyType === "arraybuffer") {
        // Convert base64 back to a Blob so GM_xmlhttpRequest sends the
        // exact binary bytes.  Using atob() alone produces a binary string
        // that GM_xmlhttpRequest re-encodes as UTF-8, corrupting bytes > 127
        // (common in JPEG/PNG/WebM files).
        const bytes = atob(body);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
          arr[i] = bytes.charCodeAt(i);
        }
        options.data = new Blob([arr]);
      } else {
        options.data = body;
      }
    }

    GM_xmlhttpRequest({
      ...options,
      onload: function (response) {
        // Transparent: pass through status codes exactly (including 4xx/5xx)
        // so the app can handle HTTP errors the same way as native fetch.
        sendResponse({
          type: "cors-tunnel-response",
          id: id,
          status: response.status,
          headers: response.responseHeaders
            ? parseHeaders(response.responseHeaders)
            : {},
          body: response.responseText || response.response || "",
        });
      },
      onerror: function (error) {
        sendResponse({
          type: "cors-tunnel-response",
          id: id,
          status: error.status || 0,
          headers: {},
          body: "",
          error: error.error || "Network error during proxied request",
        });
      },
      ontimeout: function () {
        sendResponse({
          type: "cors-tunnel-response",
          id: id,
          status: 0,
          headers: {},
          body: "",
          error: "Request timeout",
        });
      },
    });
  }

  /**
   * Parse a raw multi-line header string into a Record<string, string>.
   */
  function parseHeaders(raw) {
    const result = {};
    if (!raw) return result;

    const lines = raw.split("\n");
    for (const line of lines) {
      const sepIndex = line.indexOf(":");
      if (sepIndex === -1) continue;
      const key = line.substring(0, sepIndex).trim();
      const value = line.substring(sepIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Listen for messages from the app.
   */
  window.addEventListener("message", function (event) {
    // Only accept messages from the same origin (the app itself)
    if (event.origin !== window.location.origin) return;

    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "cors-tunnel-ping":
        console.debug(LOGPREFIX, "received message", msg.type, msg.id);
        console.debug(LOGPREFIX, "sending pong", msg.id);
        sendResponse({
          type: "cors-tunnel-pong",
          id: msg.id,
          version: PONG_VERSION,
        });
        break;

      case "cors-tunnel-request":
        console.debug(LOGPREFIX, "received message", msg.type, msg.id);
        console.debug(LOGPREFIX, "handling request to", msg.url);
        handleRequest(msg);
        break;

      default:
        // Silently ignore unknown messages (e.g. React, Vite HMR, etc.)
        break;
    }
  });
})();
