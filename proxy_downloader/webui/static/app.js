const state = {
  kind: "file",
  openLogs: new Set(),
  filesOpen: false,
  filesPath: "",
};

const els = {
  tabs: document.querySelectorAll(".tab"),
  fieldSingle: document.getElementById("field-single"),
  fieldBatch: document.getElementById("field-batch"),
  labelSingle: document.querySelector('label[for="value-single"]'),
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
};

const SINGLE_LABELS = {
  file: "URL o ID del archivo",
  folder: "URL o ID de la carpeta",
};
const SINGLE_PLACEHOLDERS = {
  file: "https://pixeldrain.com/u/XXXXXXX",
  folder: "https://pixeldrain.com/l/XXXXXXX",
};

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.kind = tab.dataset.kind;
    const isBatch = state.kind === "batch";
    els.fieldBatch.classList.toggle("hidden", !isBatch);
    els.fieldSingle.classList.toggle("hidden", isBatch);
    if (!isBatch) {
      els.labelSingle.textContent = SINGLE_LABELS[state.kind];
      els.inputSingle.placeholder = SINGLE_PLACEHOLDERS[state.kind];
    }
  });
});

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

function fileRow(entry) {
  const path = joinPath(state.filesPath, entry.name);
  const sizeLabel = entry.is_dir ? "carpeta" : fmtBytes(entry.size);
  const nameCell = entry.is_dir
    ? `<button class="link-btn" data-open="${path}">📁 ${entry.name}</button>`
    : `${entry.partial ? "⏳" : "📄"} ${entry.name}`;
  return `<tr>
    <td>${nameCell}</td>
    <td class="dim">${sizeLabel}${entry.partial ? " (incompleto)" : ""}</td>
    <td class="dim">${fmtDate(entry.mtime)}</td>
    <td class="actions">
      <button class="btn small" data-download="${path}">Descargar${entry.is_dir ? " (.zip)" : ""}</button>
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
    els.filesList.querySelectorAll("button[data-download]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.location.href = `/api/files/download?path=${encodeURIComponent(btn.dataset.download)}`;
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

refreshSites();
refreshJobs();
setInterval(refreshJobs, 1500);
setInterval(() => { if (state.filesOpen) loadFiles(state.filesPath); }, 5000);
