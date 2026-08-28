// Replaces extras/violentmonkey/video-catcher.user.js. That userscript could
// only ever see what the *page's own JavaScript* did (its fetch()/XHR calls,
// a <video> element's currentSrc) -- a real video player using MediaSource
// Extensions (very common for adaptive/progressive streaming) sets
// currentSrc to a local blob: object URL, so the actual network URL never
// appears anywhere page JS can read it at all, no matter how good the
// detection regex is. webRequest sees the real HTTP traffic at the browser
// level regardless of how the page technically fetched it -- MSE segment
// fetches included -- which is the same class of access a tool like Video
// DownloadHelper has and a userscript fundamentally cannot get.
//
// Firefox-only (this user's actual browser): uses the native `browser.*`
// promise-based WebExtensions API throughout, not `chrome.*` -- Firefox
// does provide a `chrome.*` compat shim, but it's a callback-oriented
// approximation of the Chrome API layered on top of the same promise-based
// implementation `browser.*` already exposes directly, so there's no reason
// to go through it. Also deliberately background.scripts (an event page),
// not background.service_worker -- Firefox's own MV3 docs still call
// service_worker "experimental" for it, while scripts/event-pages is the
// long-established, fully-supported path.
"use strict";

// Matched against the FULL url (not just the pathname) with the boundary
// widened to "?", "&" or end-of-string -- some sites (adult tube sites
// especially) proxy the real file through a plain endpoint like
// /remote_control.php?...&file=%2Fvideos%2F...%2Fclip_720p.mp4&... where the
// real filename only ever shows up inside a query parameter, never in the
// path, and never immediately before a bare "?" either.
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|m3u8|mpd|avi|flv|m4v)(?=[?&]|$)/i;
// Independent signal for when even that misses -- a real response
// content-type is stronger evidence than any URL guess, and unlike the old
// userscript this is available for every request type webRequest sees
// (including native <video>/MSE loads, not just page-JS fetch()/XHR).
const VIDEO_CONTENT_TYPE_RE = /^(video\/|application\/(vnd\.apple\.mpegurl|dash\+xml|x-mpegurl))/i;
// resourceType values worth looking at: "media" is a <video>/<audio> (or MSE
// segment) load, "xmlhttprequest" covers a player's own fetch()/XHR calls,
// "object" covers the rare <object>/<embed> video plugin case. Everything
// else (image, stylesheet, script, font, ping, ...) is cheap to skip before
// ever touching the URL/content-type regexes.
const RELEVANT_TYPES = new Set(["media", "xmlhttprequest", "object"]);

/** tabId -> Map<url, candidate> */
const candidatesByTab = new Map();
/** requestId -> {referer, origin, cookie}, consumed by the matching onHeadersReceived call */
const pendingHeaders = new Map();

function looksLikeVideoUrl(url) {
  try {
    return VIDEO_EXT_RE.test(new URL(url).href);
  } catch {
    return false;
  }
}

function looksLikeVideoType(contentType) {
  return !!contentType && VIDEO_CONTENT_TYPE_RE.test(contentType.trim());
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function getTabMap(tabId) {
  let m = candidatesByTab.get(tabId);
  if (!m) {
    m = new Map();
    candidatesByTab.set(tabId, m);
  }
  return m;
}

function updateBadge(tabId) {
  const m = candidatesByTab.get(tabId);
  const n = m ? m.size : 0;
  browser.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  browser.action.setBadgeBackgroundColor({ tabId, color: "#1f6feb" });
}

// Firefox's webRequest never hid Cookie/security-sensitive request headers
// from "requestHeaders" the way Chrome does (that's what Chrome's
// "extraHeaders" extraInfoSpec value exists to opt back into) -- there's no
// equivalent flag to pass here, the header's just there.
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    pendingHeaders.set(details.requestId, {
      referer: headerValue(details.requestHeaders, "referer"),
      origin: headerValue(details.requestHeaders, "origin"),
      // The old userscript could never forward this: document.cookie can't
      // see HttpOnly cookies (most session cookies are), so a CDN gating the
      // video on one was a known, undocumented-workaround-only gap.
      // webRequest inspects the real header the browser actually sent,
      // HttpOnly or not, since it's real network traffic, not JS-visible
      // page state.
      cookie: headerValue(details.requestHeaders, "cookie"),
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    // tabId is -1 for requests not tied to any tab (our own background
    // fetch() to the downloader server included) -- nothing to attribute a
    // candidate to, and nothing worth showing a user either way.
    if (details.tabId < 0) return;
    if (!RELEVANT_TYPES.has(details.type)) return;

    const contentType = headerValue(details.responseHeaders, "content-type");
    const contentLength = headerValue(details.responseHeaders, "content-length");
    const hdrs = pendingHeaders.get(details.requestId) || {};
    pendingHeaders.delete(details.requestId);

    if (!looksLikeVideoUrl(details.url) && !looksLikeVideoType(contentType)) return;

    const map = getTabMap(details.tabId);
    if (map.has(details.url)) return;
    map.set(details.url, {
      url: details.url,
      contentType: contentType || "",
      size: contentLength ? Number(contentLength) : null,
      referer: hdrs.referer || "",
      origin: hdrs.origin || "",
      cookie: hdrs.cookie || "",
    });
    updateBadge(details.tabId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

// A tab loading a new top-level page should start with an empty candidate
// list -- otherwise leftover entries from whatever was open before would
// hang around and show up as "detected" on a page that never served them.
// frameId 0 = the top-level document, not a sub-frame navigating on its own.
browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  candidatesByTab.delete(details.tabId);
  updateBadge(details.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
  candidatesByTab.delete(tabId);
});

async function getServer() {
  const { server } = await browser.storage.local.get("server");
  return (server || "").trim();
}

async function sendToDownloader(candidate, pageUrl, pageTitle) {
  const server = await getServer();
  if (!server) throw new Error("Configurá la URL de tu Proxy Downloader primero (abajo del todo en el popup).");
  const res = await fetch(server.replace(/\/+$/, "") + "/api/extension/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      page_url: pageUrl,
      page_title: pageTitle || "",
      url: candidate.url,
      headers: {
        referer: candidate.referer || pageUrl,
        origin: candidate.origin || "",
        "user-agent": navigator.userAgent,
        cookie: candidate.cookie || "",
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) message = parsed.error;
    } catch {
      /* not JSON, keep the plain status */
    }
    throw new Error(message);
  }
}

async function handleGetCandidates() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { candidates: [], pageUrl: "", pageTitle: "" };
  const map = candidatesByTab.get(tab.id);
  return {
    candidates: map ? [...map.values()] : [],
    pageUrl: tab.url || "",
    pageTitle: tab.title || "",
  };
}

async function handleSend(candidate, pageUrl, pageTitle) {
  try {
    await sendToDownloader(candidate, pageUrl, pageTitle);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Firefox's native messaging contract: return a Promise directly from the
// listener for an async response, instead of Chrome's callback-style
// sendResponse()+"return true" dance.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "getCandidates") return handleGetCandidates();
  if (msg.type === "send") return handleSend(msg.candidate, msg.pageUrl, msg.pageTitle);
  return undefined;
});
