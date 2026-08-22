const state = {
  kind: "auto",
  openLogs: new Set(),
  filesOpen: false,
  filesPath: "",
  uploadSites: [],                    // from /api/uploads/sites
  uploadSelectedSites: new Set(),     // site names checked for the next upload
  uploadFoldersBySite: {},            // site -> [{id, name}, ...]
  uploadFolderChoiceBySite: {},       // site -> chosen folder id
  uploadSelectedExisting: null,       // {path, name} of an already-downloaded file picked for upload
};

const els = {
  tabs: document.querySelectorAll(".tab"),
  fieldSingle: document.getElementById("field-single"),
  fieldBatch: document.getElementById("field-batch"),
  inputSingle: document.getElementById("value-single"),
  inputBatch: document.getElementById("value-batch"),
  outputDir: document.getElementById("output-dir"),
  proxyMode: document.getElementById("proxy-mode"),
  minSpeed: document.getElementById("min-speed"),
  form: document.getElementById("job-form"),
  formError: document.getElementById("form-error"),
  jobsList: document.getElementById("jobs-list"),
  sitesList: document.getElementById("sites-list"),
  toggleSites: document.getElementById("toggle-sites"),
  filesPanel: document.getElementById("files-panel"),
  filesList: document.getElementById("files-list"),
  filesBreadcrumb: document.getElementById("files-breadcrumb"),
  toggleFiles: document.getElementById("toggle-files"),
  refreshFiles: document.getElementById("refresh-files"),
  clearFinished: document.getElementById("clear-finished"),
  previewModal: document.getElementById("preview-modal"),
  previewContent: document.getElementById("preview-content"),
  previewClose: document.getElementById("preview-close"),
  newJobCard: document.getElementById("new-job-card"),
  fieldUpload: document.getElementById("field-upload"),
  downloadOptionsRow: document.getElementById("download-options-row"),
  submitBtn: document.getElementById("submit-btn"),
  uploadSiteChecks: document.getElementById("upload-site-checks"),
  uploadAccountBlocks: document.getElementById("upload-account-blocks"),
  uploadFileInput: document.getElementById("upload-file-input"),
  uploadSelectedExistingEl: document.getElementById("upload-selected-existing"),
  uploadFormError: document.getElementById("upload-form-error"),
  uploadJobsList: document.getElementById("upload-jobs-list"),
  uploadClearFinished: document.getElementById("upload-clear-finished"),
};

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.kind = tab.dataset.kind;
    const isBatch = state.kind === "batch";
    const isUpload = state.kind === "upload";
    els.fieldBatch.classList.toggle("hidden", !isBatch);
    els.fieldSingle.classList.toggle("hidden", isBatch || isUpload);
    els.fieldUpload.classList.toggle("hidden", !isUpload);
    els.downloadOptionsRow.classList.toggle("hidden", isUpload);
    els.submitBtn.textContent = isUpload ? "Subir" : "Descargar";
    if (isUpload) refreshUploadSites();
  });
});

function switchToUploadTab() {
  const tab = [...els.tabs].find((t) => t.dataset.kind === "upload");
  if (tab) tab.click();
}

els.toggleSites.addEventListener("click", () => {
  els.sitesList.classList.toggle("hidden");
});

els.clearFinished.addEventListener("click", async () => {
  if (!confirm("¿Borrar del historial todos los trabajos ya terminados? No afecta los archivos descargados.")) return;
  await fetch("/api/jobs/clear-finished", { method: "POST" });
  refreshJobs();
});

function fmtBytes(n) {
  if (!n || n <= 0) return "0 KB";
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtSpeed(kb) {
  if (!kb || kb <= 0) return "";
  if (kb < 1024) return `${kb.toFixed(0)} KB/s`;
  return `${(kb / 1024).toFixed(1)} MB/s`;
}

const STATUS_LABELS = {
  queued: "en cola",
  resolving: "resolviendo",
  fetching_proxies: "cargando proxies",
  running: "descargando",
  cancelling: "cancelando…",
  done: "completo",
  done_with_errors: "con errores",
  error: "error",
  failed: "falló",
  cancelled: "cancelado",
};

const CANCELLABLE_STATUSES = new Set(["queued", "resolving", "fetching_proxies", "running"]);
const RETRYABLE_STATUSES = new Set(["done_with_errors", "error", "cancelled"]);
const DELETABLE_STATUSES = new Set(["done", "done_with_errors", "error", "cancelled"]);

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.formError.textContent = "";

  if (state.kind === "upload") {
    await submitUpload();
    return;
  }

  const value = state.kind === "batch" ? els.inputBatch.value : els.inputSingle.value;
  if (!value.trim()) {
    els.formError.textContent = "Falta la URL/ID";
    return;
  }
  const body = {
    kind: state.kind,
    value,
    output_dir: els.outputDir.value.trim() || null,
    proxy_mode: els.proxyMode.value,
    speed: els.minSpeed.value || null,
  };
  try {
    await fetchJSON("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    els.inputSingle.value = "";
    els.inputBatch.value = "";
    refreshJobs();
  } catch (err) {
    els.formError.textContent = err.message;
  }
});

function siteRow(site) {
  const overrideLabel = site.override === null ? "" : site.override ? " (forzado ON)" : " (forzado OFF)";
  return `<tr>
    <td>${site.name}${site.is_default ? " ★" : ""}</td>
    <td class="dim">${site.domains.join(", ")}</td>
    <td>${site.effective_use_proxy ? "✓ proxy" : "directo"}${overrideLabel}</td>
    <td class="actions">
      <button class="btn small" data-site="${site.name}" data-action="enable">ON</button>
      <button class="btn small" data-site="${site.name}" data-action="disable">OFF</button>
      <button class="btn small" data-site="${site.name}" data-action="reset">reset</button>
    </td>
  </tr>`;
}

async function refreshSites() {
  try {
    const sites = await fetchJSON("/api/sites");
    els.sitesList.innerHTML = `<table>
      <thead><tr><th>Sitio</th><th>Dominios</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>${sites.map(siteRow).join("")}</tbody>
    </table>`;
    els.sitesList.querySelectorAll("button[data-site]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetchJSON(`/api/sites/${btn.dataset.site}/proxy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: btn.dataset.action }),
        });
        refreshSites();
      });
    });
  } catch (err) {
    els.sitesList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function itemProgress(item) {
  const pct = item.total > 0 ? Math.min(100, (item.bytes_done / item.total) * 100) : (item.status === "done" ? 100 : 0);
  const fillClass = item.status === "done" ? "done" : item.status === "failed" ? "failed" : "";
  const speed = item.status === "running" ? fmtSpeed(item.speed_kb) : "";
  const sizeLabel = item.total > 0 ? `${fmtBytes(item.bytes_done)} / ${fmtBytes(item.total)}` : fmtBytes(item.bytes_done);
  return `<div class="item">
    <div class="item-row">
      <span class="item-name">${item.filename || item.file_id} <span class="dim">(${item.site})</span></span>
      <span class="badge ${item.status}">${STATUS_LABELS[item.status] || item.status}</span>
    </div>
    <div class="item-sub">${item.mode === "proxy" ? "vía proxy" : "directo"} ${sizeLabel ? "· " + sizeLabel : ""} ${speed ? "· " + speed : ""} ${item.message ? "· " + item.message : ""}</div>
    <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${pct}%"></div></div>
  </div>`;
}

function jobCard(job) {
  const title = job.input.length > 90 ? job.input.slice(0, 90) + "…" : job.input;
  const created = new Date(job.created_at * 1000).toLocaleString();
  const logOpen = state.openLogs.has(job.id);
  const hasRetryable = job.items.some((it) => it.status === "failed" || it.status === "cancelled");
  return `<div class="job" data-job="${job.id}">
    <div class="job-head">
      <div>
        <div class="job-title">[${job.kind}] ${title}</div>
        <div class="job-meta">${created} · salida: ${job.output_dir} · ${job.summary.done}/${job.summary.total} ok${job.summary.failed ? `, ${job.summary.failed} fallidos` : ""}${job.error ? " · " + job.error : ""}</div>
      </div>
      <span class="badge ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
    </div>
    <div class="items">${job.items.map(itemProgress).join("")}</div>
    <div class="job-actions">
      ${CANCELLABLE_STATUSES.has(job.status) ? `<button class="btn small danger" data-cancel="${job.id}" ${job.status === "cancelling" ? "disabled" : ""}>${job.status === "cancelling" ? "Cancelando…" : "Cancelar"}</button>` : ""}
      ${RETRYABLE_STATUSES.has(job.status) && hasRetryable ? `<button class="btn small" data-retry="${job.id}">Reintentar fallidos</button>` : ""}
      ${DELETABLE_STATUSES.has(job.status) ? `<button class="btn small" data-delete-job="${job.id}">Borrar</button>` : ""}
      <button class="btn small" data-toggle-log="${job.id}">${logOpen ? "Ocultar log" : "Ver log"}</button>
    </div>
    ${logOpen ? `<pre class="log" id="log-${job.id}">cargando…</pre>` : ""}
  </div>`;
}

async function refreshJobs() {
  try {
    const jobs = await fetchJSON("/api/jobs");
    els.jobsList.innerHTML = jobs.length
      ? jobs.map(jobCard).join("")
      : `<p class="dim">Sin trabajos todavía.</p>`;

    els.jobsList.querySelectorAll("button[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await fetch(`/api/jobs/${btn.dataset.cancel}/cancel`, { method: "POST" });
        refreshJobs();
      });
    });
    els.jobsList.querySelectorAll("button[data-retry]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await fetchJSON(`/api/jobs/${btn.dataset.retry}/retry`, { method: "POST" });
        } catch (err) {
          alert(err.message);
        }
        refreshJobs();
      });
    });
    els.jobsList.querySelectorAll("button[data-delete-job]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Borrar este trabajo del historial? No afecta los archivos ya descargados.")) return;
        await fetch(`/api/jobs/${btn.dataset.deleteJob}`, { method: "DELETE" });
        refreshJobs();
      });
    });
    els.jobsList.querySelectorAll("button[data-toggle-log]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.toggleLog;
        if (state.openLogs.has(id)) state.openLogs.delete(id);
        else state.openLogs.add(id);
        refreshJobs();
      });
    });
    for (const id of state.openLogs) {
      const pre = document.getElementById(`log-${id}`);
      if (!pre) continue;
      fetch(`/api/jobs/${id}/log`).then((r) => r.text()).then((text) => {
        const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 10;
        pre.textContent = text || "(sin salida todavía)";
        if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
      });
    }
  } catch (err) {
    els.jobsList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function renderBreadcrumb() {
  const parts = state.filesPath ? state.filesPath.split("/") : [];
  let acc = "";
  const crumbs = [`<button data-path="">downloads</button>`];
  for (const part of parts) {
    acc = joinPath(acc, part);
    crumbs.push(`<span class="sep">/</span><button data-path="${acc}">${part}</button>`);
  }
  els.filesBreadcrumb.innerHTML = crumbs.join("");
  els.filesBreadcrumb.querySelectorAll("button[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => loadFiles(btn.dataset.path));
  });
}

const KIND_ICONS = { video: "🎬", audio: "🎵", image: "🖼" };

function fileRow(entry) {
  const path = joinPath(state.filesPath, entry.name);
  const sizeLabel = entry.is_dir ? "carpeta" : fmtBytes(entry.size);
  const icon = entry.is_dir ? "📁" : entry.partial ? "⏳" : (KIND_ICONS[entry.kind] || "📄");
  let nameCell;
  if (entry.is_dir) {
    nameCell = `<button class="link-btn" data-open="${path}">${icon} ${entry.name}</button>`;
  } else if (entry.kind && !entry.partial) {
    nameCell = `<button class="link-btn" data-preview="${path}" data-kind="${entry.kind}">${icon} ${entry.name}</button>`;
  } else {
    nameCell = `${icon} ${entry.name}`;
  }
  return `<tr>
    <td>${nameCell}</td>
    <td class="dim">${sizeLabel}${entry.partial ? " (incompleto)" : ""}</td>
    <td class="dim">${fmtDate(entry.mtime)}</td>
    <td class="actions">
      ${entry.optimizable ? `<button class="btn small" data-optimize="${path}">🚀 Optimizar</button>` : ""}
      ${entry.is_dir ? "" : `<button class="btn small" data-upload-existing="${path}" data-upload-name="${entry.name}">⬆ Subir</button>`}
      <button class="btn small" data-download="${path}">Descargar${entry.is_dir ? " (.zip)" : ""}</button>
      ${entry.partial ? "" : `<button class="btn small" data-rename="${path}" data-name="${entry.name}">✏ Renombrar</button>`}
      <button class="btn small danger" data-delete="${path}" data-name="${entry.name}">Borrar</button>
    </td>
  </tr>`;
}

async function loadFiles(path) {
  try {
    const data = await fetchJSON(`/api/files?path=${encodeURIComponent(path || "")}`);
    state.filesPath = data.path;
    renderBreadcrumb();
    els.filesList.innerHTML = data.entries.length
      ? `<table>
          <thead><tr><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead>
          <tbody>${data.entries.map(fileRow).join("")}</tbody>
        </table>`
      : `<p class="dim">Vacío.</p>`;

    els.filesList.querySelectorAll("button[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => loadFiles(btn.dataset.open));
    });
    els.filesList.querySelectorAll("button[data-preview]").forEach((btn) => {
      btn.addEventListener("click", () => openPreview(btn.dataset.preview, btn.dataset.kind));
    });
    els.filesList.querySelectorAll("button[data-optimize]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Optimizando…";
        try {
          await fetchJSON("/api/files/optimize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: btn.dataset.optimize }),
          });
        } catch (err) {
          alert(`No se pudo optimizar: ${err.message}`);
        }
        loadFiles(state.filesPath);
      });
    });
    els.filesList.querySelectorAll("button[data-upload-existing]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.uploadSelectedExisting = { path: btn.dataset.uploadExisting, name: btn.dataset.uploadName };
        renderUploadSelectedExisting();
        switchToUploadTab();
        els.newJobCard.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    els.filesList.querySelectorAll("button[data-download]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.location.href = `/api/files/download?path=${encodeURIComponent(btn.dataset.download)}`;
      });
    });
    els.filesList.querySelectorAll("button[data-rename]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const current = btn.dataset.name;
        const proposed = prompt("Nuevo nombre:", current);
        if (proposed === null || proposed.trim() === "" || proposed.trim() === current) return;
        try {
          await fetchJSON("/api/files/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: btn.dataset.rename, new_name: proposed }),
          });
          if (state.uploadSelectedExisting && state.uploadSelectedExisting.path === btn.dataset.rename) {
            state.uploadSelectedExisting = null;
            renderUploadSelectedExisting();
          }
          loadFiles(state.filesPath);
        } catch (err) {
          alert(`No se pudo renombrar: ${err.message}`);
        }
      });
    });
    els.filesList.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`¿Borrar "${btn.dataset.name}"? Esta acción no se puede deshacer.`)) return;
        await fetchJSON("/api/files", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: btn.dataset.delete }),
        });
        loadFiles(state.filesPath);
      });
    });
  } catch (err) {
    els.filesList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

els.toggleFiles.addEventListener("click", () => {
  state.filesOpen = !state.filesOpen;
  els.filesPanel.classList.toggle("hidden", !state.filesOpen);
  els.refreshFiles.classList.toggle("hidden", !state.filesOpen);
  if (state.filesOpen) loadFiles(state.filesPath);
});
els.refreshFiles.addEventListener("click", () => loadFiles(state.filesPath));

function openPreview(path, kind) {
  const url = `/api/files/preview?path=${encodeURIComponent(path)}`;
  if (kind === "video") {
    els.previewContent.innerHTML = `<video src="${url}" controls autoplay></video>`;
  } else if (kind === "audio") {
    els.previewContent.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
  } else if (kind === "image") {
    els.previewContent.innerHTML = `<img src="${url}" alt="">`;
  } else {
    return;
  }
  els.previewModal.classList.remove("hidden");
}

function closePreview() {
  els.previewModal.classList.add("hidden");
  els.previewContent.innerHTML = ""; // removing the element stops playback
}

els.previewClose.addEventListener("click", closePreview);
els.previewModal.addEventListener("click", (e) => {
  if (e.target === els.previewModal) closePreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePreview();
});

// ── Uploads (multi-site: same file(s) to every site you check) ─────────────

function renderUploadSelectedExisting() {
  if (!state.uploadSelectedExisting) {
    els.uploadSelectedExistingEl.classList.add("hidden");
    els.uploadSelectedExistingEl.innerHTML = "";
    return;
  }
  els.uploadSelectedExistingEl.classList.remove("hidden");
  els.uploadSelectedExistingEl.innerHTML =
    `Vas a subir: <strong>${state.uploadSelectedExisting.name}</strong> (ya descargado) ` +
    `<button type="button" class="btn small" id="upload-selected-clear">quitar</button>`;
  document.getElementById("upload-selected-clear").addEventListener("click", () => {
    state.uploadSelectedExisting = null;
    renderUploadSelectedExisting();
  });
}

function renderUploadSiteChecks() {
  els.uploadSiteChecks.innerHTML = state.uploadSites.map((s) => `
    <label class="upload-site-check">
      <input type="checkbox" data-site-check="${s.site}" ${state.uploadSelectedSites.has(s.site) ? "checked" : ""}>
      ${s.label}${s.needs_account ? (s.configured ? " ✓" : " (necesita cuenta)") : (s.account_optional && s.configured ? " ✓" : "")}
    </label>`
  ).join("");
  els.uploadSiteChecks.querySelectorAll("input[data-site-check]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const site = cb.dataset.siteCheck;
      if (cb.checked) state.uploadSelectedSites.add(site);
      else state.uploadSelectedSites.delete(site);
      renderUploadAccountBlocks();
    });
  });
}

function siteInfo(site) {
  return state.uploadSites.find((s) => s.site === site) || null;
}

function uploadAccountBlockHTML(info) {
  const folders = state.uploadFoldersBySite[info.site] || [];
  const chosen = state.uploadFolderChoiceBySite[info.site] || "";
  return `<div class="upload-site-block" data-block-site="${info.site}">
    <h4>${info.label}</h4>
    ${info.configured ? `
      <div class="account-row">
        <span class="dim">Cuenta: ${info.account_label || "configurada"}</span>
        <button type="button" class="btn small danger" data-remove-account="${info.site}">Quitar</button>
      </div>
      ${info.has_folders ? `
        <div class="field-row">
          <div class="field">
            <label>Carpeta / álbum destino</label>
            <select data-folder-select="${info.site}">
              ${folders.length ? folders.map((f) => `<option value="${f.id}" ${f.id === chosen ? "selected" : ""}>${f.name}</option>`).join("") : `<option value="">(sin carpetas)</option>`}
            </select>
          </div>
          <div class="field">
            <label>Crear nueva</label>
            <div class="inline-form">
              <input type="text" data-new-folder="${info.site}" placeholder="nombre">
              <button type="button" class="btn small" data-create-folder="${info.site}">Crear</button>
            </div>
          </div>
        </div>` : ""}
    ` : `
      <div class="field-row">
        <div class="field">
          <label>Token de cuenta${info.account_optional ? " (opcional)" : ""}</label>
          <input type="password" data-token-input="${info.site}" placeholder="pegá tu token">
          <span class="field-hint">${info.account_optional ? "Sin token sube como invitado (link expira a los ~10 días de inactividad). Cargá un token para elegir carpeta y que quede permanente. " : ""}Se guarda en el servidor, nunca se vuelve a mostrar</span>
        </div>
        <div class="field">
          <label>&nbsp;</label>
          <button type="button" class="btn" data-save-account="${info.site}">Guardar y verificar</button>
        </div>
      </div>
    `}
    <span class="error-msg" data-account-error="${info.site}"></span>
  </div>`;
}

function renderUploadAccountBlocks() {
  const blocks = [...state.uploadSelectedSites]
    .map(siteInfo)
    .filter((info) => info && (info.needs_account || info.account_optional));

  els.uploadAccountBlocks.innerHTML = blocks.map(uploadAccountBlockHTML).join("");

  for (const info of blocks) {
    if (info.configured && info.has_folders && !state.uploadFoldersBySite[info.site]) {
      refreshUploadFoldersFor(info.site);
    }
  }

  els.uploadAccountBlocks.querySelectorAll("button[data-save-account]").forEach((btn) => {
    btn.addEventListener("click", () => saveUploadAccount(btn.dataset.saveAccount));
  });
  els.uploadAccountBlocks.querySelectorAll("button[data-remove-account]").forEach((btn) => {
    btn.addEventListener("click", () => removeUploadAccount(btn.dataset.removeAccount));
  });
  els.uploadAccountBlocks.querySelectorAll("select[data-folder-select]").forEach((sel) => {
    sel.addEventListener("change", () => {
      state.uploadFolderChoiceBySite[sel.dataset.folderSelect] = sel.value;
    });
  });
  els.uploadAccountBlocks.querySelectorAll("button[data-create-folder]").forEach((btn) => {
    btn.addEventListener("click", () => createUploadFolder(btn.dataset.createFolder));
  });
}

function accountErrorEl(site) {
  return els.uploadAccountBlocks.querySelector(`[data-account-error="${site}"]`);
}

async function saveUploadAccount(site) {
  const input = els.uploadAccountBlocks.querySelector(`input[data-token-input="${site}"]`);
  const errEl = accountErrorEl(site);
  const token = (input.value || "").trim();
  if (!token) {
    errEl.textContent = "Falta el token";
    return;
  }
  try {
    await fetchJSON(`/api/uploads/account/${site}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    await refreshUploadSites();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function removeUploadAccount(site) {
  if (!confirm("¿Quitar la cuenta guardada para este sitio?")) return;
  await fetch(`/api/uploads/account/${site}`, { method: "DELETE" });
  delete state.uploadFoldersBySite[site];
  delete state.uploadFolderChoiceBySite[site];
  await refreshUploadSites();
}

async function refreshUploadFoldersFor(site) {
  try {
    const folders = await fetchJSON(`/api/uploads/folders/${site}`);
    state.uploadFoldersBySite[site] = folders;
    if (!state.uploadFolderChoiceBySite[site] && folders.length) {
      state.uploadFolderChoiceBySite[site] = folders[0].id;
    }
    renderUploadAccountBlocks();
  } catch (err) {
    const errEl = accountErrorEl(site);
    if (errEl) errEl.textContent = err.message;
  }
}

async function createUploadFolder(site) {
  const input = els.uploadAccountBlocks.querySelector(`input[data-new-folder="${site}"]`);
  const name = (input.value || "").trim();
  if (!name) return;
  try {
    const folder = await fetchJSON(`/api/uploads/folders/${site}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    state.uploadFolderChoiceBySite[site] = folder.id;
    delete state.uploadFoldersBySite[site];
    await refreshUploadFoldersFor(site);
  } catch (err) {
    const errEl = accountErrorEl(site);
    if (errEl) errEl.textContent = err.message;
  }
}

async function refreshUploadSites() {
  try {
    state.uploadSites = await fetchJSON("/api/uploads/sites");
    renderUploadSiteChecks();
    renderUploadAccountBlocks();
  } catch (err) {
    els.uploadSiteChecks.innerHTML = `<span class="error-msg">${err.message}</span>`;
  }
}

async function submitUpload() {
  els.uploadFormError.textContent = "";
  const sites = [...state.uploadSelectedSites].map(siteInfo).filter(Boolean);
  if (!sites.length) {
    els.uploadFormError.textContent = "Marcá al menos un sitio destino";
    return;
  }
  const notReady = sites.filter((s) => s.needs_account && !s.configured);
  if (notReady.length) {
    els.uploadFormError.textContent = `Configurá la cuenta primero: ${notReady.map((s) => s.label).join(", ")}`;
    return;
  }
  const files = [...els.uploadFileInput.files];
  if (!files.length && !state.uploadSelectedExisting) {
    els.uploadFormError.textContent = "Elegí un archivo del dispositivo o uno ya descargado";
    return;
  }

  els.submitBtn.disabled = true;
  try {
    for (const info of sites) {
      const folderId = info.has_folders ? (state.uploadFolderChoiceBySite[info.site] || null) : null;
      const folderName = folderId
        ? ((state.uploadFoldersBySite[info.site] || []).find((f) => f.id === folderId) || {}).name
        : null;

      if (state.uploadSelectedExisting) {
        await fetchJSON("/api/uploads/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            site: info.site, path: state.uploadSelectedExisting.path,
            folder_id: folderId, folder_name: folderName,
          }),
        });
      }
      for (const file of files) {
        const form = new FormData();
        form.append("site", info.site);
        if (folderId) form.append("folder_id", folderId);
        if (folderName) form.append("folder_name", folderName);
        form.append("file", file);
        await fetchJSON("/api/uploads/jobs", { method: "POST", body: form });
      }
    }
    state.uploadSelectedExisting = null;
    renderUploadSelectedExisting();
    els.uploadFileInput.value = "";
    refreshUploadJobs();
  } catch (err) {
    els.uploadFormError.textContent = err.message;
  } finally {
    els.submitBtn.disabled = false;
  }
}

function copyToClipboard(text, btn) {
  const done = () => {
    const original = btn.textContent;
    btn.textContent = "✓ Copiado";
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

function uploadJobCard(job) {
  const created = new Date(job.created_at * 1000).toLocaleString();
  const dest = job.dest_folder_name ? ` → ${job.dest_folder_name}` : "";
  return `<div class="upload-job">
    <div class="upload-job-row">
      <span class="upload-job-name">[${job.site}] ${job.source_name}${dest}</span>
      <span class="badge ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
    </div>
    <div class="upload-job-sub">${created}${job.error ? " · " + job.error : ""}</div>
    ${job.url ? `<div class="upload-job-link">
      <a href="${job.url}" target="_blank" rel="noopener">${job.url}</a>
      <button type="button" class="btn small" data-copy-link="${job.url}">📋 Copiar</button>
    </div>` : ""}
    ${job.status === "done" || job.status === "error" ? `<div class="upload-job-actions"><button class="btn small" data-delete-upload="${job.id}">Borrar</button></div>` : ""}
  </div>`;
}

async function refreshUploadJobs() {
  try {
    const jobs = await fetchJSON("/api/uploads/jobs");
    els.uploadJobsList.innerHTML = jobs.length
      ? jobs.map(uploadJobCard).join("")
      : `<p class="dim">Sin subidas todavía.</p>`;
    els.uploadJobsList.querySelectorAll("button[data-delete-upload]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/uploads/jobs/${btn.dataset.deleteUpload}`, { method: "DELETE" });
        refreshUploadJobs();
      });
    });
    els.uploadJobsList.querySelectorAll("button[data-copy-link]").forEach((btn) => {
      btn.addEventListener("click", () => copyToClipboard(btn.dataset.copyLink, btn));
    });
  } catch (err) {
    els.uploadJobsList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

els.uploadClearFinished.addEventListener("click", async () => {
  await fetch("/api/uploads/clear-finished", { method: "POST" });
  refreshUploadJobs();
});

refreshSites();
refreshJobs();
refreshUploadSites();
refreshUploadJobs();
setInterval(refreshJobs, 1500);
setInterval(refreshUploadJobs, 2000);
setInterval(() => { if (state.filesOpen) loadFiles(state.filesPath); }, 5000);
