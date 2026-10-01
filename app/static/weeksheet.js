/* ============================================================================
   WEEK SHEET — week-centric actuals entry (2026-10-01)
   ----------------------------------------------------------------------------
   Rijoy's requirement: "on a weekly basis they should be able to update the
   hours each employee has contributed to their projects and if they had under
   contributed then a reason why and also we have to calculate if we will get
   that hours billed to client or not ... if an employee is doing OT then we have
   to know if we will be billing that to client or not".

   The 53-week grid is a REVIEW surface (scan the year); entering one week in it
   meant scrolling a year-wide table. This is the ENTRY surface: pick the week,
   all the PM's people in one list, type down the column, one save.

   Money rules applied per row (all server-validated — this is the UI's view):
     actual < planned  -> reason required + "will we still bill planned?" yes/no
     actual > planned  -> OT flow (is it OT / approved / billed)
   The PM never sees rates or dollars; the billing answers decide Rijoy's side.
   ========================================================================== */

let WK = {
  loaded: false,
  inited: false,       // has the week been defaulted from `current` yet?
  week: 0,             // week index
  rows: [],            // {rid, name, title, client, project, planned, hours, note}
  dirty: false,
};

/* Both read from the PAYLOAD the sheet loads, not `state` — state comes from
   /api/state (admin-only) and is empty for a PM, which made the header read
   "Week week 1". */
function wkWeeks() {
  return ((WK.data && WK.data.weeks) || state.weeks || []);
}
function wkMonths() {
  return ((WK.data && WK.data.months) || state.months || []);
}
function wkWeekLabel(i) {
  return wkWeeks()[i] || `week ${i + 1}`;
}
function wkMonthOf(i) {
  const m = wkMonths().find((x) => x.start <= i && i <= x.end);
  return m ? m.name : "";
}

async function loadWeekSheet() {
  // Reuse /api/actuals: it is already PM-scoped (only their projects, no rates),
  // so the sheet cannot show a person the PM does not own.
  const d = await api("/api/actuals");
  WK.loaded = true;
  WK.data = d;
  // Default to the week we are ACTUALLY in — the one a PM is entering. Read it
  // from THIS payload first: `state.current` comes from /api/state which is
  // ADMIN-only, so it is undefined for a PM. Guarded by an explicit flag, NOT by
  // `!WK.week`, because week 0 is a legitimate week and that test never fired.
  WK.current = d.current || state.current || {};
  if (!WK.inited) {
    WK.inited = true;
    const c = WK.current;
    WK.week = (c.week_index === undefined || c.week_index === null) ? 0 : c.week_index;
  }
  buildWeekPicker();
  renderWeekSheet();
}

function buildWeekPicker() {
  const sel = $("#wkSelect");
  if (!sel) return;
  const weeks = wkWeeks();
  const cur = (WK.current && WK.current.week_index);
  sel.innerHTML = weeks.map((w, i) => {
    const mon = wkMonthOf(i);
    const now = (cur === i) ? "  ← current" : "";
    return `<option value="${i}" ${i === WK.week ? "selected" : ""}>${esc(w)}${mon ? " · " + esc(mon) : ""}${now}</option>`;
  }).join("");
}

function weekRows() {
  const d = WK.data || {};
  const w = WK.week;
  return (d.resources || []).map((r) => {
    const planned = (r.hours || [])[w] || 0;
    return {
      rid: r.id, name: r.name, title: r.role, client: r.client, project: r.project,
      planned,
      hours: (r.actual_hours || [])[w] || 0,
      note: (r.actual_notes || {})[w] || {},
      capacity: r.capacity,
      touched: false,   // did the PM type in this row this session?
    };
  })
    // A person with no planned hours this week is not on the sheet's critical
    // path, but a PM may still have worked them — keep them, sorted last, so
    // "everyone on my projects" is genuinely complete.
    .sort((a, b) => (b.planned - a.planned) || String(a.name).localeCompare(b.name));
}

function renderWeekSheet() {
  const head = $("#wkHead"), body = $("#wkBody");
  if (!head || !body) return;
  const w = WK.week;
  const label = wkWeekLabel(w), mon = wkMonthOf(w);
  const cur = (WK.current && WK.current.week_index);
  const isNow = cur === w;
  $("#wkNote").innerHTML = `<span class="dot ${isNow ? "on" : "off"}"></span>
    Week <b>${esc(label)}</b>${mon ? ` · ${esc(mon)}` : ""}${isNow ? " — the week we are in" : ""}.
    Type actual hours; one save records the whole week.`;

  WK.rows = weekRows();
  const withPlan = WK.rows.filter((r) => r.planned > 0);
  const entered = withPlan.filter((r) => r.hours > 0);
  const under = withPlan.filter((r) => r.hours > 0 && r.hours < r.planned);
  const over = withPlan.filter((r) => r.hours > r.planned);
  const missing = withPlan.filter((r) => !r.hours);
  $("#wkSummary").innerHTML = `
    <div class="wk-kpi"><span class="muted-note">On my projects</span><b>${withPlan.length}</b></div>
    <div class="wk-kpi"><span class="muted-note">Entered</span><b>${entered.length}</b></div>
    <div class="wk-kpi ${missing.length ? "bad" : ""}"><span class="muted-note">Not entered</span><b>${missing.length}</b></div>
    <div class="wk-kpi ${under.length ? "warn" : ""}"><span class="muted-note">Under</span><b>${under.length}</b></div>
    <div class="wk-kpi ${over.length ? "bad" : ""}"><span class="muted-note">Over</span><b>${over.length}</b></div>`;

  head.innerHTML = `<tr>
    <th>Person</th><th>Title</th><th>Client · Project</th>
    <th class="num">Planned</th><th class="num">Actual</th><th class="num">Δ</th>
    <th>Status</th><th>Detail</th>
  </tr>`;

  if (!WK.rows.length) {
    body.innerHTML = `<tr><td colspan="8"><div class="wb-empty">No people on your projects.</div></td></tr>`;
    return;
  }
  body.innerHTML = WK.rows.map((r) => {
    const d = r.hours - r.planned;
    const st = wkStatus(r, d);
    return `<tr data-rid="${r.rid}" class="${r.planned ? "" : "wk-offplan"}">
      <td><b>${esc(r.name)}</b></td>
      <td>${esc(r.title || "—")}</td>
      <td>${esc(r.client || "—")} <span class="muted-note">· ${esc(r.project || "—")}</span></td>
      <td class="num">${r.planned ? fmtH(r.planned) : "—"}</td>
      <td class="num"><input class="wk-inp" type="number" min="0" step="0.5"
          data-rid="${r.rid}" value="${r.hours || ""}" placeholder="${r.planned ? "" : "0"}"
          ${r.planned ? "" : 'title="No planned hours this week"' }></td>
      <td class="num wk-delta ${d > 0 ? "over" : d < 0 ? "under" : ""}">${r.hours || r.planned ? (d > 0 ? "+" : "") + fmtH(d) : "—"}</td>
      <td>${st}</td>
      <td class="wk-detail">${wkDetailCell(r)}</td>
    </tr>`;
  }).join("");

  $$("#wkBody .wk-inp").forEach((inp) => {
    inp.addEventListener("input", () => {
      const rid = +inp.dataset.rid;
      const row = WK.rows.find((x) => x.rid === rid);
      if (!row) return;
      row.hours = num(inp.value) || 0;
      // Only rows the PM TOUCHED are written. Without this, a planned row with
      // no entry looked like "under by 40h" and the sheet asked a billing
      // question for someone whose hours had simply not been entered yet.
      row.touched = true;
      WK.dirty = true;
      $("#wkSave").disabled = false;
      // Re-render only the derived cells for THIS row — a full re-render would
      // blow away focus and the half-typed value.
      const tr = inp.closest("tr");
      const d = row.hours - row.planned;
      const dc = tr.querySelector(".wk-delta");
      dc.textContent = (row.hours || row.planned) ? ((d > 0 ? "+" : "") + fmtH(d)) : "—";
      dc.className = "num wk-delta " + (d > 0 ? "over" : d < 0 ? "under" : "");
      tr.querySelector("td:nth-child(7)").innerHTML = wkStatus(row, d);
      tr.querySelector(".wk-detail").innerHTML = wkDetailCell(row);
    });
  });
  $("#wkSave").disabled = true;
}

/* The row's verdict, including the OT / billing answer once it is recorded. */
function wkStatus(r, d) {
  if (!r.planned) return `<span class="pill wb-pill-free">no plan</span>`;
  if (!r.hours) return `<span class="pill wk-pill-none">not entered</span>`;
  const n = r.note || {};
  if (d === 0) return `<span class="pill wb-pill-ok">on target</span>`;
  if (d < 0) {
    const ub = n.under_billed;
    if (ub === 0) return `<span class="pill wb-pill-ok">under · billed in full</span>`;
    if (ub === 1) return `<span class="pill wb-pill-over">under · revenue lost</span>`;
    return `<span class="pill wb-pill-warn">under · needs billing answer</span>`;
  }
  // overage
  if (n.is_ot === 0) return `<span class="pill wb-pill-warn">over (not OT)</span>`;
  if (!n.is_ot) return `<span class="pill wb-pill-warn">over · needs OT answer</span>`;
  if (n.approved && n.billed) {
    return n.ot_billable_approved === false
      ? `<span class="pill wb-pill-over">billable OT · awaiting Rijoy</span>`
      : `<span class="pill wb-pill-ok">billable OT</span>`;
  }
  if (n.approved && !n.billed) return `<span class="pill wb-pill-warn">OT unbilled</span>`;
  return `<span class="pill wb-pill-warn">OT pending approval</span>`;
}

/* What the row still needs, spelled out so the PM knows what the save will ask. */
function wkDetailCell(r) {
  const d = r.hours - r.planned;
  const n = r.note || {};
  if (!r.planned) return `<span class="muted-note">not assigned this week</span>`;
  if (!r.hours) return `<span class="muted-note">enter hours to record</span>`;
  if (d < 0) {
    if (n.under_billed === 0 || n.under_billed === 1) {
      return `<span class="muted-note">${esc(n.comment || "")}</span>`;
    }
    return `<span class="muted-note">will ask: reason + does the client still pay?</span>`;
  }
  if (d > 0) {
    if (n.is_ot === 0) return `<span class="muted-note">${esc(n.comment || "recorded as an overage, not OT")}</span>`;
    if (n.is_ot && (n.billed === undefined || n.billed === null)) return `<span class="muted-note">will ask: billed to the client?</span>`;
    if (n.is_ot && n.approved && !n.billed) return `<span class="muted-note">${esc(n.reason || n.comment || "")}</span>`;
    if (n.is_ot && n.billed && !n.approved) return `<span class="muted-note">billable OT — waiting on Rijoy's approval</span>`;
    return `<span class="muted-note">will ask: OT? and billed to client?</span>`;
  }
  return `<span class="muted-note">—</span>`;
}

/* ---------------- save: one request for the whole week ---------------- */
/* Ask the questions the row PROMISES to ask before the server sees the write.
   The under-delivery billing decision is optional server-side (requiring it once
   made every under-delivery unsavable from the 53-week grid), so the sheet must
   ask it itself — otherwise the row says "will ask: reason + does the client
   still pay?" and no billing question ever appears. */
async function wkPreFlight(row, notes) {
  const d = (row.hours || 0) - (row.planned || 0);
  const w0 = WK.week;
  const note0 = notes[w0] || {};

  /* ---- OVERAGE: ask is-it-OT, then billed-to-client ---- */
  if (d > 0) {
    if (note0.is_ot === undefined || note0.is_ot === null) {
      const a = await askOt(
        `${esc(row.name)} — ${wkWeekLabel(w0)}<br>Planned <b>${row.planned}h</b>, actual <b>${row.hours}h</b> (+${d}h).<br><br>Is this OVERTIME?`,
        { title: "Overtime review" });
      if (a === "cancel") return false;
      note0.is_ot = (a === "yes") ? 1 : 0;
      notes[w0] = note0;
    }
    if (!note0.is_ot) return true;               // declined OT: nothing else to ask
    if (note0.billed === undefined || note0.billed === null) {
      const b = await askOt(
        `${esc(row.name)} — ${wkWeekLabel(w0)}<br>OT of <b>${d}h</b>.<br><br>Will this OT be BILLED to the client?`,
        { title: "Billing", yesLabel: "Yes — bill the client", noLabel: "No — not billable" });
      if (b === "cancel") return false;
      note0.billed = (b === "yes") ? 1 : 0;
      notes[w0] = note0;
    }
    if (!note0.billed) {                         // unbilled needs a reason
      const why = await askOt(
        `${esc(row.name)} — ${wkWeekLabel(w0)}<br>OT of <b>${d}h</b> not billed.<br><br>Why not billed to the client? (required)`,
        { title: "Unbilled OT", input: true, inputPlaceholder: "Reason not billed", buttons: false, allowCancel: true });
      if (why === null || why === "cancel") return false;
      if (!String(why).trim()) { toast("A reason is required for unbilled OT", true); return false; }
      // Persist in BOTH fields: the server accepts either, and the unbilled
      // report reads one or the other.
      note0.reason = String(why).trim();
      note0.comment = String(why).trim();
      notes[w0] = note0;
    }
    return true;
  }

  /* ---- UNDER-DELIVERY: reason, then does the client still pay ---- */
  const note = note0;
  const w = w0;
  // Reason first — the row promised "reason + does the client still pay?".
  if (!String(note.comment || "").trim()) {
    const why = await askOt(
      `${esc(row.name)} — ${wkWeekLabel(w)}<br>Planned <b>${row.planned}h</b>, actual <b>${row.hours}h</b> (${Math.abs(d)}h under).<br><br>Why the shortfall? (required)`,
      { title: "Under-delivery — reason", input: true, inputPlaceholder: "Reason for shortfall", buttons: false, allowCancel: true });
    if (why === null || why === "cancel") return false;
    if (!String(why).trim()) { toast("A reason is required for under-delivery", true); return false; }
    note.comment = String(why).trim();
    notes[w] = note;
  }
  if (note.under_billed === 0 || note.under_billed === 1) return true;  // already answered
  const ans = await askOt(
    `${esc(row.name)} — ${wkWeekLabel(WK.week)}<br>${Math.abs(d)}h under plan.<br><br>Will the client still be billed the <b>planned</b> hours?`,
    { title: "Under-delivery — billing", yesLabel: "Yes — billed in full", noLabel: "No — revenue drops" });
  if (ans === "cancel") return false;
  note.under_billed = (ans === "yes") ? 0 : 1;
  if (note.under_billed === 1) {
    const why = await askOt(
      `${esc(row.name)} — ${wkWeekLabel(WK.week)}<br>Marked <b>not billed</b> — the shortfall becomes lost revenue.<br><br>Note (optional).`,
      { title: "Not billed", input: true, inputPlaceholder: "Optional note", buttons: false, allowCancel: true });
    if (why === "cancel") return false;
    if (String(why || "").trim()) note.comment = String(why).trim();
  }
  notes[WK.week] = note;
  return true;
}

async function saveWeekSheet() {
  const btn = $("#wkSave");
  btn.disabled = true;
  let saved = 0, failed = 0;
  // Only rows the PM entered. An untouched row keeps whatever it already had.
  const targets = WK.rows.filter((r) => r.touched);
  if (!targets.length) { toast("Nothing changed — enter some hours first", true); btn.disabled = !WK.dirty; return; }
  for (const r of targets) {
    const full = ((WK.data.resources.find((x) => x.id === r.rid) || {}).actual_hours || []).slice();
    while (full.length < (WK.data.weeks || []).length) full.push(0);
    full[WK.week] = r.hours || 0;
    const notes = {};
    Object.assign(notes, (WK.data.resources.find((x) => x.id === r.rid) || {}).actual_notes || {});
    // Ask the money question the row promises BEFORE writing.
    if (!(await wkPreFlight(r, notes))) { failed++; continue; }
    // Ask -> write -> ask again, until the server accepts. The OT flow is a
    // CHAIN (is this OT? -> approved? -> billed? -> why not billed?), and each
    // answer unlocks the next question, so a single retry is not enough.
    try {
      let res = await api(`/api/resources/${r.rid}/actuals`, {
        method: "PUT", body: JSON.stringify({ hours: full, notes }),
      });
      let rounds = 0;
      while (res.status === "needs_input" && rounds < 8) {
        rounds++;
        const ok = await wkResolve(r, res.weeks, full, notes);
        if (!ok) break;
        res = await api(`/api/resources/${r.rid}/actuals`, {
          method: "PUT", body: JSON.stringify({ hours: full, notes }),
        });
      }
      if (res.status !== "ok") {
        failed++;
        toast(`${r.name}: still needs input — week not saved`, true);
        continue;
      }
    } catch (e) { failed++; toast(`${r.name}: ${e.message}`, true); continue; }
    saved++;
  }
  WK.dirty = false;
  toast(failed ? `Saved ${saved}, ${failed} still need attention` : `Week saved — ${saved} ${saved === 1 ? "person" : "people"}`, !!failed);
  await loadActuals().catch(() => {});
  await loadWeekSheet();
  btn.disabled = !WK.dirty;
}

/* Answer the server's per-week questions for ONE person, then retry. */
async function wkResolve(row, needs, hours, notes) {
  for (const need of needs) {
    const w = need.week;
    const note = notes[w] || {};
    const planned = (WK.data.resources.find((x) => x.id === row.rid) || {}).hours?.[w] || 0;
    const actual = hours[w] || 0;
    const ov = actual - planned;
    const lbl = wkWeekLabel(w);
    const who = esc(row.name);

    if (need.status === "needs_comment") {
      const reason = await askOt(
        `${who} — ${lbl}<br>Planned <b>${planned}h</b>, actual <b>${actual}h</b> (${ov}h under).<br><br>Why the shortfall? (required)`,
        { title: "Under-delivery — reason", input: true, inputPlaceholder: "Reason for shortfall", buttons: false, allowCancel: true });
      if (reason === null || reason === "cancel") return false;
      if (!String(reason).trim()) { toast("A reason is required for under-delivery", true); return false; }
      note.comment = String(reason).trim();
      notes[w] = note;
      continue;
    }

    if (need.status === "needs_under_billing") {
      // Rijoy's rule: does the client still pay the planned hours, or is the
      // shortfall a real revenue loss?
      const ans = await askOt(
        `${who} — ${lbl}<br>${Math.abs(ov)}h under plan.<br><br>Will the client still be billed the <b>planned</b> hours?`,
        { title: "Under-delivery — billing", yesLabel: "Yes — billed in full", noLabel: "No — revenue drops" });
      if (ans === "cancel") return false;
      note.under_billed = (ans === "yes") ? 0 : 1;
      if (note.under_billed === 1) {
        const why = await askOt(
          `${who} — ${lbl}<br>Marked as <b>not billed</b> — the shortfall becomes lost revenue.<br><br>Note (optional).`,
          { title: "Not billed", input: true, inputPlaceholder: "Optional note", buttons: false, allowCancel: true });
        if (why === "cancel") return false;
        if (String(why || "").trim()) note.comment = String(why).trim();
      }
      notes[w] = note;
      continue;
    }

    if (need.status === "needs_ot") {
      const a = await askOt(
        `${who} — ${lbl}<br>Planned <b>${planned}h</b>, actual <b>${actual}h</b> (+${ov}h).<br><br>Is this OVERTIME?`,
        { title: "Overtime review" });
      if (a === "cancel") return false;
      note.is_ot = (a === "yes") ? 1 : 0;
      notes[w] = note;
      continue;
    }

    if (need.status === "needs_approval") {
      const a = await askOt(
        `${who} — ${lbl}<br>OT of <b>${ov}h</b>.<br><br>Is this OT approved?`,
        { title: "OT approval" });
      if (a === "cancel") return false;
      if (a !== "yes") {
        const dec = await askOt(
          `${who} — ${lbl}<br>Unapproved OT cannot be saved.<br><br>Decline this as NOT overtime?`,
          { title: "Unapproved OT", buttons: false });
        if (dec === "cancel") return false;
        if (dec === "yes") { note.is_ot = 0; note.approved = 0; note.billed = 0; notes[w] = note; continue; }
        return false;
      }
      note.approved = 1;
      notes[w] = note;
      continue;
    }

    if (need.status === "needs_billing_reason") {
      const r2 = await askOt(
        `${who} — ${lbl}<br>OT of <b>${ov}h</b> approved but NOT billed.<br><br>Why not billed to the client? (required)`,
        { title: "Unbilled OT", input: true, inputPlaceholder: "Reason not billed", buttons: false, allowCancel: true });
      if (r2 === null || r2 === "cancel") return false;
      if (!String(r2).trim()) { toast("A reason is required for unbilled OT", true); return false; }
      note.reason = String(r2).trim();
      note.comment = String(r2).trim();
      notes[w] = note;
      continue;
    }
  }
  return true;
}

/* Show a rejected upload as a readable list: WHO, WHICH WEEK, WHAT and the FIX.
   The server returns { message, problems:[{person, week_label, entered, planned,
   reason, fix}], problem_count }. */
function wkShowImportProblems(detail, fileName) {
  const problems = (detail && detail.problems) || [];
  const msg = (detail && detail.message) || "The upload was rejected.";
  const rows = problems.map((p) => `
    <tr>
      <td><b>${esc(p.person || "—")}</b></td>
      <td>${esc(p.project ? (p.client || "") + " · " + p.project : (p.client || "—"))}</td>
      <td>${esc(p.week_label || "—")}</td>
      <td class="num">${p.planned == null ? "—" : fmtH(p.planned)}</td>
      <td class="num">${p.entered == null ? "—" : fmtH(p.entered)}</td>
      <td>${esc(p.reason || "—")}</td>
      <td>${esc(p.fix || "—")}</td>
    </tr>`).join("");
  const more = (detail && detail.problem_count > problems.length)
    ? `<div class="muted-note" style="margin-top:8px">…and ${detail.problem_count - problems.length} more row(s).</div>`
    : "";
  showModalHTML(
    "Upload rejected — nothing was saved",
    `<div class="wk-imp-bad">${esc(msg)}</div>
     ${fileName ? `<div class="muted-note" style="margin:6px 0 10px">File: <b>${esc(fileName)}</b></div>` : ""}
     ${problems.length ? `<div class="wk-imp-scroll"><table class="wk-imp-tbl">
        <thead><tr><th>Person</th><th>Project</th><th>Week</th><th class="num">Planned</th>
        <th class="num">Entered</th><th>Why it failed</th><th>How to fix</th></tr></thead>
        <tbody>${rows}</tbody></table></div>${more}` : ""}`
  );
}

async function wkUpload(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", "merge");
  const lbl = document.querySelector('label[for="wkImportFile"]');
  const was = lbl ? lbl.innerHTML : "";
  if (lbl) lbl.innerHTML = "Uploading…";
  try {
    const res = await fetch("/api/import", { method: "POST", body: fd });
    if (!res.ok) {
      let detail = null;
      try { detail = (await res.json()).detail; } catch (_) {}
      if (detail && typeof detail === "object") wkShowImportProblems(detail, file.name);
      else toast(`Upload failed: ${detail || res.statusText}`, true);
      return;
    }
    const data = await res.json();
    const n = data.actuals_added || 0;
    toast(n ? `Uploaded — ${n} ${n === 1 ? "person" : "people"} updated` : "Upload complete — no changes found");
    await loadActuals().catch(() => {});
    await loadWeekSheet();
  } catch (e) {
    toast(`Upload failed: ${e.message}`, true);
  } finally {
    if (lbl) lbl.innerHTML = was;
  }
}

function bindWeekSheet() {
  const sel = $("#wkSelect");
  if (sel) sel.addEventListener("change", () => { WK.week = +sel.value; renderWeekSheet(); });
  const prev = $("#wkPrev");
  if (prev) prev.addEventListener("click", () => {
    WK.week = Math.max(0, WK.week - 1); buildWeekPicker(); renderWeekSheet();
  });
  const next = $("#wkNext");
  if (next) next.addEventListener("click", () => {
    const n = wkWeeks().length - 1;
    WK.week = Math.min(n, WK.week + 1); buildWeekPicker(); renderWeekSheet();
  });
  const today = $("#wkToday");
  if (today) today.addEventListener("click", () => {
    const cur = (WK.current && WK.current.week_index);
    if (cur === undefined || cur === null) { toast("No current week known", true); return; }
    WK.week = cur; buildWeekPicker(); renderWeekSheet();
  });
  const save = $("#wkSave");
  if (save) save.addEventListener("click", saveWeekSheet);
  // Export: the endpoint is already PM-scoped (their projects, no rates).
  const exp = $("#wkExport");
  if (exp) exp.addEventListener("click", () => { window.location.href = "/api/export"; });
  const imp = $("#wkImportFile");
  if (imp) imp.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    wkUpload(f);
  });
}
