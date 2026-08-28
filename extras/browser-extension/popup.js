"use strict";

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const serverInput = document.getElementById("server-input");
const saveBtn = document.getElementById("save-server");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = kind || "";
}

function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Same allowlist as the backend's extension_jobs.py -- kept in sync by
// hand, not imported, since this is a plain unbundled extension with no
// shared-module step between the two.
const KNOWN_MEDIA_EXTS = [
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".wmv",
  ".ts", ".3gp", ".mpg", ".mpeg", ".ogv", ".m3u8", ".mpd",
];

function findKnownExt(text) {
  const low = text.toLowerCase();
  for (const ext of KNOWN_MEDIA_EXTS) {
    const idx = low.indexOf(ext);
    if (idx === -1) continue;
    const end = idx + ext.length;
    if (end === text.length || !/[a-z0-9]/i.test(text[end])) return { idx, ext };
  }
  return null;
}

// Plenty of sites proxy the real file through a plain endpoint like
// /remote_control.php?...&file=%2Fvideos%2F...%2Fclip_720p.mp4&... -- the
// path's own basename ("remote_control.php") is the endpoint's name, not
// the video's, so showing it as-is is just confusing. Falls back to
// scanning the query string for a real embedded filename+extension, same
// idea backend/extension_jobs.py already applies when it picks the saved
// filename (this is display-only, doesn't have to match it exactly).
function basename(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const pathName = decodeURIComponent(u.pathname.split("/").pop() || "");
  const dot = pathName.lastIndexOf(".");
  const pathExt = dot === -1 ? "" : pathName.slice(dot).toLowerCase();
  if (KNOWN_MEDIA_EXTS.includes(pathExt)) return pathName;

  if (u.search) {
    let decoded = u.search;
    try {
      decoded = decodeURIComponent(u.search);
    } catch {
      /* keep it encoded if decoding fails, findKnownExt still works on it */
    }
    const found = findKnownExt(decoded);
    if (found) {
      const upTo = decoded.slice(0, found.idx + found.ext.length);
      const cut = Math.max(upTo.lastIndexOf("/"), upTo.lastIndexOf("="));
      return upTo.slice(cut + 1);
    }
  }
  return pathName || url;
}

async function loadServer() {
  const { server } = await browser.storage.local.get("server");
  serverInput.value = server || "";
}

saveBtn.addEventListener("click", async () => {
  await browser.storage.local.set({ server: serverInput.value.trim() });
  setStatus("Servidor guardado.", "ok");
  setTimeout(() => setStatus(""), 1500);
});

async function render() {
  const { candidates, pageUrl, pageTitle } = await browser.runtime.sendMessage({ type: "getCandidates" });
  if (!candidates || !candidates.length) {
    listEl.innerHTML = `<div class="empty">Ningún video detectado todavía en esta pestaña.<br>Reproducilo un poco y volvé a abrir esto.</div>`;
    return;
  }
  listEl.innerHTML = "";
  for (const c of candidates) {
    const row = document.createElement("div");
    row.className = "item";
    const meta = [c.contentType, fmtSize(c.size)].filter(Boolean).join(" · ");
    const name = basename(c.url);
    const nameDiv = document.createElement("div");
    nameDiv.className = "name";
    nameDiv.title = c.url;
    nameDiv.textContent = name;
    if (meta) {
      const metaDiv = document.createElement("div");
      metaDiv.className = "meta";
      metaDiv.textContent = meta;
      nameDiv.appendChild(metaDiv);
    }
    const btn = document.createElement("button");
    btn.className = "send-btn";
    btn.textContent = "Descargar";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Enviando…";
      const res = await browser.runtime.sendMessage({ type: "send", candidate: c, pageUrl, pageTitle });
      if (res.ok) {
        btn.textContent = "✓ Enviado";
        setStatus("Enviado a tu downloader.", "ok");
      } else {
        btn.disabled = false;
        btn.textContent = "Descargar";
        setStatus(res.error || "Error al enviar.", "error");
      }
    });
    row.appendChild(nameDiv);
    row.appendChild(btn);
    listEl.appendChild(row);
  }
}

loadServer();
render();
