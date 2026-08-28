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

function basename(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
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
