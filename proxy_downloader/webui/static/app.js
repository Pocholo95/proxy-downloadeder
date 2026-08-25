const state = {
  kind: "auto",
  openLogs: new Set(),
  openVideoLogs: new Set(),
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
  fieldVideo: document.getElementById("field-video"),
  fieldMinSpeed: document.getElementById("field-min-speed"),
  inputSingle: document.getElementById("value-single"),
  inputBatch: document.getElementById("value-batch"),
  inputVideo: document.getElementById("value-video"),
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
  videoJobsList: document.getElementById("video-jobs-list"),
  videoClearFinished: document.getElementById("video-clear-finished"),
  toggleProxySources: document.getElementById("toggle-proxy-sources"),
  proxySourcesPanel: document.getElementById("proxy-sources-panel"),
  proxySourcesList: document.getElementById("proxy-sources-list"),
  psType: document.getElementById("ps-type"),
  psName: document.getElementById("ps-name"),
  psFieldsList: document.getElementById("ps-fields-list"),
  psFieldsGateway: document.getElementById("ps-fields-gateway"),
  psUrl: document.getElementById("ps-url"),
  psScheme: document.getElementById("ps-scheme"),
  psHost: document.getElementById("ps-host"),
  psPort: document.getElementById("ps-port"),
  psUsername: document.getElementById("ps-username"),
  psPassword: document.getElementById("ps-password"),
  psAddBtn: document.getElementById("ps-add-btn"),
  psError: document.getElementById("ps-error"),
  extensionJobsList: document.getElementById("extension-jobs-list"),
  extensionClearFinished: document.getElementById("extension-clear-finished"),
};

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.kind = tab.dataset.kind;
    const isBatch = state.kind === "batch";
    const isUpload = state.kind === "upload";
    const isVideo = state.kind === "video";
    els.fieldBatch.classList.toggle("hidden", !isBatch);
    els.fieldSingle.classList.toggle("hidden", isBatch || isUpload || isVideo);
    els.fieldVideo.classList.toggle("hidden", !isVideo);
    els.fieldUpload.classList.toggle("hidden", !isUpload);
    els.downloadOptionsRow.classList.toggle("hidden", isUpload);
    els.fieldMinSpeed.classList.toggle("hidden", isVideo);
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

els.toggleProxySources.addEventListener("click", () => {
  els.proxySourcesPanel.classList.toggle("hidden");
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
  downloading: "descargando",
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

  if (state.kind === "video") {
    const url = els.inputVideo.value.trim();
    if (!url) {
      els.formError.textContent = "Falta la URL del video";
      return;
    }
    try {
      await fetchJSON("/api/ytdlp/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          output_dir: els.outputDir.value.trim() || null,
          proxy_mode: els.proxyMode.value,
        }),
      });
      els.inputVideo.value = "";
      refreshVideoJobs();
    } catch (err) {
      els.formError.textContent = err.message;
    }
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

function proxySourceRow(source) {
  const detail = source.type === "list"
    ? source.url
    : `${source.scheme}://${source.username}:••••••@${source.host}:${source.port}`;
  return `<div class="job">
    <div class="job-head">
      <div>
        <div class="job-title">${source.name}${source.active ? " ★" : ""}</div>
        <div class="job-meta">${source.type === "list" ? "Lista pública" : "Gateway autenticado"} · ${detail}</div>
      </div>
      ${source.active ? `<span class="badge done">activa</span>` : ""}
    </div>
    <div class="job-actions">
      ${!source.active ? `<button class="btn small" data-activate-source="${source.id}">Usar esta</button>` : ""}
      <button class="btn small danger" data-delete-source="${source.id}">Borrar</button>
    </div>
  </div>`;
}

async function refreshProxySources() {
  try {
    const sourcesList = await fetchJSON("/api/proxy-sources");
    els.proxySourcesList.innerHTML = sourcesList.map(proxySourceRow).join("");
    els.proxySourcesList.querySelectorAll("button[data-activate-source]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetchJSON(`/api/proxy-sources/${btn.dataset.activateSource}/activate`, { method: "POST" });
        refreshProxySources();
      });
    });
    els.proxySourcesList.querySelectorAll("button[data-delete-source]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Borrar esta fuente de proxy?")) return;
        try {
          await fetchJSON(`/api/proxy-sources/${btn.dataset.deleteSource}`, { method: "DELETE" });
          refreshProxySources();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch (err) {
    els.proxySourcesList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

els.psType.addEventListener("change", () => {
  const isGateway = els.psType.value === "gateway";
  els.psFieldsList.classList.toggle("hidden", isGateway);
  els.psFieldsGateway.classList.toggle("hidden", !isGateway);
});

els.psAddBtn.addEventListener("click", async () => {
  els.psError.textContent = "";
  const type = els.psType.value;
  const body = { type, name: els.psName.value.trim() };
  if (type === "list") {
    body.url = els.psUrl.value.trim();
  } else {
    body.scheme = els.psScheme.value;
    body.host = els.psHost.value.trim();
    body.port = els.psPort.value;
    body.username = els.psUsername.value.trim();
    body.password = els.psPassword.value;
  }
  try {
    await fetchJSON("/api/proxy-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    els.psName.value = "";
    els.psUrl.value = "";
    els.psHost.value = "";
    els.psPort.value = "";
    els.psUsername.value = "";
    els.psPassword.value = "";
    refreshProxySources();
  } catch (err) {
    els.psError.textContent = err.message;
  }
});

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
  const uploading = job.status === "uploading";
  const pct = job.total_bytes > 0 ? Math.min(100, (job.bytes_sent / job.total_bytes) * 100) : (job.status === "done" ? 100 : 0);
  const fillClass = job.status === "done" ? "done" : job.status === "error" ? "failed" : "";
  const sizeLabel = job.total_bytes > 0 ? `${fmtBytes(job.bytes_sent)} / ${fmtBytes(job.total_bytes)}` : "";
  return `<div class="upload-job">
    <div class="upload-job-row">
      <span class="upload-job-name">[${job.site}] ${job.source_name}${dest}</span>
      <span class="badge ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
    </div>
    <div class="upload-job-sub">${created}${job.error ? " · " + job.error : ""}</div>
    ${uploading || job.status === "done" ? `<div class="item">
      <div class="item-sub">${sizeLabel}</div>
      <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${pct}%"></div></div>
    </div>` : ""}
    ${job.url ? `<div class="upload-job-link">
      <a href="${job.url}" target="_blank" rel="noopener">${job.url}</a>
      <button type="button" class="btn small" data-copy-link="${job.url}">📋 Copiar</button>
    </div>` : ""}
    ${job.status === "done" || job.status === "error" ? `<div class="upload-job-actions">
      ${job.status === "error" ? `<button class="btn small" data-retry-upload="${job.id}">Reintentar</button>` : ""}
      <button class="btn small" data-delete-upload="${job.id}">Borrar</button>
    </div>` : ""}
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
    els.uploadJobsList.querySelectorAll("button[data-retry-upload]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await fetchJSON(`/api/uploads/jobs/${btn.dataset.retryUpload}/retry`, { method: "POST" });
        } catch (err) {
          alert(err.message);
        }
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

const VIDEO_CANCELLABLE = new Set(["queued", "running"]);
const VIDEO_DELETABLE = new Set(["done", "error", "cancelled"]);

function videoJobCard(job) {
  const created = new Date(job.created_at * 1000).toLocaleString();
  const pct = job.total > 0 ? Math.min(100, (job.bytes_done / job.total) * 100) : (job.status === "done" ? 100 : 0);
  const fillClass = job.status === "done" ? "done" : job.status === "error" ? "failed" : "";
  const speed = job.status === "running" ? fmtSpeed(job.speed_kb) : "";
  const sizeLabel = job.total > 0 ? `${fmtBytes(job.bytes_done)} / ${fmtBytes(job.total)}` : "";
  const logOpen = state.openVideoLogs.has(job.id);
  const title = job.title || job.filename || job.url;
  return `<div class="job" data-video-job="${job.id}">
    <div class="job-head">
      <div>
        <div class="job-title">${title.length > 90 ? title.slice(0, 90) + "…" : title}</div>
        <div class="job-meta">${created} · salida: ${job.output_dir}${job.error ? " · " + job.error : ""}</div>
      </div>
      <span class="badge ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
    </div>
    <div class="item">
      <div class="item-sub">${sizeLabel} ${speed ? "· " + speed : ""}</div>
      <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${pct}%"></div></div>
    </div>
    <div class="job-actions">
      ${VIDEO_CANCELLABLE.has(job.status) ? `<button class="btn small danger" data-video-cancel="${job.id}" ${job.status === "cancelling" ? "disabled" : ""}>${job.status === "cancelling" ? "Cancelando…" : "Cancelar"}</button>` : ""}
      ${VIDEO_DELETABLE.has(job.status) ? `<button class="btn small" data-video-delete="${job.id}">Borrar</button>` : ""}
      <button class="btn small" data-video-toggle-log="${job.id}">${logOpen ? "Ocultar log" : "Ver log"}</button>
    </div>
    ${logOpen ? `<pre class="log" id="video-log-${job.id}">cargando…</pre>` : ""}
  </div>`;
}

async function refreshVideoJobs() {
  try {
    const jobs = await fetchJSON("/api/ytdlp/jobs");
    els.videoJobsList.innerHTML = jobs.length
      ? jobs.map(videoJobCard).join("")
      : `<p class="dim">Sin videos todavía.</p>`;

    els.videoJobsList.querySelectorAll("button[data-video-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await fetch(`/api/ytdlp/jobs/${btn.dataset.videoCancel}/cancel`, { method: "POST" });
        refreshVideoJobs();
      });
    });
    els.videoJobsList.querySelectorAll("button[data-video-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Borrar este video del historial? No afecta el archivo ya descargado.")) return;
        await fetch(`/api/ytdlp/jobs/${btn.dataset.videoDelete}`, { method: "DELETE" });
        refreshVideoJobs();
      });
    });
    els.videoJobsList.querySelectorAll("button[data-video-toggle-log]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.videoToggleLog;
        if (state.openVideoLogs.has(id)) state.openVideoLogs.delete(id);
        else state.openVideoLogs.add(id);
        refreshVideoJobs();
      });
    });
    for (const id of state.openVideoLogs) {
      const pre = document.getElementById(`video-log-${id}`);
      if (!pre) continue;
      fetch(`/api/ytdlp/jobs/${id}/log`).then((r) => r.text()).then((text) => {
        const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 10;
        pre.textContent = text || "(sin salida todavía)";
        if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
      });
    }
  } catch (err) {
    els.videoJobsList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

els.videoClearFinished.addEventListener("click", async () => {
  await fetch("/api/ytdlp/clear-finished", { method: "POST" });
  refreshVideoJobs();
});

// ── Videos (extensión): jobs creados por el userscript de Violentmonkey
// (extras/violentmonkey/video-catcher.user.js) — ya viene con el video
// elegido, así que acá solo se muestra el progreso de la descarga. ──

function extensionItemProgress(item) {
  const pct = item.total > 0 ? Math.min(100, (item.bytes_done / item.total) * 100) : (item.status === "done" ? 100 : 0);
  const fillClass = item.status === "done" ? "done" : item.status === "failed" ? "failed" : "";
  const speed = item.status === "running" ? fmtSpeed(item.speed_kb) : "";
  const sizeLabel = item.total > 0 ? `${fmtBytes(item.bytes_done)} / ${fmtBytes(item.total)}` : fmtBytes(item.bytes_done);
  return `<div class="item">
    <div class="item-row">
      <span class="item-name">${item.filename}</span>
      <span class="badge ${item.status}">${STATUS_LABELS[item.status] || item.status}</span>
    </div>
    <div class="item-sub">${sizeLabel ? sizeLabel : ""} ${speed ? "· " + speed : ""} ${item.message ? "· " + item.message : ""}</div>
    <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${pct}%"></div></div>
  </div>`;
}

const EXTENSION_CANCELLABLE = new Set(["queued", "downloading"]);
const EXTENSION_DELETABLE = new Set(["done", "done_with_errors", "error", "cancelled"]);

function extensionJobCard(job) {
  const created = new Date(job.created_at * 1000).toLocaleString();
  const title = job.page_url.length > 90 ? job.page_url.slice(0, 90) + "…" : job.page_url;
  const itemsHtml = job.items && job.items.length ? job.items.map(extensionItemProgress).join("") : "";
  return `<div class="job" data-extension-job="${job.id}">
    <div class="job-head">
      <div>
        <div class="job-title">${title}</div>
        <div class="job-meta">${created}${job.error ? " · " + job.error : ""}</div>
      </div>
      <span class="badge ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
    </div>
    <div class="items">${itemsHtml}</div>
    <div class="job-actions">
      ${EXTENSION_CANCELLABLE.has(job.status) ? `<button class="btn small danger" data-extension-cancel="${job.id}">Cancelar</button>` : ""}
      ${EXTENSION_DELETABLE.has(job.status) ? `<button class="btn small" data-extension-delete="${job.id}">Borrar</button>` : ""}
      <button class="btn small" data-extension-toggle-log="${job.id}">${state.openLogs.has(`extension-${job.id}`) ? "Ocultar log" : "Ver log"}</button>
    </div>
    ${state.openLogs.has(`extension-${job.id}`) ? `<pre class="log" id="extension-log-${job.id}">cargando…</pre>` : ""}
  </div>`;
}

async function refreshExtensionJobs() {
  try {
    const jobs = await fetchJSON("/api/extension/jobs");
    els.extensionJobsList.innerHTML = jobs.length
      ? jobs.map(extensionJobCard).join("")
      : `<p class="dim">Sin videos todavía.</p>`;

    els.extensionJobsList.querySelectorAll("button[data-extension-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await fetch(`/api/extension/jobs/${btn.dataset.extensionCancel}/cancel`, { method: "POST" });
        refreshExtensionJobs();
      });
    });
    els.extensionJobsList.querySelectorAll("button[data-extension-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Borrar este video del historial? No afecta los archivos ya descargados.")) return;
        try {
          await fetchJSON(`/api/extension/jobs/${btn.dataset.extensionDelete}`, { method: "DELETE" });
          refreshExtensionJobs();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    els.extensionJobsList.querySelectorAll("button[data-extension-toggle-log]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = `extension-${btn.dataset.extensionToggleLog}`;
        if (state.openLogs.has(key)) state.openLogs.delete(key);
        else state.openLogs.add(key);
        refreshExtensionJobs();
      });
    });
    for (const job of jobs) {
      const key = `extension-${job.id}`;
      if (!state.openLogs.has(key)) continue;
      const pre = document.getElementById(`extension-log-${job.id}`);
      if (!pre) continue;
      fetch(`/api/extension/jobs/${job.id}/log`).then((r) => r.text()).then((text) => {
        const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 10;
        pre.textContent = text || "(sin salida todavía)";
        if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
      });
    }
  } catch (err) {
    els.extensionJobsList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

els.extensionClearFinished.addEventListener("click", async () => {
  await fetch("/api/extension/clear-finished", { method: "POST" });
  refreshExtensionJobs();
});

refreshSites();
refreshProxySources();
refreshJobs();
refreshUploadSites();
refreshUploadJobs();
refreshVideoJobs();
refreshExtensionJobs();
setInterval(refreshJobs, 1500);
setInterval(refreshUploadJobs, 2000);
setInterval(refreshVideoJobs, 1500);
setInterval(refreshExtensionJobs, 2000);
setInterval(() => { if (state.filesOpen) loadFiles(state.filesPath); }, 5000);
