const state = {
  kind: "auto",
  openLogs: new Set(),                // uid ("jobs:<id>" | "video:<id>" | "extension:<id>")
  activityFilter: "all",              // "all" | "jobs" | "video"
  filesOpen: false,
  filesPath: "",
  uploadSites: [],                    // from /api/uploads/sites
  uploadSelectedSites: new Set(),     // site names checked for the next upload
  uploadFoldersBySite: {},            // site -> [{id, name}, ...]
  uploadFolderChoiceBySite: {},       // site -> chosen folder id
  uploadSelectedExisting: null,       // {path, name} of an already-downloaded file picked for upload
  uploadSelectedFolder: null,         // {path, name} of an already-downloaded folder picked for a batch upload
  uploadGroupOverride: new Map(),     // source_name -> explicit open/closed the user picked
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
  activityList: document.getElementById("activity-list"),
  activityClearFinished: document.getElementById("activity-clear-finished"),
  activityFilters: document.getElementById("activity-filters"),
  sitesList: document.getElementById("sites-list"),
  toggleSites: document.getElementById("toggle-sites"),
  filesPanel: document.getElementById("files-panel"),
  filesList: document.getElementById("files-list"),
  filesBreadcrumb: document.getElementById("files-breadcrumb"),
  toggleFiles: document.getElementById("toggle-files"),
  refreshFiles: document.getElementById("refresh-files"),
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

els.activityClearFinished.addEventListener("click", async () => {
  if (!confirm("¿Borrar del historial todo lo ya terminado? No afecta los archivos ya descargados.")) return;
  await Promise.all([
    fetch("/api/jobs/clear-finished", { method: "POST" }),
    fetch("/api/ytdlp/clear-finished", { method: "POST" }),
    fetch("/api/extension/clear-finished", { method: "POST" }),
  ]);
  refreshActivity();
});

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
  uploading: "subiendo",
};

const ENGINE_LABELS = { aria2: "⚡ aria2", ffmpeg: "🎞 ffmpeg", requests: "requests", "yt-dlp": "yt-dlp nativo" };
function engineLabel(engine) {
  return engine ? ENGINE_LABELS[engine] || engine : "";
}

const CANCELLABLE_STATUSES = new Set(["queued", "resolving", "fetching_proxies", "running"]);
const RETRYABLE_STATUSES = new Set(["done_with_errors", "error", "cancelled"]);
const DELETABLE_STATUSES = new Set(["done", "done_with_errors", "error", "cancelled"]);
const VIDEO_CANCELLABLE = new Set(["queued", "running"]);
const VIDEO_DELETABLE = new Set(["done", "error", "cancelled"]);
const EXTENSION_CANCELLABLE = new Set(["queued", "downloading"]);
const EXTENSION_DELETABLE = new Set(["done", "done_with_errors", "error", "cancelled"]);

// The various refresh*() functions below poll every 1.5-2s and used to
// replace a whole list's innerHTML every single tick regardless of whether
// anything in it actually changed -- which wiped out any text selection
// inside it and caused a visible flicker even while the app sat idle.
// This skips the DOM rebuild (and the listener rebinding that goes with
// it) whenever the freshly-rendered HTML is byte-identical to what's
// already on screen, keyed per list so one actively-progressing download
// doesn't force unrelated, unchanged lists to redraw too. A card that's
// genuinely mid-download still redraws each tick, since its own numbers
// are genuinely changing -- there's no getting around that without a much
// heavier per-field DOM diff.
//
// Tracked per DOM element (not per key): some elements are reused across
// several logical "views" that share one key namespace but aren't the same
// content -- the files list is keyed by path, the activity list by filter.
// Keying the cache by that string alone breaks navigating back to a view
// whose content happens to be byte-identical to what it was last time:
// e.g. folder A hasn't changed, so re-entering it after visiting folder B
// would compare against A's own last-rendered html, match, and skip the
// render entirely -- even though the DOM is currently showing B, not A.
// Storing {key, html} together and requiring BOTH to match is what makes a
// bare key change (a different path/filter) always force a real render,
// while still skipping a plain unchanged poll of the same current view.
const _lastRendered = new Map();
function updateListHTML(el, key, html) {
  const last = _lastRendered.get(el);
  if (last && last.key === key && last.html === html) return false;
  _lastRendered.set(el, { key, html });
  el.innerHTML = html;
  return true;
}

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
      refreshActivity();
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
    refreshActivity();
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

// ── Actividad: una sola lista fusionando los 3 motores de descarga
// (Trabajos/SiteProvider, yt-dlp, extensión) en vez de 3 secciones
// separadas -- cada uno se normaliza a la misma forma y se renderiza con
// el mismo activityCard(), así que cancelar/reintentar/borrar/ver-log
// funcionan igual sin importar cuál de los 3 motores hizo la descarga.

function activityItemRow(item) {
  const pct = item.total > 0 ? Math.min(100, (item.bytes_done / item.total) * 100) : (item.status === "done" ? 100 : 0);
  const fillClass = item.status === "done" ? "done" : item.status === "failed" ? "failed" : "";
  const speed = (item.status === "running" || item.status === "downloading") ? fmtSpeed(item.speed_kb) : "";
  const sizeLabel = item.total > 0 ? `${fmtBytes(item.bytes_done)} / ${fmtBytes(item.total)}` : fmtBytes(item.bytes_done);
  const bits = [item.modeLabel, engineLabel(item.engine), sizeLabel, speed, item.message].filter(Boolean);
  const nameRow = item.filename
    ? `<div class="item-row">
        <span class="item-name">${item.filename}${item.site ? ` <span class="dim">(${item.site})</span>` : ""}</span>
        <span class="badge ${item.status}">${STATUS_LABELS[item.status] || item.status}</span>
      </div>`
    : "";
  return `<div class="item">
    ${nameRow}
    <div class="item-sub">${bits.join(" · ")}</div>
    <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${pct}%"></div></div>
  </div>`;
}

function normalizeJobsEntry(job) {
  const hasRetryable = job.items.some((it) => it.status === "failed" || it.status === "cancelled");
  return {
    uid: `jobs:${job.id}`, id: job.id, apiBase: "/api/jobs", kind: "jobs",
    title: `[${job.kind}] ${job.input.length > 90 ? job.input.slice(0, 90) + "…" : job.input}`,
    meta: `salida: ${job.output_dir} · ${job.summary.done}/${job.summary.total} ok${job.summary.failed ? `, ${job.summary.failed} fallidos` : ""}${job.error ? " · " + job.error : ""}`,
    status: job.status, statusLabel: STATUS_LABELS[job.status] || job.status,
    items: job.items.map((it) => ({
      filename: it.filename || it.file_id, site: it.site, status: it.status,
      bytes_done: it.bytes_done, total: it.total, speed_kb: it.speed_kb, message: it.message,
      engine: it.engine, modeLabel: it.mode === "proxy" ? "vía proxy" : "directo",
    })),
    cancellable: CANCELLABLE_STATUSES.has(job.status), cancelling: job.status === "cancelling",
    deletable: DELETABLE_STATUSES.has(job.status),
    retryable: RETRYABLE_STATUSES.has(job.status) && hasRetryable,
    created_at: job.created_at,
  };
}

function normalizeYtdlpEntry(job) {
  const title = job.title || job.filename || job.url;
  return {
    uid: `video:${job.id}`, id: job.id, apiBase: "/api/ytdlp/jobs", kind: "video",
    title: title.length > 90 ? title.slice(0, 90) + "…" : title,
    meta: `salida: ${job.output_dir}${engineLabel(job.engine) ? " · " + engineLabel(job.engine) : ""}${job.error ? " · " + job.error : ""}`,
    status: job.status, statusLabel: STATUS_LABELS[job.status] || job.status,
    items: [{
      filename: null, site: null, status: job.status, bytes_done: job.bytes_done, total: job.total,
      speed_kb: job.speed_kb, message: null, engine: null, modeLabel: null,
    }],
    cancellable: VIDEO_CANCELLABLE.has(job.status), cancelling: job.status === "cancelling",
    deletable: VIDEO_DELETABLE.has(job.status), retryable: false,
    created_at: job.created_at,
  };
}

function normalizeExtensionEntry(job) {
  return {
    uid: `extension:${job.id}`, id: job.id, apiBase: "/api/extension/jobs", kind: "video",
    title: job.page_url.length > 90 ? job.page_url.slice(0, 90) + "…" : job.page_url,
    meta: job.error || "",
    status: job.status, statusLabel: STATUS_LABELS[job.status] || job.status,
    items: (job.items || []).map((it) => ({
      filename: it.filename, site: null, status: it.status,
      bytes_done: it.bytes_done, total: it.total, speed_kb: it.speed_kb, message: it.message,
      engine: it.engine, modeLabel: null,
    })),
    cancellable: EXTENSION_CANCELLABLE.has(job.status), cancelling: false,
    deletable: EXTENSION_DELETABLE.has(job.status), retryable: false,
    created_at: job.created_at,
  };
}

function activityCard(entry) {
  const created = new Date(entry.created_at * 1000).toLocaleString();
  const logOpen = state.openLogs.has(entry.uid);
  return `<div class="job" data-uid="${entry.uid}">
    <div class="job-head">
      <div>
        <div class="job-title">${entry.title}</div>
        <div class="job-meta">${created}${entry.meta ? " · " + entry.meta : ""}</div>
      </div>
      <span class="badge ${entry.status}">${entry.statusLabel}</span>
    </div>
    <div class="items">${entry.items.map(activityItemRow).join("")}</div>
    <div class="job-actions">
      ${entry.cancellable ? `<button class="btn small danger" data-action="cancel" data-api-base="${entry.apiBase}" data-id="${entry.id}" ${entry.cancelling ? "disabled" : ""}>${entry.cancelling ? "Cancelando…" : "Cancelar"}</button>` : ""}
      ${entry.retryable ? `<button class="btn small" data-action="retry" data-api-base="${entry.apiBase}" data-id="${entry.id}">Reintentar fallidos</button>` : ""}
      ${entry.deletable ? `<button class="btn small" data-action="delete-activity" data-api-base="${entry.apiBase}" data-id="${entry.id}">Borrar</button>` : ""}
      <button class="btn small" data-action="toggle-log" data-uid="${entry.uid}">${logOpen ? "Ocultar log" : "Ver log"}</button>
    </div>
    ${logOpen ? `<pre class="log" id="log-${entry.uid}">cargando…</pre>` : ""}
  </div>`;
}

// Delegated on the container, bound once -- never needs rebinding when
// updateListHTML() skips a DOM rebuild because nothing actually changed.
els.activityList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, apiBase, id, uid } = btn.dataset;
  if (action === "cancel") {
    btn.disabled = true;
    await fetch(`${apiBase}/${id}/cancel`, { method: "POST" });
    refreshActivity();
  } else if (action === "retry") {
    try {
      await fetchJSON(`${apiBase}/${id}/retry`, { method: "POST" });
    } catch (err) {
      alert(err.message);
    }
    refreshActivity();
  } else if (action === "delete-activity") {
    if (!confirm("¿Borrar del historial? No afecta los archivos ya descargados.")) return;
    try {
      await fetchJSON(`${apiBase}/${id}`, { method: "DELETE" });
      refreshActivity();
    } catch (err) {
      alert(err.message);
    }
  } else if (action === "toggle-log") {
    if (state.openLogs.has(uid)) state.openLogs.delete(uid);
    else state.openLogs.add(uid);
    refreshActivity();
  }
});

els.activityFilters.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.activityFilter = btn.dataset.filter;
  els.activityFilters.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
  refreshActivity();
});

async function refreshActivity() {
  try {
    const [jobs, videos, exts] = await Promise.all([
      fetchJSON("/api/jobs"), fetchJSON("/api/ytdlp/jobs"), fetchJSON("/api/extension/jobs"),
    ]);
    let entries = [
      ...jobs.map(normalizeJobsEntry),
      ...videos.map(normalizeYtdlpEntry),
      ...exts.map(normalizeExtensionEntry),
    ];
    entries.sort((a, b) => b.created_at - a.created_at);
    const filtered = state.activityFilter === "all" ? entries : entries.filter((e) => e.kind === state.activityFilter);
    const html = filtered.length ? filtered.map(activityCard).join("") : `<p class="dim">Sin actividad todavía.</p>`;
    updateListHTML(els.activityList, "activity:" + state.activityFilter, html);

    for (const entry of filtered) {
      if (!state.openLogs.has(entry.uid)) continue;
      const pre = document.getElementById(`log-${entry.uid}`);
      if (!pre) continue;
      fetch(`${entry.apiBase}/${entry.id}/log`).then((r) => r.text()).then((text) => {
        const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 10;
        pre.textContent = text || "(sin salida todavía)";
        if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
      });
    }
  } catch (err) {
    els.activityList.innerHTML = `<p class="error-msg">${err.message}</p>`;
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
  if (!updateListHTML(els.filesBreadcrumb, "breadcrumb", crumbs.join(""))) return;
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
      ${entry.is_dir ? `<button class="btn small" data-upload-folder="${path}" data-upload-name="${entry.name}">⬆ Subir carpeta</button>` : `<button class="btn small" data-upload-existing="${path}" data-upload-name="${entry.name}">⬆ Subir</button>`}
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
    const html = data.entries.length
      ? `<table>
          <thead><tr><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead>
          <tbody>${data.entries.map(fileRow).join("")}</tbody>
        </table>`
      : `<p class="dim">Vacío.</p>`;
    if (!updateListHTML(els.filesList, "files:" + state.filesPath, html)) return;

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
        state.uploadSelectedFolder = null;
        state.uploadSelectedExisting = { path: btn.dataset.uploadExisting, name: btn.dataset.uploadName };
        els.uploadFileInput.value = "";
        renderUploadSelectedExisting();
        switchToUploadTab();
        els.newJobCard.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    els.filesList.querySelectorAll("button[data-upload-folder]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.uploadSelectedExisting = null;
        state.uploadSelectedFolder = { path: btn.dataset.uploadFolder, name: btn.dataset.uploadName };
        els.uploadFileInput.value = "";
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
  if (state.uploadSelectedFolder) {
    els.uploadSelectedExistingEl.classList.remove("hidden");
    els.uploadSelectedExistingEl.innerHTML =
      `Vas a subir la carpeta: <strong>${state.uploadSelectedFolder.name}</strong> (todos sus archivos) ` +
      `<button type="button" class="btn small" id="upload-selected-clear">quitar</button>` +
      `<div class="field" style="margin-top:8px;">` +
      `<label for="upload-folder-name-input">Nombre de la carpeta destino (donde no hayas elegido una existente)</label>` +
      `<input type="text" id="upload-folder-name-input" value="${escapeAttr(state.uploadSelectedFolder.name)}">` +
      `</div>`;
    document.getElementById("upload-selected-clear").addEventListener("click", () => {
      state.uploadSelectedFolder = null;
      renderUploadSelectedExisting();
    });
    return;
  }
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

els.uploadFileInput.addEventListener("change", () => {
  if (!els.uploadFileInput.files.length) return;
  state.uploadSelectedFolder = null;
  state.uploadSelectedExisting = null;
  renderUploadSelectedExisting();
});

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

  if (state.uploadSelectedFolder) {
    els.submitBtn.disabled = true;
    try {
      const sitesPayload = sites.map((info) => {
        const folderId = info.has_folders ? (state.uploadFolderChoiceBySite[info.site] || null) : null;
        const folderName = folderId
          ? ((state.uploadFoldersBySite[info.site] || []).find((f) => f.id === folderId) || {}).name
          : null;
        return { site: info.site, folder_id: folderId, folder_name: folderName };
      });
      const nameInput = document.getElementById("upload-folder-name-input");
      const newFolderName = (nameInput ? nameInput.value : "").trim() || state.uploadSelectedFolder.name;
      const result = await fetchJSON("/api/uploads/folder-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.uploadSelectedFolder.path, folder_name: newFolderName, sites: sitesPayload }),
      });
      if (result.errors && result.errors.length) {
        els.uploadFormError.textContent = result.errors.join("; ");
      }
      state.uploadSelectedFolder = null;
      renderUploadSelectedExisting();
      refreshUploadJobs();
    } catch (err) {
      els.uploadFormError.textContent = err.message;
    } finally {
      els.submitBtn.disabled = false;
    }
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

// ── Subidas: agrupadas por archivo fuente (source_name), no por sitio --
// un mismo archivo subido a 3 sitios daba 3 filas sueltas sin relación
// visible entre ellas; ahora es un grupo colapsable "archivo.mp4" con cada
// subida (sitio, link, progreso) anidada debajo. El agrupamiento es puramente
// por nombre -- no depende de que el archivo original siga en disco. ──

function uploadGroupItemRow(job) {
  const pct = job.total_bytes > 0 ? Math.min(100, (job.bytes_sent / job.total_bytes) * 100) : (job.status === "done" ? 100 : 0);
  const dest = job.dest_folder_name ? ` → ${job.dest_folder_name}` : "";
  // The group header already shows the source filename for a single-file
  // group (see uploadGroupCard) -- only a batch group's items need it
  // repeated here, since that header shows the shared destination folder
  // name instead, and each row in it is a different local file.
  const filePrefix = job.batch_id ? `${job.source_name} · ` : "";
  let sub;
  if (job.url) {
    sub = `<a href="${job.url}" target="_blank" rel="noopener">${job.url}</a>`;
    if (job.folder_url) {
      sub += `<br>carpeta: <a href="${job.folder_url}" target="_blank" rel="noopener">${job.folder_url}</a>`;
    }
  } else {
    sub = job.error || (job.status === "uploading" ? `${fmtBytes(job.bytes_sent)} / ${fmtBytes(job.total_bytes)}` : "");
  }
  return `<div class="upload-group-item">
    <div class="upload-group-item-main">
      <div class="upload-group-item-site">${filePrefix}${job.site}${dest}</div>
      <div class="upload-group-item-sub">${sub}</div>
    </div>
    <div class="upload-group-item-actions">
      ${job.status === "uploading" ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
      <span class="badge ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
      ${job.url ? `<button type="button" class="btn small" data-action="copy-link" data-link="${job.url}">Copiar</button>` : ""}
      ${job.folder_url ? `<button type="button" class="btn small" data-action="copy-link" data-link="${job.folder_url}">Copiar carpeta</button>` : ""}
      ${job.status === "error" ? `<button type="button" class="btn small" data-action="retry-upload" data-id="${job.id}">Reintentar</button>` : ""}
      ${(job.status === "done" || job.status === "error") ? `<button type="button" class="btn small" data-action="delete-upload" data-id="${job.id}">Borrar</button>` : ""}
    </div>
  </div>`;
}

function uploadGroupCard(key, label, isBatch, jobs) {
  const hasActive = jobs.some((j) => j.status === "queued" || j.status === "uploading" || j.status === "error");
  const override = state.uploadGroupOverride.get(key);
  const open = override === undefined ? hasActive : override;
  return `<div class="upload-group">
    <button type="button" class="upload-group-head" data-action="toggle-group" data-group="${key}" aria-expanded="${open}">
      <span><span class="upload-group-chevron">▸</span>${isBatch ? "📁 " : ""}${label}</span>
      <span class="upload-group-count">${jobs.length} ${jobs.length === 1 ? "subida" : "subidas"}</span>
    </button>
    <div class="upload-group-body"${open ? "" : ` style="display:none"`}>
      ${jobs.map(uploadGroupItemRow).join("")}
    </div>
  </div>`;
}

els.uploadJobsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, group, link, id } = btn.dataset;
  if (action === "toggle-group") {
    const isOpen = btn.getAttribute("aria-expanded") === "true";
    state.uploadGroupOverride.set(group, !isOpen);
    refreshUploadJobs();
  } else if (action === "copy-link") {
    copyToClipboard(link, btn);
  } else if (action === "retry-upload") {
    btn.disabled = true;
    try {
      await fetchJSON(`/api/uploads/jobs/${id}/retry`, { method: "POST" });
    } catch (err) {
      alert(err.message);
    }
    refreshUploadJobs();
  } else if (action === "delete-upload") {
    try {
      await fetch(`/api/uploads/jobs/${id}`, { method: "DELETE" });
      refreshUploadJobs();
    } catch (err) {
      alert(err.message);
    }
  }
});

async function refreshUploadJobs() {
  try {
    const jobs = await fetchJSON("/api/uploads/jobs");
    // Group by batch_id when present (every file from one "Subir carpeta"
    // batch, N different source_names that would otherwise each start
    // their own separate group) -- else by source_name, the original
    // case of one file uploaded to several sites landing in one group.
    const groups = new Map(); // key -> {label, isBatch, jobs}
    for (const job of jobs) {
      const key = job.batch_id || job.source_name;
      if (!groups.has(key)) {
        groups.set(key, { label: job.batch_id ? (job.batch_label || key) : job.source_name, isBatch: !!job.batch_id, jobs: [] });
      }
      groups.get(key).jobs.push(job);
    }
    for (const g of groups.values()) g.jobs.sort((a, b) => b.created_at - a.created_at);
    const groupEntries = [...groups.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].jobs.map((j) => j.created_at));
      const bMax = Math.max(...b[1].jobs.map((j) => j.created_at));
      return bMax - aMax;
    });
    const html = groupEntries.length
      ? groupEntries.map(([key, g]) => uploadGroupCard(key, g.label, g.isBatch, g.jobs)).join("")
      : `<p class="dim">Sin subidas todavía.</p>`;
    updateListHTML(els.uploadJobsList, "uploads", html);
  } catch (err) {
    els.uploadJobsList.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

els.uploadClearFinished.addEventListener("click", async () => {
  await fetch("/api/uploads/clear-finished", { method: "POST" });
  refreshUploadJobs();
});

refreshSites();
refreshProxySources();
refreshActivity();
refreshUploadSites();
refreshUploadJobs();
setInterval(refreshActivity, 1500);
setInterval(refreshUploadJobs, 2000);
setInterval(() => { if (state.filesOpen) loadFiles(state.filesPath); }, 5000);
