// ==UserScript==
// @name         Proxy Downloader - Video Catcher
// @namespace    proxy-downloader
// @version      1.0.0
// @description  Detects video URLs on any page (fetch/XHR calls, <video> elements) and sends the one you pick to your self-hosted Proxy Downloader for a server-side download -- the same idea as Video DownloadHelper, but you play the video yourself in your own real browser instead of a heuristic click in a headless one.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      *
// @run-at       document-start
// ==/UserScript==

/*
 * How this works, and why:
 *
 * - The @match rule above (any scheme, any host, any path) makes
 *   Violentmonkey inject this into every frame whose URL matches -- that
 *   includes cross-origin <iframe>s (each frame is its
 *   own injection target, evaluated independently), which is exactly what
 *   most embed-style video sites need: the actual player usually lives in
 *   an iframe on a different origin than the page you're looking at, and
 *   that's where the real video request happens. A server-side headless
 *   browser has to go hunt down that iframe and guess where to click;
 *   here it's automatic, and there's no click-guessing at all -- you just
 *   watch the video normally and the real request happens because you
 *   actually did that, the same way Video DownloadHelper works.
 *
 * - Detection has two independent sources, since neither alone covers
 *   everything a page might do:
 *     1. fetch()/XMLHttpRequest interception -- catches anything a
 *        player's own JS explicitly requests (HLS/DASH manifests and
 *        segments, signed URLs it fetched from some API first, etc.)
 *     2. <video>/<source> element observation -- catches the plain case
 *        of a native <video src="..."> the browser loads on its own,
 *        which never goes through step 1 at all since it's the browser's
 *        own resource fetch, not page JS.
 *
 * - Only Referer/Origin/User-Agent get sent alongside the URL -- not
 *   cookies. document.cookie can't see HttpOnly cookies anyway (most
 *   session cookies are), and every site verified so far (see this
 *   project's README) only needed those three to get past a CDN's
 *   hotlink protection. If a site you use needs cookies too, they can be
 *   added to the headers object in sendToDownloader() below.
 *
 * - No auth on the server call (GM_xmlhttpRequest bypasses CORS entirely,
 *   which is what lets this reach your own server from any third-party
 *   page's context) -- matches this whole project's own trust model
 *   (Tailscale/LAN only, no login anywhere in it either).
 */

(function () {
  "use strict";

  const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|m3u8|mpd|avi|ts|flv|m4v)(\?|$)/i;
  const candidates = new Map(); // url -> {url, contentType, size}

  function looksLikeVideoUrl(url) {
    try {
      return VIDEO_EXT_RE.test(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  }

  function addCandidate(url, contentType, size) {
    if (!url || candidates.has(url) || !looksLikeVideoUrl(url)) return;
    candidates.set(url, { url, contentType: contentType || "", size: size ? Number(size) : null });
    updateButton();
  }

  // ── Source 1: fetch()/XHR interception ──────────────────────────────
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const requested = args[0];
      const requestedUrl = typeof requested === "string" ? requested : requested?.url;
      return origFetch.apply(this, args).then((resp) => {
        try {
          addCandidate(resp.url || requestedUrl, resp.headers.get("content-type"), resp.headers.get("content-length"));
        } catch { /* ignore */ }
        return resp;
      });
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener("load", () => {
      try {
        addCandidate(this.responseURL || url, this.getResponseHeader("content-type"), this.getResponseHeader("content-length"));
      } catch { /* ignore */ }
    });
    return origOpen.call(this, method, url, ...rest);
  };

  // ── Source 2: <video>/<source> elements (native browser resource
  // loads never touch fetch/XHR, so these need their own watcher) ──────
  function watchVideoEl(el) {
    if (el.dataset.pdWatched) return;
    el.dataset.pdWatched = "1";
    const report = () => { if (el.currentSrc) addCandidate(el.currentSrc, "", null); };
    el.addEventListener("loadedmetadata", report);
    el.addEventListener("play", report);
    report();
  }

  document.querySelectorAll("video").forEach(watchVideoEl);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") watchVideoEl(node);
        node.querySelectorAll?.("video").forEach(watchVideoEl);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── UI: a small floating button, only shown once something's found ──
  let btn = null;
  function ensureButton() {
    if (btn) return btn;
    btn = document.createElement("div");
    btn.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#1f6feb;" +
      "color:#fff;padding:8px 14px;border-radius:20px;font:600 13px -apple-system,sans-serif;" +
      "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);display:none;user-select:none;";
    btn.addEventListener("click", showPicker);
    document.documentElement.appendChild(btn);
    return btn;
  }

  function updateButton() {
    const b = ensureButton();
    const n = candidates.size;
    b.textContent = `⬇ ${n} video${n === 1 ? "" : "s"}`;
    b.style.display = n ? "block" : "none";
  }

  function showPicker() {
    const list = [...candidates.values()];
    const lines = list
      .map((c, i) => `${i + 1}. ${c.url.split("/").pop().split("?")[0]}${c.contentType ? " (" + c.contentType + ")" : ""}`)
      .join("\n");
    const choice = prompt(`Videos encontrados en esta página:\n${lines}\n\nNúmero a descargar (o "todos"):`, "1");
    if (!choice) return;
    const trimmed = choice.trim().toLowerCase();
    const chosen = trimmed === "todos" ? list : [list[parseInt(trimmed, 10) - 1]].filter(Boolean);
    if (!chosen.length) return;
    chosen.forEach(sendToDownloader);
  }

  function sendToDownloader(candidate) {
    const server = GM_getValue("server", "");
    if (!server) {
      alert('Configurá la URL de tu Proxy Downloader primero: menú de Violentmonkey en esta página → "Configurar servidor".');
      return;
    }
    GM_xmlhttpRequest({
      method: "POST",
      url: server.replace(/\/+$/, "") + "/api/extension/download",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        page_url: location.href,
        url: candidate.url,
        headers: {
          referer: location.href,
          origin: location.origin,
          "user-agent": navigator.userAgent,
        },
      }),
      onload: (res) => {
        if (res.status < 300) {
          GM_notification({ text: "Enviado a tu downloader.", title: "Proxy Downloader" });
        } else {
          GM_notification({ text: `Error (${res.status}): ${res.responseText.slice(0, 200)}`, title: "Proxy Downloader" });
        }
      },
      onerror: () => GM_notification({ text: "No se pudo conectar al servidor. Revisá la URL configurada.", title: "Proxy Downloader" }),
    });
  }

  GM_registerMenuCommand("⚙️ Configurar servidor", () => {
    const current = GM_getValue("server", "");
    const value = prompt("URL de tu Proxy Downloader (ej: http://100.x.x.x:8080 o tu hostname de Tailscale):", current);
    if (value !== null) GM_setValue("server", value.trim());
  });
})();
