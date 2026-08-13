/* ============ Revenue Tracker — frontend logic ============
   Tabs:
   - Onsite   : Country, Client, Project, Resource Name, Title (dropdown),
                Rate, Total Hours, Total Revenue, then Month+Week columns.
                Master sheet — hours entered here (PLANNED).
   - Offshore : same columns, but the rate shown is your OFFSHORE (cost) rate.
                Hours mirror Onsite; pick a Title to auto-fill the cost rate.
   - Actuals  : PM reconciliation — record ACTUAL hours, validated against
                planned. Overage → OT flow; under → comment required.
   - Dashboard: Country, Client, Resource(s), Revenue, Expense, Difference,
                plus Additional Revenue/Expense + Adjustment from Actuals.
   - Pricing  : Title library + Project→PM assignment + per-resource capacity.
   Roles: admin (everything) vs pm (Actuals only, scoped to their projects).
*/
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = { resources: [], weeks: [], months: [], pricing: [], view: "dash", gridEdit: { planned: false }, me: null };
const dirty = new Map();   // resource rid -> {fields:{}, hours:bool}
const pDirty = new Map();  // pricing pid -> {title?, rate?, offshore_rate?}
const aDirty = new Map();  // actuals rid -> {hours:bool, notes:{}}
let flushTimer = null, pFlushTimer = null, aFlushTimer = null;

/* ---------------- helpers ---------------- */
const fmt = (n, dp = 2) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function showModal(title, body) {
  $("#modalTitle").textContent = title;
  $("#modalBody").textContent = body;
  $("#modal").classList.remove("hidden");
}
$("#modalOk").addEventListener("click", () => $("#modal").classList.add("hidden"));

/* ---------------- auth / boot ---------------- */
async function boot() {
  try {
    const me = await api("/api/me");
    state.me = me;
    showApp();
  } catch (e) {
    showLogin();
  }
}

function showLogin() {
  $("#loginView").classList.remove("hidden");
  $("#topbar").classList.add("hidden");
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#loginUser").focus();
}

function showApp() {
  $("#loginView").classList.add("hidden");
  $("#topbar").classList.remove("hidden");
  const isAdmin = state.me.role === "admin";
  // PMs see only the Actuals tab
  $$(".tab").forEach((t) => {
    const adminOnly = ["dash", "pricing", "util", "planned"].includes(t.dataset.tab);
    t.style.display = (isAdmin || !adminOnly) ? "" : "none";
  });
  $("#btnImport").style.display = isAdmin ? "" : "none";
  $("#btnExport").style.display = isAdmin ? "" : "none";
  $("#importMode").style.display = isAdmin ? "" : "none";
  $("#btnAdd").style.display = "none";
  $("#subLine").textContent = isAdmin
    ? "Planned · Actuals · Dashboard · Pricing · Utilization"
    : `Actuals — signed in as ${esc(state.me.username)}`;
  if (!isAdmin) {
    state.view = "actuals";
    // show only the actuals view
    $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "actuals"));
    $("#gridView").classList.add("hidden");
    $("#dashView").classList.add("hidden");
    $("#pricingView").classList.add("hidden");
    $("#utilView").classList.add("hidden");
    $("#actualsView").classList.remove("hidden");
    loadActuals();
  } else {
    loadState();
  }
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#loginErr");
  err.textContent = "";
  try {
    const me = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#loginUser").value, password: $("#loginPass").value }),
    });
    state.me = me;
    showApp();
  } catch (ex) {
    err.textContent = ex.message || "Login failed";
  }
});

$("#btnLogout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (_) {}
  state.me = null;
  showLogin();
});

/* ---------------- data load ---------------- */
async function loadState() {
  const s = await api("/api/state");
  Object.assign(state, s);
  renderView();
}

const MODES = {
  planned: {
    rateFields: ["rate", "offshore_rate"],
    rateLabels: ["Rate", "Offshore Rate"],
    hoursEditable: true,
    metaEditable: true,
    note: "PLANNED hours — what you CHARGE (Rate) and what it COSTS (Offshore Rate). Enter hours & both rates. Pick a Title from Pricing to auto-fill both.",
    dot: "on",
  },
};

/* ---------------- combined grid (Planned: both rate sides) ---------------- */
const N_META = 5;          // Country..Title fields under the group label
const N_LOCKED = 10;       // sticky-left: Country, Client, Project, Name, Title, Rate, OffRate, TH, TR, TE
const WEEKS_START = 10;    // cell index where weeks begin (0-based children)

function gridHeadHTML() {
  const weeks = state.weeks, months = state.months, mode = MODES[state.view];
  const colHeads = [["Country", "sc1"], ["Client", "sc2"], ["Project", "sc3"], ["Resource Name", "sc4"],
                    ["Title", "sc5"], [esc(mode.rateLabels[0]), "sc6"], [esc(mode.rateLabels[1]), "sc7"],
                    ["Total Hours", "sc8"], ["Total Revenue", "sc9"], ["Total Expense", "sc10"]];
  const headCells = colHeads.map(([h, sc]) =>
    `<th class="sticky-h ${sc} colh">${h}</th>`).join("");
  const headBlank = (n) => (n > 0 ? "<th></th>".repeat(n) : "");
  const stickySpacers = Array.from({ length: N_LOCKED }, (_, i) =>
    `<th class="sticky-h sc${i + 1}"></th>`).join("");
  const monthCells = months.map((m) => `<th colspan="${m.end - m.start + 1}">${esc(m.name)}</th>`).join("");
  const weekCells = weeks.map((w) => `<th class="week-h">${esc(w)}</th>`).join("");
  const actionBlank = "<th></th>";
  return `<tr class="head-row">
            ${headCells}
            ${headBlank(weeks.length)}${actionBlank}
          </tr>
          <tr class="month-row">${stickySpacers}${monthCells}${actionBlank}</tr>
          <tr class="week-row">${stickySpacers}${weekCells}${actionBlank}</tr>`;
}

function colgroupHTML() {
  const metaW = [70, 150, 140, 160, 160, 90, 90, 90, 110, 110];
  let s = "<colgroup>";
  metaW.forEach((w) => { s += `<col style="width:${w}px">`; });
  for (let i = 0; i < state.weeks.length; i++) s += '<col style="width:54px">';
  s += '<col style="width:40px">';
  return s + "</colgroup>";
}

function titleSelectHTML(r) {
  let html = `<select class="inp sel" data-field="role">`;
  html += `<option value="">—</option>`;
  for (const p of state.pricing) {
    const sel = p.title === r.role ? " selected" : "";
    html += `<option value="${esc(p.title)}"${sel}>${esc(p.title)}</option>`;
  }
  html += `</select>`;
  return html;
}

function metaCell(r, field, editable) {
  const v = r[field];
  if (editable) {
    return `<input class="inp" data-field="${field}" value="${esc(v ?? "")}" placeholder="—" title="${field}">`;
  }
  return `<span class="mirror-val">${esc((v ?? "") || "—")}</span>`;
}

function gridEditState() {
  const unlocked = !!state.gridEdit[state.view];
  return { meta: unlocked, hours: unlocked, rates: unlocked };
}

function gridRowHTML(r) {
  const es = gridEditState();
  const mode = MODES[state.view];
  const hours = r.hours || Array(state.weeks.length).fill(0);
  const rate = effRate(r);
  const offRate = effOffshore(r);
  const total = hours.reduce((a, b) => a + b, 0);
  const rev = (rate || 0) * total;
  const cost = (offRate || 0) * total;
  const weekCell = (h, i) => es.hours
    ? `<input class="inp" type="number" step="0.25" min="0" data-week="${i}" value="${h ? h : ""}" placeholder="0" inputmode="decimal">`
    : `<input class="inp mirror" type="number" step="0.25" min="0" disabled value="${h ? h : ""}" data-week="${i}">`;
  let weekCells = "";
  hours.forEach((h, i) => { weekCells += `<td class="week${es.hours ? "" : " mirror-cell"}">${weekCell(h, i)}</td>`; });

  const delBtn = es.meta ? `<button class="del" title="Delete resource">✕</button>` : "";
  const cur = gridCurrencyTag(r);
  const titleCell = es.meta
    ? titleSelectHTML(r)
    : `<span class="mirror-val">${esc(r.role || "—")}</span>`;
  const rateCell = (field, label) => {
    const val = field === "offshore_rate" ? offRate : rate;
    return es.meta
      ? `${cur}<input class="inp num" type="number" min="0" step="any" data-field="${field}" value="${val ?? ""}" placeholder="—" title="${label} (auto-fills from Title)">`
      : `<span class="mirror-val">${cur}${val !== null && val !== undefined ? fmt(val) : "—"}</span>`;
  };
  return `<tr class="resource-row" data-rid="${r.id}">
    <td class="sticky-l sc1 meta-col">${metaCell(r, "country", es.meta)}</td>
    <td class="sticky-l sc2 meta-col">${metaCell(r, "client", es.meta)}</td>
    <td class="sticky-l sc3 meta-col">${metaCell(r, "project", es.meta)}</td>
    <td class="sticky-l sc4 meta-col">${metaCell(r, "name", es.meta)}</td>
    <td class="sticky-l sc5 meta-col">${titleCell}</td>
    <td class="sticky-l sc6 meta-col num-cell">${rateCell("rate", mode.rateLabels[0])}</td>
    <td class="sticky-l sc7 meta-col num-cell">${rateCell("offshore_rate", mode.rateLabels[1])}</td>
    <td class="sticky-l sc8 calc dim" data-calc="total_hrs">${fmt(total, 1)}</td>
    <td class="sticky-l sc9 calc" data-calc="total_rev">${fmt(rev)}</td>
    <td class="sticky-l sc10 calc dim" data-calc="total_exp">${fmt(cost)}</td>
    ${weekCells}
    <td>${delBtn}</td>
  </tr>`;
}

function alignSticky() {
  const wrap = document.querySelector("#gridWrap");
  const table = document.querySelector("#gridTable");
  const probe = document.querySelector("#gridBody tr.resource-row");
  if (!wrap || !table || !probe) return;
  const prev = wrap.scrollLeft;
  wrap.scrollLeft = 0;
  const els = document.querySelectorAll("#gridHead [class*=sc], #gridBody [class*=sc]");
  els.forEach((el) => { el.style.left = ""; el.style.position = "static"; });
  const tLeft = table.getBoundingClientRect().left;
  const xs = [];
  for (let i = 1; i <= N_LOCKED; i++) {
    const cell = probe.children[i - 1];
    xs.push(cell ? Math.round(cell.getBoundingClientRect().left - tLeft) : null);
  }
  els.forEach((el) => { el.style.position = ""; });
  for (let i = 1; i <= N_LOCKED; i++) {
    if (xs[i - 1] === null) continue;
    document.querySelectorAll(`#gridHead .sc${i}, #gridBody .sc${i}`).forEach((el) => {
      el.style.left = `${xs[i - 1]}px`;
    });
  }
  wrap.scrollLeft = prev;
}

function renderGrid() {
  const weeks = state.weeks, mode = MODES[state.view], es = gridEditState();
  const groups = [];
  for (const r of state.resources) {
    const client = (r.client || "").trim();
    const project = (r.project || "").trim();
    const key = client + "|" + project;
    if (groups.length && groups[groups.length - 1].key === key) {
      groups[groups.length - 1].members.push(r);
    } else {
      groups.push({ key, client, project, members: [r] });
    }
  }
  const filter = ($("#filter").value || "").toLowerCase();
  const lockHint = es.meta ? "" : " · LOCKED — click Edit to make changes";
  $("#gridNote").innerHTML = `<span class="dot ${mode.dot}"></span>${mode.note}${lockHint}`;
  $("#btnAdd").style.display = "initial";
  $("#btnEditGrid").textContent = es.meta ? "Done · Lock" : "Edit";
  $("#btnEditGrid").classList.toggle("edit-active", es.meta);

  $("#gridHead").innerHTML = gridHeadHTML();
  let oldCols = document.querySelector("#gridTable colgroup");
  if (oldCols) oldCols.remove();
  document.querySelector("#gridTable").insertAdjacentHTML("afterbegin", colgroupHTML());
  let html = "<tbody>";
  groups.forEach((g, gi) => {
    let hrs = 0, rev = 0, cost = 0;
    for (const m of g.members) {
      const total = (m.hours || []).reduce((a, b) => a + b, 0);
      hrs += total; rev += (effRate(m) || 0) * total; cost += (effOffshore(m) || 0) * total;
    }
    html += `<tr class="group-row" data-group="${gi}" title="Expand / collapse">
      <td class="sticky-l sc1" colspan="${N_META + 2}"><span class="group-chevron">▼</span>${esc(g.client || "—")}${g.project ? ` · ${esc(g.project)}` : ""}<span class="proj-count-chip">${g.members.length} resource(s)</span></td>
      <td class="sticky-l sc8 calc dim" data-calc="total_hrs">${fmt(hrs, 1)}</td>
      <td class="sticky-l sc9 calc" data-calc="total_rev">${fmt(rev)}</td>
      <td class="sticky-l sc10 calc dim" data-calc="total_exp">${fmt(cost)}</td>
      ${weeks.map(() => "<td></td>").join("")}
      <td></td></tr>`;

    let body = "";
    for (const m of g.members) {
      const keep = !filter || [m.name, m.client, m.project, m.role, m.country].some((v) => (v || "").toLowerCase().includes(filter));
      if (keep) body += gridRowHTML(m);
    }
    if (body) html += body;
  });
  html += "</tbody>";
  $("#gridBody").innerHTML = html;
  alignSticky();
}

/* ---------------- grid live math ---------------- */
function computeRow(tr) {
  const rate = num($(`input[data-field="rate"]`, tr)?.value) ?? 0;
  const offRate = num($(`input[data-field="offshore_rate"]`, tr)?.value) ?? 0;
  let total = 0;
  $$(`input[data-week]`, tr).forEach((i) => { total += num(i.value) || 0; });
  const rev = rate * total;
  const cost = offRate * total;
  tr.querySelector('[data-calc="total_hrs"]').textContent = fmt(total, 1);
  tr.querySelector('[data-calc="total_rev"]').textContent = fmt(rev);
  tr.querySelector('[data-calc="total_exp"]').textContent = fmt(cost);
  return { total, rev, cost };
}

function groupIndexOf(tr) {
  const rows = Array.from(tr.parentElement.children);
  const idx = rows.indexOf(tr);
  for (let i = idx; i >= 0; i--) {
    if (rows[i].classList.contains("group-row")) return +rows[i].dataset.group;
  }
  return null;
}

function recomputeGroup(gidx) {
  if (gidx === null || gidx < 0) return;
  const tbody = $("#gridBody");
  const gr = tbody.querySelector(`tr.group-row[data-group="${gidx}"]`);
  const sr = tbody.querySelector(`tr.subtotal-row[data-group="${gidx}"]`);
  if (!gr) return;
  const rows = Array.from(tbody.children);
  const start = rows.indexOf(gr);
  let hrs = 0, rev = 0, cost = 0;
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.classList.contains("group-row")) break;
    if (!row.classList.contains("resource-row")) continue;
    const rate = num($(`input[data-field="rate"]`, row)?.value) ?? 0;
    const offRate = num($(`input[data-field="offshore_rate"]`, row)?.value) ?? 0;
    let total = 0;
    $$(`input[data-week]`, row).forEach((i) => { total += num(i.value) || 0; });
    hrs += total; rev += rate * total; cost += offRate * total;
  }
  for (const el of [gr, sr]) {
    if (!el) continue;
    const hEl = el.querySelector('[data-calc="total_hrs"]');
    const rEl = el.querySelector('[data-calc="total_rev"]');
    const eEl = el.querySelector('[data-calc="total_exp"]');
    if (hEl) hEl.textContent = fmt(hrs, 1);
    if (rEl) rEl.textContent = fmt(rev);
    if (eEl) eEl.textContent = fmt(cost);
  }
}
function weeksCount() { return state.weeks.length; }

/* ---------------- title auto-fill ---------------- */
function pricingEntry(title) {
  return state.pricing.find((p) => p.title === title) || null;
}
const CURR_SYM = { USD: "$", GBP: "£", CAD: "CA$" };
function gridCurrencyTag(r) {
  const e = pricingEntry(r.role);
  const sym = e && e.currency ? (CURR_SYM[e.currency] || e.currency) : null;
  return sym ? `<span class="cur-tag">${sym}</span>` : "";
}

function effRate(r) {
  if (r.rate !== null && r.rate !== undefined) return r.rate;
  const e = pricingEntry(r.role);
  return e ? e.rate : null;
}
function effOffshore(r) {
  if (r.offshore_rate !== null && r.offshore_rate !== undefined) return r.offshore_rate;
  const e = pricingEntry(r.role);
  return e ? e.offshore_rate : null;
}

function fillRateFromTitle(tr) {
  const sel = $(`select[data-field="role"]`, tr);
  const title = sel ? sel.value : "";
  const entry = pricingEntry(title);
  if (!entry) return;
  const rid = +tr.dataset.rid;
  const md = dirty.get(rid) || { fields: {}, hours: false };
  const filled = [];
  if (entry.rate !== null && entry.rate !== undefined) {
    const rateInp = $(`input[data-field="rate"]`, tr);
    if (rateInp) rateInp.value = entry.rate;
    md.fields.rate = entry.rate;
    filled.push(`Onsite $${entry.rate}`);
  }
  if (entry.offshore_rate !== null && entry.offshore_rate !== undefined) {
    const offInp = $(`input[data-field="offshore_rate"]`, tr);
    if (offInp) offInp.value = entry.offshore_rate;
    md.fields.offshore_rate = entry.offshore_rate;
    filled.push(`Offshore $${entry.offshore_rate}`);
  }
  md.fields.role = title;
  dirty.set(rid, md);
  if (!flushTimer) flushTimer = setTimeout(flush, 1200);
  computeRow(tr);
  recomputeGroup(groupIndexOf(tr));
  toast(filled.length ? `"${title}": ${filled.join(" + ")} from Pricing` : `"${title}" set`);
}

/* ---------------- save queue (resources) ---------------- */
function markDirty(rid, kind, field, value) {
  let d = dirty.get(rid) || { fields: null, hours: false };
  if (kind === "hours") d.hours = true;
  else { d.fields = d.fields || {}; d.fields[field] = value; }
  dirty.set(rid, d);
  if (!flushTimer) flushTimer = setTimeout(flush, 1200);
}

async function flush() {
  flushTimer = null;
  if (!dirty.size) return;
  const pending = Array.from(dirty.entries());
  dirty.clear();
  let saved = 0;
  for (const [rid, d] of pending) {
    try {
      if (d.fields) {
        const updated = await api(`/api/resources/${rid}`, { method: "PUT", body: JSON.stringify(d.fields) });
        const r = state.resources.find((x) => x.id === rid);
        if (r && updated) Object.assign(r, updated);
      }
      if (d.hours) {
        const tr = $(`#gridBody tr[data-rid="${rid}"]`);
        if (tr) {
          const hours = Array.from($$(`input[data-week]`, tr)).map((i) => num(i.value) || 0);
          const updated = await api(`/api/resources/${rid}/hours`, { method: "PUT", body: JSON.stringify({ hours }) });
          const r = state.resources.find((x) => x.id === rid);
          if (r && updated) r.hours = updated.hours;
        }
      }
      saved++;
    } catch (e) {
      toast(`Save failed: ${e.message}`, true);
    }
  }
  if (saved) toast("Saved");
  renderView();
}

/* ---------------- save queue (pricing) ---------------- */
function pMarkDirty(pid, field, value) {
  const d = pDirty.get(pid) || {};
  d[field] = value;
  pDirty.set(pid, d);
  if (!pFlushTimer) pFlushTimer = setTimeout(pFlush, 1200);
}

async function pFlush() {
  pFlushTimer = null;
  if (!pDirty.size) return;
  const pending = Array.from(pDirty.entries());
  pDirty.clear();
  let saved = 0;
  for (const [pid, d] of pending) {
    try {
      const body = {};
      if ("title" in d) body.title = d.title;
      if ("rate" in d && d.rate !== undefined) body.rate = d.rate;
      if ("offshore_rate" in d && d.offshore_rate !== undefined) body.offshore_rate = d.offshore_rate;
      await api(`/api/pricing/${pid}`, { method: "PUT", body: JSON.stringify(body) });
      saved++;
    } catch (e) {
      toast(`Pricing save failed: ${e.message}`, true);
    }
  }
  if (saved) {
    toast("Pricing saved");
    await loadState();
  }
}

/* ---------------- grid events ---------------- */
$("#gridBody").addEventListener("input", (e) => {
  const el = e.target.closest("input");
  if (el && el.closest("tr[data-rid]")) {
    const tr = el.closest("tr[data-rid]");
    const rid = +tr.dataset.rid;
    if (el.dataset.week !== undefined && !el.disabled) {
      markDirty(rid, "hours");
      computeRow(tr);
      recomputeGroup(groupIndexOf(tr));
    } else if (el.dataset.field && !el.disabled) {
      const f = el.dataset.field;
      const v = (f === "rate" || f === "offshore_rate") ? (num(el.value) ?? null) : el.value;
      markDirty(rid, "fields", f, v);
      computeRow(tr);
      recomputeGroup(groupIndexOf(tr));
    }
    return;
  }
  const sel = e.target.closest("select[data-field='role']");
  if (sel && sel.closest("tr[data-rid]")) {
    const tr = sel.closest("tr[data-rid]");
    const rid = +tr.dataset.rid;
    markDirty(rid, "fields", "role", sel.value);
    fillRateFromTitle(tr);
  }
});

$("#gridBody").addEventListener("paste", (e) => {
  const inp = e.target.closest("input");
  if (!inp || !inp.closest("tr[data-rid]")) return;
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  if (!text.includes("\t") && !text.includes("\n")) return;
  e.preventDefault();
  const es = gridEditState();
  const tr = inp.closest("tr[data-rid]");
  const anchorCol = inp.closest("td").cellIndex;
  const lines = text.replace(/\r/g, "").split("\n");
  let rowEl = tr;
  const META = ["country", "client", "project", "name", "role"];
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) { rowEl = nextResourceRow(rowEl); if (!rowEl) break; }
    const cols = lines[li].split("\t");
    for (let ci = 0; ci < cols.length; ci++) {
      const col = anchorCol + ci;
      const val = cols[ci].trim();
      if (!val) continue;
      const rid = +rowEl.dataset.rid;
      if (col < N_META) {
        const f = META[col];
        if (f && es.meta) {
          const mi = $(`input[data-field="${f}"]`, rowEl);
          if (mi) { mi.value = val; markDirty(rid, "fields", f, val); }
        }
      } else if (col === N_META) {
        // rate column (5)
        const ri = $(`input[data-field="rate"]`, rowEl);
        if (ri) { ri.value = val; markDirty(rid, "fields", "rate", num(val) ?? null); }
      } else if (col === N_META + 1) {
        // offshore rate column (6)
        const ri = $(`input[data-field="offshore_rate"]`, rowEl);
        if (ri) { ri.value = val; markDirty(rid, "fields", "offshore_rate", num(val) ?? null); }
      } else if (col >= WEEKS_START && col < WEEKS_START + state.weeks.length) {
        if (!es.hours) continue;
        const w = col - WEEKS_START;
        const wi = $(`input[data-week="${w}"]`, rowEl);
        if (wi) { wi.value = val; markDirty(rid, "hours"); }
      }
    }
    computeRow(rowEl);
    recomputeGroup(groupIndexOf(rowEl));
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 1200);
});
function nextResourceRow(tr) {
  const cur = tr.nextElementSibling;
  return cur && cur.classList.contains("resource-row") ? cur : null;
}

function toggleGroupRows(gr, force) {
  const collapsed = force !== undefined ? force : !gr.classList.contains("collapsed");
  gr.classList.toggle("collapsed", collapsed);
  let nxt = gr.nextElementSibling;
  while (nxt && !nxt.classList.contains("group-row")) {
    if (nxt.classList.contains("resource-row")) nxt.classList.toggle("collapsed", collapsed);
    nxt = nxt.nextElementSibling;
  }
  alignSticky();
}

$("#gridBody").addEventListener("click", async (e) => {
  const del = e.target.closest(".del");
  if (del) {
    const tr = del.closest("tr[data-rid]");
    const r = state.resources.find((x) => x.id === +tr.dataset.rid);
    if (!confirm(`Delete ${r ? r.name : "this resource"}? This can't be undone.`)) return;
    try {
      await api(`/api/resources/${tr.dataset.rid}`, { method: "DELETE" });
      toast("Deleted");
      await loadState();
    } catch (err) { toast(`Delete failed: ${err.message}`, true); }
    return;
  }
  const gr = e.target.closest("tr.group-row");
  if (gr) toggleGroupRows(gr);
});

/* ---------------- pricing tab ---------------- */
let editingPid = null;

function curSym(code) { return CURR_SYM[code] || code || "$"; }

function pricingRowHTML(p) {
  const isEdit = editingPid === p.id || (editingPid === -1 && p.id === -1);
  if (isEdit) {
    const sel = ["USD", "GBP", "CAD"].map((c) =>
      `<option value="${c}"${(p.currency || "USD") === c ? " selected" : ""}>${curSym(c)}</option>`).join("");
    return `<tr class="p-res p-edit" data-pid="${p.id}">
      <td><input class="rate-inp txt" data-field="title" value="${esc(p.title)}" placeholder="Title (e.g. Sr. DevOps Engineer)"></td>
      <td class="num"><input class="rate-inp" type="number" min="0" step="any" data-field="rate" value="${p.rate ?? ""}" placeholder="—"></td>
      <td class="num"><input class="rate-inp" type="number" min="0" step="any" data-field="offshore_rate" value="${p.offshore_rate ?? ""}" placeholder="—"></td>
      <td><select class="cur-sel" data-field="currency" title="Currency for this title">${sel}</select></td>
      <td class="num dim">${p.used_by} resource(s)</td>
      <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
    </tr>`;
  }
  const sym = curSym(p.currency);
  return `<tr class="p-res" data-pid="${p.id}">
    <td class="p-title-read">${esc(p.title)}</td>
    <td class="num"><span class="p-read">${sym}${p.rate !== null && p.rate !== undefined ? fmt(p.rate) : '<span class="p-empty">—</span>'}</span></td>
    <td class="num"><span class="p-read">${sym}${p.offshore_rate !== null && p.offshore_rate !== undefined ? fmt(p.offshore_rate) : '<span class="p-empty">—</span>'}</span></td>
    <td><span class="cur-chip">${sym}</span></td>
    <td class="num dim">${p.used_by} resource(s)</td>
    <td><button class="btn mini edit">Edit</button> <button class="btn mini apply">Apply</button> <button class="del" title="Delete title">✕</button></td>
  </tr>`;
}

function renderPricing() {
  // Ensure PM/project data is loaded (it's fetched async; without this the
  // Add-PM row shows zero project checkboxes on first tab visit).
  if (!loadPMDataStarted) {
    loadPMDataStarted = true;
    loadPMData().then(() => { if (state.view === "pricing") renderPMs(); });
  }
  const rows = state.pricing || [];
  let html = `<thead><tr>
    <th>Title</th><th class="num">Rate</th><th class="num">Offshore Rate</th><th>Currency</th>
    <th class="num">Used By</th><th></th>
  </tr></thead><tbody>`;
  if (!rows.length && editingPid !== -1) {
    html += `<tr class="p-res"><td colspan="6" class="dim">No titles yet — click + Add Title or import an Excel file.</td></tr>`;
  }
  for (const p of rows) html += pricingRowHTML(p);
  if (editingPid === -1) html += pricingRowHTML({ id: -1, title: "", rate: null, offshore_rate: null, currency: "USD", used_by: 0 });
  html += "</tbody>";
  $("#pricingBody").innerHTML = html;
  renderPMs();
  renderCapacity();
}

function readEditRow(tr) {
  const g = (f) => tr.querySelector(`[data-field="${f}"]`);
  return {
    title: (g("title")?.value || "").trim(),
    rate: num(g("rate")?.value) ?? null,
    offshore_rate: num(g("offshore_rate")?.value) ?? null,
    currency: g("currency")?.value || "USD",
  };
}

async function saveEditRow(tr) {
  const pid = +tr.dataset.pid;
  const data = readEditRow(tr);
  if (!data.title) { toast("Title is required", true); return; }
  const btn = tr.querySelector(".save");
  btn.disabled = true; btn.textContent = "…";
  try {
    if (pid === -1) {
      await api("/api/pricing", { method: "POST", body: JSON.stringify(data) });
    } else {
      await api(`/api/pricing/${pid}`, { method: "PUT", body: JSON.stringify(data) });
    }
    editingPid = null;
    toast(`"${data.title}" saved — now in the Onsite/Offshore dropdowns`);
    await loadState();
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
    btn.disabled = false; btn.textContent = "Save";
  }
}

$("#pricingBody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-pid]");
  if (!tr) return;
  const pid = +tr.dataset.pid;
  if (e.target.closest(".edit")) {
    editingPid = pid;
    renderPricing();
    return;
  }
  if (e.target.closest(".save")) {
    await saveEditRow(tr);
    return;
  }
  if (e.target.closest(".cancel")) {
    editingPid = null;
    renderPricing();
    return;
  }
  const p = state.pricing.find((x) => x.id === pid);
  if (e.target.closest(".apply")) {
    if (!confirm(`Push "${p ? p.title : ""}"'s rates to all ${p ? p.used_by : 0} resource(s) using it?`)) return;
    const btn = e.target.closest(".apply");
    btn.disabled = true; btn.textContent = "…";
    try {
      const res = await api(`/api/pricing/${pid}/apply`, { method: "POST" });
      toast(`Applied ${res.rate ?? "—"} / ${res.offshore_rate ?? "—"} to ${res.updated} resource(s)`);
      await loadState();
    } catch (err) { toast(`Apply failed: ${err.message}`, true); }
    return;
  }
  if (e.target.closest(".del")) {
    if (!confirm(`Delete title "${p ? p.title : ""}"? Resources keep their current rates.`)) return;
    try {
      await api(`/api/pricing/${pid}`, { method: "DELETE" });
      toast("Title deleted");
      await loadState();
    } catch (err) { toast(`Delete failed: ${err.message}`, true); }
  }
});

$("#btnAddTitle").addEventListener("click", () => {
  editingPid = -1;
  renderPricing();
});

$("#btnApplyAll").addEventListener("click", async () => {
  const used = state.pricing.reduce((a, p) => a + (p.used_by || 0), 0);
  if (!confirm(`Push EVERY title's rates onto all ${used} resource(s) using them?\n\nAll Onsite/Offshore rates will match the Pricing tab and every total will recompute.`)) return;
  const btn = $("#btnApplyAll");
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    const res = await api("/api/pricing/apply-all", { method: "POST" });
    toast(`Update All: ${res.updated} resource(s) updated across ${(res.per_title || []).length} title(s)`);
    await loadState();
  } catch (err) { toast(`Update All failed: ${err.message}`, true); }
  btn.disabled = false; btn.textContent = "Update All Pricing";
});

/* ---------------- PM assignment + capacity ---------------- */
let users = [], projects = [], projectOwners = {};
let editingUser = null;
let loadPMDataStarted = false;

async function loadPMData() {
  try {
    const [u, p, o] = await Promise.all([api("/api/users"), api("/api/projects"), api("/api/project-owners")]);
    users = u; projects = p; projectOwners = o || {};
  } catch (e) { toast(`PM data failed: ${e.message}`, true); }
}

/* A project checkbox is disabled when another PM already owns it (one PM per
   project). The PM currently being edited may keep its own projects. */
function projectCheckboxes(selected, selfUsername) {
  const sel = new Set(selected || []);
  return projects.map((pr) => {
    const owner = projectOwners[pr];
    const taken = owner && owner !== selfUsername;
    const checked = sel.has(pr);
    const dis = taken ? " disabled" : "";
    const tag = taken ? ` <span class="pm-taken">(${esc(owner)})</span>` : "";
    return `<label class="pm-proj${dis ? " pm-disabled" : ""}"><input type="checkbox" value="${esc(pr)}"${checked ? " checked" : ""}${dis}> ${esc(pr)}${tag}</label>`;
  }).join("");
}

function renderPMs() {
  $("#pmHead").innerHTML = `<tr><th>PM</th><th>Assigned Projects</th><th></th></tr>`;
  let html = "<tbody>";
  if (!users.length) html += `<tr><td colspan="3" class="dim">No PMs yet — click + Add PM.</td></tr>`;
  for (const u of users) {
    if (editingUser === u.id) {
      html += `<tr class="p-res p-edit" data-uid="${u.id}">
        <td><input class="rate-inp txt" data-field="username" value="${esc(u.username)}" disabled></td>
        <td><div class="pm-projs">${projectCheckboxes(u.projects, u.username)}</div></td>
        <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
      </tr>`;
    } else {
      html += `<tr class="p-res" data-uid="${u.id}">
        <td>${esc(u.username)}</td>
        <td class="dim">${(u.projects || []).map(esc).join(", ") || "—"}</td>
        <td><button class="btn mini edit">Edit</button> <button class="del" title="Delete PM">✕</button></td>
      </tr>`;
    }
  }
  if (editingUser === -1) {
    html += `<tr class="p-res p-edit" data-uid="-1">
      <td>
        <input class="rate-inp txt" data-field="username" placeholder="PM username" autocomplete="off">
        <input class="rate-inp txt pm-pw" data-field="password" type="password" placeholder="Password" autocomplete="new-password">
      </td>
      <td><div class="pm-projs">${projectCheckboxes([], null)}</div></td>
      <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
    </tr>`;
  }
  html += "</tbody>";
  $("#pmBody").innerHTML = html;
}

function renderCapacity() {
  $("#capHead").innerHTML = `<tr><th>Resource</th><th>Client · Project</th><th class="num">Capacity (hrs/wk)</th></tr>`;
  let html = "<tbody>";
  for (const r of state.resources) {
    const cap = r.capacity ?? 40;
    html += `<tr class="p-res" data-rid="${r.id}">
      <td>${esc(r.name)}</td>
      <td class="dim">${esc(r.client)}${r.project ? " · " + esc(r.project) : ""}</td>
      <td class="num"><input class="rate-inp cap-inp" type="number" min="1" step="1" data-cap="${r.id}" value="${cap}"></td>
    </tr>`;
  }
  html += "</tbody>";
  $("#capBody").innerHTML = html;
}

$("#pmBody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-uid]");
  if (!tr) return;
  const uid = +tr.dataset.uid;
  if (e.target.closest(".edit")) { editingUser = uid; renderPMs(); return; }
  if (e.target.closest(".cancel")) { editingUser = null; renderPMs(); return; }
  if (e.target.closest(".save")) {
    const uname = (tr.querySelector('[data-field="username"]')?.value || "").trim();
    const pw = (tr.querySelector('[data-field="password"]')?.value || "").trim();
    const projs = Array.from(tr.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
    if (!uname) { toast("PM username required", true); return; }
    if (uid === -1 && !pw) { toast("Password required for new PM", true); return; }
    const btn = tr.querySelector(".save"); btn.disabled = true; btn.textContent = "…";
    try {
      if (uid === -1) {
        await api("/api/users", { method: "POST", body: JSON.stringify({ username: uname, password: pw, projects: projs }) });
      } else {
        await api(`/api/users/${uid}`, { method: "PUT", body: JSON.stringify({ projects: projs }) });
      }
      editingUser = null;
      toast("PM saved");
      await loadPMData(); renderPMs();
    } catch (err) { toast(`PM save failed: ${err.message}`, true); btn.disabled = false; btn.textContent = "Save"; }
    return;
  }
  if (e.target.closest(".del")) {
    if (!confirm(`Delete PM "${unameOf(uid)}"?`)) return;
    try { await api(`/api/users/${uid}`, { method: "DELETE" }); await loadPMData(); renderPMs(); }
    catch (err) { toast(`Delete failed: ${err.message}`, true); }
  }
});
function unameOf(uid) { const u = users.find((x) => x.id === uid); return u ? u.username : "this PM"; }

$("#btnAddUser").addEventListener("click", () => { editingUser = -1; renderPMs(); });

// capacity save (debounced)
let capTimer = null;
$("#capBody").addEventListener("input", (e) => {
  const inp = e.target.closest("[data-cap]");
  if (!inp) return;
  clearTimeout(capTimer);
  capTimer = setTimeout(async () => {
    const rid = +inp.dataset.cap;
    const v = num(inp.value);
    try {
      await api(`/api/resources/${rid}`, { method: "PUT", body: JSON.stringify({ capacity: v }) });
      toast("Capacity saved");
    } catch (err) { toast(`Capacity save failed: ${err.message}`, true); }
  }, 800);
});

/* ---------------- utilization tab ---------------- */
function utilClass(v) {
  if (v > 100) return "red";
  if (v >= 80) return "green";
  if (v >= 50) return "yellow";
  return "orange";
}

function renderUtilization() {
  api("/api/utilization").then((data) => {
    const months = data.months;
    const sub = (lbl) => `<th class="u-sub">${lbl}</th>`;
    let head = `<tr><th class="u-th-name" rowspan="2">Resource</th><th rowspan="2">Projects</th><th rowspan="2" class="num">Cap/wk</th>`;
    head += months.map((m) => `<th class="num" colspan="2">${esc(m)}</th>`).join("");
    head += `<th class="num" colspan="2">Overall</th></tr>`;
    head += `<tr>${months.map(() => sub("P") + sub("A")).join("")}${sub("P") + sub("A")}</tr>`;
    let rows = "";
    for (const row of data.rows) {
      rows += `<tr>
        <td class="u-name-td"><div class="u-name">${esc(row.name)}</div></td>
        <td class="u-proj">${esc(row.projects.join(", ") || "—")}</td>
        <td class="u-cell num">${row.capacity_week || 40}</td>`;
      for (const mo of row.months) {
        const pc = utilClass(mo.planned_pct);
        const ac = utilClass(mo.actual_pct);
        rows += `<td class="u-cell ${pc}" title="planned ${(mo.planned_hours||0).toLocaleString()}h / ${mo.capacity}h">${fmt(mo.planned_pct, 0)}%</td>`;
        rows += `<td class="u-cell ${ac}" title="actual ${(mo.actual_hours||0).toLocaleString()}h / ${mo.capacity}h">${fmt(mo.actual_pct, 0)}%</td>`;
      }
      const poc = utilClass(row.planned_overall);
      const aoc = utilClass(row.actual_overall);
      rows += `<td class="u-cell ${poc}" title="planned ${(row.total_planned||0).toLocaleString()}h total">${fmt(row.planned_overall, 0)}%</td>`;
      rows += `<td class="u-cell ${aoc}" title="actual ${(row.total_actual||0).toLocaleString()}h total">${fmt(row.actual_overall, 0)}%</td></tr>`;
    }
    $("#utilHead").innerHTML = head;
    $("#utilBody").innerHTML = rows;
    // sticky alignment for the new 3-column frozen block (Resource + Projects + Cap/wk)
    alignUtilSticky();
  }).catch((e) => toast(`Utilization failed: ${e.message}`, true));
}

/* Pin Resource + Projects + Cap/wk; the "Resource" header cell also pins to
   the left. Projects & Cap/wk are intentionally NOT sticky (they scroll). */
function alignUtilSticky() {
  const table = document.getElementById("utilTable");
  const probe = document.querySelector("#utilBody tr");
  if (!table || !probe) return;
  const tLeft = table.getBoundingClientRect().left;
  // Resource column stays pinned at left:0 (CSS handles it).
  // Just ensure the name header and body align after render.
  const nameHead = document.querySelector("#utilHead th.u-th-name");
  const nameBody = probe ? probe.children[0] : null;
  if (nameHead && nameBody) {
    const h = Math.round(nameHead.getBoundingClientRect().left - tLeft);
    const b = Math.round(nameBody.getBoundingClientRect().left - tLeft);
    if (h !== b) nameHead.style.left = `${b}px`;
  }
}

/* ---------------- dashboard ---------------- */
function renderDashboard() {
  api("/api/dashboard").then((data) => {
    const groups = data.rows.groups, totals = data.rows.totals;
    let totalRev = 0, totalExp = 0, totalActRev = 0, totalActExp = 0;
    totals.forEach((t) => {
      totalRev += t.revenue; totalExp += t.expense;
      totalActRev += t.actual_rev || 0; totalActExp += t.actual_exp || 0;
    });
    const plannedSavings = totalRev - totalExp;
    const actualSavings = totalActRev - totalActExp;
    $("#dashCards").innerHTML = `
      <div class="card glass"><div class="k">Planned Revenue</div><div class="v cyan">$${fmt(totalRev)}</div></div>
      <div class="card glass"><div class="k">Planned Expense</div><div class="v">$${fmt(totalExp)}</div></div>
      <div class="card glass"><div class="k">Planned Savings</div><div class="v ${plannedSavings >= 0 ? "green" : "red"}">$${fmt(plannedSavings)}</div></div>
      <div class="card glass"><div class="k">Actual Revenue</div><div class="v cyan">$${fmt(totalActRev)}</div></div>
      <div class="card glass"><div class="k">Actual Expense</div><div class="v">$${fmt(totalActExp)}</div></div>
      <div class="card glass"><div class="k">Actual Savings</div><div class="v ${actualSavings >= 0 ? "green" : "red"}">$${fmt(actualSavings)}</div></div>`;
    let rows = `<thead><tr><th>Country</th><th>Client</th><th>Project</th><th>Resource(s)</th><th>Planned Revenue</th><th>Planned Expense</th><th>Planned Savings</th><th>Actual Revenue</th><th>Actual Expense</th><th>Actual Savings</th></tr></thead><tbody>`;
    for (const g of groups) {
      const pSavings = g.revenue - g.expense;
      const aSavings = (g.actual_rev || 0) - (g.actual_exp || 0);
      rows += `<tr>
        <td>${esc(g.country)}</td><td>${esc(g.client)}</td><td>${esc(g.project)}</td><td>${g.resources}</td>
        <td>$${fmt(g.revenue)}</td><td>$${fmt(g.expense)}</td>
        <td style="color:${pSavings >= 0 ? "var(--green)" : "var(--red)"}">$${fmt(pSavings)}</td>
        <td>$${fmt(g.actual_rev || 0)}</td><td>$${fmt(g.actual_exp || 0)}</td>
        <td style="color:${aSavings >= 0 ? "var(--green)" : "var(--red)"}">$${fmt(aSavings)}</td></tr>`;
    }
    for (const t of totals) {
      const pSavings = t.revenue - t.expense;
      const aSavings = (t.actual_rev || 0) - (t.actual_exp || 0);
      rows += `<tr class="total-row">
        <td>TOTAL ${t.currency}</td><td>—</td><td>—</td><td>—</td>
        <td>$${fmt(t.revenue)}</td><td>$${fmt(t.expense)}</td>
        <td style="color:${pSavings >= 0 ? "var(--green)" : "var(--red)"}">$${fmt(pSavings)}</td>
        <td>$${fmt(t.actual_rev || 0)}</td><td>$${fmt(t.actual_exp || 0)}</td>
        <td style="color:${aSavings >= 0 ? "var(--green)" : "var(--red)"}">$${fmt(aSavings)}</td></tr>`;
    }
    rows += "</tbody>";
    $("#dashTable").innerHTML = rows;
  }).catch((e) => toast(`Dashboard failed: ${e.message}`, true));
}

/* ---------------- ACTUALS tab ---------------- */
let actualsData = { resources: [], weeks: [], months: [] };

async function loadActuals() {
  try {
    actualsData = await api("/api/actuals");
    renderActuals();
  } catch (e) { toast(`Actuals failed: ${e.message}`, true); }
}

function actualsHeadHTML() {
  const weeks = actualsData.weeks, months = actualsData.months;
  const colHeads = [["Country", "sc1"], ["Client", "sc2"], ["Project", "sc3"], ["Resource Name", "sc4"],
                    ["Title", "sc5"], ["Planned", "sc6"], ["Actual", "sc7"], ["Δ", "sc8"]];
  const headCells = colHeads.map(([h, sc]) => `<th class="sticky-h ${sc} colh">${h}</th>`).join("");
  const stickySpacers = Array.from({ length: 8 }, (_, i) => `<th class="sticky-h sc${i + 1}"></th>`).join("");
  const monthCells = months.map((m) => `<th colspan="${m.end - m.start + 1}">${esc(m.name)}</th>`).join("");
  const weekCells = weeks.map((w) => `<th class="week-h">${esc(w)}</th>`).join("");
  return `<tr class="head-row">${headCells}${weekCells}</tr>
          <tr class="month-row">${stickySpacers}${monthCells}</tr>
          <tr class="week-row">${stickySpacers}${weekCells}</tr>`;
}

function actualsColgroup() {
  const metaW = [70, 150, 140, 160, 160, 70, 70, 70];
  let s = "<colgroup>";
  metaW.forEach((w) => { s += `<col style="width:${w}px">`; });
  for (let i = 0; i < actualsData.weeks.length; i++) s += '<col style="width:54px">';
  return s + "</colgroup>";
}

function actualsRowHTML(r) {
  const planned = r.hours || Array(actualsData.weeks.length).fill(0);
  const actual = r.actual_hours || Array(actualsData.weeks.length).fill(0);
  const notes = r.actual_notes || {};
  const cap = r.capacity ?? 40;
  const totalPlanned = planned.reduce((a, b) => a + b, 0);
  const totalActual = actual.reduce((a, b) => a + b, 0);
  const delta = totalActual - totalPlanned;
  const weekCell = (p, a, i) => {
    const n = notes[i] || {};
    let cls = "";
    if (a > p) cls = "a-over";
    else if (a < p) cls = "a-under";
    // OT status chip: OT approved+billed ✓, OT approved unbilled (reason), OT unapproved ⛔
    let chip = "";
    if (a > p && n.is_ot) {
      if (n.approved && n.billed) chip = `<span class="ot-chip ot-ok" title="OT approved & billed">OT ✓</span>`;
      else if (n.approved && !n.billed) chip = `<span class="ot-chip ot-unbilled" title="OT approved, not billed">OT unbilled</span>`;
      else chip = `<span class="ot-chip ot-block" title="OT not approved">OT ⛔</span>`;
    } else if (a > p && n.is_ot === 0) {
      chip = `<span class="ot-chip ot-not" title="Not OT">not OT</span>`;
    }
    return `<td class="week"><input class="inp a-inp ${cls}" type="number" step="0.25" min="0" data-week="${i}" value="${a ? a : ""}" placeholder="0" inputmode="decimal" title="planned ${p}h">${chip}</td>`;
  };
  let weekCells = "";
  planned.forEach((p, i) => { weekCells += weekCell(p, actual[i] || 0, i); });
  const deltaCls = delta > 0 ? "a-over" : delta < 0 ? "a-under" : "";
  return `<tr class="resource-row" data-rid="${r.id}">
    <td class="sticky-l sc1 meta-col">${esc(r.country || "—")}</td>
    <td class="sticky-l sc2 meta-col">${esc(r.client || "—")}</td>
    <td class="sticky-l sc3 meta-col">${esc(r.project || "—")}</td>
    <td class="sticky-l sc4 meta-col">${esc(r.name)}</td>
    <td class="sticky-l sc5 meta-col">${esc(r.role || "—")}</td>
    <td class="sticky-l sc6 calc dim">${fmt(totalPlanned, 1)}</td>
    <td class="sticky-l sc7 calc">${fmt(totalActual, 1)}</td>
    <td class="sticky-l sc8 calc ${deltaCls}">${delta > 0 ? "+" : ""}${fmt(delta, 1)}</td>
    ${weekCells}
  </tr>`;
}

function renderActuals() {
  const weeks = actualsData.weeks;
  const groups = [];
  for (const r of actualsData.resources) {
    const client = (r.client || "").trim();
    const project = (r.project || "").trim();
    const key = client + "|" + project;
    if (groups.length && groups[groups.length - 1].key === key) groups[groups.length - 1].members.push(r);
    else groups.push({ key, client, project, members: [r] });
  }
  const filter = ($("#actualsFilter").value || "").toLowerCase();
  $("#actualsHead").innerHTML = actualsHeadHTML();
  let oldCols = document.querySelector("#actualsTable colgroup");
  if (oldCols) oldCols.remove();
  document.querySelector("#actualsTable").insertAdjacentHTML("afterbegin", actualsColgroup());
  let html = "<tbody>";
  groups.forEach((g, gi) => {
    let p = 0, a = 0;
    for (const m of g.members) {
      p += (m.hours || []).reduce((x, y) => x + y, 0);
      a += (m.actual_hours || []).reduce((x, y) => x + y, 0);
    }
    html += `<tr class="group-row" data-group="${gi}" title="Expand / collapse">
      <td class="sticky-l sc1" colspan="5"><span class="group-chevron">▼</span>${esc(g.client || "—")}${g.project ? ` · ${esc(g.project)}` : ""}<span class="proj-count-chip">${g.members.length} resource(s)</span></td>
      <td class="sticky-l sc6 calc dim">${fmt(p, 1)}</td>
      <td class="sticky-l sc7 calc">${fmt(a, 1)}</td>
      <td class="sticky-l sc8 calc">${fmt(a - p, 1)}</td>
      ${weeks.map(() => "<td></td>").join("")}
    </tr>`;
    let body = "";
    for (const m of g.members) {
      const keep = !filter || [m.name, m.client, m.project, m.role].some((v) => (v || "").toLowerCase().includes(filter));
      if (keep) body += actualsRowHTML(m);
    }
    if (body) html += body;
  });
  html += "</tbody>";
  $("#actualsBody").innerHTML = html;
  alignActualsSticky();
}

function alignActualsSticky() {
  const wrap = document.querySelector("#actualsWrap");
  const table = document.querySelector("#actualsTable");
  const probe = document.querySelector("#actualsBody tr.resource-row");
  if (!wrap || !table || !probe) return;
  const prev = wrap.scrollLeft;
  wrap.scrollLeft = 0;
  const els = document.querySelectorAll("#actualsHead [class*=sc], #actualsBody [class*=sc]");
  els.forEach((el) => { el.style.left = ""; el.style.position = "static"; });
  const tLeft = table.getBoundingClientRect().left;
  const xs = [];
  for (let i = 1; i <= 8; i++) {
    const cell = probe.children[i - 1];
    xs.push(cell ? Math.round(cell.getBoundingClientRect().left - tLeft) : null);
  }
  els.forEach((el) => { el.style.position = ""; });
  for (let i = 1; i <= 8; i++) {
    if (xs[i - 1] === null) continue;
    document.querySelectorAll(`#actualsHead .sc${i}, #actualsBody .sc${i}`).forEach((el) => { el.style.left = `${xs[i - 1]}px`; });
  }
  wrap.scrollLeft = prev;
}

function aMarkDirty(rid, week, value) {
  let d = aDirty.get(rid) || { hours: false, notes: {} };
  d.hours = true;
  aDirty.set(rid, d);
  if (!aFlushTimer) aFlushTimer = setTimeout(aFlush, 1200);
}

async function aFlush() {
  aFlushTimer = null;
  if (!aDirty.size) return;
  const pending = Array.from(aDirty.entries());
  aDirty.clear();
  for (const [rid, d] of pending) {
    const tr = $(`#actualsBody tr[data-rid="${rid}"]`);
    if (!tr) continue;
    const hours = Array.from($$(`input[data-week]`, tr)).map((i) => num(i.value) || 0);
    const notes = {};
    // collect any notes already stored for this resource
    const r = actualsData.resources.find((x) => x.id === rid);
    if (r && r.actual_notes) Object.assign(notes, r.actual_notes);
    try {
      const res = await api(`/api/resources/${rid}/actuals`, { method: "PUT", body: JSON.stringify({ hours, notes }) });
      if (res.status === "needs_input") {
        // OT flow: prompt the PM for each week needing input
        for (const w of res.weeks) {
          const ok = await actualsPrompt(rid, w, hours);
          if (!ok) { toast("Actuals not saved — resolve the flagged weeks", true); return; }
        }
        // retry after prompts
        const r2 = actualsData.resources.find((x) => x.id === rid);
        const notes2 = r2 ? r2.actual_notes || {} : {};
        const res2 = await api(`/api/resources/${rid}/actuals`, { method: "PUT", body: JSON.stringify({ hours, notes: notes2 }) });
        if (res2.status !== "ok") { toast("Actuals still need input", true); return; }
      }
      toast("Actuals saved");
      await loadActuals();
      refreshDashboard();
    } catch (e) {
      toast(`Actuals save failed: ${e.message}`, true);
    }
  }
}

/* ---------------- Inline OT flow (Yes/No/Cancel modal) ----------------
   Replaces browser confirm()/prompt() with a clean in-app modal. Each step
   shows Yes / No / Cancel; Yes and No advance to the next question based on
   the situation, Cancel aborts the whole save. */
function askOt(question, opts = {}) {
  return new Promise((resolve) => {
    const body = $("#otModalBody");
    const title = $("#otModalTitle");
    title.textContent = opts.title || "Overtime Review";
    let html = `<div class="ot-q">${question}</div>`;
    if (opts.hint) html += `<div class="ot-hint">${opts.hint}</div>`;
    if (opts.input) {
      html += `<input class="inp ot-input" id="otInput" type="text" placeholder="${esc(opts.inputPlaceholder || "")}" value="${esc(opts.inputValue || "")}">`;
    }
    html += `<div class="ot-btns">`;
    if (opts.buttons !== false) {
      html += `<button class="btn primary ot-yes" data-v="yes">Yes</button>`;
      html += `<button class="btn ghost ot-no" data-v="no">No</button>`;
    }
    if (opts.allowCancel !== false) {
      html += `<button class="btn ghost ot-cancel" data-v="cancel">Cancel</button>`;
    }
    html += `</div>`;
    body.innerHTML = html;
    $("#otModal").classList.remove("hidden");

    const finish = (val) => {
      $("#otModal").classList.add("hidden");
      resolve(val);
    };
    body.querySelector(".ot-yes")?.addEventListener("click", () => finish("yes"));
    body.querySelector(".ot-no")?.addEventListener("click", () => finish("no"));
    body.querySelector(".ot-cancel")?.addEventListener("click", () => finish("cancel"));
    const inp = body.querySelector("#otInput");
    if (inp) {
      inp.focus();
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(inp.value.trim());
        if (e.key === "Escape") finish("cancel");
      });
    }
  });
}

/* OT flow prompt — returns true if the week is resolved (saved). Uses the
   inline Yes/No/Cancel modal. */
async function actualsPrompt(rid, w, hours) {
  const r = actualsData.resources.find((x) => x.id === rid);
  const planned = r ? (r.hours || [])[w] || 0 : 0;
  const actual = hours[w] || 0;
  const overage = actual - planned;
  const note = (r && r.actual_notes && r.actual_notes[w]) || {};
  const weekLabel = actualsData.weeks[w] || `week ${w + 1}`;
  const who = r ? r.name : "";

  if (overage < 0) {
    // under-delivery: mandatory comment
    const comment = await askOt(
      `${who} — ${weekLabel}<br>Planned <b>${planned}h</b>, actual <b>${actual}h</b> (${overage}h under).<br><br>Why the shortfall? (required)`,
      { title: "Under-delivery", input: true, inputPlaceholder: "Reason for shortfall", inputValue: note.comment || "", buttons: false, allowCancel: true }
    );
    if (comment === null || comment === "cancel") return false;
    if (!comment.trim()) { toast("A comment is required for under-delivery", true); return false; }
    note.comment = comment.trim();
    note.is_ot = 0; note.approved = 0; note.billed = 0;
    r.actual_notes[w] = note;
    return true;
  }

  // overage -> OT flow
  const isOt = await askOt(
    `${who} — ${weekLabel}<br>Planned <b>${planned}h</b>, actual <b>${actual}h</b> (+${overage}h).<br><br>Is this OVERTIME?`,
    { title: "Overtime Review" }
  );
  if (isOt === "cancel") return false;
  if (isOt === "no") {
    note.is_ot = 0; note.approved = 0; note.billed = 0;
    r.actual_notes[w] = note;
    return true;
  }
  note.is_ot = 1;

  const approved = await askOt(
    `${who} — ${weekLabel}<br>OT of <b>${overage}h</b>.<br><br>Is this OT APPROVED?`,
    { title: "OT Approval" }
  );
  if (approved === "cancel") return false;
  if (approved === "no") {
    // block: must approve or decline
    const decline = await askOt(
      `${who} — ${weekLabel}<br>Unapproved OT cannot be saved.<br><br>Decline this as NOT overtime?`,
      { title: "Unapproved OT", buttons: false }
    );
    if (decline === "cancel") return false;
    if (decline === "yes") { note.is_ot = 0; note.approved = 0; note.billed = 0; r.actual_notes[w] = note; return true; }
    return false;
  }
  note.approved = 1;

  const billed = await askOt(
    `${who} — ${weekLabel}<br>OT of <b>${overage}h</b> APPROVED.<br><br>Is this BILLED to the client?`,
    { title: "Billing" }
  );
  if (billed === "cancel") return false;
  if (billed === "yes") {
    note.billed = 1;
    r.actual_notes[w] = note;
    return true;
  }
  note.billed = 0;
  const reason = await askOt(
    `${who} — ${weekLabel}<br>OT of <b>${overage}h</b> approved but NOT billed.<br><br>Why not billed to the client? (required)`,
    { title: "Unbilled OT", input: true, inputPlaceholder: "Reason not billed", inputValue: note.comment || "", buttons: false, allowCancel: true }
  );
  if (reason === null || reason === "cancel") return false;
  if (!reason.trim()) { toast("A reason is required for unbilled OT", true); return false; }
  note.comment = reason.trim();
  r.actual_notes[w] = note;
  return true;
}

$("#actualsBody").addEventListener("input", (e) => {
  const el = e.target.closest("input[data-week]");
  if (!el) return;
  const tr = el.closest("tr[data-rid]");
  if (!tr) return;
  const rid = +tr.dataset.rid;
  const week = +el.dataset.week;
  aMarkDirty(rid, week, num(el.value) || 0);
  // live delta update
  const r = actualsData.resources.find((x) => x.id === rid);
  if (r) {
    const planned = (r.hours || [])[week] || 0;
    const actual = num(el.value) || 0;
    el.classList.toggle("a-over", actual > planned);
    el.classList.toggle("a-under", actual < planned);
  }
});

$("#actualsBody").addEventListener("click", (e) => {
  const gr = e.target.closest("tr.group-row");
  if (gr) toggleActualsGroup(gr);
});
function toggleActualsGroup(gr) {
  const collapsed = !gr.classList.contains("collapsed");
  gr.classList.toggle("collapsed", collapsed);
  let nxt = gr.nextElementSibling;
  while (nxt && !nxt.classList.contains("group-row")) {
    if (nxt.classList.contains("resource-row")) nxt.classList.toggle("collapsed", collapsed);
    nxt = nxt.nextElementSibling;
  }
  alignActualsSticky();
}
$("#btnActualsExpandAll").addEventListener("click", () => $$("#actualsBody tr.group-row").forEach((g) => toggleActualsGroup(g, false)));
$("#btnActualsCollapseAll").addEventListener("click", () => $$("#actualsBody tr.group-row").forEach((g) => toggleActualsGroup(g, true)));
let aFilterT = null;
$("#actualsFilter").addEventListener("input", () => { clearTimeout(aFilterT); aFilterT = setTimeout(renderActuals, 250); });

/* ---------------- ACTUALS ENTRY POPUP (wizard) ---------------- */
let actualsEntry = { client: "", project: "", month: 0, resources: [] };
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function actualsClients() {
  const set = new Set();
  for (const r of actualsData.resources) if ((r.client || "").trim()) set.add(r.client.trim());
  return Array.from(set).sort();
}
function actualsProjectsFor(client) {
  const set = new Set();
  for (const r of actualsData.resources) if ((r.client || "").trim() === client && (r.project || "").trim()) set.add(r.project.trim());
  return Array.from(set).sort();
}
function actualsResourcesFor(client, project) {
  return actualsData.resources.filter((r) =>
    (r.client || "").trim() === client && (r.project || "").trim() === project);
}

async function openActualsModal() {
  // Ensure actuals data is loaded (the wizard reads actualsData; if the user
  // opens it without visiting the Actuals tab first, it would be empty).
  if (!actualsData.resources || !actualsData.resources.length) {
    try { actualsData = await api("/api/actuals"); }
    catch (e) { toast(`Could not load actuals: ${e.message}`, true); return; }
  }
  actualsEntry = { client: "", project: "", month: 0, resources: [] };
  renderActualsModal();
  $("#actualsModal").classList.remove("hidden");
}
function closeActualsModal() { $("#actualsModal").classList.add("hidden"); }

function renderActualsModal() {
  const e = actualsEntry;
  const clients = actualsClients();
  const projects = e.client ? actualsProjectsFor(e.client) : [];
  const months = actualsData.months || [];
  const year = actualsData.year || 2026;
  let html = `
    <div class="a-wizard">
      <div class="a-pick-row">
        <label>Client
          <select id="aClient" class="cur-sel">
            <option value="">— Select client —</option>
            ${clients.map((c) => `<option value="${esc(c)}"${c === e.client ? " selected" : ""}>${esc(c)}</option>`).join("")}
          </select>
        </label>
        <label>Project
          <select id="aProject" class="cur-sel" ${e.client ? "" : "disabled"}>
            <option value="">— Select project —</option>
            ${projects.map((p) => `<option value="${esc(p)}"${p === e.project ? " selected" : ""}>${esc(p)}</option>`).join("")}
          </select>
        </label>
        <label>Month
          <select id="aMonth" class="cur-sel">
            ${months.map((m, i) => `<option value="${i}"${i === e.month ? " selected" : ""}>${esc(m.name)}</option>`).join("")}
          </select>
        </label>
        <label>Year <span class="a-year">${year}</span></label>
      </div>
      <div id="aTeam"></div>
    </div>`;
  $("#actualsModalBody").innerHTML = html;
  // wire pickers
  $("#aClient").addEventListener("change", (ev) => {
    actualsEntry.client = ev.target.value;
    actualsEntry.project = "";
    renderActualsModal();
  });
  $("#aProject").addEventListener("change", (ev) => {
    actualsEntry.project = ev.target.value;
    renderActualsModal();
  });
  $("#aMonth").addEventListener("change", (ev) => {
    actualsEntry.month = +ev.target.value;
    renderActualsModal();
  });
  if (e.client && e.project) renderActualsTeam();
}

function renderActualsTeam() {
  const e = actualsEntry;
  const resources = actualsResourcesFor(e.client, e.project);
  const months = actualsData.months || [];
  const m = months[e.month];
  if (!m) { $("#aTeam").innerHTML = `<div class="dim">No month data.</div>`; return; }
  const weekIdx = [];
  for (let i = m.start; i <= m.end; i++) weekIdx.push(i);
  const weekLabels = weekIdx.map((i) => actualsData.weeks[i] || `W${i + 1}`);
  let html = `<div class="a-team-head">${resources.length} resource(s) · ${esc(e.client)} / ${esc(e.project)} · ${esc(m.name)}</div>`;
  if (!resources.length) {
    html += `<div class="dim">No resources assigned to this project.</div>`;
    $("#aTeam").innerHTML = html;
    return;
  }
  html += `<table class="a-entry-table">
    <thead><tr><th>Resource</th><th>Title</th>${weekLabels.map((w) => `<th>${esc(w)}</th>`).join("")}<th>Total</th></tr></thead><tbody>`;
  for (const r of resources) {
    const planned = r.hours || [];
    const actual = r.actual_hours || [];
    const notes = r.actual_notes || {};
    let total = 0;
    html += `<tr data-rid="${r.id}">
      <td class="a-res-name">${esc(r.name)}</td>
      <td class="dim">${esc(r.role || "—")}</td>`;
    for (const i of weekIdx) {
      const p = planned[i] || 0;
      const a = actual[i] || 0;
      total += a;
      const n = notes[i] || {};
      const flag = (a > p && !n.is_ot) ? " ⚠" : (a > p && n.is_ot && !n.approved) ? " ⛔" : "";
      html += `<td class="a-week-cell" data-week="${i}" data-planned="${p}">
        <div class="a-planned">${p ? p + "h" : "—"}</div>
        <input class="inp a-inp" type="number" step="0.25" min="0" data-week="${i}" value="${a ? a : ""}" placeholder="0" inputmode="decimal" title="planned ${p}h${flag}">
      </td>`;
    }
    html += `<td class="a-total" data-total>${total ? total : "—"}</td></tr>`;
  }
  html += `</tbody></table>`;
  $("#aTeam").innerHTML = html;
  // live total + over/under highlight
  $$("#aTeam tr[data-rid]").forEach((tr) => {
    const rid = +tr.dataset.rid;
    $$("input[data-week]", tr).forEach((inp) => {
      inp.addEventListener("input", () => {
        const p = +inp.closest("td").dataset.planned;
        const a = num(inp.value) || 0;
        inp.classList.toggle("a-over", a > p);
        inp.classList.toggle("a-under", a < p);
        let t = 0;
        $$("input[data-week]", tr).forEach((x) => { t += num(x.value) || 0; });
        tr.querySelector("[data-total]").textContent = t ? t : "—";
      });
    });
  });
}

/* Save the popup: validate all entered weeks via the OT flow, then persist. */
async function saveActualsModal() {
  const e = actualsEntry;
  const resources = actualsResourcesFor(e.client, e.project);
  const months = actualsData.months || [];
  const m = months[e.month];
  if (!m) { toast("Select a month first", true); return; }
  const weekIdx = [];
  for (let i = m.start; i <= m.end; i++) weekIdx.push(i);
  let any = false;
  for (const r of resources) {
    const tr = $(`#aTeam tr[data-rid="${r.id}"]`);
    if (!tr) continue;
    const hours = [...(r.actual_hours || [])];
    const notes = { ...(r.actual_notes || {}) };
    let changed = false;
    for (const i of weekIdx) {
      const inp = $(`input[data-week="${i}"]`, tr);
      if (!inp) continue;
      const v = num(inp.value) || 0;
      if (v !== (r.actual_hours || [])[i]) {
        changed = true;
        // hours changed → clear that week's stored note so the OT flow
        // re-fires (a stale is_ot=0 would otherwise skip the prompt)
        delete notes[i];
      }
      hours[i] = v;
    }
    if (!changed) continue;
    any = true;
    try {
      const res = await api(`/api/resources/${r.id}/actuals`, { method: "PUT", body: JSON.stringify({ hours, notes }) });
      if (res.status === "needs_input") {
        // OT flow: prompt for each week needing input
        for (const w of res.weeks) {
          const ok = await actualsPrompt(r.id, w.week, hours);
          if (!ok) { toast("Actuals not saved — resolve the flagged weeks", true); return; }
        }
        const r2 = actualsData.resources.find((x) => x.id === r.id);
        const notes2 = r2 ? r2.actual_notes || {} : {};
        const res2 = await api(`/api/resources/${r.id}/actuals`, { method: "PUT", body: JSON.stringify({ hours, notes: notes2 }) });
        if (res2.status !== "ok") { toast("Actuals still need input", true); return; }
      }
    } catch (err) { toast(`Save failed: ${err.message}`, true); return; }
  }
  if (!any) { toast("No changes to save"); return; }
  toast("Actuals saved");
  closeActualsModal();
  await loadActuals();
  refreshDashboard();
}

/* Re-fetch the dashboard so Additional Revenue/Expense reflect the latest
   actuals — the dashboard is a separate endpoint and won't update on its own. */
function refreshDashboard() {
  if (state.view === "dash") renderDashboard();
}

$("#btnAddActuals").addEventListener("click", openActualsModal);
$("#actualsModalCancel").addEventListener("click", closeActualsModal);
$("#actualsModalSave").addEventListener("click", saveActualsModal);

/* ---------------- toolbar ---------------- */
$("#btnAdd").addEventListener("click", async () => {
  try {
    await api("/api/resources", { method: "POST", body: JSON.stringify({}) });
    await loadState();
    toast("Resource added — fill in client, project, name, title & hours");
  } catch (e) { toast(`Add failed: ${e.message}`, true); }
});
$("#btnEditGrid").addEventListener("click", () => {
  state.gridEdit[state.view] = !state.gridEdit[state.view];
  renderGrid();
});
$("#btnCollapseAll").addEventListener("click", () => {
  $$("#gridBody tr.group-row").forEach((g) => toggleGroupRows(g, true));
});
$("#btnExpandAll").addEventListener("click", () => {
  $$("#gridBody tr.group-row").forEach((g) => toggleGroupRows(g, false));
});
let filterT = null;
$("#filter").addEventListener("input", () => { clearTimeout(filterT); filterT = setTimeout(renderGrid, 250); });

/* ---------------- import / export ---------------- */
$("#btnImport").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const mode = $("#importMode")?.value || "merge";
  if (mode === "replace") {
    const ok = confirm(
      "⚠️ REPLACE ALL DATA\n\nEvery existing resource and hour will be DELETED and this file becomes the whole database. " +
      "Your Pricing (rate card) is kept. A backup of the current database is saved automatically before anything is deleted.\n\nContinue?"
    );
    if (!ok) { e.target.value = ""; return; }
  }
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", mode);
  const btn = $("#btnImport");
  btn.disabled = true; btn.textContent = "Importing…";
  try {
    const res = await fetch("/api/import", { method: "POST", body: fd });
    if (!res.ok) { let m = res.statusText; try { m = (await res.json()).detail || m; } catch (_) {} throw new Error(m); }
    const data = await res.json();
    await loadState();
    const warn = (data.warnings || []).length
      ? `\n\n⚠ ${data.warnings.length} row(s) without an Off-Shore rate (expense will be 0):\n${data.warnings.slice(0, 8).join("\n")}`
      : "";
    const pricingNote = data.pricing_added || data.pricing_updated
      ? `\nPricing sheet: ${data.pricing_added || 0} added, ${data.pricing_updated || 0} updated.`
      : "";
    const actualsNote = data.actuals_added
      ? `\nActuals sheet: ${data.actuals_added} resource(s) actual hours loaded.`
      : "";
    const replaceNote = data.mode === "replace"
      ? `\n\nReplaced all data — ${data.resources.length} resource(s) loaded from this file. Backup saved to ${data.backup}`
      : "";
    showModal("Import complete", `${data.added} added, ${data.updated} updated, ${data.renamed || 0} renamed from “${file.name}”.${pricingNote}${actualsNote}${replaceNote}${warn}`);
    toast(`Import ${data.mode === "replace" ? "(replace) " : ""}done`);
  } catch (err) { toast(`Import failed: ${err.message}`, true); }
  btn.disabled = false; btn.textContent = "Import Excel";
  e.target.value = "";
});

/* ---------------- tabs ---------------- */
async function switchView(view) {
  state.view = view;
  await flush();
  await pFlush();
  await aFlush();
  // toggle view visibility (renderView handles the rest)
  $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === view));
  const isGrid = view === "planned";
  $("#gridView").classList.toggle("hidden", !isGrid);
  $("#dashView").classList.toggle("hidden", view !== "dash");
  $("#pricingView").classList.toggle("hidden", view !== "pricing");
  $("#utilView").classList.toggle("hidden", view !== "util");
  $("#actualsView").classList.toggle("hidden", view !== "actuals");
  $("#btnAdd").style.display = isGrid ? "initial" : "none";
  if (view === "actuals") { loadActuals(); return; }
  await loadState();
}

function renderView() {
  $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === state.view));
  const isGrid = state.view === "planned";
  $("#gridView").classList.toggle("hidden", !isGrid);
  $("#dashView").classList.toggle("hidden", state.view !== "dash");
  $("#pricingView").classList.toggle("hidden", state.view !== "pricing");
  $("#utilView").classList.toggle("hidden", state.view !== "util");
  $("#actualsView").classList.toggle("hidden", state.view !== "actuals");
  $("#btnAdd").style.display = isGrid ? "initial" : "none";
  if (isGrid) renderGrid();
  else if (state.view === "dash") renderDashboard();
  else if (state.view === "util") renderUtilization();
  else if (state.view === "actuals") renderActuals();
  else renderPricing();
}

$$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.tab)));

/* ---------------- boot ---------------- */
window.addEventListener("error", (e) => {
  console.error("Revenue tracker error:", e.message, e.filename, e.lineno);
  toast(`App error: ${e.message} (${e.filename ? e.filename.split("/").pop() : ""}:${e.lineno || "?"})`, true);
});
boot();
setInterval(() => flush(), 3000);
setInterval(() => pFlush(), 3000);
setInterval(() => aFlush(), 3000);
