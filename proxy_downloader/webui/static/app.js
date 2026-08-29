// ── Shared state ────────────────────────────────────────────────────────
const state = {
  kind: "auto",                       // which "Agregar" modal tab is active
  view: "all",                        // sidebar selection: "all" | "downloads" | "downloads:<site>" |
                                       // "video" | "extension" | "uploads" | "uploads:<site>" |
                                       // "st:queued" | "st:active" | "st:done" | "st:error" |
                                       // "view:files" | "view:sites"
  query: "",
  selected: new Set(),                // selected task uids (top-level rows only)
  expanded: new Set(),                // task uids currently showing their child rows
  openLogs: new Set(),                // uid ("jobs:<id>" | "video:<id>" | "extension:<id>")
  filesPath: "",
  filesSelected: new Set(),           // selected file paths in the current Archivos listing
  uploadSites: [],                    // from /api/uploads/sites
  uploadSelectedSites: new Set(),     // site names checked for the next upload
  uploadFoldersBySite: {},            // site -> [{id, name}, ...]
  uploadFolderChoiceBySite: {},       // site -> chosen folder id
  uploadSelectedExisting: null,       // {path, name} of an already-downloaded file picked for upload
  uploadSelectedFolder: null,         // {path, name} of an already-downloaded folder picked for a batch upload
  uploadSelectedFiles: null,          // [{path, name}, ...] hand-picked from Archivos (not a whole folder) for a batch upload
};

const els = {
  // topbar
  btnAdd: document.getElementById("btn-add"),
  btnCancelActive: document.getElementById("btn-cancel-active"),
  btnClear: document.getElementById("btn-clear"),
  searchInput: document.getElementById("search-input"),
  // shell
  sidebar: document.getElementById("sidebar"),
  viewTitle: document.getElementById("view-title"),
  viewSub: document.getElementById("view-sub"),
  refreshFilesBtn: document.getElementById("refresh-files-btn"),
  bulkBar: document.getElementById("bulk-bar"),
  bulkCount: document.getElementById("bulk-count"),
  bulkStart: document.getElementById("bulk-start"),
  bulkRetry: document.getElementById("bulk-retry"),
  bulkCancel: document.getElementById("bulk-cancel"),
  bulkDelete: document.getElementById("bulk-delete"),
  tableView: document.getElementById("table-view"),
  taskBody: document.getElementById("task-body"),
  chkAll: document.getElementById("chk-all"),
  filesView: document.getElementById("files-view"),
  sitesView: document.getElementById("sites-view"),
  // status bar
  sbDlSpeed: document.getElementById("sb-dlspeed"),
  sbUlSpeed: document.getElementById("sb-ulspeed"),
  sbActive: document.getElementById("sb-active"),
  sbQueued: document.getElementById("sb-queued"),
  sbHeld: document.getElementById("sb-held"),
  sbDone: document.getElementById("sb-done"),
  sbError: document.getElementById("sb-error"),
  sbStatusMsg: document.getElementById("sb-status-msg"),
  // add-task modal
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalClose: document.getElementById("modal-close"),
  modalCancel: document.getElementById("modal-cancel"),
  modalTabs: document.getElementById("modal-tabs"),
  fieldSingle: document.getElementById("field-single"),
  fieldBatch: document.getElementById("field-batch"),
  fieldVideo: document.getElementById("field-video"),
  fieldMinSpeed: document.getElementById("field-min-speed"),
  fieldHold: document.getElementById("field-hold"),
  holdMode: document.getElementById("hold-mode"),
  inputSingle: document.getElementById("value-single"),
  inputBatch: document.getElementById("value-batch"),
  inputVideo: document.getElementById("value-video"),
  outputDir: document.getElementById("output-dir"),
  proxyMode: document.getElementById("proxy-mode"),
  minSpeed: document.getElementById("min-speed"),
  form: document.getElementById("job-form"),
  formError: document.getElementById("form-error"),
  fieldUpload: document.getElementById("field-upload"),
  downloadOptionsRow: document.getElementById("download-options-row"),
  submitBtn: document.getElementById("submit-btn"),
  uploadSiteChecks: document.getElementById("upload-site-checks"),
  uploadAccountBlocks: document.getElementById("upload-account-blocks"),
  uploadFileInput: document.getElementById("upload-file-input"),
  uploadSelectedExistingEl: document.getElementById("upload-selected-existing"),
  uploadFormError: document.getElementById("upload-form-error"),
  // files view
  filesList: document.getElementById("files-list"),
  filesBreadcrumb: document.getElementById("files-breadcrumb"),
  filesBulkBar: document.getElementById("files-bulk-bar"),
  filesBulkCount: document.getElementById("files-bulk-count"),
  filesBulkUpload: document.getElementById("files-bulk-upload"),
  filesBulkDownload: document.getElementById("files-bulk-download"),
  filesBulkDelete: document.getElementById("files-bulk-delete"),
  filesNewFolderBtn: document.getElementById("files-new-folder"),
  filesBulkMove: document.getElementById("files-bulk-move"),
  filesBulkRename: document.getElementById("files-bulk-rename"),
  // generic file-manager modal (move / advanced rename)
  fmModalBackdrop: document.getElementById("fm-modal-backdrop"),
  fmModalTitle: document.getElementById("fm-modal-title"),
  fmModalBody: document.getElementById("fm-modal-body"),
  fmModalFoot: document.getElementById("fm-modal-foot"),
  fmModalClose: document.getElementById("fm-modal-close"),
  // preview modal
  previewModal: document.getElementById("preview-modal"),
  previewContent: document.getElementById("preview-content"),
  previewClose: document.getElementById("preview-close"),
  // sites/proxy sources view
  sitesList: document.getElementById("sites-list"),
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

// ── Small shared helpers ───────────────────────────────────────────────

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
  if (!kb || kb <= 0) return "—";
  if (kb < 1024) return `${kb.toFixed(0)} KB/s`;
  return `${(kb / 1024).toFixed(1)} MB/s`;
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function copyToClipboard(text, btn) {
  const done = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "✓";
    setTimeout(() => { btn.textContent = original; }, 1200);
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

// The task table and sidebar redraw every ~1.8s poll tick regardless of
// whether anything in them actually changed -- without this, that wipes
// out any in-progress text selection and causes a visible flicker even
// while the app sits idle. Skips the DOM rebuild (and the listener
// rebinding that goes with it) whenever the freshly-rendered HTML is
// byte-identical to what's already on screen. Selection/expand state is
// safe either way since it's read from `state` on every render rather
// than from the DOM, so a skipped rebuild never leaves stale checkboxes.
const _lastRendered = new Map();
function updateListHTML(el, key, html) {
  const last = _lastRendered.get(el);
  if (last && last.key === key && last.html === html) return false;
  _lastRendered.set(el, { key, html });
  el.innerHTML = html;
  return true;
}

const STATUS_LABELS = {
  queued: "en cola",
  resolving: "resolviendo",
  held: "en espera",
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

// Maps a raw status string to one of the 5 visual pill styles. "held" reuses
// the warn/yellow style -- like done_with_errors and cancelling, it's a
// state that wants the user's attention/action, not passive progress.
function statusPillClass(status) {
  if (status === "queued" || status === "cancelled") return "st-queued";
  if (status === "held") return "st-warn";
  if (["resolving", "fetching_proxies", "running", "cancelling", "downloading", "uploading"].includes(status)) return "st-active";
  if (status === "done") return "st-done";
  if (status === "done_with_errors") return "st-warn";
  if (status === "error" || status === "failed") return "st-error";
  return "st-queued";
}

// Held jobs are cancellable (discard before ever downloading) and directly
// deletable (no need to cancel first -- nothing is actually in flight) the
// same way a queued job is, but must NOT be swept up by "Cancelar activos"
// in the toolbar (see that handler) since holding one is a deliberate
// "not yet" the user shouldn't have undone out from under them in bulk.
const CANCELLABLE_STATUSES = new Set(["queued", "held", "resolving", "fetching_proxies", "running"]);
const RETRYABLE_STATUSES = new Set(["done_with_errors", "error", "cancelled"]);
const DELETABLE_STATUSES = new Set(["done", "done_with_errors", "error", "cancelled", "held"]);
const VIDEO_CANCELLABLE = new Set(["queued", "running"]);
const VIDEO_DELETABLE = new Set(["done", "error", "cancelled"]);
const EXTENSION_CANCELLABLE = new Set(["queued", "downloading"]);
const EXTENSION_DELETABLE = new Set(["done", "done_with_errors", "error", "cancelled"]);

// Real per-site accent colors -- distinct from the app's own accent hue so
// they read as "which host" rather than competing with primary/status color.
const SITE_COLOR = {
  pixeldrain: "oklch(0.72 0.17 155)",
  gofile: "oklch(0.74 0.15 230)",
  "1fichier": "oklch(0.75 0.15 85)",
  mega: "oklch(0.7 0.18 25)",
  bunkr: "oklch(0.72 0.16 320)",
  filester: "oklch(0.75 0.13 190)",
  mediafire: "oklch(0.73 0.17 55)",
  fileditch: "oklch(0.72 0.14 280)",
};
function siteSwatch(site) {
  const color = SITE_COLOR[site] || "var(--faint)";
  return `<span class="sw" style="background:${color}"></span>`;
}

const ICONS = {
  file: '<svg class="kind-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5h5M6 3h8l5 5v13H6z"/></svg>',
  folder: '<svg class="kind-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
  video: '<svg class="kind-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3z"/></svg>',
  ext: '<svg class="kind-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h3a2 2 0 0 1 2 2v3a2 2 0 1 0 0 4v3a2 2 0 0 1-2 2h-3a2 2 0 1 0-4 0H7a2 2 0 0 1-2-2v-3a2 2 0 1 0 0-4V5a2 2 0 0 1 2-2h3a2 2 0 1 0 4 0"/></svg>',
  upload: '<svg class="kind-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21V8M6 13l6-6 6 6"/><path d="M4 21h16"/></svg>',
};
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 6l6 6-6 6"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const HOLD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v13M6 11l6 6 6-6"/><path d="M4 21h16"/></svg>';
const RENAME_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const OPTIMIZE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
const MOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M9 15l3-3-3-3"/><path d="M12 12H6"/></svg>';

// ═══════════════════════════════════════════════════════════════════════
// Add-task modal — tabs mirror the 4 old always-visible sidebar tabs, just
// moved into a dialog. Field ids are unchanged so the submit logic below
// (also carried over) needs no changes beyond how the tabs get toggled.
// ═══════════════════════════════════════════════════════════════════════

function setModalKind(kind) {
  state.kind = kind;
  els.modalTabs.querySelectorAll(".mtab").forEach((t) => t.classList.toggle("active", t.dataset.kind === kind));
  const isBatch = kind === "batch";
  const isUpload = kind === "upload";
  const isVideo = kind === "video";
  els.fieldBatch.classList.toggle("hidden", !isBatch);
  els.fieldSingle.classList.toggle("hidden", isBatch || isUpload || isVideo);
  els.fieldVideo.classList.toggle("hidden", !isVideo);
  els.fieldUpload.classList.toggle("hidden", !isUpload);
  els.downloadOptionsRow.classList.toggle("hidden", isUpload);
  els.fieldMinSpeed.classList.toggle("hidden", isVideo);
  // Hold ("solo agregar, no descargar todavía") only exists for the site-
  // download engine (jobs.py) -- yt-dlp/uploads have no resolve-then-park
  // step to hold at.
  els.fieldHold.classList.toggle("hidden", isVideo || isUpload);
  els.submitBtn.textContent = isUpload ? "Subir" : "Descargar";
  if (isUpload) refreshUploadSites();
}

els.modalTabs.querySelectorAll(".mtab").forEach((tab) => {
  tab.addEventListener("click", () => setModalKind(tab.dataset.kind));
});

function openModal(kind) {
  els.formError.textContent = "";
  setModalKind(kind || "auto");
  els.modalBackdrop.classList.add("show");
}
function closeModal() {
  els.modalBackdrop.classList.remove("show");
}
els.btnAdd.addEventListener("click", () => openModal("auto"));
els.modalClose.addEventListener("click", closeModal);
els.modalCancel.addEventListener("click", closeModal);
els.modalBackdrop.addEventListener("click", (e) => { if (e.target === els.modalBackdrop) closeModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.modalBackdrop.classList.contains("show")) closeModal();
});

function switchToUploadTab() {
  openModal("upload");
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
      closeModal();
      refreshTasks();
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
    hold: els.holdMode.checked,
  };
  try {
    await fetchJSON("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    els.inputSingle.value = "";
    els.inputBatch.value = "";
    els.holdMode.checked = false;
    closeModal();
    refreshTasks();
  } catch (err) {
    els.formError.textContent = err.message;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Unified task table — normalizes the 4 independent job engines (site
// downloads, yt-dlp, browser-extension, uploads) into one row shape so
// they share a single sortable/filterable/selectable table instead of 2
// separate always-expanded lists. A folder/batch download, a multi-URL
// extension job, or a multi-site/multi-file upload batch all collapse to
// one row with a disclosure arrow revealing their real per-file items --
// closed by default so a 30-file batch doesn't dominate the screen.
// ═══════════════════════════════════════════════════════════════════════

function truncate(s, n) {
  const clean = String(s).replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

const KIND_LABEL = { file: "archivo", folder: "carpeta", batch: "batch", auto: "" };

function normalizeDownloadEntry(job) {
  const items = job.items || [];
  const sites = [...new Set(items.map((it) => it.site).filter(Boolean))];
  const rawName = truncate(job.input, 90);
  const singleName = items.length === 1 ? (items[0].filename || items[0].hint_name || items[0].file_id) : null;
  const kindLabel = KIND_LABEL[job.kind] || "";
  const sub = items.length > 1
    ? `${items.length} archivos${kindLabel ? " · " + kindLabel : ""}`
    : (items.length === 1 && singleName && job.kind !== "file" ? rawName : null);
  const hasFailed = items.some((it) => it.status === "failed" || it.status === "cancelled");
  const totalBytes = items.reduce((s, it) => s + (it.total || 0), 0);
  const doneBytes = items.reduce((s, it) => s + (it.bytes_done || 0), 0);
  const running = items.find((it) => it.status === "running");
  return {
    uid: `jobs:${job.id}`, id: job.id, apiBase: "/api/jobs", engineKind: "downloads",
    name: singleName || rawName, sub, msg: job.error || null,
    sites, totalBytes, doneBytes, speedKbps: running ? running.speed_kb : 0,
    status: job.status,
    cancellable: CANCELLABLE_STATUSES.has(job.status),
    retryable: RETRYABLE_STATUSES.has(job.status) && hasFailed,
    deletable: DELETABLE_STATUSES.has(job.status),
    startable: job.status === "held",
    createdAt: job.created_at,
    children: items.length > 1 ? items.map((it) => ({
      name: it.filename || it.hint_name || it.file_id, site: it.site,
      totalBytes: it.total, doneBytes: it.bytes_done,
      speedKbps: it.status === "running" ? it.speed_kb : 0,
      status: it.status, msg: it.message,
    })) : null,
    rawJobs: [job],
  };
}

function normalizeYtdlpEntry(job) {
  const name = job.title || job.filename || truncate(job.url, 90);
  return {
    uid: `video:${job.id}`, id: job.id, apiBase: "/api/ytdlp/jobs", engineKind: "video",
    name, sub: job.engine ? `motor: ${job.engine}` : null, msg: job.error || null,
    sites: ["yt-dlp"], totalBytes: job.total, doneBytes: job.bytes_done,
    speedKbps: job.status === "running" ? job.speed_kb : 0,
    status: job.status,
    cancellable: VIDEO_CANCELLABLE.has(job.status), retryable: false,
    deletable: VIDEO_DELETABLE.has(job.status),
    createdAt: job.created_at, children: null, rawJobs: [job],
  };
}

function normalizeExtensionEntry(job) {
  const items = job.items || [];
  const totalBytes = items.reduce((s, it) => s + (it.total || 0), 0);
  const doneBytes = items.reduce((s, it) => s + (it.bytes_done || 0), 0);
  const running = items.find((it) => it.status === "running" || it.status === "downloading");
  const singleName = items.length === 1 ? items[0].filename || items[0].url : null;
  return {
    uid: `extension:${job.id}`, id: job.id, apiBase: "/api/extension/jobs", engineKind: "extension",
    name: singleName || truncate(job.page_url, 90),
    sub: items.length > 1 ? `${items.length} archivos · extensión` : null, msg: job.error || null,
    sites: ["extensión"], totalBytes, doneBytes, speedKbps: running ? running.speed_kb : 0,
    status: job.status,
    cancellable: EXTENSION_CANCELLABLE.has(job.status), retryable: false,
    deletable: EXTENSION_DELETABLE.has(job.status),
    createdAt: job.created_at,
    children: items.length > 1 ? items.map((it) => ({
      name: it.filename || it.url, site: "extensión",
      totalBytes: it.total, doneBytes: it.bytes_done,
      speedKbps: (it.status === "running" || it.status === "downloading") ? it.speed_kb : 0,
      status: it.status, msg: it.message,
    })) : null,
    rawJobs: [job],
  };
}

// Groups upload jobs by batch_id (a whole local folder uploaded at once --
// N different source files) or else by source_name (one file uploaded to
// several sites at once) -- same grouping rule the old separate "Subidas"
// list used, just feeding this table instead of its own section. A group
// of exactly one job renders as a plain leaf row (no point expanding a
// folder icon to reveal the one file it already shows).
function buildUploadEntries(jobs) {
  const groups = new Map(); // key -> {label, jobs: []}
  for (const job of jobs) {
    const key = job.batch_id || job.source_name;
    if (!groups.has(key)) groups.set(key, { label: job.batch_id ? (job.batch_label || key) : job.source_name, jobs: [] });
    groups.get(key).jobs.push(job);
  }
  const entries = [];
  for (const [key, g] of groups) {
    g.jobs.sort((a, b) => b.created_at - a.created_at);
    const sites = [...new Set(g.jobs.map((j) => j.site))];
    const totalBytes = g.jobs.reduce((s, j) => s + (j.total_bytes || 0), 0);
    const doneBytes = g.jobs.reduce((s, j) => s + (j.bytes_sent || 0), 0);
    const uploading = g.jobs.find((j) => j.status === "uploading");
    const status = uploading ? "uploading"
      : g.jobs.some((j) => j.status === "queued") ? "queued"
      : g.jobs.every((j) => j.status === "done") ? "done"
      : g.jobs.every((j) => j.status === "error") ? "error"
      : "done_with_errors";
    const maxCreated = Math.max(...g.jobs.map((j) => j.created_at));
    const fileditchCount = g.jobs.filter((j) => j.site === "fileditch" && j.url).length;
    entries.push({
      uid: `uploads:${key}`, id: key, apiBase: "/api/uploads/jobs", engineKind: "uploads",
      name: g.label, sub: g.jobs.length > 1 ? `${g.jobs.length} subidas` : null,
      msg: g.jobs.length === 1 ? g.jobs[0].error : null,
      sites, totalBytes, doneBytes, speedKbps: uploadGroupSpeed(g.jobs),
      status,
      cancellable: false,
      retryable: g.jobs.some((j) => j.status === "error"),
      deletable: g.jobs.every((j) => j.status === "done" || j.status === "error"),
      createdAt: maxCreated,
      singleUrl: g.jobs.length === 1 ? g.jobs[0].url : null,
      singleFolderUrl: g.jobs.length === 1 ? g.jobs[0].folder_url : null,
      fileditchCount,
      children: g.jobs.length > 1 ? g.jobs.map((j) => uploadChild(j)) : null,
      rawJobs: g.jobs,
    });
  }
  return entries;
}

function uploadChild(job) {
  return {
    name: job.source_name, site: job.site, dest: job.dest_folder_name,
    totalBytes: job.total_bytes, doneBytes: job.bytes_sent,
    speedKbps: uploadJobSpeed(job),
    status: job.status, msg: job.error,
    url: job.url, folderUrl: job.folder_url, jobId: job.id,
  };
}

// Upload jobs report bytes_sent/total_bytes but never a rate -- unlike the
// download/video/extension engines, which already compute speed_kb
// server-side. This tracks bytes-sent-per-job across polls client-side to
// derive one, same idea, just computed here instead of in upload_jobs.py.
const _uploadSpeedTracker = new Map(); // job id -> {bytes, t}
function uploadJobSpeed(job) {
  if (job.status !== "uploading") { _uploadSpeedTracker.delete(job.id); return 0; }
  const now = Date.now();
  const prev = _uploadSpeedTracker.get(job.id);
  _uploadSpeedTracker.set(job.id, { bytes: job.bytes_sent, t: now });
  if (!prev) return 0;
  const dt = (now - prev.t) / 1000;
  if (dt <= 0) return 0;
  return Math.max(0, ((job.bytes_sent - prev.bytes) / 1024) / dt);
}
function uploadGroupSpeed(jobs) {
  return jobs.reduce((s, j) => s + uploadJobSpeed(j), 0);
}

async function fetchAllTasks() {
  const [jobs, videos, exts, uploads] = await Promise.all([
    fetchJSON("/api/jobs"), fetchJSON("/api/ytdlp/jobs"),
    fetchJSON("/api/extension/jobs"), fetchJSON("/api/uploads/jobs"),
  ]);
  const entries = [
    ...jobs.map(normalizeDownloadEntry),
    ...videos.map(normalizeYtdlpEntry),
    ...exts.map(normalizeExtensionEntry),
    ...buildUploadEntries(uploads),
  ];
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return entries;
}

let _lastEntries = new Map(); // uid -> entry, for bulk/row action lookups

// ── Sidebar ───────────────────────────────────────────────────────────

function statusBucket(status) {
  if (status === "queued") return "queued";
  if (status === "held") return "held";
  if (["resolving", "fetching_proxies", "running", "cancelling", "downloading", "uploading"].includes(status)) return "active";
  if (status === "done") return "done";
  if (status === "error" || status === "done_with_errors") return "error";
  return null; // cancelled -- not bucketed under any of the 4 status filters
}

function buildSidebarCounts(entries) {
  const c = { all: entries.length, downloads: 0, video: 0, extension: 0, uploads: 0, held: 0, queued: 0, active: 0, done: 0, error: 0 };
  const bySite = {};
  for (const e of entries) {
    c[e.engineKind] = (c[e.engineKind] || 0) + 1;
    if (e.engineKind === "downloads" || e.engineKind === "uploads") {
      for (const site of e.sites) {
        const key = e.engineKind + ":" + site;
        bySite[key] = (bySite[key] || 0) + 1;
      }
    }
    const bucket = statusBucket(e.status);
    if (bucket) c[bucket]++;
  }
  return { c, bySite };
}

function sideItem(key, label, count, iconSvg, isSub) {
  const active = state.view === key;
  return `<div class="side-item${isSub ? " sub" : ""}${active ? " active" : ""}" data-view="${key}">
    ${iconSvg || ""}
    <span class="lbl">${label}</span>${count !== "" ? `<span class="cnt">${count}</span>` : ""}
  </div>`;
}

function buildSidebar(entries) {
  const { c, bySite } = buildSidebarCounts(entries);
  const downloadSites = Object.keys(SITE_COLOR).filter((s) => bySite["downloads:" + s]);
  const uploadSites = Object.keys(SITE_COLOR).filter((s) => bySite["uploads:" + s]);

  let html = `<div class="side-group">`;
  html += sideItem("all", "Todo", c.all,
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>');
  html += `</div>`;

  html += `<div class="side-group"><div class="side-heading">Tareas</div>`;
  html += sideItem("downloads", "Descargas", c.downloads, ICONS.folder);
  for (const s of downloadSites) html += sideItem("downloads:" + s, siteSwatch(s) + s, bySite["downloads:" + s], "", true);
  html += sideItem("st:held", "En espera", c.held, HOLD_ICON);
  html += sideItem("video", "Video (yt-dlp)", c.video, ICONS.video);
  html += sideItem("extension", "Extensión", c.extension, ICONS.ext);
  html += sideItem("uploads", "Subidas", c.uploads, ICONS.upload);
  for (const s of uploadSites) html += sideItem("uploads:" + s, siteSwatch(s) + s, bySite["uploads:" + s], "", true);
  html += `</div>`;

  html += `<div class="side-group"><div class="side-heading">Estado</div>`;
  html += sideItem("st:queued", "En cola", c.queued, "", true);
  html += sideItem("st:active", "Activos", c.active, "", true);
  html += sideItem("st:done", "Completados", c.done, "", true);
  html += sideItem("st:error", "Con error", c.error, "", true);
  html += `</div>`;

  html += `<div class="side-group"><div class="side-heading">Vistas</div>`;
  html += sideItem("view:files", "Archivos", "",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>');
  html += sideItem("view:sites", "Sitios y proxies", "",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>');
  html += `</div>`;

  if (!updateListHTML(els.sidebar, "sidebar", html)) return;
  els.sidebar.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => {
      state.view = el.getAttribute("data-view");
      renderCurrentView();
    });
  });
}

// ── Row filtering + rendering ────────────────────────────────────────

function entryMatches(e) {
  if (state.query) {
    const q = state.query;
    const hay = (e.name + " " + e.sites.join(" ")).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const v = state.view;
  if (v === "all") return true;
  if (v === "downloads" || v === "video" || v === "extension" || v === "uploads") return e.engineKind === v;
  if (v.startsWith("downloads:")) return e.engineKind === "downloads" && e.sites.includes(v.slice(10));
  if (v.startsWith("uploads:")) return e.engineKind === "uploads" && e.sites.includes(v.slice(8));
  if (v === "st:held") return statusBucket(e.status) === "held";
  if (v === "st:queued") return statusBucket(e.status) === "queued";
  if (v === "st:active") return statusBucket(e.status) === "active";
  if (v === "st:done") return statusBucket(e.status) === "done";
  if (v === "st:error") return statusBucket(e.status) === "error";
  return true;
}

function siteCellHtml(sites) {
  if (!sites || sites.length === 0) return `<span class="dim">—</span>`;
  if (sites.length === 1) return `<span class="site-pill">${siteSwatch(sites[0])}${sites[0]}</span>`;
  return `<span class="site-pill"><span class="sw" style="background:var(--faint)"></span>Varios sitios</span>`;
}

function progCellHtml(doneBytes, totalBytes, status) {
  const pct = totalBytes > 0 ? Math.round(Math.min(1, doneBytes / totalBytes) * 100) : (status === "done" ? 100 : 0);
  const fillClass = (status === "error" || status === "failed") ? "error" : (status === "done" ? "done" : "");
  return `<div class="prog-cell">
    <div class="prog-track"><div class="prog-fill ${fillClass}" style="width:${pct}%"></div></div>
    <span class="prog-pct num">${pct}%</span>
  </div>`;
}

function rowActionsHtml(entry) {
  const links = [];
  if (entry.singleUrl) links.push(`<button type="button" class="rlink" data-action="copy" data-link="${escapeAttr(entry.singleUrl)}">Copiar</button>`);
  if (entry.singleFolderUrl) links.push(`<button type="button" class="rlink" data-action="copy" data-link="${escapeAttr(entry.singleFolderUrl)}">Copiar carpeta</button>`);
  if (entry.fileditchCount > 0) links.push(`<button type="button" class="rlink" data-action="copy-fileditch" data-uid="${entry.uid}">FileDitch ×${entry.fileditchCount}</button>`);

  const icons = [];
  if (entry.startable) icons.push(`<button type="button" class="ricon" data-action="start" data-uid="${entry.uid}" title="Iniciar descarga">${PLAY_ICON}</button>`);
  if (entry.cancellable) icons.push(`<button type="button" class="ricon" data-action="cancel" data-uid="${entry.uid}" title="Cancelar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`);
  if (entry.retryable) icons.push(`<button type="button" class="ricon" data-action="retry" data-uid="${entry.uid}" title="Reintentar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4v5h5M20 20v-5h-5"/><path d="M5.5 9a7 7 0 0 1 12.3-2.5M18.5 15a7 7 0 0 1-12.3 2.5"/></svg></button>`);
  if (entry.deletable) icons.push(`<button type="button" class="ricon" data-action="delete" data-uid="${entry.uid}" title="Quitar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>`);
  return `<div class="row-actions">${links.join("")}${icons.join("")}</div>`;
}

function rowHtml(entry) {
  const isSel = state.selected.has(entry.uid);
  const hasChildren = Array.isArray(entry.children) && entry.children.length > 0;
  const isOpen = state.expanded.has(entry.uid);
  const kindIco = ICONS[entry.engineKind === "video" ? "video" : entry.engineKind === "extension" ? "ext" : entry.engineKind === "uploads" ? "upload" : (hasChildren ? "folder" : "file")];
  const disclosure = hasChildren
    ? `<button type="button" class="disclosure${isOpen ? " open" : ""}" data-toggle="${entry.uid}" aria-label="${isOpen ? "Contraer" : "Expandir"}">${CHEVRON}</button>`
    : `<span class="disclosure-spacer"></span>`;

  const parent = `<tr class="${isSel ? "selected" : ""}" data-uid="${entry.uid}">
    <td class="chk-col"><input type="checkbox" data-chk="${entry.uid}" ${isSel ? "checked" : ""}></td>
    <td>
      <div class="name-cell">
        ${disclosure}${kindIco}
        <div class="name-col-inner">
          <div class="name-txt" title="${escapeAttr(entry.name)}">${entry.name}</div>
          ${entry.sub ? `<div class="name-sub">${entry.sub}</div>` : (entry.msg ? `<div class="name-sub err">${entry.msg}</div>` : "")}
        </div>
      </div>
    </td>
    <td>${siteCellHtml(entry.sites)}</td>
    <td>${progCellHtml(entry.doneBytes, entry.totalBytes, entry.status)}</td>
    <td class="num-col num">${fmtSpeed(entry.speedKbps)}</td>
    <td class="num-col num">${fmtBytes(entry.totalBytes)}</td>
    <td><span class="status-pill ${statusPillClass(entry.status)}"><span class="dot"></span>${STATUS_LABELS[entry.status] || entry.status}</span></td>
    <td>${rowActionsHtml(entry)}</td>
  </tr>`;

  if (!hasChildren) return parent;
  return parent + entry.children.map((c, i) => childRowHtml(entry, c, i === entry.children.length - 1)).join("");
}

function childRowHtml(parent, c, isLast) {
  const isUpload = parent.engineKind === "uploads";
  let actions = "";
  if (isUpload) {
    const links = [];
    if (c.url) links.push(`<button type="button" class="rlink" data-action="copy" data-link="${escapeAttr(c.url)}">Copiar</button>`);
    if (c.folderUrl) links.push(`<button type="button" class="rlink" data-action="copy" data-link="${escapeAttr(c.folderUrl)}">Copiar carpeta</button>`);
    const icons = [];
    if (c.status === "error") icons.push(`<button type="button" class="ricon" data-action="retry-job" data-job-id="${c.jobId}" title="Reintentar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4v5h5M20 20v-5h-5"/><path d="M5.5 9a7 7 0 0 1 12.3-2.5M18.5 15a7 7 0 0 1-12.3 2.5"/></svg></button>`);
    if (c.status === "done" || c.status === "error") icons.push(`<button type="button" class="ricon" data-action="delete-job" data-job-id="${c.jobId}" title="Quitar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>`);
    actions = `<div class="row-actions">${links.join("")}${icons.join("")}</div>`;
  }
  const site = c.site ? siteCellHtml([c.site]) : "";
  return `<tr class="child-row${isLast ? " child-last" : ""}${state.expanded.has(parent.uid) ? " open" : ""}" data-parent="${parent.uid}">
    <td class="chk-col"></td>
    <td>
      <div class="name-cell">
        ${ICONS.file}
        <div class="name-col-inner">
          <div class="name-txt" title="${escapeAttr(c.name || "")}">${c.name || "—"}${c.dest ? ` <span class="dim">→ ${c.dest}</span>` : ""}</div>
          ${c.msg ? `<div class="name-sub err">${c.msg}</div>` : ""}
        </div>
      </div>
    </td>
    <td>${site}</td>
    <td>${progCellHtml(c.doneBytes, c.totalBytes, c.status)}</td>
    <td class="num-col num">${fmtSpeed(c.speedKbps)}</td>
    <td class="num-col num">${fmtBytes(c.totalBytes)}</td>
    <td><span class="status-pill ${statusPillClass(c.status)}"><span class="dot"></span>${STATUS_LABELS[c.status] || c.status}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function renderTaskBody(entries) {
  const rows = entries.filter(entryMatches);
  els.viewSub.textContent = `${rows.length} ${rows.length === 1 ? "tarea" : "tareas"}`;
  const html = rows.length
    ? rows.map(rowHtml).join("")
    : `<tr class="empty-row"><td colspan="8">Sin tareas en esta categoría.</td></tr>`;
  if (!updateListHTML(els.taskBody, "tasks:" + state.view + ":" + state.query, html)) {
    updateBulkBar(rows);
    return;
  }

  els.taskBody.querySelectorAll("[data-chk]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", () => {
      const uid = el.getAttribute("data-chk");
      if (el.checked) state.selected.add(uid); else state.selected.delete(uid);
      updateBulkBar(rows);
      el.closest("tr").classList.toggle("selected", el.checked);
    });
  });

  els.taskBody.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = btn.getAttribute("data-toggle");
      const nowOpen = !state.expanded.has(uid);
      if (nowOpen) state.expanded.add(uid); else state.expanded.delete(uid);
      btn.classList.toggle("open", nowOpen);
      btn.setAttribute("aria-label", nowOpen ? "Contraer" : "Expandir");
      els.taskBody.querySelectorAll(`[data-parent="${uid}"]`).forEach((tr) => tr.classList.toggle("open", nowOpen));
    });
  });

  updateBulkBar(rows);
}

function updateBulkBar(visibleRows) {
  if (state.selected.size > 0) {
    els.bulkBar.classList.add("show");
    els.bulkCount.textContent = state.selected.size;
  } else {
    els.bulkBar.classList.remove("show");
  }
  if (visibleRows) {
    els.chkAll.checked = visibleRows.length > 0 && visibleRows.every((r) => state.selected.has(r.uid));
  }
}

els.chkAll.addEventListener("change", () => {
  const visible = [..._lastEntries.values()].filter(entryMatches);
  if (els.chkAll.checked) visible.forEach((e) => state.selected.add(e.uid));
  else visible.forEach((e) => state.selected.delete(e.uid));
  renderTaskBody([..._lastEntries.values()]);
});

els.searchInput.addEventListener("input", () => {
  state.query = els.searchInput.value.trim().toLowerCase();
  renderTaskBody([..._lastEntries.values()]);
});

// ── Row + bulk action handlers ──────────────────────────────────────────

async function cancelEntry(entry) {
  if (!entry.cancellable) return;
  await fetch(`${entry.apiBase}/${entry.id}/cancel`, { method: "POST" });
}
async function startEntry(entry) {
  if (!entry.startable) return;
  try { await fetchJSON(`${entry.apiBase}/${entry.id}/start`, { method: "POST" }); } catch (err) { alert(err.message); }
}
async function retryEntry(entry) {
  if (entry.engineKind === "uploads") {
    for (const job of entry.rawJobs) {
      if (job.status !== "error") continue;
      try { await fetchJSON(`/api/uploads/jobs/${job.id}/retry`, { method: "POST" }); } catch (err) { alert(err.message); }
    }
    return;
  }
  try { await fetchJSON(`${entry.apiBase}/${entry.id}/retry`, { method: "POST" }); } catch (err) { alert(err.message); }
}
async function deleteEntry(entry) {
  if (entry.engineKind === "uploads") {
    for (const job of entry.rawJobs) {
      if (job.status !== "done" && job.status !== "error") continue;
      try { await fetchJSON(`/api/uploads/jobs/${job.id}`, { method: "DELETE" }); } catch (err) { /* ignore */ }
    }
    return;
  }
  try { await fetchJSON(`${entry.apiBase}/${entry.id}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
}

els.taskBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "copy") {
    copyToClipboard(btn.dataset.link, btn);
  } else if (action === "copy-fileditch") {
    const entry = _lastEntries.get(btn.dataset.uid);
    const links = entry ? entry.rawJobs.filter((j) => j.site === "fileditch" && j.url).map((j) => j.url) : [];
    copyToClipboard(links.join("\n"), btn);
  } else if (action === "start") {
    const entry = _lastEntries.get(btn.dataset.uid);
    if (!entry) return;
    btn.disabled = true;
    await startEntry(entry);
    refreshTasks();
  } else if (action === "cancel") {
    const entry = _lastEntries.get(btn.dataset.uid);
    if (!entry) return;
    btn.disabled = true;
    await cancelEntry(entry);
    refreshTasks();
  } else if (action === "retry") {
    const entry = _lastEntries.get(btn.dataset.uid);
    if (entry) await retryEntry(entry);
    refreshTasks();
  } else if (action === "delete") {
    const entry = _lastEntries.get(btn.dataset.uid);
    if (!entry) return;
    if (!confirm("¿Borrar del historial? No afecta los archivos ya descargados/subidos.")) return;
    await deleteEntry(entry);
    refreshTasks();
  } else if (action === "retry-job") {
    try { await fetchJSON(`/api/uploads/jobs/${btn.dataset.jobId}/retry`, { method: "POST" }); } catch (err) { alert(err.message); }
    refreshTasks();
  } else if (action === "delete-job") {
    try { await fetchJSON(`/api/uploads/jobs/${btn.dataset.jobId}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
    refreshTasks();
  }
});

function selectedEntries() {
  return [...state.selected].map((uid) => _lastEntries.get(uid)).filter(Boolean);
}

els.bulkStart.addEventListener("click", async () => {
  for (const entry of selectedEntries()) if (entry.startable) await startEntry(entry);
  refreshTasks();
});
els.bulkRetry.addEventListener("click", async () => {
  for (const entry of selectedEntries()) if (entry.retryable) await retryEntry(entry);
  refreshTasks();
});
els.bulkCancel.addEventListener("click", async () => {
  for (const entry of selectedEntries()) if (entry.cancellable) await cancelEntry(entry);
  refreshTasks();
});
els.bulkDelete.addEventListener("click", async () => {
  const entries = selectedEntries().filter((e) => e.deletable);
  if (!entries.length) return;
  if (!confirm(`¿Borrar ${entries.length} del historial? No afecta los archivos ya descargados/subidos.`)) return;
  for (const entry of entries) await deleteEntry(entry);
  state.selected.clear();
  refreshTasks();
});

els.btnCancelActive.addEventListener("click", async () => {
  // Held jobs are cancellable (so the row/bulk-selection X still works on
  // them) but deliberately excluded here -- "en espera" means the user
  // parked it on purpose, so a blanket "cancel everything active" shouldn't
  // sweep it away too.
  const targets = [..._lastEntries.values()].filter((e) => e.cancellable && e.status !== "held");
  if (!targets.length) return;
  if (!confirm(`¿Cancelar ${targets.length} tarea(s) activa(s)/en cola?`)) return;
  await Promise.all(targets.map(cancelEntry));
  refreshTasks();
});

els.btnClear.addEventListener("click", async () => {
  if (!confirm("¿Borrar del historial todo lo ya terminado? No afecta los archivos ya descargados/subidos.")) return;
  await Promise.all([
    fetch("/api/jobs/clear-finished", { method: "POST" }),
    fetch("/api/ytdlp/clear-finished", { method: "POST" }),
    fetch("/api/extension/clear-finished", { method: "POST" }),
    fetch("/api/uploads/clear-finished", { method: "POST" }),
  ]);
  refreshTasks();
});

// ── Status bar ───────────────────────────────────────────────────────

function updateStatusBar(entries) {
  const { c } = buildSidebarCounts(entries);
  els.sbActive.textContent = c.active;
  els.sbQueued.textContent = c.queued;
  els.sbHeld.textContent = c.held;
  els.sbDone.textContent = c.done;
  els.sbError.textContent = c.error;

  let dlKbps = 0;
  let ulKbps = 0;
  for (const e of entries) {
    if (statusBucket(e.status) !== "active") continue;
    if (e.engineKind === "uploads") ulKbps += e.speedKbps;
    else dlKbps += e.speedKbps;
  }
  els.sbDlSpeed.textContent = fmtSpeed(dlKbps);
  els.sbUlSpeed.textContent = fmtSpeed(ulKbps);
}

// ── View switching + polling ─────────────────────────────────────────

const VIEW_TITLES = {
  all: "Todo", downloads: "Descargas", video: "Video (yt-dlp)", extension: "Extensión", uploads: "Subidas",
  "st:held": "En espera", "st:queued": "En cola", "st:active": "Activos", "st:done": "Completados", "st:error": "Con error",
  "view:files": "Archivos", "view:sites": "Sitios y proxies",
};
function viewTitle() {
  if (state.view.startsWith("downloads:")) return "Descargas · " + state.view.slice(10);
  if (state.view.startsWith("uploads:")) return "Subidas · " + state.view.slice(8);
  return VIEW_TITLES[state.view] || "Todo";
}

function renderCurrentView() {
  buildSidebar([..._lastEntries.values()]);
  els.viewTitle.textContent = viewTitle();
  const isFiles = state.view === "view:files";
  const isSites = state.view === "view:sites";
  els.tableView.style.display = isFiles || isSites ? "none" : "block";
  els.filesView.style.display = isFiles ? "block" : "none";
  els.sitesView.style.display = isSites ? "block" : "none";
  els.bulkBar.classList.toggle("show", !isFiles && !isSites && state.selected.size > 0);
  els.refreshFilesBtn.style.display = isFiles ? "flex" : "none";
  els.viewSub.style.display = isFiles || isSites ? "none" : "inline";

  if (isFiles) {
    loadFiles(state.filesPath);
  } else if (isSites) {
    refreshSites();
    refreshProxySources();
  } else {
    renderTaskBody([..._lastEntries.values()]);
  }
}

async function refreshTasks() {
  try {
    const entries = await fetchAllTasks();
    _lastEntries = new Map(entries.map((e) => [e.uid, e]));
    // Selection/expansion only make sense for uids still present.
    for (const uid of [...state.selected]) if (!_lastEntries.has(uid)) state.selected.delete(uid);
    for (const uid of [...state.expanded]) if (!_lastEntries.has(uid)) state.expanded.delete(uid);
    buildSidebar(entries);
    if (state.view !== "view:files" && state.view !== "view:sites") renderTaskBody(entries);
    updateStatusBar(entries);
  } catch (err) {
    els.sbStatusMsg.textContent = err.message;
  }
}

els.refreshFilesBtn.addEventListener("click", () => loadFiles(state.filesPath));

// ═══════════════════════════════════════════════════════════════════════
// Sitios y proxies view
// ═══════════════════════════════════════════════════════════════════════

function siteRow(site) {
  const overrideLabel = site.override === null ? "" : site.override ? " (forzado ON)" : " (forzado OFF)";
  return `<tr>
    <td>${site.name}${site.is_default ? " ★" : ""}</td>
    <td class="dim">${site.domains.join(", ")}</td>
    <td>${site.effective_use_proxy ? "✓ proxy" : "directo"}${overrideLabel}</td>
    <td class="actions">
      <button type="button" class="tbtn ghost" data-site="${site.name}" data-action="enable">ON</button>
      <button type="button" class="tbtn ghost" data-site="${site.name}" data-action="disable">OFF</button>
      <button type="button" class="tbtn ghost" data-site="${site.name}" data-action="reset">reset</button>
    </td>
  </tr>`;
}

async function refreshSites() {
  try {
    const sites = await fetchJSON("/api/sites");
    els.sitesList.innerHTML = `<table class="data-table">
      <thead><tr><th>Sitio</th><th>Dominios</th><th>Estado</th><th></th></tr></thead>
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
  return `<div class="card-lite">
    <div class="card-lite-head">
      <div>
        <div class="card-lite-title">${source.name}${source.active ? " ★" : ""}</div>
        <div class="card-lite-meta">${source.type === "list" ? "Lista pública" : "Gateway autenticado"} · ${detail}</div>
      </div>
      ${source.active ? `<span class="status-pill st-done"><span class="dot"></span>activa</span>` : ""}
    </div>
    <div class="card-lite-actions">
      ${!source.active ? `<button type="button" class="tbtn ghost" data-activate-source="${source.id}">Usar esta</button>` : ""}
      <button type="button" class="tbtn ghost" data-delete-source="${source.id}">Borrar</button>
    </div>
  </div>`;
}

async function refreshProxySources() {
  try {
    const sourcesList = await fetchJSON("/api/proxy-sources");
    els.proxySourcesList.innerHTML = sourcesList.map(proxySourceRow).join("") || `<p class="dim">Sin fuentes todavía.</p>`;
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

// ═══════════════════════════════════════════════════════════════════════
// Archivos view — local /downloads browser: preview, rename, delete,
// optimize, download, and the two "upload this" shortcuts that jump into
// the Agregar modal's Subir tab pre-filled with the picked file/folder.
// ═══════════════════════════════════════════════════════════════════════

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function renderBreadcrumb() {
  const parts = state.filesPath ? state.filesPath.split("/") : [];
  let acc = "";
  const crumbs = [`<button type="button" data-path="">downloads</button>`];
  for (const part of parts) {
    acc = joinPath(acc, part);
    crumbs.push(`<span class="sep">/</span><button type="button" data-path="${escapeAttr(acc)}">${part}</button>`);
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
    nameCell = `<button type="button" class="link-btn" data-open="${escapeAttr(path)}">${icon} ${entry.name}</button>`;
  } else if (entry.kind && !entry.partial) {
    nameCell = `<button type="button" class="link-btn" data-preview="${escapeAttr(path)}" data-kind="${entry.kind}">${icon} ${entry.name}</button>`;
  } else {
    nameCell = `${icon} ${entry.name}`;
  }

  // Only plain files are selectable for the "pick a few, upload together"
  // batch flow -- a folder already has its own dedicated whole-folder
  // upload action, and mixing the two into one batch would mean silently
  // expanding a folder selection into "every file in it", not what a
  // checkbox next to one specific row should imply.
  const chk = entry.is_dir ? "" : `<input type="checkbox" data-fchk="${escapeAttr(path)}" ${state.filesSelected.has(path) ? "checked" : ""}>`;

  const icons = [];
  if (entry.optimizable) icons.push(`<button type="button" class="ricon" data-optimize="${escapeAttr(path)}" title="Optimizar para streaming">${OPTIMIZE_ICON}</button>`);
  if (entry.is_dir) {
    icons.push(`<button type="button" class="ricon" data-upload-folder="${escapeAttr(path)}" data-upload-name="${escapeAttr(entry.name)}" title="Subir carpeta">${ICONS.upload}</button>`);
  } else {
    icons.push(`<button type="button" class="ricon" data-upload-existing="${escapeAttr(path)}" data-upload-name="${escapeAttr(entry.name)}" title="Subir">${ICONS.upload}</button>`);
  }
  icons.push(`<button type="button" class="ricon" data-download="${escapeAttr(path)}" title="Descargar${entry.is_dir ? " (.zip)" : ""}">${DOWNLOAD_ICON}</button>`);
  if (!entry.partial) icons.push(`<button type="button" class="ricon" data-move="${escapeAttr(path)}" data-name="${escapeAttr(entry.name)}" title="Mover">${MOVE_ICON}</button>`);
  if (!entry.partial) icons.push(`<button type="button" class="ricon" data-rename="${escapeAttr(path)}" data-name="${escapeAttr(entry.name)}" title="Renombrar">${RENAME_ICON}</button>`);
  icons.push(`<button type="button" class="ricon" data-delete="${escapeAttr(path)}" data-name="${escapeAttr(entry.name)}" title="Borrar">${TRASH_ICON}</button>`);

  return `<tr>
    <td class="chk-col">${chk}</td>
    <td>${nameCell}</td>
    <td class="dim">${sizeLabel}${entry.partial ? " (incompleto)" : ""}</td>
    <td class="dim">${fmtDate(entry.mtime)}</td>
    <td class="actions"><div class="row-actions">${icons.join("")}</div></td>
  </tr>`;
}

function updateFilesBulkBar() {
  const n = state.filesSelected.size;
  els.filesBulkBar.classList.toggle("show", n > 0);
  els.filesBulkCount.textContent = n;
}

async function loadFiles(path) {
  try {
    const navigated = path !== state.filesPath;
    const data = await fetchJSON(`/api/files?path=${encodeURIComponent(path || "")}`);
    // A same-path refresh (after renaming/deleting/optimizing one row via
    // its own icon) keeps whatever multi-selection was already in
    // progress; only an actual navigation elsewhere resets it -- carrying
    // a selection across an unrelated folder makes no sense to keep.
    if (navigated) state.filesSelected.clear();
    state.filesPath = data.path;
    renderBreadcrumb();
    els.filesList.innerHTML = data.entries.length
      ? `<table class="data-table">
          <thead><tr><th class="chk-col"><input type="checkbox" id="files-chk-all"></th><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead>
          <tbody>${data.entries.map(fileRow).join("")}</tbody>
        </table>`
      : `<p class="dim">Vacío.</p>`;
    updateFilesBulkBar();

    const selectableEntries = data.entries.filter((e) => !e.is_dir);
    const chkAll = document.getElementById("files-chk-all");
    if (chkAll) {
      chkAll.checked = selectableEntries.length > 0 && selectableEntries.every((e) => state.filesSelected.has(joinPath(state.filesPath, e.name)));
      chkAll.addEventListener("change", () => {
        for (const e of selectableEntries) {
          const p = joinPath(state.filesPath, e.name);
          if (chkAll.checked) state.filesSelected.add(p); else state.filesSelected.delete(p);
        }
        els.filesList.querySelectorAll("input[data-fchk]").forEach((cb) => { cb.checked = chkAll.checked; });
        updateFilesBulkBar();
      });
    }
    els.filesList.querySelectorAll("input[data-fchk]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const p = cb.dataset.fchk;
        if (cb.checked) state.filesSelected.add(p); else state.filesSelected.delete(p);
        updateFilesBulkBar();
      });
    });

    els.filesList.querySelectorAll("button[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => loadFiles(btn.dataset.open));
    });
    els.filesList.querySelectorAll("button[data-preview]").forEach((btn) => {
      btn.addEventListener("click", () => openPreview(btn.dataset.preview, btn.dataset.kind));
    });
    els.filesList.querySelectorAll("button[data-optimize]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.title = "Optimizando…";
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
      });
    });
    els.filesList.querySelectorAll("button[data-upload-folder]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.uploadSelectedExisting = null;
        state.uploadSelectedFolder = { path: btn.dataset.uploadFolder, name: btn.dataset.uploadName };
        els.uploadFileInput.value = "";
        renderUploadSelectedExisting();
        switchToUploadTab();
      });
    });
    els.filesList.querySelectorAll("button[data-download]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.location.href = `/api/files/download?path=${encodeURIComponent(btn.dataset.download)}`;
      });
    });
    els.filesList.querySelectorAll("button[data-move]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openMoveModal([{ path: btn.dataset.move, name: btn.dataset.name }]);
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

els.filesBulkUpload.addEventListener("click", () => {
  const paths = [...state.filesSelected];
  if (!paths.length) return;
  state.uploadSelectedExisting = null;
  state.uploadSelectedFolder = null;
  state.uploadSelectedFiles = paths.map((p) => ({ path: p, name: p.split("/").pop() }));
  els.uploadFileInput.value = "";
  renderUploadSelectedExisting();
  switchToUploadTab();
});

els.filesBulkDownload.addEventListener("click", () => {
  // Multiple simultaneous window.location.href navigations would only
  // keep the last one -- a throwaway <a download> click per file avoids
  // that without navigating the page at all, same trick the browser's
  // own multi-file download UI uses.
  for (const p of state.filesSelected) {
    const a = document.createElement("a");
    a.href = `/api/files/download?path=${encodeURIComponent(p)}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});

els.filesBulkDelete.addEventListener("click", async () => {
  const paths = [...state.filesSelected];
  if (!paths.length) return;
  if (!confirm(`¿Borrar ${paths.length} archivo(s)? Esta acción no se puede deshacer.`)) return;
  for (const p of paths) {
    try {
      await fetchJSON("/api/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
    } catch (err) {
      alert(`No se pudo borrar "${p}": ${err.message}`);
    }
  }
  state.filesSelected.clear();
  loadFiles(state.filesPath);
});

els.filesNewFolderBtn.addEventListener("click", async () => {
  const name = prompt("Nombre de la carpeta nueva:");
  if (name === null || name.trim() === "") return;
  try {
    await fetchJSON("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.filesPath, name }),
    });
    loadFiles(state.filesPath);
  } catch (err) {
    alert(`No se pudo crear la carpeta: ${err.message}`);
  }
});

els.filesBulkMove.addEventListener("click", () => {
  const paths = [...state.filesSelected];
  if (!paths.length) return;
  openMoveModal(paths.map((p) => ({ path: p, name: p.split("/").pop() })));
});

els.filesBulkRename.addEventListener("click", () => {
  const paths = [...state.filesSelected];
  if (!paths.length) return;
  openRenameModal(paths.map((p) => ({ path: p, name: p.split("/").pop() })));
});

// ═══════════════════════════════════════════════════════════════════════
// Generic file-manager modal — reused for the "Mover" folder picker and
// the "Renombrar" (advanced batch rename) tool. Both build their own
// content into fm-modal-body/-foot on open and tear it down on close, the
// same dynamic-innerHTML approach openPreview() below uses for its modal.
// ═══════════════════════════════════════════════════════════════════════

function openFmModal(title) {
  els.fmModalTitle.textContent = title;
  els.fmModalBackdrop.classList.add("show");
}
function closeFmModal() {
  els.fmModalBackdrop.classList.remove("show");
  els.fmModalBody.innerHTML = "";
  els.fmModalFoot.innerHTML = "";
}
els.fmModalClose.addEventListener("click", closeFmModal);
els.fmModalBackdrop.addEventListener("click", (e) => { if (e.target === els.fmModalBackdrop) closeFmModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.fmModalBackdrop.classList.contains("show")) closeFmModal();
});

// items: [{path, name}, ...] to relocate. Browses folders starting from
// wherever Archivos currently is, independent of the underlying view's
// own navigation state.
function openMoveModal(items) {
  let navPath = state.filesPath;
  openFmModal(items.length === 1 ? `Mover "${items[0].name}"` : `Mover ${items.length} elementos`);

  async function render() {
    try {
      const data = await fetchJSON(`/api/files?path=${encodeURIComponent(navPath)}`);
      navPath = data.path;
      const dirs = data.entries.filter((e) => e.is_dir);

      const parts = navPath ? navPath.split("/") : [];
      let acc = "";
      const crumbs = [`<button type="button" data-nav="">downloads</button>`];
      for (const part of parts) {
        acc = joinPath(acc, part);
        crumbs.push(`<span class="sep">/</span><button type="button" data-nav="${escapeAttr(acc)}">${part}</button>`);
      }
      const rows = dirs.length
        ? dirs.map((d) => `<button type="button" class="link-btn" data-nav="${escapeAttr(joinPath(navPath, d.name))}">📁 ${d.name}</button>`).join("")
        : `<p class="dim">Sin subcarpetas.</p>`;

      els.fmModalBody.innerHTML = `
        <div class="breadcrumb">${crumbs.join("")}</div>
        <div class="move-dir-list">${rows}</div>
      `;
      els.fmModalBody.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.addEventListener("click", () => { navPath = btn.dataset.nav; render(); });
      });

      els.fmModalFoot.innerHTML = `
        <span class="error-msg" id="fm-move-error"></span>
        <div class="tb-spacer"></div>
        <button type="button" class="tbtn ghost big" id="fm-move-cancel">Cancelar</button>
        <button type="button" class="tbtn primary big" id="fm-move-confirm">Mover aquí</button>
      `;
      document.getElementById("fm-move-cancel").addEventListener("click", closeFmModal);
      document.getElementById("fm-move-confirm").addEventListener("click", async () => {
        const confirmBtn = document.getElementById("fm-move-confirm");
        const errEl = document.getElementById("fm-move-error");
        confirmBtn.disabled = true;
        const errors = [];
        for (const item of items) {
          try {
            await fetchJSON("/api/files/move", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: item.path, dest: navPath }),
            });
          } catch (err) {
            errors.push(`${item.name}: ${err.message}`);
          }
        }
        if (errors.length) {
          errEl.textContent = errors.join(" · ");
          confirmBtn.disabled = false;
          loadFiles(state.filesPath);
          return;
        }
        state.filesSelected.clear();
        closeFmModal();
        loadFiles(state.filesPath);
      });
    } catch (err) {
      els.fmModalBody.innerHTML = `<p class="error-msg">${err.message}</p>`;
    }
  }
  render();
}

// items: [{path, name}, ...] to rename. Find/replace runs on the name
// without its extension; prefix/suffix/counter wrap around that result,
// the extension is always re-appended untouched last.
function openRenameModal(items) {
  openFmModal(items.length === 1 ? `Renombrar "${items[0].name}"` : `Renombrar ${items.length} archivos`);

  function readOpts() {
    return {
      find: document.getElementById("rn-find").value,
      replace: document.getElementById("rn-replace").value,
      prefix: document.getElementById("rn-prefix").value,
      suffix: document.getElementById("rn-suffix").value,
      counter: document.getElementById("rn-counter-enable").checked,
      counterPos: document.getElementById("rn-counter-pos").value,
      counterStart: parseInt(document.getElementById("rn-counter-start").value, 10) || 1,
      counterDigits: Math.max(1, parseInt(document.getElementById("rn-counter-digits").value, 10) || 1),
      counterSep: document.getElementById("rn-counter-sep").value,
    };
  }

  function computeName(name, index, opts) {
    const dot = name.lastIndexOf(".");
    const hasExt = dot > 0; // dot===0 is a dotfile with no real extension
    let base = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : "";
    if (opts.find) base = base.split(opts.find).join(opts.replace);
    let counter = "";
    if (opts.counter) {
      counter = opts.counterSep + String(opts.counterStart + index).padStart(opts.counterDigits, "0");
    }
    let result = opts.prefix + (opts.counter && opts.counterPos === "start" ? counter : "") + base;
    result += opts.suffix + (opts.counter && opts.counterPos === "end" ? counter : "");
    return result + ext;
  }

  function renderPreview() {
    const opts = readOpts();
    document.getElementById("rn-counter-fields").classList.toggle("hidden", !opts.counter);
    document.getElementById("rn-preview-body").innerHTML = items
      .map((item, i) => `<tr><td class="dim">${escapeAttr(item.name)}</td><td>${escapeAttr(computeName(item.name, i, opts))}</td></tr>`)
      .join("");
  }

  els.fmModalBody.innerHTML = `
    <div class="field-row">
      <div class="field"><label for="rn-find">Buscar</label><input type="text" id="rn-find" placeholder="texto a buscar"></div>
      <div class="field"><label for="rn-replace">Reemplazar por</label><input type="text" id="rn-replace" placeholder="texto nuevo"></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="rn-prefix">Prefijo</label><input type="text" id="rn-prefix"></div>
      <div class="field"><label for="rn-suffix">Sufijo</label><input type="text" id="rn-suffix"></div>
    </div>
    <div class="field-check">
      <label class="check-label"><input type="checkbox" id="rn-counter-enable">Agregar contador</label>
    </div>
    <div class="field-row hidden" id="rn-counter-fields">
      <div class="field"><label for="rn-counter-pos">Posición</label>
        <select id="rn-counter-pos"><option value="end">Al final</option><option value="start">Al inicio</option></select>
      </div>
      <div class="field"><label for="rn-counter-start">Empezar en</label><input type="number" id="rn-counter-start" value="1"></div>
      <div class="field"><label for="rn-counter-digits">Dígitos</label><input type="number" id="rn-counter-digits" value="2" min="1"></div>
      <div class="field"><label for="rn-counter-sep">Separador</label><input type="text" id="rn-counter-sep" value="_"></div>
    </div>
    <label class="field-hint" style="display:block;margin:10px 0 6px;">Vista previa</label>
    <table class="data-table"><thead><tr><th>Actual</th><th>Nuevo</th></tr></thead><tbody id="rn-preview-body"></tbody></table>
  `;
  els.fmModalBody.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", renderPreview);
    el.addEventListener("change", renderPreview);
  });
  renderPreview();

  els.fmModalFoot.innerHTML = `
    <span class="error-msg" id="rn-error"></span>
    <div class="tb-spacer"></div>
    <button type="button" class="tbtn ghost big" id="rn-cancel">Cancelar</button>
    <button type="button" class="tbtn primary big" id="rn-confirm">Renombrar</button>
  `;
  document.getElementById("rn-cancel").addEventListener("click", closeFmModal);
  document.getElementById("rn-confirm").addEventListener("click", async () => {
    const opts = readOpts();
    const confirmBtn = document.getElementById("rn-confirm");
    const errEl = document.getElementById("rn-error");
    confirmBtn.disabled = true;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const newName = computeName(item.name, i, opts);
      if (newName === item.name) continue;
      try {
        await fetchJSON("/api/files/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: item.path, new_name: newName }),
        });
      } catch (err) {
        errors.push(`${item.name}: ${err.message}`);
      }
    }
    if (errors.length) {
      errEl.textContent = errors.join(" · ");
      confirmBtn.disabled = false;
      loadFiles(state.filesPath);
      return;
    }
    state.filesSelected.clear();
    closeFmModal();
    loadFiles(state.filesPath);
  });
}

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
els.previewModal.addEventListener("click", (e) => { if (e.target === els.previewModal) closePreview(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePreview(); });

// ═══════════════════════════════════════════════════════════════════════
// Uploads — site selection, account/folder management, and submission for
// the Agregar modal's "Subir" tab.
// ═══════════════════════════════════════════════════════════════════════

function renderUploadSelectedExisting() {
  if (state.uploadSelectedFiles && state.uploadSelectedFiles.length) {
    const names = state.uploadSelectedFiles.map((f) => f.name).join(", ");
    const defaultName = state.uploadSelectedFiles.length === 1
      ? state.uploadSelectedFiles[0].name.replace(/\.[^.]+$/, "")
      : `${state.uploadSelectedFiles.length} archivos`;
    els.uploadSelectedExistingEl.classList.remove("hidden");
    els.uploadSelectedExistingEl.innerHTML =
      `Vas a subir <strong>${state.uploadSelectedFiles.length} archivo(s)</strong>: ${escapeAttr(names)} ` +
      `<button type="button" class="tbtn ghost" id="upload-selected-clear">quitar</button>` +
      `<div class="field" style="margin-top:8px;">` +
      `<label for="upload-folder-name-input">Nombre de la carpeta destino (donde no hayas elegido una existente)</label>` +
      `<input type="text" id="upload-folder-name-input" value="${escapeAttr(defaultName)}">` +
      `</div>`;
    document.getElementById("upload-selected-clear").addEventListener("click", () => {
      state.uploadSelectedFiles = null;
      renderUploadSelectedExisting();
    });
    return;
  }
  if (state.uploadSelectedFolder) {
    els.uploadSelectedExistingEl.classList.remove("hidden");
    els.uploadSelectedExistingEl.innerHTML =
      `Vas a subir la carpeta: <strong>${state.uploadSelectedFolder.name}</strong> (todos sus archivos) ` +
      `<button type="button" class="tbtn ghost" id="upload-selected-clear">quitar</button>` +
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
    `<button type="button" class="tbtn ghost" id="upload-selected-clear">quitar</button>`;
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
        <button type="button" class="tbtn ghost" data-remove-account="${info.site}">Quitar</button>
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
              <button type="button" class="tbtn ghost" data-create-folder="${info.site}">Crear</button>
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
          <button type="button" class="tbtn primary" data-save-account="${info.site}">Guardar y verificar</button>
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
  state.uploadSelectedFiles = null;
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

  if (state.uploadSelectedFolder || state.uploadSelectedFiles) {
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
      const defaultName = state.uploadSelectedFolder
        ? state.uploadSelectedFolder.name
        : `${state.uploadSelectedFiles.length} archivos`;
      const newFolderName = (nameInput ? nameInput.value : "").trim() || defaultName;
      // Same endpoint either way: one request creates N jobs sharing one
      // batch_id/folder, whether the "N files" came from "everything in
      // this folder" (path) or a hand-picked subset (paths).
      const body = state.uploadSelectedFolder
        ? { path: state.uploadSelectedFolder.path, folder_name: newFolderName, sites: sitesPayload }
        : { paths: state.uploadSelectedFiles.map((f) => f.path), folder_name: newFolderName, sites: sitesPayload };
      const result = await fetchJSON("/api/uploads/folder-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (result.errors && result.errors.length) {
        els.uploadFormError.textContent = result.errors.join("; ");
      } else {
        closeModal();
        state.filesSelected.clear();
      }
      state.uploadSelectedFolder = null;
      state.uploadSelectedFiles = null;
      renderUploadSelectedExisting();
      refreshTasks();
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
    closeModal();
    refreshTasks();
  } catch (err) {
    els.uploadFormError.textContent = err.message;
  } finally {
    els.submitBtn.disabled = false;
  }
}

// ── Boot ─────────────────────────────────────────────────────────────

buildSidebar([]);
refreshTasks();
refreshUploadSites();
setInterval(refreshTasks, 1800);
