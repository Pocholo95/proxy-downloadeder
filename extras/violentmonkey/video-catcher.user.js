// ==UserScript==
// @name         Proxy Downloader - Video Catcher
// @namespace    proxy-downloader
// @version      1.1.0
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

  // ── Real browser-tab title, even from inside a cross-origin iframe ──
  // document.title only reflects *this* frame's own title -- for a video
  // embedded in a cross-origin iframe (the common case: see the @match
  // comment above) that's usually empty or some generic player-widget
  // title, not what's actually showing in the tab. Cross-origin frames
  // can't read window.top.document.title directly (blocked by the same-
  // origin policy), but postMessage works across origins for messaging,
  // so ask the top frame for it instead. This script itself is what's
  // listening on the other end, since @match injects it into every frame
  // including the top one.
  //
  // This always-on listener answers other frames' title requests; it has
  // to stay registered for the page's whole lifetime since a request can
  // come in at any time. The *asking* side is deliberately NOT done once
  // here at load -- @run-at document-start means this script runs before
  // the page has even parsed its own <title> tag, let alone before any
  // SPA-style JS sets a more specific one after the video loads, so a
  // title grabbed this early is reliably wrong (that's what caused a
  // download to get saved as a raw CDN filename instead of a real title).
  // getFreshTabTitle() below asks fresh, right when a download is about
  // to be sent, by which point the user has actually been looking at the
  // page long enough for its title to have settled.
  window.addEventListener("message", (e) => {
    if (e.data && e.data.__pdGetTitle && e.source) {
      try {
        e.source.postMessage({ __pdTitle: document.title, __pdReqId: e.data.__pdReqId }, "*");
      } catch { /* ignore */ }
    }
  });

  function getFreshTabTitle() {
    if (window.top === window) return Promise.resolve(document.title);
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      let settled = false;
      const finish = (title) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", listener);
        resolve(title);
      };
      const listener = (e) => {
        if (e.data && e.data.__pdTitle !== undefined && e.data.__pdReqId === reqId) {
          finish(e.data.__pdTitle);
        }
      };
      window.addEventListener("message", listener);
      try {
        window.top.postMessage({ __pdGetTitle: true, __pdReqId: reqId }, "*");
      } catch {
        finish(document.title);
        return;
      }
      // No response (top frame's own userscript instance hasn't attached
      // its listener yet, cross-origin restrictions on postMessage itself,
      // etc.) -- fall back to this frame's own title rather than hang.
      setTimeout(() => finish(document.title), 500);
    });
  }

  // .ts (and DASH's .m4s) deliberately excluded -- those are individual HLS/
  // DASH *segments*, dozens/hundreds per stream, never something to download
  // on its own. The .m3u8/.mpd manifest is the one thing worth surfacing;
  // ffmpeg reads it and fetches every segment itself when it downloads.
  //
  // Matched against the FULL url (not just the pathname) with the boundary
  // widened to "?", "&" or end-of-string -- plenty of sites (adult tube
  // sites especially) proxy the real file through a plain endpoint like
  // /remote_control.php?...&file=%2Fvideos%2F...%2Fclip_720p.mp4&... where
  // the real filename only ever shows up inside a query parameter, never
  // in the path itself. Pathname-only matching missed every one of those.
  const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|m3u8|mpd|avi|flv|m4v)(?=[?&]|$)/i;
  // Independent fallback signal for the same case when even that misses --
  // a real HTTP response content-type is a much stronger signal than any
  // URL guess, when it's actually available (fetch()/XHR only; a native
  // <video> element's own resource load never exposes response headers to
  // page JS at all, so this can't help that path, only the interception one).
  const VIDEO_CONTENT_TYPE_RE = /^(video\/|application\/(vnd\.apple\.mpegurl|dash\+xml|x-mpegurl))/i;
  const candidates = new Map(); // url -> {url, contentType, size}

  function looksLikeVideoUrl(url) {
    try {
      return VIDEO_EXT_RE.test(new URL(url, location.href).href);
    } catch {
      return false;
    }
  }

  function looksLikeVideoType(contentType) {
    return !!contentType && VIDEO_CONTENT_TYPE_RE.test(contentType.trim());
  }

  function addCandidate(url, contentType, size) {
    if (!url || candidates.has(url)) return;
    if (!looksLikeVideoUrl(url) && !looksLikeVideoType(contentType)) return;
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

  async function sendToDownloader(candidate) {
    const server = GM_getValue("server", "");
    if (!server) {
      alert('Configurá la URL de tu Proxy Downloader primero: menú de Violentmonkey en esta página → "Configurar servidor".');
      return;
    }
    const title = await getFreshTabTitle();
    GM_xmlhttpRequest({
      method: "POST",
      url: server.replace(/\/+$/, "") + "/api/extension/download",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        page_url: location.href,
        page_title: title || "",
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
