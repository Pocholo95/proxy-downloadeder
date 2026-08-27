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
  uploadSites: [],                    // from /api/uploads/sites
  uploadSelectedSites: new Set(),     // site names checked for the next upload
  uploadFoldersBySite: {},            // site -> [{id, name}, ...]
  uploadFolderChoiceBySite: {},       // site -> chosen folder id
  uploadSelectedExisting: null,       // {path, name} of an already-downloaded file picked for upload
  uploadSelectedFolder: null,         // {path, name} of an already-downloaded folder picked for a batch upload
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

// Maps a raw status string to one of the 5 visual pill styles.
function statusPillClass(status) {
  if (status === "queued" || status === "cancelled") return "st-queued";
  if (["resolving", "fetching_proxies", "running", "cancelling", "downloading", "uploading"].includes(status)) return "st-active";
  if (status === "done") return "st-done";
  if (status === "done_with_errors") return "st-warn";
  if (status === "error" || status === "failed") return "st-error";
  return "st-queued";
}

const CANCELLABLE_STATUSES = new Set(["queued", "resolving", "fetching_proxies", "running"]);
const RETRYABLE_STATUSES = new Set(["done_with_errors", "error", "cancelled"]);
const DELETABLE_STATUSES = new Set(["done", "done_with_errors", "error", "cancelled"]);
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
  };
  try {
    await fetchJSON("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    els.inputSingle.value = "";
    els.inputBatch.value = "";
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
  if (["resolving", "fetching_proxies", "running", "cancelling", "downloading", "uploading"].includes(status)) return "active";
  if (status === "done") return "done";
  if (status === "error" || status === "done_with_errors") return "error";
  return null; // cancelled -- not bucketed under any of the 4 status filters
}

function buildSidebarCounts(entries) {
  const c = { all: entries.length, downloads: 0, video: 0, extension: 0, uploads: 0, queued: 0, active: 0, done: 0, error: 0 };
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
  const targets = [..._lastEntries.values()].filter((e) => e.cancellable);
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
  "st:queued": "En cola", "st:active": "Activos", "st:done": "Completados", "st:error": "Con error",
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
  return `<tr>
    <td>${nameCell}</td>
    <td class="dim">${sizeLabel}${entry.partial ? " (incompleto)" : ""}</td>
    <td class="dim">${fmtDate(entry.mtime)}</td>
    <td class="actions">
      ${entry.optimizable ? `<button type="button" class="tbtn ghost" data-optimize="${escapeAttr(path)}">🚀 Optimizar</button>` : ""}
      ${entry.is_dir ? `<button type="button" class="tbtn ghost" data-upload-folder="${escapeAttr(path)}" data-upload-name="${escapeAttr(entry.name)}">⬆ Subir carpeta</button>` : `<button type="button" class="tbtn ghost" data-upload-existing="${escapeAttr(path)}" data-upload-name="${escapeAttr(entry.name)}">⬆ Subir</button>`}
      <button type="button" class="tbtn ghost" data-download="${escapeAttr(path)}">Descargar${entry.is_dir ? " (.zip)" : ""}</button>
      ${entry.partial ? "" : `<button type="button" class="tbtn ghost" data-rename="${escapeAttr(path)}" data-name="${escapeAttr(entry.name)}">✏ Renombrar</button>`}
      <button type="button" class="tbtn ghost" data-delete="${escapeAttr(path)}" data-name="${escapeAttr(entry.name)}">Borrar</button>
    </td>
  </tr>`;
}

async function loadFiles(path) {
  try {
    const data = await fetchJSON(`/api/files?path=${encodeURIComponent(path || "")}`);
    state.filesPath = data.path;
    renderBreadcrumb();
    els.filesList.innerHTML = data.entries.length
      ? `<table class="data-table">
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
      } else {
        closeModal();
      }
      state.uploadSelectedFolder = null;
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
