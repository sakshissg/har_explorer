
/**
 * Client-side HAR explorer — no network uploads.
 */

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  browseBtn: $("#browse-btn"),
  toolbar: $("#toolbar"),
  main: $("#main"),
  filterInput: $("#filter-input"),
  methodFilter: $("#method-filter"),
  statusFilter: $("#status-filter"),
  clearFile: $("#clear-file"),
  exportHar: $("#export-har"),
  stats: $("#stats"),
  selectAllVisible: $("#select-all-visible"),
  tbody: $("#req-tbody"),
  detailEmpty: $("#detail-empty"),
  detailContent: $("#detail-content"),
  toast: $("#toast"),
};

let harData = null;
/** @type {NormalizedEntry[]} */
let entries = [];
/** @type {NormalizedEntry[]} */
let filtered = [];
let selectedIndex = -1;
/** Original entry indices (`ne.index`) that are checked for export */
const checkedEntryIndices = new Set();

/**
 * @typedef {object} NormalizedEntry
 * @property {number} index
 * @property {object} raw
 */

function showToast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  els.toast.classList.toggle("error", isError);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), 4000);
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms) {
  if (ms == null || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function headerMap(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (h && h.name) out[h.name] = h.value ?? "";
  }
  return out;
}

function getContentText(content) {
  if (!content) return { text: "", mime: "", size: 0 };
  const mime = content.mimeType || "";
  let text = content.text;
  const size = content.size != null ? content.size : (text ? text.length : 0);
  if (content.encoding === "base64" && typeof text === "string") {
    try {
      const bin = atob(text.replace(/\s/g, ""));
      if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) {
        text = new TextDecoder("utf-8", { fatal: false }).decode(
          Uint8Array.from(bin, (c) => c.charCodeAt(0))
        );
      } else {
        text = bin;
      }
    } catch {
      text = "(binary / decode error)";
    }
  }
  return { text: text ?? "", mime, size };
}

function normalizeHar(json) {
  const log = json.log;
  if (!log || !Array.isArray(log.entries)) {
    throw new Error("Invalid HAR: missing log.entries");
  }
  const rawEntries = log.entries;
  return rawEntries.map((entry, index) => ({ index, raw: entry }));
}

function statusClass(status) {
  if (status >= 200 && status < 300) return "status-2xx";
  if (status >= 300 && status < 400) return "status-3xx";
  if (status >= 400 && status < 500) return "status-4xx";
  if (status >= 500) return "status-5xx";
  return "";
}

function methodClass(method) {
  const m = (method || "").toUpperCase();
  if (m === "GET") return "method-get";
  if (m === "POST") return "method-post";
  if (m === "PUT" || m === "PATCH") return "method-put";
  if (m === "DELETE") return "method-delete";
  return "";
}

function rowFromEntry(ne) {
  const e = ne.raw;
  const req = e.request || {};
  const res = e.response || {};
  const content = res.content || {};
  const mime = content.mimeType || headerMap(res.headers)["content-type"]?.split(";")[0]?.trim() || "";
  const size = content.size != null ? content.size : (getContentText(content).text?.length ?? 0);
  const status = res.status ?? 0;
  const time = e.time;
  return {
    idx: ne.index + 1,
    method: req.method || "—",
    url: req.url || "",
    status,
    mime: mime || "—",
    size,
    time,
    ne,
  };
}

function collectMethods() {
  const set = new Set();
  for (const ne of entries) {
    const m = ne.raw.request?.method;
    if (m) set.add(m);
  }
  return [...set].sort();
}

function applyFilters() {
  const q = els.filterInput.value.trim().toLowerCase();
  const method = els.methodFilter.value;
  const statusPrefix = els.statusFilter.value;

  filtered = entries.filter((ne) => {
    const e = ne.raw;
    const req = e.request || {};
    const res = e.response || {};
    const st = String(res.status ?? "");
    if (method && (req.method || "") !== method) return false;
    if (statusPrefix && !st.startsWith(statusPrefix)) return false;
    if (!q) return true;
    const blob = [
      req.url,
      req.method,
      st,
      res.statusText,
      (res.content && res.content.mimeType) || "",
    ]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });

  renderTable();
  updateStats();
  updateExportControls();
  selectedIndex = -1;
  showDetailEmpty();
}

function updateStats() {
  const total = entries.length;
  const shown = filtered.length;
  let totalBytes = 0;
  let totalTime = 0;
  for (const ne of filtered) {
    const r = ne.raw.response?.content;
    const sz = r?.size != null ? r.size : (getContentText(r || {}).text?.length ?? 0);
    totalBytes += sz || 0;
    totalTime += ne.raw.time || 0;
  }
  const nSel = checkedEntryIndices.size;
  const selPart =
    nSel > 0
      ? ` · <strong>${nSel}</strong> selected for export`
      : "";
  els.stats.innerHTML = `
    Showing <strong>${shown}</strong> of <strong>${total}</strong> requests
    · combined size <strong>${formatBytes(totalBytes)}</strong>
    · filtered time sum <strong>${formatMs(totalTime)}</strong>${selPart}
  `;
}

function renderTable() {
  els.tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < filtered.length; i++) {
    const ne = filtered[i];
    const r = rowFromEntry(ne);
    const tr = document.createElement("tr");
    tr.dataset.filterIndex = String(i);
    if (i === selectedIndex) tr.classList.add("selected");
    const checked = checkedEntryIndices.has(ne.index) ? " checked" : "";
    tr.innerHTML = `
      <td class="col-check">
        <input type="checkbox"${checked} aria-label="Select request ${r.idx}" data-entry-index="${ne.index}" />
      </td>
      <td class="col-idx">${r.idx}</td>
      <td class="col-method"><span class="method-pill ${methodClass(r.method)}">${escapeHtml(r.method)}</span></td>
      <td class="col-url" title="${escapeAttr(r.url)}">${escapeHtml(shortUrl(r.url))}</td>
      <td class="col-status ${statusClass(r.status)}">${r.status || "—"}</td>
      <td class="col-type" title="${escapeAttr(r.mime)}">${escapeHtml(truncate(r.mime, 24))}</td>
      <td class="col-size">${formatBytes(r.size)}</td>
      <td class="col-time">${formatMs(r.time)}</td>
    `;
    const cb = tr.querySelector("input[type=checkbox]");
    cb.addEventListener("click", (ev) => ev.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) checkedEntryIndices.add(ne.index);
      else checkedEntryIndices.delete(ne.index);
      updateExportControls();
      updateStats();
      syncSelectAllCheckboxState();
    });
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest("td.col-check")) return;
      selectRow(i);
    });
    frag.appendChild(tr);
  }
  els.tbody.appendChild(frag);
  syncSelectAllCheckboxState();
}

function syncSelectAllCheckboxState() {
  const el = els.selectAllVisible;
  if (!el) return;
  const n = filtered.length;
  if (n === 0) {
    el.checked = false;
    el.indeterminate = false;
    return;
  }
  let c = 0;
  for (const ne of filtered) {
    if (checkedEntryIndices.has(ne.index)) c++;
  }
  el.checked = c === n;
  el.indeterminate = c > 0 && c < n;
}

function updateExportControls() {
  const n = checkedEntryIndices.size;
  if (els.exportHar) {
    els.exportHar.disabled = n === 0;
    els.exportHar.textContent =
      n === 0 ? "Export selected HAR" : `Export selected HAR (${n})`;
  }
}

function shSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function buildCookieHeaderFromHar(req) {
  if (!Array.isArray(req.cookies) || !req.cookies.length) return null;
  return req.cookies.map((c) => `${c.name}=${c.value ?? ""}`).join("; ");
}

function getRequestBodyForCurl(req) {
  return formatPostData(req.postData).text || "";
}

/** @param {object} entry HAR log entry */
function buildCurlCommand(entry) {
  const req = entry.request || {};
  const url = req.url || "";
  const method = (req.method || "GET").toUpperCase();
  const lines = [`curl ${shSingleQuote(url)}`];
  if (method !== "GET" && method !== "HEAD") {
    lines.push(`  -X ${shSingleQuote(method)}`);
  }
  const hdrs = Array.isArray(req.headers) ? req.headers : [];
  const seen = new Set();
  for (const h of hdrs) {
    if (!h || !h.name) continue;
    const name = h.name;
    if (name.startsWith(":")) continue;
    const ln = name.toLowerCase();
    if (ln === "content-length") continue;
    seen.add(ln);
    lines.push(`  -H ${shSingleQuote(`${name}: ${h.value ?? ""}`)}`);
  }
  const cookieFromHar = buildCookieHeaderFromHar(req);
  if (cookieFromHar && !seen.has("cookie")) {
    lines.push(`  -H ${shSingleQuote(`Cookie: ${cookieFromHar}`)}`);
  }
  const body = getRequestBodyForCurl(req);
  if (body.length > 0 && method !== "HEAD") {
    lines.push(`  --data-binary ${shSingleQuote(body)}`);
  }
  return lines.join(" \\\n");
}

/** cURL replay plus captured response block from the HAR (documentation). */
function buildCurlWithHarResponse(entry) {
  const curl = buildCurlCommand(entry);
  const res = entry.response || {};
  const ver = res.httpVersion || "1.1";
  const statusLine = `HTTP/${ver} ${res.status ?? 0} ${res.statusText || ""}`.trim();
  const rh = Array.isArray(res.headers)
    ? res.headers
        .filter((h) => h && h.name && !String(h.name).startsWith(":"))
        .map((h) => `${h.name}: ${h.value ?? ""}`)
        .join("\n")
    : "";
  const body = getContentText(res.content || {}).text || "";
  return [
    "# --- cURL (replay request) ---",
    curl,
    "",
    "# --- Response captured in this HAR (not produced by running curl above) ---",
    statusLine,
    rh,
    "",
    body,
  ].join("\n");
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg || "Copied to clipboard");
  } catch {
    showToast("Copy failed", true);
  }
}

function exportSelectedHar() {
  if (!harData || !harData.log || checkedEntryIndices.size === 0) return;
  const picked = entries
    .filter((ne) => checkedEntryIndices.has(ne.index))
    .map((ne) => JSON.parse(JSON.stringify(ne.raw)));
  const src = harData.log;
  const newHar = {
    log: {
      version: src.version || "1.2",
      creator: src.creator,
      browser: src.browser,
      ...(Array.isArray(src.pages) ? { pages: JSON.parse(JSON.stringify(src.pages)) } : {}),
      entries: picked,
    },
  };
  const blob = new Blob([JSON.stringify(newHar, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  const name = `export-${picked.length}-requests.har`;
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Downloaded ${name}`);
}

const COL_STORAGE_KEY = "harexplorer-req-col-widths";
const COL_COUNT = 8;
const COL_MINS = [32, 32, 56, 140, 48, 68, 56, 56];

function defaultColWidths() {
  return [40, 40, 76, 400, 56, 112, 68, 64];
}

function loadColWidths() {
  try {
    const raw = localStorage.getItem(COL_STORAGE_KEY);
    if (!raw) return defaultColWidths();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== COL_COUNT) return defaultColWidths();
    return arr.map((w, i) => Math.max(COL_MINS[i], Number(w) || COL_MINS[i]));
  } catch {
    return defaultColWidths();
  }
}

let colWidths = loadColWidths();

function saveColWidths() {
  try {
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(colWidths));
  } catch {
    /* quota */
  }
}

function syncReqTableWidth() {
  const table = document.getElementById("req-table");
  const wrap = document.getElementById("req-table-wrap");
  if (!table || !wrap) return;
  const sum = colWidths.reduce((a, b) => a + b, 0);
  const minFill = wrap.clientWidth || 0;
  table.style.width = `${Math.max(sum, minFill)}px`;
}

function applyColWidths() {
  document.querySelectorAll("#req-colgroup col").forEach((col, i) => {
    col.style.width = `${colWidths[i]}px`;
  });
  syncReqTableWidth();
}

function initColumnResize() {
  const table = document.getElementById("req-table");
  if (!table) return;
  applyColWidths();
  table.querySelectorAll(".col-resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (downEv) => {
      downEv.preventDefault();
      downEv.stopPropagation();
      const b = Number(handle.dataset.boundary);
      if (Number.isNaN(b) || b < 0 || b >= COL_COUNT - 1) return;
      const startX = downEv.clientX;
      const start = colWidths.slice();
      const total = start[b] + start[b + 1];
      const minL = COL_MINS[b];
      const minR = COL_MINS[b + 1];

      document.body.classList.add("col-resizing");

      function onMove(e) {
        const dx = e.clientX - startX;
        let left = start[b] + dx;
        left = Math.max(minL, Math.min(left, total - minR));
        colWidths[b] = Math.round(left);
        colWidths[b + 1] = Math.round(total - left);
        applyColWidths();
      }

      function onUp() {
        document.body.classList.remove("col-resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        saveColWidths();
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });

  const wrap = document.getElementById("req-table-wrap");
  if (wrap && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => syncReqTableWidth()).observe(wrap);
  }
  window.addEventListener("resize", syncReqTableWidth);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + u.search + (u.hash || "");
  } catch {
    return truncate(url, 80);
  }
}

function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function selectRow(filterIdx) {
  selectedIndex = filterIdx;
  for (const tr of els.tbody.querySelectorAll("tr")) {
    tr.classList.toggle("selected", tr.dataset.filterIndex === String(filterIdx));
  }
  const ne = filtered[filterIdx];
  if (ne) renderDetail(ne);
  else showDetailEmpty();
}

function showDetailEmpty() {
  els.detailEmpty.classList.remove("hidden");
  els.detailContent.classList.add("hidden");
  els.detailContent.innerHTML = "";
}

function timingParts(timings) {
  if (!timings) return [];
  const keys = ["blocked", "dns", "connect", "ssl", "send", "wait", "receive"];
  const colors = {
    blocked: "#6b7280",
    dns: "#8b5cf6",
    connect: "#3b82f6",
    ssl: "#6366f1",
    send: "#0ea5e9",
    wait: "#f59e0b",
    receive: "#22c55e",
  };
  const parts = [];
  for (const k of keys) {
    let v = timings[k];
    if (v == null || v < 0) v = 0;
    parts.push({ key: k, ms: v, color: colors[k] || "#888" });
  }
  return parts;
}

function renderDetail(ne) {
  const e = ne.raw;
  const req = e.request || {};
  const res = e.response || {};
  const t = e.timings || {};
  const parts = timingParts(t);
  const totalMs = parts.reduce((a, p) => a + p.ms, 0) || e.time || 1;
  const segs = parts
    .filter((p) => p.ms > 0)
    .map(
      (p) =>
        `<div class="timing-seg" style="width:${(p.ms / totalMs) * 100}%;background:${p.color}" title="${p.key}: ${formatMs(p.ms)}"></div>`
    )
    .join("");
  const legend = parts
    .filter((p) => p.ms > 0)
    .map(
      (p) =>
        `<span><span class="timing-dot" style="background:${p.color}"></span>${p.key} ${formatMs(p.ms)}</span>`
    )
    .join("");

  const reqBody = formatPostData(req.postData);
  const resBody = getContentText(res.content || {});
  const reqPretty = tryPrettyJson(reqBody.text) || reqBody.text;
  const resPretty = tryPrettyJson(resBody.text) || resBody.text;

  els.detailEmpty.classList.add("hidden");
  els.detailContent.classList.remove("hidden");

  const tabs = [
    { id: "ov", label: "Overview" },
    { id: "rh", label: "Request headers" },
    { id: "rs", label: "Response headers" },
    { id: "rb", label: "Request body" },
    { id: "sb", label: "Response body" },
    { id: "tm", label: "Timing" },
  ];

  els.detailContent.innerHTML = `
    <h2>${escapeHtml(req.method || "")} ${escapeHtml(shortUrl(req.url || ""))}</h2>
    <div class="detail-actions">
      <button type="button" class="btn secondary" id="detail-copy-curl">Copy cURL</button>
      <button type="button" class="btn secondary" id="detail-copy-curl-response">Copy cURL + HAR response</button>
    </div>
    <div class="detail-meta">
      <span>Full URL: <strong style="color:var(--text)">${escapeHtml(req.url || "")}</strong></span>
      <span>Status: <strong class="${statusClass(res.status)}">${res.status ?? "—"} ${escapeHtml(res.statusText || "")}</strong></span>
      <span>HTTP: ${escapeHtml(req.httpVersion || "")} → ${escapeHtml(res.httpVersion || "")}</span>
      <span>Started: ${escapeHtml(e.startedDateTime || "—")}</span>
    </div>
    <div class="timing-bar">${segs || `<div class="timing-seg" style="flex:1;background:var(--border)"></div>`}</div>
    <div class="timing-legend">${legend}</div>
    <div class="tabs" role="tablist">
      ${tabs
        .map(
          (t, i) =>
            `<button type="button" class="tab${i === 0 ? " active" : ""}" data-tab="${t.id}" role="tab">${escapeHtml(t.label)}</button>`
        )
        .join("")}
    </div>
    <div id="panel-ov" class="tab-panel active" role="tabpanel">${renderOverview(req, res)}</div>
    <div id="panel-rh" class="tab-panel" role="tabpanel">${renderHeadersTable(req.headers)}</div>
    <div id="panel-rs" class="tab-panel" role="tabpanel">${renderHeadersTable(res.headers)}</div>
    <div id="panel-rb" class="tab-panel" role="tabpanel">${renderBodyShell("req", reqBody)}</div>
    <div id="panel-sb" class="tab-panel" role="tabpanel">${renderBodyShell("res", resBody)}</div>
    <div id="panel-tm" class="tab-panel" role="tabpanel"><pre class="body-pre">${escapeHtml(JSON.stringify(t, null, 2))}</pre></div>
  `;

  els.detailContent.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab;
      els.detailContent.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      els.detailContent.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.toggle("active", p.id === `panel-${id}`);
      });
    });
  });

  const entryRaw = ne.raw;
  const btnCurl = els.detailContent.querySelector("#detail-copy-curl");
  const btnCurlResp = els.detailContent.querySelector("#detail-copy-curl-response");
  if (btnCurl) {
    btnCurl.addEventListener("click", () => {
      copyText(buildCurlCommand(entryRaw), "cURL copied to clipboard");
    });
  }
  if (btnCurlResp) {
    btnCurlResp.addEventListener("click", () => {
      copyText(
        buildCurlWithHarResponse(entryRaw),
        "cURL and HAR response copied to clipboard"
      );
    });
  }

  wireBodyToolbar(els.detailContent);

  const preReq = els.detailContent.querySelector("#req-body");
  const preRes = els.detailContent.querySelector("#res-body");
  if (preReq) {
    preReq.textContent = reqBody.text || "";
    preReq._raw = reqBody.text || "";
    preReq._json = reqPretty;
  }
  if (preRes) {
    preRes.textContent = resBody.text || "";
    preRes._raw = resBody.text || "";
    preRes._json = resPretty;
  }
}

function renderOverview(req, res) {
  const qh = (req.queryString && req.queryString.length)
    ? `<h3>Query string</h3><pre class="body-pre">${escapeHtml(
        req.queryString.map((q) => `${q.name}=${q.value}`).join("\n")
      )}</pre>`
    : "";
  return `${qh}`;
}

function renderHeadersTable(headers) {
  if (!Array.isArray(headers) || !headers.length) {
    return "<p class=\"text-muted\">No headers</p>";
  }
  const rows = headers
    .map(
      (h) =>
        `<tr><td>${escapeHtml(h.name)}</td><td>${escapeHtml(h.value ?? "")}</td></tr>`
    )
    .join("");
  return `<div class="headers-block"><h3>Headers</h3><table class="headers-table">${rows}</table></div>`;
}

function formatPostData(postData) {
  if (!postData) return { text: "", mime: "" };
  if (postData.text != null) {
    return { text: postData.text, mime: postData.mimeType || "" };
  }
  if (Array.isArray(postData.params) && postData.params.length) {
    const lines = postData.params.map((p) => `${p.name}=${p.value ?? ""}`);
    return { text: lines.join("\n"), mime: "application/x-www-form-urlencoded" };
  }
  return { text: "", mime: postData.mimeType || "" };
}

function renderBodyShell(kind, { text }) {
  if (!text || !String(text).length) {
    return "<p style=\"color:var(--text-muted)\">No body</p>";
  }
  const safeId = kind === "req" ? "req-body" : "res-body";
  return `
    <div class="body-toolbar">
      <button type="button" class="btn secondary" data-view="raw" data-target="${safeId}">Raw</button>
      <button type="button" class="btn secondary" data-view="json" data-target="${safeId}">JSON</button>
      <button type="button" class="btn secondary" data-copy="${safeId}">Copy</button>
    </div>
    <pre class="body-pre" id="${safeId}"></pre>
  `;
}

function tryPrettyJson(text) {
  try {
    const o = JSON.parse(text);
    return JSON.stringify(o, null, 2);
  } catch {
    return null;
  }
}

function wireBodyToolbar(root) {
  root.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.target;
      const pre = root.querySelector(`#${CSS.escape(id)}`);
      if (!pre) return;
      const view = btn.dataset.view;
      const raw = pre._raw ?? "";
      const json = pre._json ?? raw;
      pre.textContent = view === "json" ? json : raw;
    });
  });
  root.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.copy;
      const pre = root.querySelector(`#${CSS.escape(id)}`);
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.textContent);
        showToast("Copied to clipboard");
      } catch {
        showToast("Copy failed", true);
      }
    });
  });
}

function populateMethodFilter() {
  const methods = collectMethods();
  els.methodFilter.innerHTML = '<option value="">All methods</option>';
  for (const m of methods) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    els.methodFilter.appendChild(opt);
  }
}

async function loadFile(file) {
  if (!file) return;
  const text = await file.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    showToast("Could not parse JSON — is this a valid HAR file?", true);
    return;
  }
  try {
    entries = normalizeHar(json);
    harData = json;
  } catch (err) {
    showToast(err.message || "Invalid HAR", true);
    return;
  }

  checkedEntryIndices.clear();
  els.dropzone.classList.add("hidden");
  els.toolbar.classList.remove("hidden");
  els.main.classList.remove("hidden");
  populateMethodFilter();
  els.filterInput.value = "";
  els.methodFilter.value = "";
  els.statusFilter.value = "";
  filtered = [...entries];
  selectedIndex = -1;
  renderTable();
  updateStats();
  updateExportControls();
  showDetailEmpty();
  requestAnimationFrame(() => {
    syncReqTableWidth();
    requestAnimationFrame(syncReqTableWidth);
  });
}

function resetUi() {
  harData = null;
  entries = [];
  filtered = [];
  selectedIndex = -1;
  checkedEntryIndices.clear();
  updateExportControls();
  els.dropzone.classList.remove("hidden");
  els.toolbar.classList.add("hidden");
  els.main.classList.add("hidden");
  els.tbody.innerHTML = "";
  showDetailEmpty();
  els.fileInput.value = "";
}

els.browseBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (ev) => {
  const f = ev.target.files?.[0];
  if (f) loadFile(f);
});

els.dropzone.addEventListener("click", (e) => {
  if (e.target === els.browseBtn || els.browseBtn.contains(e.target)) return;
  if (e.target === els.fileInput) return;
  els.fileInput.click();
});

["dragenter", "dragover", "dragleave", "drop"].forEach((ev) => {
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});

els.dropzone.addEventListener("dragover", () => els.dropzone.classList.add("dragover"));
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
els.dropzone.addEventListener("drop", (e) => {
  els.dropzone.classList.remove("dragover");
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

els.filterInput.addEventListener("input", () => applyFilters());
els.methodFilter.addEventListener("change", () => applyFilters());
els.statusFilter.addEventListener("change", () => applyFilters());
els.clearFile.addEventListener("click", resetUi);

if (els.exportHar) {
  els.exportHar.addEventListener("click", exportSelectedHar);
}

if (els.selectAllVisible) {
  els.selectAllVisible.addEventListener("change", () => {
    const on = els.selectAllVisible.checked;
    for (const ne of filtered) {
      if (on) checkedEntryIndices.add(ne.index);
      else checkedEntryIndices.delete(ne.index);
    }
    renderTable();
    updateExportControls();
    updateStats();
  });
}

initColumnResize();
