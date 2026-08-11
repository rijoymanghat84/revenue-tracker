/* ============ Revenue Tracker — frontend logic ============
   Four tabs:
   - Onsite   : Country, Client, Project, Resource Name, Title (dropdown),
                Rate, Total Hours, Total Revenue, then Month+Week columns.
                Master sheet — hours entered here.
   - Offshore : same columns, but the rate shown is your OFFSHORE (cost) rate.
                Hours mirror Onsite; pick a Title to auto-fill the cost rate.
   - Dashboard: Country, Client, Resource(s), Revenue, Expense, Difference, Cur.
   - Pricing  : Title library — Title / Rate / Offshore Rate. Titles drive the
                dropdowns; selecting one auto-fills the rate on the active side.
*/
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = { resources: [], weeks: [], months: [], pricing: [], view: "dash", gridEdit: { onsite: false, offshore: false } };
const dirty = new Map();   // resource rid -> {fields:{}, hours:bool}
const pDirty = new Map();  // pricing pid -> {title?, rate?, offshore_rate?}
let flushTimer = null, pFlushTimer = null;

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

/* ---------------- data load ---------------- */
async function loadState() {
  const s = await api("/api/state");
  Object.assign(state, s);
  renderView();
}

const MODES = {
  onsite: {
    rateField: "rate",
    rateLabel: "Rate",
    hoursEditable: true,
    metaEditable: true,
    note: "What you CHARGE — enter hours & the rate. Pick a Title from Pricing to auto-fill its rate.",
    dot: "on",
  },
  offshore: {
    rateField: "offshore_rate",
    rateLabel: "Offshore Rate",
    hoursEditable: false,
    metaEditable: false,
    note: "What it COSTS — hours mirror Onsite automatically. Pick a Title to auto-fill its cost rate.",
    dot: "off",
  },
};

/* ---------------- combined grid ----------------
   Column order (per spec): Country, Client, Project, Name, Title, Rate,
   Total Hours, Total Revenue, then Month + Week columns. The first 8 columns
   are sticky-left (never move when scrolling right); weeks scroll. */
const N_META = 5;          // Country..Title fields under the group label
const N_LOCKED = 8;        // sticky-left: Country, Client, Project, Name, Title, Rate, TH, TR
const WEEKS_START = 8;     // cell index where weeks begin (0-based children)

function gridHeadHTML() {
  const weeks = state.weeks, months = state.months, mode = MODES[state.view];
  const colHeads = [["Country", "sc1"], ["Client", "sc2"], ["Project", "sc3"], ["Resource Name", "sc4"],
                    ["Title", "sc5"], [esc(mode.rateLabel), "sc6"], ["Total Hours", "sc7"], ["Total Revenue", "sc8"]];
  const headCells = colHeads.map(([h, sc]) =>
    `<th class="sticky-h ${sc} colh">${h}</th>`).join("");
  const headBlank = (n) => (n > 0 ? "<th></th>".repeat(n) : "");
  // month/week rows pin the SAME frozen block (Country..TR = sc1..sc8) so the
  // whole 3-row header stays one solid unit while the month/week labels scroll.
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

/** Deterministic column widths via <colgroup> — no phantom gaps, even columns. */
function colgroupHTML() {
  const metaW = [70, 150, 140, 160, 160, 90, 90, 110];
  let s = "<colgroup>";
  metaW.forEach((w) => { s += `<col style="width:${w}px">`; });
  for (let i = 0; i < state.weeks.length; i++) s += '<col style="width:54px">';
  s += '<col style="width:40px">';
  return s + "</colgroup>";
}

function titleSelectHTML(r) {
  const opts = new Map();
  for (const p of state.pricing) opts.set(p.title, p);
  if (r.role && !opts.has(r.role)) opts.set(r.role, null); // keep custom titles selectable
  let html = `<select class="inp sel" data-field="role">`;
  html += `<option value="">—</option>`;
  for (const title of opts.keys()) {
    const sel = title === r.role ? " selected" : "";
    html += `<option value="${esc(title)}"${sel}>${esc(title)}</option>`;
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

function effByField(r, field) {
  return field === "offshore_rate" ? effOffshore(r) : effRate(r);
}

/** per-view edit state: the Edit/Done toggle is the single source of truth.
    Onsite defaults unlocked (the entry surface); Offshore defaults locked.
    Locked = fully read-only; unlocked = everything editable. */
function gridEditState() {
  const unlocked = !!state.gridEdit[state.view];
  return { meta: unlocked, hours: unlocked, rates: unlocked };
}

function gridRowHTML(r) {
  const es = gridEditState();
  const mode = MODES[state.view];
  const hours = r.hours || Array(state.weeks.length).fill(0);
  const rate = r[mode.rateField];
  const total = hours.reduce((a, b) => a + b, 0);
  const rev = (rate || 0) * total;
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
  const rateVal = effByField(r, mode.rateField);
  const rateCell = es.meta
    ? `${cur}<input class="inp num" type="number" min="0" step="any" data-field="${mode.rateField}" value="${rateVal ?? ""}" placeholder="—" title="${mode.rateLabel} (auto-fills from Title)">`
    : `<span class="mirror-val">${cur}${rateVal !== null && rateVal !== undefined ? fmt(rateVal) : "—"}</span>`;
  return `<tr class="resource-row" data-rid="${r.id}">
    <td class="sticky-l sc1 meta-col">${metaCell(r, "country", es.meta)}</td>
    <td class="sticky-l sc2 meta-col">${metaCell(r, "client", es.meta)}</td>
    <td class="sticky-l sc3 meta-col">${metaCell(r, "project", es.meta)}</td>
    <td class="sticky-l sc4 meta-col">${metaCell(r, "name", es.meta)}</td>
    <td class="sticky-l sc5 meta-col">${titleCell}</td>
    <td class="sticky-l sc6 meta-col num-cell">${rateCell}</td>
    <td class="sticky-l sc7 calc dim" data-calc="total_hrs">${fmt(total, 1)}</td>
    <td class="sticky-l sc8 calc" data-calc="total_rev">${fmt(rev)}</td>
    ${weekCells}
    <td>${delBtn}</td>
  </tr>`;
}

/**
 * Pin each sticky column to its NATURAL layout position. Must run whenever
 * column widths can change (initial render AND group collapse/expand — hidden
 * rows stop contributing width, so offsets go stale). Measures with any stale
 * inline offsets cleared, at scrollLeft 0.
 */
function alignSticky() {
  const wrap = document.querySelector("#gridWrap");
  const table = document.querySelector("#gridTable");
  const probe = document.querySelector("#gridBody tr.resource-row");
  if (!wrap || !table || !probe) return;
  const prev = wrap.scrollLeft;
  wrap.scrollLeft = 0;
  // Measure NATURAL positions: temporarily drop position:sticky too, because
  // Chromium renders sticky cells at their `left` offset even at rest — so a
  // cleared inline left exposes the CSS fallback and poisons the measurement.
  const els = document.querySelectorAll("#gridHead [class*=sc], #gridBody [class*=sc]");
  els.forEach((el) => { el.style.left = ""; el.style.position = "static"; });
  const tLeft = table.getBoundingClientRect().left;
  const xs = [];
  for (let i = 1; i <= N_LOCKED; i++) {
    const cell = probe.children[i - 1];  // children[0]=Country(sc1) .. children[7]=Total Revenue(sc8)
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
    let hrs = 0, rev = 0;
    for (const m of g.members) {
      const total = (m.hours || []).reduce((a, b) => a + b, 0);
      hrs += total; rev += (m[mode.rateField] || 0) * total;
    }
    html += `<tr class="group-row" data-group="${gi}" title="Expand / collapse">
      <td class="sticky-l sc1" colspan="${N_META + 1}"><span class="group-chevron">▼</span>${esc(g.client || "—")}${g.project ? ` · ${esc(g.project)}` : ""}<span class="proj-count-chip">${g.members.length} resource(s)</span></td>
      <td class="sticky-l sc7 calc dim" data-calc="total_hrs">${fmt(hrs, 1)}</td>
      <td class="sticky-l sc8 calc" data-calc="total_rev">${fmt(rev)}</td>
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
  const mode = MODES[state.view];
  const rate = num($(`input[data-field="${mode.rateField}"]`, tr)?.value) ?? 0;
  let total = 0;
  $$(`input[data-week]`, tr).forEach((i) => { total += num(i.value) || 0; });
  const rev = rate * total;
  tr.querySelector('[data-calc="total_hrs"]').textContent = fmt(total, 1);
  tr.querySelector('[data-calc="total_rev"]').textContent = fmt(rev);
  return { total, rev };
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
  const mode = MODES[state.view];
  const tbody = $("#gridBody");
  const gr = tbody.querySelector(`tr.group-row[data-group="${gidx}"]`);
  const sr = tbody.querySelector(`tr.subtotal-row[data-group="${gidx}"]`);
  if (!gr) return;
  const rows = Array.from(tbody.children);
  const start = rows.indexOf(gr);
  let hrs = 0, rev = 0;
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.classList.contains("group-row")) break;
    if (!row.classList.contains("resource-row")) continue;
    const rate = num($(`input[data-field="${mode.rateField}"]`, row)?.value) ?? 0;
    let total = 0;
    $$(`input[data-week]`, row).forEach((i) => { total += num(i.value) || 0; });
    hrs += total; rev += rate * total;
  }
  for (const el of [gr, sr]) {
    if (!el) continue;
    const hEl = el.querySelector('[data-calc="total_hrs"]');
    const rEl = el.querySelector('[data-calc="total_rev"]');
    if (hEl) hEl.textContent = fmt(hrs, 1);
    if (rEl) rEl.textContent = fmt(rev);
  }
}
function weeksCount() { return state.weeks.length; }

/* ---------------- title auto-fill (BOTH sides come from Pricing) ---------------- */
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
  // Always persist BOTH rates from Pricing, even when only one side's input is
  // visible on this grid (the other side still needs to be filled).
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
    await loadState(); // refresh used_by + titles after possible rename cascade
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

/* Paste: Excel-style. cellIndex 0-4 meta, 5 rate, 6-7 totals (skip), 9.. weeks. */
$("#gridBody").addEventListener("paste", (e) => {
  const inp = e.target.closest("input");
  if (!inp || !inp.closest("tr[data-rid]")) return;
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  if (!text.includes("\t") && !text.includes("\n")) return;
  e.preventDefault();
  const mode = MODES[state.view];
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
        // meta columns 0..4
        const f = META[col];
        if (f && es.meta) {
          const mi = $(`input[data-field="${f}"]`, rowEl);
          if (mi) { mi.value = val; markDirty(rid, "fields", f, val); }
        }
      } else if (col === N_META) {
        // rate column (5)
        const ri = $(`input[data-field="${mode.rateField}"]`, rowEl);
        if (ri) { ri.value = val; markDirty(rid, "fields", mode.rateField, num(val) ?? null); }
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

/**
 * Toggle a project group; hide/show its resource rows (rows between this
 * group row and the next group row).
 */
function toggleGroupRows(gr, force) {
  const collapsed = force !== undefined ? force : !gr.classList.contains("collapsed");
  gr.classList.toggle("collapsed", collapsed);
  let nxt = gr.nextElementSibling;
  while (nxt && !nxt.classList.contains("group-row")) {
    if (nxt.classList.contains("resource-row")) nxt.classList.toggle("collapsed", collapsed);
    nxt = nxt.nextElementSibling;
  }
  // hidden resource rows change the table's column widths → re-align sticky
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

/* ---------------- pricing tab (read-only + edit mode) ---------------- */
let editingPid = null; // pid being edited, or -1 for a brand-new row

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
  editingPid = -1;               // render a fresh editable row; saved on Save
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
    let head = `<tr><th>Resource</th><th>Projects</th>${months.map((m) => `<th class="num">${esc(m)}</th>`).join("")}<th class="num">Overall</th></tr>`;
    let rows = "";
    for (const row of data.rows) {
      rows += `<tr>
        <td class="u-name">${esc(row.name)}</td>
        <td class="u-proj">${esc(row.projects.join(", ") || "—")}</td>`;
      for (const mo of row.months) {
        const cls = utilClass(mo.utilization);
        rows += `<td class="u-cell ${cls}" title="${mo.hours.toLocaleString()}h / ${mo.capacity}h">${fmt(mo.utilization, 0)}%</td>`;
      }
      const oc = utilClass(row.overall);
      rows += `<td class="u-cell ${oc}" title="${row.total_hours.toLocaleString()}h total">${fmt(row.overall, 0)}%</td></tr>`;
    }
    $("#utilHead").innerHTML = head;
    $("#utilBody").innerHTML = rows;
  }).catch((e) => toast(`Utilization failed: ${e.message}`, true));
}

/* ---------------- dashboard ---------------- */
function renderDashboard() {
  api("/api/dashboard").then((data) => {
    const groups = data.rows.groups, totals = data.rows.totals;
    let totalRev = 0, totalExp = 0;
    totals.forEach((t) => { totalRev += t.revenue; totalExp += t.expense; });
    const profit = totalRev - totalExp;
    $("#dashCards").innerHTML = `
      <div class="card glass"><div class="k">Total Revenue (Onsite)</div><div class="v cyan">$${fmt(totalRev)}</div></div>
      <div class="card glass"><div class="k">Total Expense (Offshore)</div><div class="v">$${fmt(totalExp)}</div></div>
      <div class="card glass"><div class="k">Profit</div><div class="v ${profit >= 0 ? "green" : "red"}">$${fmt(profit)}</div></div>
      <div class="card glass"><div class="k">By currency</div>
        <div class="v" style="font-size:14px;line-height:1.5">${(totals.length ? totals : []).map((t) => `TOTAL ${t.currency}: $${fmt(t.revenue)}`).join("<br>") || "—"}</div></div>`;
    let rows = `<thead><tr><th>Country</th><th>Client</th><th>Project</th><th>Resource(s)</th><th>Revenue (Onsite)</th><th>Expense (Offshore)</th><th>Difference</th><th>Cur</th></tr></thead><tbody>`;
    const maxDiff = Math.max(...groups.map((g) => Math.abs(g.difference)), 1);
    for (const g of groups) {
      const pct = Math.min(100, Math.max(4, (Math.abs(g.difference) / maxDiff) * 100));
      const bar = `<span class="diffbar ${g.difference >= 0 ? "pos" : "neg"}" style="width:${pct}%"></span>`;
      rows += `<tr>
        <td>${esc(g.country)}</td><td>${esc(g.client)}</td><td>${esc(g.project)}</td><td>${g.resources}</td>
        <td>$${fmt(g.revenue)}</td><td>$${fmt(g.expense)}</td>
        <td style="color:${g.difference >= 0 ? "var(--green)" : "var(--red)"}">$${fmt(g.difference)} ${bar}</td>
        <td><span class="cur-chip">${g.currency}</span></td></tr>`;
    }
    for (const t of totals) {
      rows += `<tr class="total-row">
        <td>TOTAL ${t.currency}</td><td>—</td><td>—</td><td>—</td>
        <td>$${fmt(t.revenue)}</td><td>$${fmt(t.expense)}</td>
        <td style="color:${t.difference >= 0 ? "var(--green)" : "var(--red)"}">$${fmt(t.difference)}</td>
        <td><span class="cur-chip">${t.currency}</span></td></tr>`;
    }
    rows += "</tbody>";
    $("#dashTable").innerHTML = rows;
  }).catch((e) => toast(`Dashboard failed: ${e.message}`, true));
}

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
    const replaceNote = data.mode === "replace"
      ? `\n\nReplaced all data — ${data.resources.length} resource(s) loaded from this file. Backup saved to ${data.backup}`
      : "";
    showModal("Import complete", `${data.added} added, ${data.updated} updated, ${data.renamed || 0} renamed from “${file.name}”.${pricingNote}${replaceNote}${warn}`);
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
  await loadState();
}

function renderView() {
  $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === state.view));
  const isGrid = state.view === "onsite" || state.view === "offshore";
  $("#gridView").classList.toggle("hidden", !isGrid);
  $("#dashView").classList.toggle("hidden", state.view !== "dash");
  $("#pricingView").classList.toggle("hidden", state.view !== "pricing");
  $("#utilView").classList.toggle("hidden", state.view !== "util");
  $("#btnAdd").style.display = isGrid ? "initial" : "none";
  if (isGrid) renderGrid();
  else if (state.view === "dash") renderDashboard();
  else if (state.view === "util") renderUtilization();
  else renderPricing();
}

$$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.tab)));

/* ---------------- boot ---------------- */
/* Surface any runtime error on-screen instead of silently blanking a section,
   so stale-cache / browser issues are self-diagnosing. */
window.addEventListener("error", (e) => {
  console.error("Revenue tracker error:", e.message, e.filename, e.lineno);
  toast(`App error: ${e.message} (${e.filename ? e.filename.split("/").pop() : ""}:${e.lineno || "?"})`, true);
});
async function boot() {
  try { await loadState(); } catch (e) { toast(`Load failed: ${e.message}`, true); }
}
boot();
setInterval(() => flush(), 3000);
setInterval(() => pFlush(), 3000);