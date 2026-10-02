/* ============================================================================
   PM WORKBENCH + People + OT approvals  (feature: PM access, 2026-10-01)
   ----------------------------------------------------------------------------
   Built to Rijoy's spec:
     * one master People list; a PM picks a person, never types a name
     * assign a % of weekly capacity over the project's start/end dates
     * 100% WEEKLY HARD BLOCK — the save is refused and the refusal names the
       clashing week and the competing project
     * restricted titles, with a mandatory reason when it isn't the home title
     * the load rail shows every person's booked % BEFORE you assign
   The rail and the server validator both read person_week_load, so they cannot
   disagree; the client verdict here is a courtesy preview, and the server is
   always the final authority (it re-validates on save).
   ========================================================================== */

/* Renders an HTML body (showModal() above is text-only) and installs the OK
   handler through app.js's single-handler contract. */
function showModalHTML(title, htmlBody) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = htmlBody;
  $("#modal").classList.remove("hidden");
}

let WB = {
  projects: [],          // /api/my-projects
  people: [],            // /api/people
  load: [],              // /api/pm/load -> people with `weeks`
  weekLabels: [],
  months: [],            // month bands + their week ranges (from /api/pm/load)
  weekMonth: [],         // week index -> month name, for labels + tooltips
  current: {},           // which week/month is "now" (server-authoritative)
  selKey: null,          // "client||project" of the selected project
  filter: "",
  loadFilter: "",
  loadTitle: "",         // GH-50: title selected in the Find-a-person dropdown
  loadWindow: "auto",    // GH-51: window selector — auto | 12w | 26w | year
  compare: [],           // GH-52: person ids ticked for comparison
  move: null,            // GH-53: draft of the reallocation being proposed
};
const wbKey = (cl, pr) => `${cl}||${pr}`;

/* ---------------- load the workbench ---------------- */
async function loadWorkbench() {
  const [proj, people, load] = await Promise.all([
    api("/api/my-projects"), api("/api/people"), api("/api/pm/load"),
  ]);
  WB.projects = proj.projects || [];
  WB.people = people.people || [];
  WB.load = load.people || [];
  WB.weekLabels = load.week_labels || [];
  WB.months = load.months || [];
  // Rate-card titles (strings only) so the "New joiner" dialog can offer them.
  // state.pricing is admin-only, so a PM had an empty list.
  WB.titles = load.titles || WB.titles || [];
  WB.weekMonth = load.week_month || [];
  WB.current = load.current || {};
  if (!WB.selKey && WB.projects.length) {
    WB.selKey = wbKey(WB.projects[0].client, WB.projects[0].project);
  }
  renderWorkbench();
}

function wbSel() {
  return WB.projects.find((p) => wbKey(p.client, p.project) === WB.selKey) || null;
}

function renderWorkbench() {
  renderWbProjects();
  renderWbTeam();
  renderWbProgress();
  // GH-51: the load rail lives on the Resources tab now, so only re-render it
  // when that view is the one on screen (renderWbLoad guards on #wbLoad).
  if (state.view === "resources") renderWbLoad();
}

/* GH-51: the Resources tab. Ensures the roster is loaded (the tab can be the
   first thing a PM opens, before My Projects has ever fetched anything) and
   then renders the rail. */
async function renderResources() {
  if (!(WB.load || []).length) {
    try { await loadWorkbench(); } catch (e) { /* rail renders its own empty state */ }
  }
  renderWbLoad();
  renderWbCompare();
}

/* ---------------- project progress chart (GH-49) ----------------
 * "Some where in the screen can we include a graph, that will should how the
 * project is going on compare to what was planned. It should be a graph and not
 * a bar diagram some thing on view would know how project is running."
 *
 * So: a CUMULATIVE LINE/AREA chart of planned vs actual hours for the selected
 * project. Cumulative is the point — two lines diverging is what tells you at a
 * glance whether the project is running ahead of or behind plan; a per-week
 * series would just look like noise. Hours only, never money.
 */
let wbProgCache = {};   // "client||project" -> series, so switching back is instant

async function renderWbProgress() {
  const box = $("#wbProgChart");
  const note = $("#wbProgNote");
  if (!box) return;
  const sel = wbSel();
  if (!sel) {
    box.innerHTML = `<div class="wb-empty">Pick a project to see how it is running against plan.</div>`;
    if (note) note.textContent = "planned vs actual hours, cumulative";
    return;
  }
  const key = wbKey(sel.client, sel.project);
  let d = wbProgCache[key];
  if (!d) {
    box.innerHTML = `<div class="wb-empty">Loading chart…</div>`;
    try {
      d = await api(`/api/pm/progress?client=${encodeURIComponent(sel.client || "")}`
        + `&project=${encodeURIComponent(sel.project || "")}`);
      wbProgCache[key] = d;
    } catch (e) {
      box.innerHTML = `<div class="wb-empty">Could not load progress: ${esc(e.message || "")}</div>`;
      return;
    }
  }
  // The selected project may have changed while the fetch was in flight.
  if (wbKey(wbSel()?.client, wbSel()?.project) !== key) return;

  const cp = d.cum_planned || [], ca = d.cum_actual || [];
  const maxV = Math.max(1, ...cp, ...ca);
  const cur = d.current_week;
  // Only draw the actual line up to "now" — an actual line running flat into
  // future weeks implies work happened that has not.
  const upto = (cur === null || cur === undefined) ? ca.length - 1 : cur;
  const shown = ca.slice(0, upto + 1);

  const t = d.totals || { planned: 0, actual: 0 };
  if (!cp.length || (maxV <= 1 && !t.planned)) {
    box.innerHTML = `<div class="wb-empty">No planned hours booked on this project yet, so there is nothing to compare against.</div>`;
    if (note) note.textContent = "";
    return;
  }
  // A project with a plan but no actuals yet is normal (the month has not been
  // reconciled) — say that plainly instead of drawing a misleading flat line.
  const noActuals = shown.every((v) => !v);
  if (note) {
    const pct = t.planned ? Math.round((t.actual / t.planned) * 100) : 0;
    note.textContent = `planned ${fmtH(t.planned)} h · actual ${fmtH(t.actual)} h`
      + (t.planned ? ` · ${pct}% of plan` : "")
      + (noActuals ? " · no actuals recorded yet" : "");
  }
  box.innerHTML = svgProgress(cp, ca, upto, d.weeks || [], d.week_month || [], d.months || []);
}

/* Hand-rolled SVG so there is no charting dependency and it inherits the
   theme variables (works across all themes, including the light ones). */
function svgProgress(cumPlanned, cumActual, upto, weeks, weekMonth, months) {
  const W = 1000, H = 260;                 // viewBox units; CSS scales it
  const L = 62, R = 16, T = 16, B = 46;    // margins
  const n = cumPlanned.length;
  const plotW = W - L - R, plotH = H - T - B;
  const maxV = Math.max(1, ...cumPlanned, ...cumActual);
  // Round the top up to something tidy so the gridlines carry readable numbers.
  const mag = Math.pow(10, Math.floor(Math.log10(maxV)));
  const top = Math.ceil(maxV / mag) * mag;
  const x = (i) => L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => T + plotH - (v / top) * plotH;

  const line = (arr, last) => arr.slice(0, last + 1)
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = (arr, last) => arr.slice(0, last + 1)
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
    + ` L${x(last).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  // 4 horizontal gridlines with value labels.
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (top / 4) * g, yy = y(v);
    grid += `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}" class="wb-g"/>`
      + `<text x="${L - 8}" y="${(yy + 4).toFixed(1)}" class="wb-ax" text-anchor="end">${fmtH(v)}</text>`;
  }
  // Month ticks: label the first week of each month, thinned so they never collide.
  let mticks = "";
  const seen = new Set();
  weeks.forEach((w, i) => {
    const mn = weekMonth[i];
    if (!mn || seen.has(mn)) return;
    seen.add(mn);
    if (seen.size % 2 === 0 && n > 14) return;      // thin on long ranges
    mticks += `<text x="${x(i).toFixed(1)}" y="${H - B + 18}" class="wb-mx" text-anchor="middle">${esc(mn.slice(0, 3))}</text>`;
  });
  // "Today" marker — where the actual line stops.
  const nowX = x(upto).toFixed(1);
  const nowLine = (upto >= 0 && upto < n - 1)
    ? `<line x1="${nowX}" y1="${T}" x2="${nowX}" y2="${T + plotH}" class="wb-now"/>`
      + `<text x="${nowX}" y="${T - 4}" class="wb-nowt" text-anchor="middle">today</text>`
    : "";

  const endP = cumPlanned[n - 1], endA = cumActual[upto >= 0 ? upto : 0];
  const behind = endA < endP;

  return `<svg viewBox="0 0 ${W} ${H}" class="wb-svg" role="img"
      aria-label="Cumulative planned versus actual hours for this project">
    ${grid}${mticks}${nowLine}
    <path d="${area(cumPlanned, n - 1)}" class="wb-area-p"/>
    <path d="${line(cumPlanned, n - 1)}" class="wb-line-p"/>
    ${upto >= 0 ? `<path d="${area(cumActual, upto)}" class="wb-area-a"/>` : ""}
    ${upto >= 0 ? `<path d="${line(cumActual, upto)}" class="wb-line-a${behind ? " behind" : ""}"/>` : ""}
    <circle cx="${x(n - 1).toFixed(1)}" cy="${y(endP).toFixed(1)}" r="3.5" class="wb-dot-p"/>
    ${upto >= 0 ? `<circle cx="${x(upto).toFixed(1)}" cy="${y(endA).toFixed(1)}" r="3.5" class="wb-dot-a${behind ? " behind" : ""}"/>` : ""}
  </svg>
  <div class="wb-prog-legend">
    <span><i class="sw plan"></i>Planned (cumulative)</span>
    <span><i class="sw act"></i>Actual (to date)</span>
    <span class="muted-note">${behind
      ? "Behind plan — actual is below planned hours"
      : "On or ahead of plan"}</span>
  </div>`;
}

/* ---------------- left: owned projects ---------------- */
function renderWbProjects() {
  const box = $("#wbProjects");
  if (!box) return;
  const f = WB.filter.trim().toLowerCase();
  const list = WB.projects.filter((p) =>
    !f || `${p.client} ${p.project}`.toLowerCase().includes(f));
  if (!list.length) {
    box.innerHTML = `<div class="wb-empty">No projects match.</div>`;
    return;
  }
  box.innerHTML = list.map((p) => {
    const on = wbKey(p.client, p.project) === WB.selKey;
    // Count this project's people who are over 100% somewhere — a PM should see
    // the problem on the project card, not have to hunt for it in the rail.
    const over = (p.team || []).filter((t) => {
      const l = WB.load.find((x) => x.id === t.person_id);
      return l && l.peak_pct > 100;
    }).length;
    return `<div class="wb-pitem ${on ? "on" : ""}" data-k="${esc(wbKey(p.client, p.project))}">
      <div class="cl">${esc(p.client || "—")}</div>
      <div class="pj">${esc(p.project)}</div>
      <!-- The client is repeated under the project name on purpose: project
           NAMES repeat across clients ("Quadient" at 5 clients, "Support" at
           3), so a PM owning two of them would otherwise see two identical
           rows and not know which is which. -->
      <div class="mt">
        <span title="Client">${esc(p.client || "—")}</span>
        <span>${p.people} ${p.people === 1 ? "person" : "people"}</span>
        <span>${fmtH(p.booked_hours)} h</span>
        ${over ? `<span class="over">${over} over capacity</span>` : ""}
        <!-- GH-37: "The PM should be able to delete the project he created as
             well." Everything in this list is owned by the signed-in PM, so the
             button is always safe to offer; the API re-checks ownership anyway. -->
        <button class="btn mini wb-pdel" data-del-k="${esc(wbKey(p.client, p.project))}"
          data-del-client="${esc(p.client || "")}" data-del-project="${esc(p.project || "")}"
          title="Delete ${esc(p.client)} · ${esc(p.project)}">🗑</button>
      </div>
    </div>`;
  }).join("");
  $$("#wbProjects .wb-pitem").forEach((el) => el.addEventListener("click", () => {
    WB.selKey = el.dataset.k;
    renderWorkbench();
  }));
  // Delete must not also select the project, hence stopPropagation.
  $$("#wbProjects .wb-pdel").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteWbProject(b.dataset.delClient || "", b.dataset.delProject || "");
  }));
}

/* GH-37: create a project as a PM (client + project name only — no rates, no
   money; those live on the Rate Card and are admin-only). The server writes this
   PM as the owner, so the project appears in the list behind the dialog and on
   the admin Dashboard straight away. */
function openWbNewProject() {
  const body = `
    <p class="muted-note">You become the project manager of what you create, and it
    appears on the Dashboard immediately. Rates and titles are admin-owned — add your
    team afterwards with <b>+ Add team member</b>.</p>
    <div class="assign-grid">
      <div><label class="f">Client</label><input id="wpClient" placeholder="e.g. Doxim"></div>
      <div><label class="f">Project</label><input id="wpName" placeholder="e.g. Support"></div>
    </div>
    <div class="assign-grid">
      <div><label class="f">Start date <span class="muted-note">(optional)</span></label><input id="wpStart" type="date"></div>
      <div><label class="f">End date <span class="muted-note">(optional)</span></label><input id="wpEnd" type="date"></div>
    </div>`;
  showModalHTML("New project", body);
  const ok = $("#modalOk");
  if (ok) ok.textContent = "Create";
  setModalOk(async () => {
    const client = ($("#wpClient").value || "").trim();
    const project = ($("#wpName").value || "").trim();
    if (!client || !project) { toast("Client and project are required", true); return; }
    ok.disabled = true;
    try {
      await api("/api/projects", { method: "POST", body: JSON.stringify({
        client, project,
        start_date: $("#wpStart").value || "", end_date: $("#wpEnd").value || "",
      }) });
      closeModal();
      toast(`Created ${client} · ${project} — you are its PM`);
      WB.selKey = wbKey(client, project);
      await refreshWorkbenchProjects();
    } catch (e) {
      const det = e && e.detail ? e.detail : null;
      toast((det && det.message) || e.message || "Could not create the project", true);
    } finally { ok.disabled = false; }
  });
}

/* GH-37: delete a project the PM owns. Mirrors the Dashboard's two-step flow:
   the API refuses a staffed project and names the loss, so the second confirm
   carries the real numbers rather than a generic warning. */
async function deleteWbProject(client, project) {
  const label = `${client}${project ? " · " + project : ""}`;
  let target = null;
  try {
    const list = await api("/api/projects");
    target = (list || []).find((x) =>
      (x.client || "").toUpperCase() === client.toUpperCase() &&
      (x.project || "").toUpperCase() === project.toUpperCase());
  } catch (e) { toast(`Could not load projects: ${e.message}`, true); return; }
  if (!target) { toast(`${label} is not a Project entry`, true); return; }

  const go = async (force) => {
    try {
      // GH-38: a PM's delete ARCHIVES. The project leaves their view but nothing
      // is destroyed, and an admin can reactivate it — so the wording must not
      // promise permanence, and a staffed project is refused the same way.
      const res = await api(`/api/projects/${target.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      const d = (res && res.deleted) || {};
      if (res && res.archived) {
        toast(`Removed ${d.client || client} · ${d.project || project} — an admin can restore it if this was a mistake`);
      } else {
        toast(`Deleted ${d.client || client} · ${d.project || project}` +
              (d.people ? ` — removed ${d.people} assignment(s), ${d.planned_weeks} planned week(s)` : ""));
      }
      if (WB.selKey === wbKey(client, project)) WB.selKey = "";
      await refreshWorkbenchProjects();
    } catch (e) {
      const det = e && e.detail ? e.detail : null;
      if (det && det.code === "has_assignments") {
        if (confirm(`${det.message}\n\nRemove it anyway? An admin can still restore it.`)) return go(true);
        return;
      }
      toast((det && det.message) || e.message || "Delete failed", true);
    }
  };
  if (confirm(`Remove ${label} from your projects?\n\nIt disappears from your view. Your admin can restore it, and it is not deleted from the company's records.`)) {
    await go(false);
  }
}

/* Reload the workbench after a project create/delete.

   `loadWorkbench()` is the single source of WB.projects/people/load (it calls
   /api/pm/load, which already returns the caller's projects), so re-running it is
   the whole refresh — there is no separate /api/workbench/projects endpoint. */
async function refreshWorkbenchProjects() {
  try { await loadWorkbench(); } catch (e) { toast(`Reload failed: ${e.message}`, true); }
  renderWorkbench();
}

const fmtH = (v) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 }));

/* ---------------- right: the selected project's team ---------------- */
function renderWbTeam() {
  const p = wbSel();
  const head = $("#wbTeamHead"), body = $("#wbTeamBody");
  if (!head || !body) return;
  const addBtn = $("#btnWbAdd");
  if (!p) {
    head.innerHTML = ""; body.innerHTML = "";
    if (addBtn) addBtn.disabled = true;
    $("#wbHead").innerHTML = `<span class="dot off"></span>Pick a project on the left.`;
    return;
  }
  if (addBtn) addBtn.disabled = false;
  const window_ = [p.start_date, p.end_date].filter(Boolean).join(" → ") || "full year";
  $("#wbHead").innerHTML = `<span class="dot on"></span><b>${esc(p.client)} · ${esc(p.project)}</b>
    — ${p.people} ${p.people === 1 ? "person" : "people"}, ${fmtH(p.booked_hours)} h booked. Dates: ${esc(window_)}.`;

  head.innerHTML = `<tr>
    <th>Person</th><th>Title</th><th class="num">Allocation</th>
    <th>Start</th><th>End</th><th class="num">Weekly hrs</th>
    <th>Load (all projects)</th><th>Status</th><th></th>
  </tr>`;
  if (!p.team.length) {
    body.innerHTML = `<tr><td colspan="9"><div class="wb-empty">Nobody on this project yet. Use <b>+ Add team member</b>.</div></td></tr>`;
    return;
  }
  body.innerHTML = p.team.map((t) => {
    const l = WB.load.find((x) => x.id === t.person_id);
    const peak = l ? l.peak_pct : null;
    const cap = t.capacity || 40;
    const pct = t.allocation_pct == null ? null : t.allocation_pct;
    const weekly = t.weekly_hours != null
      ? t.weekly_hours
      : (pct == null ? null : Math.round(pct / 100 * cap * 10) / 10);
    const status = peak == null ? `<span class="pill">no load data</span>`
      : peak > 100 ? `<span class="pill wb-pill-over">Over ${peak}%</span>`
      : peak >= 80 ? `<span class="pill wb-pill-ok">Healthy ${peak}%</span>`
      : peak >= 50 ? `<span class="pill wb-pill-warn">${peak}%</span>`
      : `<span class="pill wb-pill-free">${peak}%</span>`;
    const exc = (t.title_exception || "").trim();
    // GH-54: most resources came in from Excel with NO allocation % stored, so
    // this cell (and the Edit dialog) used to render blank for almost the whole
    // book. The server now derives the % from their planned hours; the "from
    // plan" note says so, so a derived number is never mistaken for one someone
    // actually typed. Saving Edit stores it.
    const derived = !!t.allocation_derived;
    const allocCell = (pct == null ? "—" : `${esc(pct)}%`)
      + (derived
        ? `<div class="muted-note" title="No allocation % is stored for this resource — it came in from the Excel import with hours only. Shown from their plan: peak week / ${fmtH(cap)}h, on the 25% grid. The hours themselves are untouched.">from plan</div>`
        : "")
      + ((t.phases && t.phases.length > 1)
        ? `<div class="muted-note" title="${esc((t.phases || []).map((x) => x.allocation_pct + "% from " + (x.start_date || "start")).join(" · "))}">${t.phases.length} phases</div>`
        : "");
    return `<tr data-rid="${t.id}" data-pid="${t.person_id}">
      <td><b>${esc(t.name)}</b>${exc ? `<div class="muted-note">⚑ ${esc(exc)}</div>` : ""}</td>
      <td>${esc(t.role || "—")}</td>
      <td class="num">${allocCell}</td>
      <td>${esc(t.start_date || "—")}</td>
      <td>${esc(t.end_date || "—")}</td>
      <td class="num">${weekly == null ? "—" : fmtH(weekly)}</td>
      <td>${peak == null ? "—" : loadBarHTML(peak)}</td>
      <td>${status}</td>
      <td class="wb-rowactions">
        <button class="btn mini" data-act="edit">Edit</button>
        <button class="btn mini" data-act="del">Remove</button>
      </td>
    </tr>`;
  }).join("");
  $$("#wbTeamBody tr").forEach((tr) => {
    const rid = +tr.dataset.rid, pid = +tr.dataset.pid;
    tr.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
      const t = p.team.find((x) => x.id === rid);
      if (!t) return;
      // Edit opens pre-filled with THIS resource — the person is not re-picked
      // and the booked title/allocation/window come from the row (GH-54).
      if (b.dataset.act === "edit") return openAssignModal(p, pid, rid);
      // Remove asks the resigned question first (GH-54) instead of a bare
      // browser confirm that only warned about deleted hours.
      return openRemoveModal(p, t);
    }));
  });
}

/* ---------------- Remove: resigned, or back to the bench? (GH-54) ----------------
   Rijoy: "remove button should ask if the resource resigned — if not then put the
   resource along with the availability back to bench and if resigned then remove
   the resource and make the person inactive".

   A browser confirm() cannot ask that, so this is a real in-app dialog that
   states what is lost, offers the two outcomes, and warns BEFORE deactivating
   someone who is still on other projects. The server re-checks everything; the
   dialog is the explanation, not the guard. */
function openRemoveModal(project, t) {
  const isBench = String(project.client || "").trim().toUpperCase() === "INTERNAL"
    && String(project.project || "").trim().toUpperCase() === "BENCH";
  const person = WB.people.find((x) => x.id === t.person_id) || {};
  const hereKey = `${String(project.client || "").trim().toUpperCase()}|${String(project.project || "").trim().toUpperCase()}`;
  const others = (person.assignments || []).filter((a) =>
    `${String(a.client || "").trim().toUpperCase()}|${String(a.project || "").trim().toUpperCase()}` !== hereKey);
  const otherLabels = others.map((a) => `${a.client} · ${a.project}`);
  const cap = t.capacity || 40;
  const rowPct = t.allocation_pct == null ? 0 : t.allocation_pct;
  // What goes back to Bench is their AVAILABILITY after this removal, not the
  // share this one row held — 50% here + 50% elsewhere means 50% freed, not
  // 100%. Mirrors what the server computes after deleting the row.
  const pl = WB.load.find((x) => x.id === t.person_id);
  const peakAll = pl ? (pl.peak_pct || 0) : rowPct;
  const freeAfter = Math.max(0, Math.min(100, Math.floor((100 - peakAll + rowPct) / 25) * 25));
  // Default to the non-destructive answer on BOTH cases: taking someone off a
  // project must never default to marking them resigned.
  let choice = "bench";                         // bench | resign
  let armed = false;                            // second press for resign-with-others

  const body = `
    <div class="rm-head">
      <div><b>${esc(t.name)}</b> <span class="muted-note">${esc(t.role || "—")}</span></div>
      <div class="muted-note">Removing from <b>${esc(project.client)} · ${esc(project.project)}</b></div>
    </div>
    <div class="rm-loss">
      This removes their assignment here — <b>${fmtH(t.planned_hours || 0)} planned hour(s)</b>
      and any actual hours recorded against it.
      ${otherLabels.length
        ? `They stay on <b>${esc(otherLabels.slice(0, 4).join(", "))}</b>${otherLabels.length > 4 ? ` +${otherLabels.length - 4} more` : ""} — this is not their only project.`
        : "This is their only project."}
    </div>
    <div class="rm-q">Did this person resign?</div>
    <div class="rm-opts" id="rmOpts">
      <button type="button" class="rm-opt on" data-choice="bench">
        <b>${isBench ? "No — take them off Bench" : "No — keep them, back to Bench"}</b>
        <span>${isBench
          ? "Removes the Bench record. There is nowhere to re-bench them — they are already on Bench — so this simply clears it."
          : `Removes them here and parks them on <b>Internal · Bench</b> for the <b>${freeAfter}%</b> of their week that frees up (${fmtH(freeAfter / 100 * cap)} h/week), so their availability stays visible instead of disappearing.`}</span>
      </button>
      <button type="button" class="rm-opt${isBench ? " on" : ""}" data-choice="resign">
        <b>Yes — they resigned</b>
        <span>Removes them here and marks them <b>Inactive</b> on the People list — they have left the company, so they stop appearing as available.</span>
      </button>
    </div>
    <div id="rmWarn" class="rm-warn hidden"></div>
    <div class="muted-note" id="rmNote" style="margin-top:10px"></div>
  `;
  showModalHTML(`Remove — ${t.name}`, body);

  const warn = $("#rmWarn"), note = $("#rmNote");
  function refresh() {
    $$("#rmOpts .rm-opt").forEach((b) => b.classList.toggle("on", b.dataset.choice === choice));
    if (isBench) {
      warn.className = "rm-warn hidden"; warn.innerHTML = "";
      note.innerHTML = "This is the Bench project — removing clears their bench allocation. Nothing is re-benched.";
      return;
    }
    if (choice === "resign" && otherLabels.length) {
      // The person is still booked elsewhere. Deactivating them is allowed but
      // must be deliberate: they keep those assignments, so say so plainly.
      warn.className = "rm-warn";
      warn.innerHTML = armed
        ? `<b>Confirmed.</b> Press <b>OK</b> once more to mark ${esc(t.name)} inactive.`
        : `<b>Heads up:</b> ${esc(t.name)} is still on ${esc(otherLabels.slice(0, 4).join(", "))}. Marking them inactive leaves those assignments in place — it does not remove them.`;
      note.innerHTML = armed ? "" : "Press <b>OK</b> once to acknowledge, then once more to confirm.";
    } else if (choice === "resign") {
      warn.className = "rm-warn hidden"; warn.innerHTML = "";
      note.innerHTML = `${esc(t.name)} has no other project, so this is a clean offboard.`;
    } else {
      warn.className = "rm-warn hidden"; warn.innerHTML = "";
      note.innerHTML = "Bench holds no rate, so this changes no cost or revenue.";
    }
  }
  $$("#rmOpts .rm-opt").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.choice === choice) return;   // a no-op click must not reset `armed`
    choice = b.dataset.choice;
    armed = false;
    refresh();
  }));
  refresh();

  // A person with NO person record cannot be benched or marked inactive — there
  // is nobody to act on. Say so where the buttons are, not after the fact.
  if (!t.person_id) {
    warn.className = "rm-warn";
    warn.innerHTML = "<b>This resource is not linked to a person record.</b> It will be removed from the project; there is no one to bench or mark inactive.";
    $$("#rmOpts .rm-opt").forEach((b) => { b.disabled = true; b.style.opacity = ".5"; });
  }

  setModalOk(async () => {
    // Resign-with-others takes two presses: the first arms, the second acts.
    if (choice === "resign" && otherLabels.length && !armed) {
      armed = true; refresh(); return;
    }
    const ok = $("#modalOk");
    if (ok) ok.disabled = true;
    try {
      const res = await api(`/api/assignments/${t.id}/remove`, {
        method: "POST",
        body: JSON.stringify({ resigned: choice === "resign", force: armed }),
      });
      closeModal();
      toast(res.outcome || `${t.name} removed from ${project.project}`);
      await loadWorkbench();
    } catch (e) {
      // The server is the authority. A 409 still_assigned means the UI's
      // "other projects" list was stale — arm rather than pretend it worked.
      const det = e && e.detail ? e.detail : null;
      if (det && det.code === "still_assigned") {
        armed = true;
        warn.className = "rm-warn";
        warn.innerHTML = `<b>Still assigned elsewhere:</b> ${esc(det.message || "")}`;
        note.innerHTML = "Press <b>OK</b> again to confirm.";
      } else {
        toast((det && det.message) || e.message || "Remove failed", true);
      }
    } finally {
      if (ok) ok.disabled = false;
    }
  });
}

function loadBarHTML(pct) {
  const w = Math.min(pct, 100);
  const cls = pct > 100 ? "hot" : pct >= 50 ? "warn" : "booked";
  return `<div class="bar" title="${pct}% of capacity"><i class="${cls}" style="width:${w}%"></i></div>`;
}

/* The load rail's week grid: a MONTH band across the top, then one column per
   week (labelled MM-DD) so a block is traceable to a real date, not a mystery
   square. Built with a CSS grid whose columns are the weeks-in-month, because
   months are 4-5 weeks long and uneven — a uniform flex strip could never line
   the band up with its weeks. Each cell is clickable. */
function weekGridHTML(x) {
  const weeks = WB.weekLabels || [];
  const months = WB.months || [];
  const cols = `grid-template-columns:repeat(${weeks.length || 1}, minmax(0, 1fr));`;
  if (!weeks.length) return "";
  const cur = WB.current || {};
  const band = months.map((m) => {
    const span = (m.end - m.start) + 1;
    // The month we are IN gets a solid accent so "where am I?" needs no counting.
    const isNow = cur.month && String(m.name).toUpperCase() === String(cur.month).toUpperCase();
    return `<i class="wb-mo ${isNow ? "now" : ""}" style="grid-column:span ${span}"
      title="${esc(m.name)} (${span} weeks)${isNow ? " — current month" : ""}">${esc(m.name)}</i>`;
  }).join("");
  const cells = weeks.map((wl, i) => {
    const v = (x.weeks || [])[i] || 0;
    const cls = v > 100 ? "hot" : v >= 50 ? "warn" : v > 0 ? "booked" : "";
    // "03-Mar" reads as a date; the full tooltip carries month + utilisation.
    const mmdd = wl.includes("-") ? wl.split("-").slice(1).join("-") : wl;
    const mon = (WB.weekMonth || [])[i] || "";
    const isNow = cur.week_index === i;
    const nowNote = isNow && cur.week_start
      ? ` — CURRENT WEEK (${esc(cur.week_start)} to ${esc(cur.week_end)})`
      : "";
    return `<b class="wb-wk ${cls} ${isNow ? "now" : ""}" data-wk="${i}" tabindex="0" role="button"
      title="${esc(x.name)} — ${esc(mon)} ${esc(wl)}: ${v}% of capacity${nowNote} · click for detail">${esc(mmdd)}</b>`;
  }).join("");
  return `<div class="wb-grid-rail" style="${cols}">${band}${cells}</div>`;
}

/* ---------------------------------------------------------------------------
   GH-51 — the Resources tab.
   Rijoy: "lets also include the unavailable folks too and we will move this to
   another tab on the left called Resources."

   This is the GH-50 finder promoted out of My Projects and widened to the whole
   roster, with two changes that matter:
     1. Nobody is dropped. People who cannot take work are rendered in a
        COLLAPSED section that says WHY — which week they peak and on how many
        projects. Hiding them was the thing Rijoy asked to fix.
     2. The window is an explicit choice. "Available" is meaningless without a
        period, so the rail offers auto (this project, else 12 weeks), 12w, 26w
        or the whole year, and always names what it used.
   Every number comes from the booked-% payload a PM already receives; no rates
   and no money cross this surface (CHARTER clause 1).
   --------------------------------------------------------------------------- */

const WB_BUCKETS = [
  { min: 100, label: "100% available" },
  { min: 75,  label: "75–99% available" },
  { min: 50,  label: "50–74% available" },
  { min: 0,   label: "under 50% available" },
];

/* Resolve the window the rail measures against.
   mode: "auto" (default) uses the selected project's own range, falling back to
   the near-term horizon; "12w"/"26w"/"year" are explicit choices.

   When a project has no dates (14 of 16 legacy projects, imported without them)
   we use a NEAR-TERM horizon rather than the whole year. Measured on live data
   2026-10-02: a 53-week window leaves only 11 of 49 people "available" because
   38 are booked to >=100% at SOME point in the year, while 12 weeks shows 20.
   The label always says which horizon produced the number. */
function wbLoadWindow(mode) {
  const all = WB.weekLabels.map((_, i) => i);
  const startIdx = () => {
    let s = (WB.current && typeof WB.current.week_index === "number") ? WB.current.week_index : -1;
    if (s < 0) {
      const today = new Date();
      const first = all.find((i) => { const d = weekLabelToDate(WB.weekLabels[i]); return d && d >= today; });
      s = first == null ? 0 : first;
    }
    return s;
  };
  const from = (n, label) => {
    const s = startIdx();
    const idx = all.filter((i) => i >= s && i < s + n);
    if (!idx.length) return { idx: all, label: "the rest of the year" };
    // Be honest when the year runs out: asking for 26 weeks in October can only
    // reach the end of 2026, and a label claiming 26 would be a lie.
    return { idx, label: idx.length < n ? `the next ${idx.length} weeks (to year end)` : label };
  };
  const m = mode || WB.loadWindow || "auto";
  if (m === "year") return { idx: all, label: "all of 2026" };
  if (m === "26w") return from(26, "the next 26 weeks");
  if (m === "12w") return from(12, "the next 12 weeks");
  // auto
  const p = wbSel();
  if (p && p.start_date && p.end_date) {
    const start = new Date(p.start_date + "T00:00:00");
    const end = new Date(p.end_date + "T00:00:00");
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      const idx = all.filter((i) => {
        const d = weekLabelToDate(WB.weekLabels[i]);
        return d && d >= start && d <= end;
      });
      if (idx.length) return { idx, label: `${p.start_date} → ${p.end_date}` };
    }
  }
  return from(12, "the next 12 weeks");
}

/* Availability, measured over the window.
 *
 * TWO numbers, because they answer two different questions a PM asks:
 *
 *   freePct  = 100 − AVERAGE booked% across the window
 *              "how much of this person is available over this period" — the
 *              headline number, and what the 100/75/50/25 buckets use.
 *   fullSlot = 100 − WORST booked% in the window  (minimum headroom)
 *              "can they take a full-time slot?" — 0 means every week is
 *              already at 100%, so they can only ever take part-time work.
 *
 * Why average and not peak: measured on live data 2026-10-02, peak-of-window
 * reported **Ankish Mittal and Khushi Bhatia as 0% free and unavailable** when
 * their actual pattern was [100,0,0,0,0,0,0,0,0,0,0,0] — busy in ONE week (the
 * current week) and free for the other eleven. Peak collapsed "busy this week"
 * into "no capacity", which is what Rijoy spotted as the % not being right.
 * Average over the window is what a PM means by "how much of them can I use".
 */
function wbAvailability(x, win) {
  const vals = win.idx.map((i) => (x.weeks || [])[i] || 0);
  const n = vals.length || 1;
  const avg = Math.round((vals.reduce((a, b) => a + b, 0) / n) * 10) / 10;
  let peak = 0, peakIdx = win.idx.length ? win.idx[0] : 0;
  win.idx.forEach((i) => {
    const v = (x.weeks || [])[i] || 0;
    if (v > peak) { peak = v; peakIdx = i; }
  });
  const free = Math.max(0, Math.round(100 - avg));
  const fullSlot = Math.max(0, Math.round(100 - peak));
  const freeWeeks = vals.filter((v) => v < 100).length;
  return {
    free,                       // headline: % free, averaged over the window
    avg,
    fullSlot,                   // worst-week headroom (can they take a full slot?)
    peak: Math.round(peak),
    peakWeek: (WB.weekLabels || [])[peakIdx] || "",
    peakProjects: (((x.detail || [])[peakIdx]) || []).map((d) => d.label).filter(Boolean),
    freeWeeks,
    weeks: n,
  };
}

/* One resource row — shared by the available list and the busy one, so the two
   can never drift apart. `r` comes from wbAvailability(). */
function wbLoadCard(x, r, opts) {
  const o = opts || {};
  // Headline is % free, averaged over the window; the worst-week headroom is
  // shown separately because "free on average" and "can take a full slot" are
  // different questions (see wbAvailability).
  const cls = r.free >= 75 ? "wb-pill-ok" : r.free >= 50 ? "wb-pill-warn"
    : r.free > 0 ? "wb-pill-over" : "wb-pill-over";
  const pill = `<span class="pill ${cls}">${r.free}% free</span>`;
  const partTime = r.fullSlot === 0 && r.free > 0
    ? ` <span class="wb-note">part-time only</span>` : "";
  const projs = (x.projects || []).length
    ? x.projects.map(esc).join(" + ")
    : `<span class="wb-note">no project work booked</span>`;
  // WHY someone has no room: the week they are fully booked, and what is on them.
  const why = r.fullSlot === 0
    ? `<div class="sub wb-why">No full-time capacity — fully booked ${esc(r.peakWeek)}${r.peakProjects.length ? " (" + r.peakProjects.map(esc).join(" + ") + ")" : ""}</div>`
    : "";
  return `<div class="wb-load" data-pid="${x.id}">
      <div class="h">
        <label class="wb-pick" title="Add ${esc(x.name)} to the comparison">
          <input type="checkbox" data-act="pick" data-pid="${x.id}"${WB.compare.includes(x.id) ? " checked" : ""}>
        </label>
        <div class="wb-id"><b>${esc(x.name)}</b> <span class="sub">${esc(x.home_title || "—")}</span></div>
        <div>
          ${pill}${partTime} <span class="sub">free ${r.freeWeeks}/${r.weeks} wks</span>
          <button class="btn mini" data-act="move" data-pid="${x.id}" title="Move part of this person to another project (needs the releasing PM's approval)">Move…</button>
          <button class="btn mini" data-act="view" title="Add this person to one of your projects">Assign…</button>
        </div>
      </div>
      <div class="sub">${projs}</div>
      ${why}
      ${weekGridHTML(x)}
    </div>`;
}

/* ---------------------------------------------------------------------------
   GH-52 — compare selected resources.

   Rijoy: "there should be a way to select multiple resource to compare and see
   their availability and while doing that we should know where they are
   currently allocated for which project".

   The allocation shown here is derived from the per-week `detail` array the PM
   already receives (the same numbers the hard block uses), NOT from
   `resources.allocation_pct` — that column is NULL on the 62 of 66 legacy rows,
   so reading it would show "—" for almost everyone. Collapsing detail across the
   window gives the real share per project AND the weeks it spans.
   Money never enters this payload (CHARTER clause 1); the admin-only rate column
   is fetched separately and only when /api/state is available.
   --------------------------------------------------------------------------- */
function wbAllocations(x, win) {
  const by = {};
  win.idx.forEach((i) => {
    ((x.detail || [])[i] || []).forEach((d) => {
      const key = (d.label || `${d.client}/${d.project}`);
      const a = by[key] || (by[key] = { label: key, client: d.client, project: d.project,
                                        resourceId: d.resource_id, peak: 0, weeks: 0,
                                        first: i, last: i, hours: 0 });
      // peak% = the most of this person this project ever takes in the window;
      // weeks = how many weeks it touches. Together they describe the booking
      // honestly even when it varies week to week (Deepak Kumar: 100% on
      // FOP/Support, then a 50/50 split, then 100% on Print Mail — a phased
      // handover, which only the week span shows).
      a.peak = Math.max(a.peak, d.pct || 0);
      a.hours += d.hours || 0;
      a.weeks += 1;
      a.first = Math.min(a.first, i);
      a.last = Math.max(a.last, i);
    });
  });
  const list = Object.values(by).sort((a, b) => b.peak - a.peak);
  // Over-allocation: a person whose projects SUM past 100% in some week. It
  // cannot be created through the UI (the 100% hard block refuses it) but it
  // exists in imported data — measured live 2026-10-02, Ritik Kango is at 125%
  // (TSG/Quadient 100% + Vision Direct/Quadient 25%). A staffing view that hides
  // that is a staffing view that lies, so it is flagged on the row.
  let worst = 0, worstWeek = "";
  win.idx.forEach((i) => {
    const tot = ((x.detail || [])[i] || []).reduce((s, d) => s + (d.pct || 0), 0);
    if (tot > worst) { worst = tot; worstWeek = (WB.weekLabels || [])[i] || ""; }
  });
  list.over = worst > 100.5 ? { pct: Math.round(worst), week: worstWeek } : null;
  return list;
}

/* Rate lookup for ADMINS only. state.resources is admin-gated; PMs get nothing
   here and the column is not rendered for them. */
function wbRateFor(resourceId) {
  const res = (typeof state !== "undefined" && state.resources) || [];
  const r = res.find((q) => q.id === resourceId);
  return r ? { rate: r.rate, offshore: r.offshore_rate } : null;
}

function renderWbCompare() {
  const box = $("#wbCompare");
  if (!box) return;
  const win = wbLoadWindow();
  const ids = WB.compare || [];
  if (!ids.length) {
    box.innerHTML = `<div class="muted-note" style="padding:10px 2px">Tick <b>Compare</b> on any resource below to line them up side by side.</div>`;
    return;
  }
  const isAdmin = !!(state.me && state.me.role === "admin" && (state.resources || []).length);
  const people = ids.map((id) => WB.load.find((x) => x.id === id)).filter(Boolean);

  const head = `<tr>
    <th>Resource</th><th>Title</th><th>% free</th><th>Full slot?</th>
    <th>Booked in window</th><th>Current allocations (project · % of capacity)</th>
    ${isAdmin ? "<th>Rate</th><th>Offshore</th>" : ""}
    <th></th></tr>`;
  const rows = people.map((x) => {
    const r = wbAvailability(x, win);
    const allocs = wbAllocations(x, win);
    const allocHtml = (allocs.length
      ? allocs.map((a) => {
          const span = win.idx.length > 1
            ? `${(WB.weekLabels[a.first] || "")}–${(WB.weekLabels[a.last] || "")}` : "";
          return `<div class="wb-alloc"><b>${esc(a.label)}</b> · ${a.peak}% `
            + `<span class="muted-note">(${a.weeks} wk${a.weeks === 1 ? "" : "s"}${span ? ", " + esc(span) : ""}, ${Math.round(a.hours)}h)</span></div>`;
        }).join("")
      : `<span class="wb-note">no project work booked</span>`)
      + (allocs.over
          ? `<div class="wb-why">Over-allocated ${allocs.over.pct}% in ${esc(allocs.over.week)} — the projects above add up past a full week</div>`
          : "");
    const rates = isAdmin ? (() => {
      const any = allocs.map((a) => wbRateFor(a.resourceId)).find(Boolean);
      return any ? `<td class="num">${any.rate ?? "—"}</td><td class="num">${any.offshore ?? "—"}</td>`
                 : `<td class="num">—</td><td class="num">—</td>`;
    })() : "";
    const slot = r.fullSlot > 0
      ? `<span class="pill wb-pill-ok">yes</span>`
      : (r.free > 0 ? `<span class="pill wb-pill-warn">part-time only</span>`
                    : `<span class="pill wb-pill-over">no</span>`);
    const cls = r.free >= 75 ? "wb-pill-ok" : r.free >= 50 ? "wb-pill-warn" : "wb-pill-over";
    return `<tr>
      <td><b>${esc(x.name)}</b></td>
      <td>${esc(x.home_title || "—")}</td>
      <td class="num"><span class="pill ${cls}">${r.free}%</span></td>
      <td>${slot}</td>
      <td class="num">${r.avg}% avg <span class="muted-note">/ ${r.peak}% peak</span></td>
      <td>${allocHtml}</td>
      ${rates}
      <td class="wb-cmp-act">
        <button class="btn mini" data-act="move" data-pid="${x.id}" title="Propose moving part of this person to another project">Move…</button>
        <button class="btn mini" data-act="unpick" data-pid="${x.id}" title="Remove from comparison">✕</button>
      </td>
    </tr>`;
  }).join("");

  box.innerHTML = `
    <div class="wb-cmp-head">
      <b>Comparing ${people.length} resource${people.length === 1 ? "" : "s"}</b>
      <span class="muted-note">over ${esc(win.label)}</span>
      <button class="btn mini" id="wbCmpClear">Clear</button>
    </div>
    <div class="table-wrap glass"><table class="wb-cmp">${head}${rows}</table></div>
    <div class="muted-note" style="margin-top:6px">% free = 100 − average booked% across the window. “Full slot?” = is there any week with a full 100% free.</div>`;

  $$("#wbCompare button[data-act=unpick]").forEach((b) => b.addEventListener("click", () => {
    WB.compare = WB.compare.filter((i) => i !== +b.dataset.pid);
    renderWbLoad(); renderWbCompare();
  }));
  $$("#wbCompare button[data-act=move]").forEach((b) => b.addEventListener("click", () => {
    openMoveModal(+b.dataset.pid);
  }));
  const clr = $("#wbCmpClear");
  if (clr) clr.addEventListener("click", () => { WB.compare = []; renderWbLoad(); renderWbCompare(); });
}

/* ============================================================================
   GH-53 — reallocation requests, the bell, and the audit trail.
   Rijoy: "the allocation happen once FOP PM approved, so there should be a
   notification bell icon on the top right hand side ... I can approve or reject
   and all these get tracked and noted. and the same option the admin should have
   too and incase of admin he can do it for any client and project and resource
   including PM".
   ========================================================================== */

/* All projects the person could move TO. For a PM that is their own projects
   (a PM may only place work they own); for an admin, every project. */
function moveTargetProjects() {
  const own = (WB.projects || []).map((p) => ({ client: p.client, project: p.project }));
  const isAdmin = !!(state.me && state.me.role === "admin");
  if (!isAdmin) return own;
  // Admins get the full project list from state (if loaded); fall back to own.
  const all = ((state.projects || []).length ? state.projects
    : (state.resources || []).map((r) => ({ client: r.client, project: r.project })));
  const seen = new Set(own.map((p) => `${p.client}||${p.project}`));
  all.forEach((p) => {
    const k = `${p.client}||${p.project}`;
    if (p.project && !seen.has(k)) { seen.add(k); own.push({ client: p.client, project: p.project }); }
  });
  return own.sort((a, b) => `${a.client}${a.project}`.localeCompare(`${b.client}${b.project}`));
}

function openMoveModal(pid) {
  const x = WB.load.find((q) => q.id === pid);
  if (!x) return;
  const win = wbLoadWindow();
  const allocs = wbAllocations(x, win);
  const mine = wbAvailability(x, win);
  if (!allocs.length) {
    toast(`${x.name} has no current booking to move — assign them to a project first.`, true);
    return;
  }
  const st = WB.move = { pid, from: allocs[0], pct: 50, until: "", reason: "" };
  const fromOpts = allocs.map((a, i) =>
    `<option value="${i}">${esc(a.label)} — ${a.peak}% (${a.weeks} wk)</option>`).join("");
  const toOpts = moveTargetProjects().map((p) =>
    `<option value="${esc(p.client)}||${esc(p.project)}">${esc(p.client)} · ${esc(p.project)}</option>`).join("");
  const isAdmin = !!(state.me && state.me.role === "admin");

  $("#moveTitle").textContent = `Move ${x.name}`;
  $("#moveBody").innerHTML = `
    <div class="mv-sum">
      <b>${esc(x.name)}</b> <span class="muted-note">${esc(x.home_title || "")}</span>
      — currently ${mine.free}% free over ${esc(win.label)}
    </div>
    <label class="f">Move OFF <span class="muted-note">(the project releasing capacity)</span></label>
    <select id="mvFrom" class="cur-sel">${fromOpts}</select>

    <label class="f">Take <span class="muted-note">% of capacity</span></label>
    <select id="mvPct" class="cur-sel">
      ${[25, 50, 75, 100].map((v) => `<option value="${v}"${v === 50 ? " selected" : ""}>${v}%</option>`).join("")}
    </select>

    <label class="f">Move TO <span class="muted-note">(the project taking the work)</span></label>
    <select id="mvTo" class="cur-sel"><option value="">— pick a project —</option>${toOpts}</select>

    <label class="f">For how long?</label>
    <select id="mvKind" class="cur-sel">
      <option value="">Permanent (no return date)</option>
      <option value="loan">Loan — comes back on a date</option>
    </select>
    <div id="mvUntilWrap" class="hidden">
      <label class="f">Return date</label>
      <input type="date" id="mvUntil" class="inp">
      <div class="muted-note" style="margin-top:4px">The releasing project gets the share back automatically on this date, with a 7-day heads-up to both PMs.</div>
    </div>

    <label class="f">Why? <span class="muted-note">(shown to the approving PM)</span></label>
    <textarea id="mvReason" class="inp" rows="2" placeholder="e.g. covering the Quadient migration while Sunil is on leave"></textarea>

    <div class="muted-note mv-note" id="mvNote"></div>
    <div class="mv-actions">
      <button class="btn primary" id="mvSubmit">${isAdmin ? "Move now (applies immediately)" : "Send request for approval"}</button>
      <button class="btn ghost" id="mvCancel">Cancel</button>
    </div>`;
  $("#moveModal").classList.remove("hidden");
  const upd = () => {
    const a = allocs[+$("#mvFrom").value] || allocs[0];
    const pct = +$("#mvPct").value;
    const over = pct > a.peak;
    $("#mvNote").innerHTML = over
      ? `⚠ ${esc(x.name)} is only at <b>${a.peak}%</b> on ${esc(a.label)} — asking for ${pct}% takes more than that project currently holds.`
      : `Takes ${pct}% off ${esc(a.label)}, leaving ${Math.max(0, a.peak - pct)}% there.`;
    $("#mvNote").classList.toggle("mv-warn", over);
  };
  $("#mvFrom").addEventListener("change", upd);
  $("#mvPct").addEventListener("change", upd);
  $("#mvKind").addEventListener("change", (e) => {
    $("#mvUntilWrap").classList.toggle("hidden", e.target.value !== "loan");
  });
  upd();
  // `moveClose` lives in the modal HEADER (outside #moveBody); `mvCancel` and
  // `mvSubmit` are inside the body we just wrote. Guarded individually: a
  // mismatch here silently killed the whole submit flow — the API suite passed
  // because it never touches the DOM wiring, and only driving the real modal in
  // a browser caught it (workbench.js:996, "Cannot read properties of null").
  const wire = (sel, fn) => { const el = $(sel); if (el) el.addEventListener("click", fn); };
  wire("#moveClose", closeMoveModal);
  wire("#mvCancel", closeMoveModal);
  wire("#mvSubmit", submitMove);
}

function closeMoveModal() {
  $("#moveModal").classList.add("hidden");
  WB.move = null;
}

async function submitMove() {
  const st = WB.move;
  if (!st) return;
  const a = wbAllocations(WB.load.find((q) => q.id === st.pid), wbLoadWindow())[+$("#mvFrom").value];
  const toRaw = $("#mvTo").value;
  if (!toRaw) { toast("Pick the project to move them to.", true); return; }
  const toClient = toRaw.split("||")[0], toProject = toRaw.split("||")[1];
  const kind = $("#mvKind").value;
  const until = kind === "loan" ? ($("#mvUntil").value || "") : "";
  if (kind === "loan" && !until) { toast("Pick the return date for the loan.", true); return; }
  const pct = +$("#mvPct").value;
  const body = {
    person_id: st.pid,
    from_client: a.client, from_project: a.project, from_pct: pct,
    to_client: toClient, to_project: toProject, to_pct: pct,
    until_date: until, reason: ($("#mvReason").value || "").trim(),
  };
  const btn = $("#mvSubmit");
  btn.disabled = true; btn.textContent = "Working…";
  try {
    const res = await api("/api/allocation-requests", { method: "POST", body: JSON.stringify(body) });
    closeMoveModal();
    const applied = res.status === "applied";
    toast(applied
      ? `Moved ${pct}% of ${a.label} → ${toClient} · ${toProject}. Recorded in the bell.`
      : `Request sent — ${toClient} · ${toProject} moves once ${res.request.from_owner || "an admin"} approves it.`);
    await refreshBell();
    await renderResources();
  } catch (e) {
    toast(e.message || "Could not raise the request", true);
    btn.disabled = false; btn.textContent = "Try again";
  }
}

/* ---------------- the bell ---------------- */
let bellData = { needs_deciding: [], sent: [], decided: [], unread: 0 };

async function refreshBell() {
  const badge = $("#bellBadge");
  try {
    bellData = await api("/api/notifications");
  } catch (e) {
    return;                                   // silent: the bell is not critical
  }
  const n = bellData.unread || 0;
  if (badge) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n === 0);
  }
  const btn = $("#btnBell");
  if (btn) btn.classList.toggle("bell-alert", n > 0);
  if ($("#bellPanel") && !$("#bellPanel").classList.contains("hidden")) renderBell();
}

function reqRow(r, mode) {
  const statusPill = {
    pending: `<span class="pill wb-pill-warn">awaiting ${esc(r.from_owner || "an admin")}</span>`,
    approved: `<span class="pill wb-pill-ok">approved by ${esc(r.decided_by)}</span>`,
    applied: `<span class="pill wb-pill-ok">applied${r.decided_by ? " by " + esc(r.decided_by) : ""}</span>`,
    rejected: `<span class="pill wb-pill-over">rejected by ${esc(r.decided_by)}</span>`,
    cancelled: `<span class="pill wb-pill-free">cancelled</span>`,
    expired: `<span class="pill wb-pill-over">expired</span>`,
  }[r.status] || `<span class="pill">${esc(r.status)}</span>`;
  const actions = mode === "needs"
    ? `<div class="bl-acts">
         <button class="btn mini primary" data-bl="approve" data-id="${r.id}">Approve</button>
         <button class="btn mini" data-bl="reject" data-id="${r.id}">Reject</button>
         <button class="btn mini" data-bl="trail" data-id="${r.id}">Details</button>
       </div>`
    : `<div class="bl-acts"><button class="btn mini" data-bl="trail" data-id="${r.id}">Details</button>
       ${r.status === "pending" && r.mine ? `<button class="btn mini" data-bl="cancel" data-id="${r.id}">Withdraw</button>` : ""}</div>`;
  return `<div class="bl-req" data-req="${r.id}">
      <div class="bl-line1">${statusPill} <span class="muted-note">#${r.id} · ${esc(r.requester)} · ${esc(r.created_at)}</span></div>
      <div class="bl-sum">${esc(r.summary)}</div>
      ${r.reason ? `<div class="muted-note">“${esc(r.reason)}”</div>` : ""}
      ${actions}
      <div class="bl-trail hidden" id="blTrail${r.id}"></div>
    </div>`;
}

function renderBell() {
  const body = $("#bellBody");
  if (!body) return;
  const needs = bellData.needs_deciding || [], sent = bellData.sent || [], done = bellData.decided || [];
  let html = "";
  html += `<div class="bl-sec"><b>Needs my decision</b>${needs.length ? "" : ` <span class="muted-note">— nothing waiting</span>`}</div>`;
  html += needs.length ? needs.map((r) => reqRow(r, "needs")).join("")
    : `<div class="muted-note bl-empty">No reallocation requests are waiting on you.</div>`;
  if (sent.length) {
    html += `<div class="bl-sec"><b>Sent by me (${sent.length})</b></div>`;
    html += sent.map((r) => reqRow(r, "sent")).join("");
  }
  if (done.length) {
    html += `<div class="bl-sec"><b>Recently decided (${done.length})</b></div>`;
    html += done.slice(0, 10).map((r) => reqRow(r, "done")).join("");
  }
  body.innerHTML = html;
  $$("#bellBody button[data-bl]").forEach((b) => b.addEventListener("click", () => bellAction(b.dataset.bl, +b.dataset.id)));
}

async function bellAction(act, id) {
  try {
    if (act === "approve") {
      const res = await api(`/api/allocation-requests/${id}/approve`, { method: "POST", body: "{}" });
      toast("Approved — the allocation is applied.");
      await refreshBell();
      if (state.view === "resources") await renderResources();
      return;
    }
    if (act === "reject") {
      const note = prompt("Why are you rejecting this? (required)");
      if (note === null) return;
      if (!note.trim()) { toast("A reason is required.", true); return; }
      await api(`/api/allocation-requests/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) });
      toast("Rejected — nothing was moved.");
      await refreshBell(); return;
    }
    if (act === "cancel") {
      await api(`/api/allocation-requests/${id}/cancel`, { method: "POST" });
      toast("Request withdrawn.");
      await refreshBell(); return;
    }
    if (act === "trail") {
      const box = $(`#blTrail${id}`);
      if (!box) return;
      if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
      const d = await api(`/api/allocation-requests/${id}/trail`);
      box.innerHTML = `<div class="bl-trail-in">
        <div><b>${esc(d.person)}</b> — ${int_(d.from_pct)}% of capacity moves ${esc(d.from_client)} · ${esc(d.from_project)} → ${esc(d.to_client)} · ${esc(d.to_project)}</div>
        <div class="muted-note">${d.permanent ? "Permanent" : "Loan until " + esc(d.until_date)} · effective from ${esc(d.effective_label)}${d.from_owner ? " · releasing PM: " + esc(d.from_owner) : " · no PM on the source project (an admin decides)"}</div>
        <div class="bl-events">${(d.events || []).map((e) =>
          `<div><span class="muted-note">${esc(e.at)}</span> <b>${esc(e.actor)}</b> ${esc(e.action)}${e.detail ? " — " + esc(e.detail) : ""}</div>`).join("")}</div>
      </div>`;
      box.classList.remove("hidden");
    }
  } catch (e) {
    toast(e.message || "That notification action failed", true);
  }
}

const int_ = (v) => Math.round(Number(v) || 0);

function bindBell() {
  const btn = $("#btnBell"), panel = $("#bellPanel");
  if (!btn || !panel) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) { renderBell(); refreshBell(); }
  });
  const close = $("#bellClose");
  if (close) close.addEventListener("click", () => panel.classList.add("hidden"));
  const rf = $("#bellRefresh");
  if (rf) rf.addEventListener("click", () => refreshBell());
  // Click-away closes it, but never when the click is inside the panel.
  document.addEventListener("click", (e) => {
    if (panel.classList.contains("hidden")) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    panel.classList.add("hidden");
  });
  // A slow poll keeps the badge honest without a websocket. Paused when the tab
  // is hidden so a backgrounded tab costs nothing.
  setInterval(() => { if (!document.hidden) refreshBell(); }, 60000);
  refreshBell();
}

function bindResources() {
  const lt = $("#wbLoadTitle");
  if (lt) lt.addEventListener("change", () => { WB.loadTitle = lt.value; renderResources(); });
  const lf = $("#wbLoadFilter");
  if (lf) lf.addEventListener("input", () => { WB.loadFilter = lf.value; renderResources(); });
  const ws = $("#wbLoadWindowSel");
  if (ws) ws.addEventListener("change", () => { WB.loadWindow = ws.value; renderResources(); });
}

/* Render the whole roster into #wbLoad: available people first, ranked and
   bucketed, then a collapsed "cannot take work" section.
   (Name kept as renderWbLoad so existing callers — renderWorkbench — do not
   silently stop updating the rail.) */
function renderWbLoad() {
  const box = $("#wbLoad");
  if (!box) return;

  /* Populate the title dropdown once, from the rate-card vocabulary already on
     the payload (bare strings, no money). */
  const sel = $("#wbLoadTitle");
  if (sel && sel.options.length <= 1 && (WB.titles || []).length) {
    sel.innerHTML = `<option value="">— all titles —</option>` +
      WB.titles.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    sel.value = WB.loadTitle || "";
  }
  const ws = $("#wbLoadWindowSel");
  if (ws && ws.value !== (WB.loadWindow || "auto")) ws.value = WB.loadWindow || "auto";

  const win = wbLoadWindow();
  const scope = $("#wbLoadScope");
  if (scope) scope.textContent = win.label;

  const f = WB.loadFilter.trim().toLowerCase();
  const t = (WB.loadTitle || "").trim().toLowerCase();

  const matched = WB.load.filter((x) => {
    if (f && !x.name.toLowerCase().includes(f)) return false;
    if (t) {
      const held = approvedTitles(x.id).map((s) => (s || "").toLowerCase());
      const home = (x.home_title || "").toLowerCase();
      if (home !== t && !held.includes(t)) return false;
    }
    return true;
  }).map((x) => ({ x, ...wbAvailability(x, win) }));

  const open = matched.filter((r) => r.free > 0)
    .sort((a, b) => (b.free - a.free) || (b.fullSlot - a.fullSlot) || a.x.name.localeCompare(b.x.name));
  const busy = matched.filter((r) => r.free === 0)
    .sort((a, b) => (b.fullSlot - a.fullSlot) || a.x.name.localeCompare(b.x.name));

  // A title/search filter can remove everyone in one group; say so rather than
  // silently emptying a section.
  if (!matched.length) {
    box.innerHTML = `<div class="wb-empty">No resources match${t ? " that title" : ""}. Try clearing the title filter or the search box.</div>`;
    return;
  }

  let html = `<div class="wb-count">${matched.length} of ${WB.load.length} resources — <b>${open.length} with free capacity</b>, ${busy.length} fully booked</div>`;

  let last = null;
  open.forEach((r) => {
    const bucket = WB_BUCKETS.find((b) => r.free >= b.min);
    if (bucket !== last) {
      last = bucket;
      html += `<div class="wb-bucket">${esc(bucket.label)} <span class="wb-bucket-n">${open.filter((o) => WB_BUCKETS.find((b) => o.free >= b.min) === bucket).length}</span></div>`;
    }
    html += wbLoadCard(r.x, r, {});
  });
  if (!open.length) {
    html += `<div class="wb-empty">Nobody has free capacity in this window${t ? " for that title" : ""}.</div>`;
  }

  // Rijoy (2026-10-02): "the list should have all the resources not just few all
  // available, non available ones too." So this group is OPEN by default — a
  // closed <details> made the busy half of the roster look missing. It stays a
  // <details> so it can be collapsed, but it renders expanded.
  if (busy.length) {
    html += `<details class="wb-unavail" open>
      <summary>Fully booked — no free capacity in this window <span class="wb-bucket-n">${busy.length}</span> <span class="muted-note">— click to collapse</span></summary>
      ${busy.map((r) => wbLoadCard(r.x, r, {})).join("")}
    </details>`;
  }
  box.innerHTML = html;

  $$("#wbLoad .wb-load button[data-act=view]").forEach((b) => b.addEventListener("click", () => {
    const pid = +b.closest(".wb-load").dataset.pid;
    openAssignModal(wbSel(), pid, null);
  }));
  // GH-53: Move is on EVERY row, not only inside the compare panel. Rijoy had to
  // ask "how does the move resource work, where do I do that?" — a feature you
  // cannot find is not shipped. Same handler the compare button uses.
  $$("#wbLoad .wb-load button[data-act=move]").forEach((b) => b.addEventListener("click", () => {
    openMoveModal(+b.closest(".wb-load").dataset.pid);
  }));
  // GH-52: the compare checkbox. Kept out of the Assign path on purpose — ticking
  // a box must not open a dialog.
  $$("#wbLoad input[data-act=pick]").forEach((cb) => cb.addEventListener("change", () => {
    const pid = +cb.dataset.pid;
    if (cb.checked) { if (!WB.compare.includes(pid)) WB.compare.push(pid); }
    else WB.compare = WB.compare.filter((i) => i !== pid);
    renderWbCompare();
  }));
  // Any week cell opens the detail popup for that person+week.
  $$("#wbLoad .wb-wk").forEach((el) => el.addEventListener("click", () => {
    const pid = +el.closest(".wb-load").dataset.pid;
    openWeekDetail(pid, +el.dataset.wk);
  }));
}

/* ---------------- assignment dialog ---------------- */
let wbCheckTimer = null;

function approvedTitles(pid) {
  const p = WB.people.find((x) => x.id === pid);
  if (!p) return [];
  const out = (p.titles || []).slice();
  if (p.home_title && !out.includes(p.home_title)) out.unshift(p.home_title);
  return out;
}

function openAssignModal(project, pid, rid) {
  if (!project) { toast("Pick a project first", true); return; }
  const editing = rid != null;
  const team = project.team || [];
  const alreadyIds = team.filter((t) => t.id !== rid).map((t) => t.person_id);
  const cur = editing ? team.find((t) => t.id === rid) : null;
  if (editing && !cur) { toast("That resource is no longer on this project", true); return; }

  /* GH-54 — Edit is about THIS resource. Rijoy: "I don't have to select the
     resource from the list when I am already selecting the Edit for the
     resource". So editing shows NO person picker: the person is fixed and named,
     and every field opens on what the resource ACTUALLY has.
     On CREATE the picker stays — there is nobody to pre-choose. */
  const choices = editing
    ? [cur.person_id]
    : WB.people.filter((x) => !alreadyIds.includes(x.id) && !(x.active === 0)).map((x) => x.id);
  if (!editing && !choices.length) {
    showModalHTML("Add team member",
      `<p class="muted-note">Nobody left to add — everyone in the People list is already on this project.</p>`);
    return;
  }
  const selPid = editing ? cur.person_id : (pid || choices[0]);
  const p = WB.people.find((x) => x.id === selPid) || null;
  if (!p) {
    showModalHTML(editing ? "Edit assignment" : "Add team member",
      `<p class="muted-note">${editing
        ? "This resource is not linked to a person record any more. Remove it from the project and add the person again."
        : "That person could not be found in the People list."}</p>`);
    return;
  }

  // The title the resource is booked under HERE — not their home title. Seeding
  // the home title was a real defect: 8 live rows are booked under a different
  // title (a QA booked as a Quadient Developer), so Edit showed the home title
  // and a save silently re-titled the booking.
  const bookedTitle = (cur && (cur.role || "").trim()) || "";
  // Open on the real values. Legacy rows store no %/window, so the server sends
  // them DERIVED from the plan; defaulting to a flat 50% and blank dates here is
  // what made Edit look empty.
  const seedPct = cur && cur.allocation_pct != null ? cur.allocation_pct : 50;
  const seedStart = cur ? (cur.start_date || "") : "";
  const seedEnd = cur ? (cur.end_date || "") : "";
  const seedException = cur ? (cur.title_exception || "") : "";

  const body = `
    <div class="assign-grid">
      <div>
        <label class="f">${editing ? "Resource" : "Person"}</label>
        ${editing
          ? `<div class="asg-locked">
               <b>${esc(p.name)}</b>
               <span class="muted-note">${esc(p.home_title || "no home title")}${p.country ? " · " + esc(p.country) : ""}</span>
             </div>`
          : `<select id="wbPerson">
               ${choices.map((idv) => { const x = WB.people.find((y) => y.id === idv) || {};
                 return `<option value="${idv}" ${idv === selPid ? "selected" : ""}>${esc(x.name)} — ${esc(x.home_title || "no title")} — ${esc(peakLabel(idv))}</option>`; }).join("")}
             </select>`}
      </div>
      <div>
        <label class="f">Booked title <span class="muted-note">(approved titles only)</span></label>
        <select id="wbTitle"></select>
        ${editing && bookedTitle ? `<div class="muted-note" style="margin-top:5px">Booked on this project as <b>${esc(bookedTitle)}</b>.</div>` : ""}
      </div>
    </div>
    <div id="wbExcWrap" class="hidden">
      <label class="f">Why a different title? <span style="color:var(--red)">*required</span></label>
      <textarea id="wbExc" placeholder="e.g. covering BA work on this engagement while the home title is Developer">${esc(seedException)}</textarea>
      <div class="muted-note" style="margin-top:5px">Rijoy is flagged whenever the booked title differs from the home title.</div>
    </div>
    <div class="wb-modetabs" role="tablist">
      <button type="button" class="wb-modetab" data-mode="flat">Single allocation</button>
      <button type="button" class="wb-modetab" data-mode="phased">Phased (changes over time)</button>
    </div>
    <div class="muted-note" style="margin:-6px 0 12px">
      Phased is for an engagement that tapers — e.g. 100% for the first 3 months,
      then 50%, then 25%. One row per person per project either way.
    </div>

    <!-- FLAT: one % across one window (unchanged behaviour) -->
    <div id="wbFlat">
      <div>
        <label class="f">Allocation — % of their weekly capacity</label>
        <div class="wb-slide">
          <!-- 25% increments per Rijoy: 25 / 50 / 75 / 100. A finer step let the slider
             rest on values nobody allocates at (35%, 45%) while the chips beside it
             already offered only quarters. -->
          <input type="range" id="wbPct" min="0" max="100" step="25" value="${seedPct}">
          <span class="wb-pctval" id="wbPctVal">${seedPct}%</span>
        </div>
        <div class="wb-chips" id="wbChips">
          ${[25, 50, 75, 100].map((v) => `<div class="wb-chip" data-v="${v}">${v}%</div>`).join("")}
        </div>
      </div>
      <div class="assign-grid" style="margin-top:14px">
        <div><label class="f">Start date</label><input type="date" id="wbStart" value="${esc(seedStart)}"></div>
        <div><label class="f">End date</label><input type="date" id="wbEnd" value="${esc(seedEnd)}"></div>
      </div>
    </div>

    <!-- PHASED: an ordered list of (% , start, end) legs -->
    <div id="wbPhased" class="hidden">
      <label class="f">Phases <span class="muted-note">— dates snap to whole weeks (Mon–Sun)</span></label>
      <div id="wbPhaseRows"></div>
      <div class="wb-phase-actions">
        <button type="button" class="btn mini" id="wbAddPhase">+ Add phase</button>
        <button type="button" class="btn mini" id="wbSplitPhase" title="Split the last phase in half so you can taper it">Split last phase</button>
      </div>
      <div class="muted-note" style="margin-top:8px">
        Phases must not overlap. Each owns whole weeks, and the last one runs to
        its end date — leave an end date blank to run to the year end.
      </div>
    </div>

    <div class="wb-verdict ok" id="wbVerdict" style="margin-top:14px">Checking…</div>
    <div class="muted-note" id="wbFillNote">${editing
      ? "Changing the allocation % or the dates re-spreads the weekly grid. Leaving them alone keeps every week exactly as planned."
      : "Leave the dates blank to spread the allocation across the whole year. The app fills the weekly grid; you can fine-tune individual weeks afterwards on Planned."}</div>
  `;
  showModalHTML(editing ? `Edit — ${p.name}` : `Add team member — ${project.client} · ${project.project}`, body);

  const $p = $("#wbPerson");     // null when editing — the person is fixed
  const homeOf = (pidv) => (WB.people.find((x) => x.id === pidv) || {}).home_title || "";
  function fillTitles() {
    const pidv = $p ? +$p.value : selPid;
    const list = approvedTitles(pidv);
    const home = homeOf(pidv);
    // Seed the CURRENT booking when editing, never the home title.
    const want = editing ? bookedTitle : home;
    $("#wbTitle").innerHTML = list.length
      ? list.map((t) => `<option value="${esc(t)}" ${t === want ? "selected" : ""}>${esc(t)}${t === home ? " (home)" : ""}</option>`).join("")
      : `<option value="">— no approved title —</option>`;
    if (editing && bookedTitle && !list.includes(bookedTitle)) {
      // The booking is not on their approved list (legacy data). Keep it
      // selectable so a no-op save cannot silently re-title them.
      $("#wbTitle").innerHTML = `<option value="${esc(bookedTitle)}" selected>${esc(bookedTitle)} — current booking</option>`
        + $("#wbTitle").innerHTML;
    }
    syncException();
  }
  function syncException() {
    const ttl = $("#wbTitle").value;
    const home = homeOf($p ? +$p.value : selPid);
    // A title that is simply what they are ALREADY booked under is not a change,
    // so never demand a reason for a legacy booking (8 live rows would become
    // unsaveable). A real CHANGE to a non-home title still requires one.
    const needs = editing
      ? (ttl !== bookedTitle && (!home || ttl !== home))
      : (!home || (ttl && ttl !== home));
    $("#wbExcWrap").classList.toggle("hidden", !needs);
  }
  function syncChips() {
    const v = +$("#wbPct").value;
    $("#wbPctVal").textContent = v + "%";
    $$("#wbChips .wb-chip").forEach((c) => c.classList.toggle("on", +c.dataset.v === v));
  }
  function check() {
    clearTimeout(wbCheckTimer);
    wbCheckTimer = setTimeout(async () => {
      const pidv = $p ? +$p.value : selPid;
      try {
        let v;
        if (mode === "phased") {
          // A phase list is a structure, so this is a POST. The server applies
          // the SAME 100% rule per phase and returns a week-aligned schedule.
          v = await api("/api/assignment/check-phases", {
            method: "POST",
            body: JSON.stringify({
              person_id: pidv, phases: phaseRows,
              exclude_resource_id: editing ? rid : null,
            }),
          });
        } else {
          const q = new URLSearchParams({
            person_id: pidv, allocation_pct: $("#wbPct").value,
            start_date: $("#wbStart").value || "", end_date: $("#wbEnd").value || "",
          });
          if (editing) q.set("exclude_resource_id", rid);
          v = await api(`/api/assignment/check?${q.toString()}`);
        }
        renderVerdict(v, $("#wbTitle").value);
      } catch (e) {
        $("#wbVerdict").className = "wb-verdict bad";
        $("#wbVerdict").textContent = e.message || "Could not check allocation.";
      }
    }, 140);
  }
  function renderVerdict(v, ttl) {
    const el = $("#wbVerdict");
    const cap = (v.person && v.person.capacity) || 40;
    const pct = +$("#wbPct").value;
    const wk = Math.round(pct / 100 * cap * 10) / 10;
    const name = (v.person && v.person.name) || "This person";
    const titleNote = ttl && v.person && ttl !== (WB.people.find((x) => x.id === v.person.id) || {}).home_title
      ? `<br>Booking as <b>${esc(ttl)}</b>.` : "";
    // Invalid phase list (overlap / out of range) short-circuits before the
    // 100% test — show that reason rather than a misleading "no conflict".
    if (v.invalid) {
      el.className = "wb-verdict bad";
      el.innerHTML = `<b>⛔ Fix the phases.</b><br>${esc(v.invalid)}${titleNote}`;
      $("#modalOk").disabled = true; $("#modalOk").style.opacity = ".45";
      return;
    }
    if (v.ok && v.schedule && v.schedule.length) {
      // Phased: spell out each leg and the total, so the taper is verifiable
      // before committing rather than discovered in the weekly grid later.
      el.className = "wb-verdict ok";
      const rows = v.schedule.map((x) => {
        const span = x.first_week && x.last_week
          ? `${esc(x.first_week)} → ${esc(x.last_week)}` : "—";
        return `<li><b>${x.allocation_pct}%</b> · ${span} · ${x.weeks} week(s)`
             + ` · ${fmtH(x.hours_per_week)} h/week</li>`;
      }).join("");
      el.innerHTML = `<b>OK — no conflict.</b> ${esc(name)} gets a ${v.schedule.length}-phase plan
        totalling <b>${fmtH(v.total_hours)} h</b> across ${v.weeks_in_window} week(s).
        <ul>${rows}</ul>${titleNote}`;
    } else if (v.ok) {
      el.className = "wb-verdict ok";
      el.innerHTML = `<b>OK — no conflict.</b> ${esc(name)} would be at
        <b>${wk} h/week (${pct}%)</b> across ${v.weeks_in_window} week(s).${titleNote}`;
    } else {
      el.className = "wb-verdict bad";
      const c = (v.conflicts || [])[0] || {};
      const others = (c.existing || []).slice(0, 3).map(esc).join(", ") || "existing assignments";
      const more = v.conflict_count > (v.conflicts || []).length
        ? `<br>…and ${v.conflict_count - v.conflicts.length} more week(s).` : "";
      const atPct = c.phase_pct != null ? c.phase_pct : pct;
      el.innerHTML = `<b>⛔ Cannot assign ${esc(name)} at ${atPct}%.</b><br>
        This exceeds 100% of capacity in <b>${v.conflict_count} week(s)</b>.<br>
        First clash: <b>${esc(c.label || "?")}</b> would reach <b>${c.total_pct}%</b>
        (${c.existing_pct}% already booked on ${others}).${more}
        <ul>
          <li>Lower the allocation to <b>${Math.max(0, Math.round(100 - c.existing_pct))}%</b> or less, or</li>
          <li>shorten the date range to a window they're free in.</li>
        </ul>${titleNote}`;
    }
    const ok = v.ok;
    $("#modalOk").disabled = !ok;
    $("#modalOk").style.opacity = ok ? "" : ".45";
  }

  if ($p) $p.addEventListener("change", () => { fillTitles(); check(); });
  $("#wbTitle").addEventListener("change", () => { syncException(); check(); });
  $("#wbPct").addEventListener("input", () => { syncChips(); check(); });
  $("#wbStart").addEventListener("change", check);
  $("#wbEnd").addEventListener("change", check);
  $$("#wbChips .wb-chip").forEach((c) => c.addEventListener("click", () => {
    $("#wbPct").value = c.dataset.v; syncChips(); check();
  }));

  /* ---------------- time-phased allocation editor ----------------
   * A taper is modelled as an ordered list of phases on ONE assignment row, so
   * the person stays a single entry on the project (counts, utilization and the
   * Excel round-trip all stay clean). Dates are snapped to the week containing
   * them, because allocation is written per week (Mon-Sun) — letting a user pick
   * a Tuesday would make the phase boundary ambiguous.
   */
  let mode = (cur && cur.phases && cur.phases.length) ? "phased" : "flat";
  let phaseRows = (cur && cur.phases && cur.phases.length)
    ? cur.phases.map((x) => ({ allocation_pct: x.allocation_pct, start_date: x.start_date || "", end_date: x.end_date || "" }))
    : [];

  // Snap an ISO date to the Monday of the week that contains it. The server sends
  // the week labels, so we snap against the same calendar the app writes with.
  /* Format a Date as YYYY-MM-DD using LOCAL calendar fields.
     toISOString() converts to UTC first, so in any timezone AHEAD of UTC
     (e.g. Europe) a local-midnight Date serialises to the PREVIOUS day and the
     picker would show a date one day off. This app is used from different
     machines, so never round-trip a calendar date through UTC. */
  function isoLocal(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* Snap a picked date to the week that CONTAINS it.

     Weeks run Monday->Sunday and an assignment is allocated per WEEK, so the
     phase takes the whole week the PM pointed at:
       start -> the Monday of that week  (never LATER than the picked date)
       end   -> the Sunday of that week  (never EARLIER than the picked date)

     GH-45 follow-up (Rijoy, 2026-10-02: "i tried selecting 30oct as end date and
     it select nov 11 instead"). The previous version did NOT do this. For a
     start it searched backwards only when the date was not already a Monday, and
     for an end it searched FORWARD to the first Sunday on or after the date.
     Measured in the live app: picking Fri 2026-10-02 as a start showed Sep-28
     (-4 days) and picking Fri 2026-10-30 as an end showed Nov-08 (+9 days) — up
     to +12 days, which is why the two dates looked unrelated to what was typed.
     Worse, the forward-only end search could land AFTER a start that had
     snapped backwards, giving end < start for adjacent picks.

     Containing-week snapping is symmetric (max 6 days), keeps start <= end for
     any pair of picks, and matches the server: _weeks_between() owns a week when
     its Monday falls inside [start,end], so these boundaries tile the span
     exactly. */
  function snapToWeek(iso, which) {
    if (!iso || !(WB.weekLabels || []).length) return iso;
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    const monday = new Date(d.getTime() - ((d.getDay() + 6) % 7) * 86400000);
    if (which === "end") {
      // `monday` is midnight local; +6 days lands on Sunday of the same week.
      return isoLocal(new Date(monday.getTime() + 6 * 86400000));
    }
    return isoLocal(monday);
  }

  function renderPhaseRows() {
    const box = $("#wbPhaseRows");
    if (!box) return;
    if (!phaseRows.length) {
      box.innerHTML = `<div class="muted-note" style="padding:8px 0">No phases yet — add one, or use <b>Split last phase</b> after the first.</div>`;
    } else {
      box.innerHTML = phaseRows.map((r, i) => `
        <div class="wb-phase" data-i="${i}">
          <span class="wb-phase-n">${i + 1}</span>
          <input type="range" class="wb-ph-pct" min="0" max="100" step="25" value="${r.allocation_pct}">
          <span class="wb-ph-val">${r.allocation_pct}%</span>
          <input type="date" class="wb-ph-start" value="${r.start_date || ""}">
          <span class="wb-ph-arrow">→</span>
          <input type="date" class="wb-ph-end" value="${r.end_date || ""}">
          <button type="button" class="btn mini wb-ph-del" title="Remove this phase">✕</button>
        </div>`).join("");
    }
    $$("#wbPhaseRows .wb-phase").forEach((el) => {
      const i = +el.dataset.i;
      el.querySelector(".wb-ph-pct").addEventListener("input", (e) => {
        phaseRows[i].allocation_pct = +e.target.value;
        el.querySelector(".wb-ph-val").textContent = e.target.value + "%";
        check();
      });
      el.querySelector(".wb-ph-start").addEventListener("change", (e) => {
        phaseRows[i].start_date = snapToWeek(e.target.value, "start");
        renderPhaseRows(); check();
      });
      el.querySelector(".wb-ph-end").addEventListener("change", (e) => {
        phaseRows[i].end_date = snapToWeek(e.target.value, "end");
        renderPhaseRows(); check();
      });
      el.querySelector(".wb-ph-del").addEventListener("click", () => {
        phaseRows.splice(i, 1); renderPhaseRows(); check();
      });
    });
  }

  function setMode(m) {
    mode = m;
    $$(".wb-modetab").forEach((t) => t.classList.toggle("on", t.dataset.mode === m));
    $("#wbFlat").classList.toggle("hidden", m !== "flat");
    $("#wbPhased").classList.toggle("hidden", m !== "phased");
    $("#wbFillNote").classList.toggle("hidden", m !== "flat");
    if (m === "phased" && !phaseRows.length) {
      // Seed from whatever the flat form currently says, so switching modes
      // never loses the % / dates the user already typed.
      phaseRows = [{
        allocation_pct: +$("#wbPct").value || 0,
        start_date: snapToWeek($("#wbStart").value || "", "start"),
        end_date: snapToWeek($("#wbEnd").value || "", "end"),
      }];
      renderPhaseRows();
    }
    check();
  }
  $$(".wb-modetab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  $("#wbAddPhase").addEventListener("click", () => {
    // A new phase starts the week after the last one ends, so the common case
    // (append a leg) needs no date typing at all.
    const last = phaseRows[phaseRows.length - 1];
    let start = "";
    if (last && last.end_date) {
      const e = new Date(last.end_date + "T00:00:00");
      if (!isNaN(e)) start = new Date(e.getTime() + 86400000).toISOString().slice(0, 10);
    }
    // Pre-taper by one quarter, so the default taper reads 100 -> 75 -> 50 -> 25.
    // The floor stays on the 25% grid (0 is a valid 'bench' leg).
    phaseRows.push({ allocation_pct: last ? Math.max(0, last.allocation_pct - 25) : 50,
                     start_date: start, end_date: "" });
    renderPhaseRows(); check();
  });
  $("#wbSplitPhase").addEventListener("click", () => {
    const last = phaseRows[phaseRows.length - 1];
    if (!last) {
      phaseRows = [{ allocation_pct: +$("#wbPct").value || 50,
                     start_date: snapToWeek($("#wbStart").value || "", "start"),
                     end_date: snapToWeek($("#wbEnd").value || "", "end") }];
    } else {
      // Split the last phase at the midpoint WEEK boundary: same span, halved %
      // on each side. Midpoint is computed from the dates themselves, not a
      // timestamp, so a long phase cannot drift by a day. The boundary is a
      // Sunday (the last day of a week) so the two halves tile without a gap or
      // an overlap — week N ends Sunday and week N+1 starts the next Monday.
      const sd = new Date((last.start_date || "") + "T00:00:00");
      const ed = new Date((last.end_date || "") + "T00:00:00");
      if (isNaN(sd) || isNaN(ed) || ed <= sd) { toast("Give the last phase both dates before splitting it", true); return; }
      const days = Math.round((ed.getTime() - sd.getTime()) / 86400000);
      const weeks = Math.floor((days + 1) / 7);
      if (weeks < 2) { toast("This phase is only one week long — nothing to split", true); return; }
      const firstWeeks = Math.max(1, Math.round(weeks / 2));
      // Sunday ending the first half: Monday + (7*firstWeeks - 1) days.
      const cut = new Date(sd.getTime() + (7 * firstWeeks - 1) * 86400000);
      last.end_date = isoLocal(cut);
      // The second half starts the NEXT day (a Monday) and keeps the old end.
      phaseRows.push({ allocation_pct: last.allocation_pct,
                       start_date: isoLocal(new Date(cut.getTime() + 86400000)),
                       end_date: isoLocal(ed) });
    }
    renderPhaseRows(); check();
  });
  setMode(mode);

  // The modal's OK button performs the save; closeModal() clears the handler.
  const okBtn = $("#modalOk");
  setModalOk(async () => {
    const pidv = $p ? +$p.value : selPid;
    const excNeeded = !$("#wbExcWrap").classList.contains("hidden");
    const payload = {
      person_id: pidv, client: project.client, project: project.project,
      title: $("#wbTitle").value,
      // Send the reason only while it is actually required, so switching the
      // title back to the home title clears a stale exception instead of
      // leaving one attached to a home-title booking.
      title_exception: excNeeded ? (($("#wbExc") && $("#wbExc").value) || "") : "",
      // Flat fields stay populated even in phased mode so the headline % and
      // overall span are meaningful on the team table; the server prefers
      // `phases` when it is non-empty.
      allocation_pct: mode === "phased"
        ? (phaseRows[0] ? phaseRows[0].allocation_pct : 0)
        : +$("#wbPct").value,
      start_date: mode === "phased" ? (phaseRows[0] ? phaseRows[0].start_date : "") : ($("#wbStart").value || ""),
      end_date: mode === "phased"
        ? (phaseRows.reduce((a, r) => (r.end_date && r.end_date > a ? r.end_date : a), ""))
        : ($("#wbEnd").value || ""),
      phases: mode === "phased" ? phaseRows : null,
    };
    okBtn.disabled = true;
    try {
      if (editing) await api(`/api/assignments/${rid}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/assignments", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      toast(editing ? "Assignment updated" : "Team member added");
      await loadWorkbench();
    } catch (e) {
      // The server is the authority: surface its exact refusal in the verdict.
      $("#wbVerdict").className = "wb-verdict bad";
      $("#wbVerdict").innerHTML = `<b>⛔ Refused by the server.</b><br>${esc(e.message || "Save failed")}`;
      toast(e.message || "Save failed", true);
    } finally {
      okBtn.disabled = false;
    }
  });

  fillTitles(); syncChips(); check();
}

/* Clicking a week cell: show exactly WHERE that week was spent, the %/hours per
   project, and offer to jump to the project (so the PM can adjust it) or assign
   more work in that week. This is what makes the blocks actionable rather than
   decorative. */
function openWeekDetail(pid, wk) {
  const person = WB.load.find((x) => x.id === pid);
  if (!person) return;
  const lbl = (WB.weekLabels || [])[wk] || ("#" + wk);
  const mon = (WB.weekMonth || [])[wk] || "";
  const pct = (person.weeks || [])[wk] || 0;
  const detail = ((person.detail || [])[wk] || []);
  const cap = person.capacity || 40;
  const hrs = Math.round(pct / 100 * cap * 10) / 10;
  const state_ = pct > 100 ? `<span class="pill wb-pill-over">over capacity</span>`
    : pct >= 80 ? `<span class="pill wb-pill-ok">healthy</span>`
    : pct >= 1 ? `<span class="pill wb-pill-warn">partly booked</span>`
    : `<span class="pill wb-pill-free">free</span>`;
  const cur = WB.current || {};
  const isNowWeek = cur.week_index === wk;
  // "Now" needs to be stated, not inferred: the week containing today carries
  // the label of its Monday, so the current week can read as a PREVIOUS month
  // (Thu 1 Oct 2026 sits in the week labelled Sep-28 / month SEP).
  const nowBadge = (!isNowWeek && String(cur.month || "").toUpperCase() !== String(mon).toUpperCase())
    ? ""
    : `<span class="wk-now">● ${isNowWeek ? "This is the current week" : "Current month"}${isNowWeek && cur.week_start ? ` (${esc(cur.week_start)} → ${esc(cur.week_end)})` : ""}</span>`;
  const rows = detail.length
    ? `<table class="wk-tbl"><thead><tr><th>Client · Project</th><th class="num">Alloc</th>
         <th class="num">Hours</th><th></th></tr></thead><tbody>
         ${detail.map((d) => `<tr>
           <td><b>${esc(d.client || "—")}</b><div class="muted-note">${esc(d.project || "—")}</div></td>
           <td class="num">${d.pct}%</td>
           <td class="num">${fmtH(d.hours)}</td>
           <td>${isMine(d.client, d.project)
             ? `<button class="btn mini" data-goto="${d.resource_id}" data-client="${esc(d.client)}" data-project="${esc(d.project)}">Open project</button>`
             : `<span class="muted-note">not yours</span>`}</td>
         </tr>`).join("")}
         </tbody></table>`
    : `<div class="muted-note">No project hours booked in this week — ${esc(person.name)} is free.</div>`;
  const body = `
    <div class="wk-head">
      <div><b>${esc(person.name)}</b> <span class="muted-note">${esc(person.home_title || "—")}</span></div>
      <div>${esc(mon)} · week of <b>${esc(lbl)}</b> ${nowBadge}</div>
    </div>
    <div class="wk-sum">
      <div><span class="muted-note">Booked</span><br><b>${pct}%</b> <span class="muted-note">(${hrs} of ${fmtH(cap)} h)</span></div>
      <div><span class="muted-note">Status</span><br>${state_}</div>
    </div>
    ${rows}
    <div class="muted-note" style="margin-top:10px">Allocation is a share of a ${fmtH(cap)}-hour week. Editing a week's hours is done on the project itself, so the change stays attached to the work it belongs to.</div>
  `;
  showModalHTML(`${person.name} — ${mon} ${lbl}`.trim(), body);
  setModalOk(null);   // this popup is informational; its actions are its buttons
  $$("#modalBody button[data-goto]").forEach((b) => b.addEventListener("click", () => {
    const client = b.dataset.client, project = b.dataset.project;
    closeModal();
    // Select the project in the workbench so its team table is on screen.
    const hit = (WB.projects || []).find((p) => p.client === client && p.project === project);
    if (hit) { WB.selKey = wbKey(hit.client, hit.project); renderWorkbench(); }
    else toast(`No access to ${client} · ${project}`, true);
  }));
}

/* Is this (client, project) one of the PM's own? */
function isMine(client, project) {
  return (WB.projects || []).some((p) => p.client === client && p.project === project);
}

function peakLabel(pid) {
  const l = WB.load.find((x) => x.id === pid);
  if (!l) return "load unknown";
  if (l.peak_pct > 100) return `over capacity (${l.peak_pct}%)`;
  if (l.peak_pct >= 80) return `${l.peak_pct}% booked`;
  if (l.peak_pct >= 1) return `${l.peak_pct}% booked`;
  return "free";
}

function bindWorkbench() {
  const f = $("#wbFilter");
  if (f) f.addEventListener("input", () => { WB.filter = f.value; renderWbProjects(); });
  const lf = $("#wbLoadFilter");
  if (lf) lf.addEventListener("input", () => { WB.loadFilter = lf.value; renderWbLoad(); });
  const lt = $("#wbLoadTitle");
  if (lt) lt.addEventListener("change", () => { WB.loadTitle = lt.value; renderWbLoad(); });
  const add = $("#btnWbAdd");
  if (add) add.addEventListener("click", () => openAssignModal(wbSel(), null, null));
}

/* ============================================================================
   People page (admin) — the master list, approved titles, capacity, merging
   ========================================================================== */
async function loadPeople() {
  const d = await api("/api/people");
  WB.people = d.people || [];
  renderPeople();
}

function renderPeople() {
  const head = $("#peopleHead"), body = $("#peopleBody");
  if (!head || !body) return;
  // GH-35: Active/Inactive is the FIRST column (Rijoy: "the active or inactive
  // flag ... should be the first flag to make sure that the resource is
  // available — if inactive then they are no longer in the company"). It is a
  // button, so the status is changed from where it is read instead of two clicks
  // away inside Edit.
  head.innerHTML = `<tr>
    <th title="Is this person still with the company? Inactive = left, so they are excluded from resourcing.">Active</th>
    <th>Person</th><th>Home title</th><th>Approved titles</th>
    <th class="num">Capacity</th><th class="num">Projects</th><th>Load</th><th></th>
  </tr>`;
  if (!WB.people.length) {
    body.innerHTML = `<tr><td colspan="8"><div class="wb-empty">No people yet.</div></td></tr>`;
    return;
  }
  const sorted = WB.people.slice().sort((a, b) => a.name.localeCompare(b.name));
  body.innerHTML = sorted.map((p) => {
    const l = WB.load.find((x) => x.id === p.id);
    const peak = l ? l.peak_pct : null;
    const inactive = p.active === 0;
    // The status cell is a BUTTON: flipping someone to Inactive (they have left)
    // or back is a one-click judgement made from the list you are reading.
    const actCell = `<button class="btn mini p-act${inactive ? " off" : " on"}"
        data-act="toggle-active"
        title="${inactive ? "Inactive — they have left the company. Click to mark active." : "Active — click to mark inactive (left the company)"}"
        aria-pressed="${inactive ? "false" : "true"}">${inactive ? "Inactive" : "Active"}</button>`;
    const titles = (p.titles || []).length
      ? p.titles.map((t) => esc(t)).join("<br>")
      : `<span class="muted-note">none</span>`;
    // Flag anyone sitting on a project with no PM — same signal as the PM table,
    // so the gap is visible from either page.
    const unowned = (typeof unassignedProjects === "function") ? unassignedProjects() : [];
    const myOrphans = unowned.filter((u) => (p.assignments || []).some((a) =>
      `${(a.client || "").trim().toUpperCase()}|${(a.project || "").trim().toUpperCase()}` === u.key));
    const ownerFlag = myOrphans.length
      ? `<div class="noowner-chip" title="No PM owns this project">⚠ ${esc(myOrphans.map((m) => m.project).join(", "))}</div>`
      : "";
    return `<tr data-pid="${p.id}"${inactive ? ' class="p-inactive-row"' : ""}>
      <td class="p-act-cell">${actCell}</td>
      <td><b>${esc(p.name)}</b>${inactive ? ` <span class="p-inactive-tag" title="Inactive — left the company. They are excluded from assignments.">Inactive</span>` : ""}${p.country ? `<div class="muted-note">${esc(p.country)}</div>` : ""}${ownerFlag}</td>
      <td>${esc(p.home_title || "—")}</td>
      <td>${titles}</td>
      <td class="num">${fmtH(p.capacity)}</td>
      <td class="num">${p.project_count}</td>
      <td>${peak == null ? "—" : loadBarHTML(peak)}</td>
      <td class="wb-rowactions">
        <button class="btn mini" data-act="edit">Edit</button>
        <button class="btn mini" data-act="merge">Merge</button>
        <button class="btn mini" data-act="del">Delete</button>
      </td>
    </tr>`;
  }).join("");
  $$("#peopleBody tr").forEach((tr) => {
    const pid = +tr.dataset.pid;
    const p = WB.people.find((x) => x.id === pid);
    tr.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.act === "edit") return openPersonModal(p);
      if (b.dataset.act === "merge") return openMergeModal(p);
      if (b.dataset.act === "toggle-active") {
        const next = p.active === 0 ? 1 : 0;
        b.disabled = true;
        try {
          // Send only the status: api_person_update keeps every other field when
          // it is omitted, so a toggle can never blank a name or capacity.
          await api(`/api/people/${pid}`, { method: "PUT", body: JSON.stringify({ active: next }) });
          toast(`${p.name} is now ${next ? "active" : "inactive (left the company)"}`);
          loadActivity();
          await loadPeople(); await refreshLoadOnly();
        } catch (e) { toast(e.message || "Could not change status", true); b.disabled = false; }
        return;
      }
      // Names the person AND what is lost. A bare "Delete X?" hid the fact that
      // their planned + actual hours go too.
      const lost = (p.assignments || []).map((a) => `${a.client} · ${a.project}`).join(", ") || "no assignments";
      if (!confirm(`Delete ${p.name}?\n\nOnly possible when they hold no project assignments.\nCurrently: ${lost}\n\nThis cannot be undone.`)) return;
      try {
        await api(`/api/people/${pid}`, { method: "DELETE" });
        toast(`${p.name} deleted`);
        loadActivity();   // reflect the freshly-logged row
        await loadPeople(); await refreshLoadOnly();
      } catch (e) { toast(e.message || "Delete failed", true); }
    }));
  });
}

async function refreshLoadOnly() {
  try {
    const d = await api("/api/pm/load");
    WB.load = d.people || [];
    WB.weekLabels = d.week_labels || WB.weekLabels;
    WB.months = d.months || WB.months;
    WB.titles = d.titles || WB.titles;
    WB.weekMonth = d.week_month || WB.weekMonth;
    WB.current = d.current || WB.current;
    renderWbLoad();
  } catch (_) {}
}

function openPersonModal(p) {
  const editing = !!p;
  const titles = (WB.people || []).length ? null : null;
  const body = `
    <div class="assign-grid">
      <div><label class="f">Name</label><input id="pName" value="${editing ? esc(p.name) : ""}" placeholder="Full name as it should appear"></div>
      <div><label class="f">Country</label><input id="pCountry" value="${editing ? esc(p.country || "") : ""}" placeholder="optional"></div>
    </div>
    <div class="assign-grid">
      <div><label class="f">Home title</label>
        <input id="pHome" list="titleList" value="${editing ? esc(p.home_title || "") : ""}" placeholder="e.g. Quadient Developer">
        <datalist id="titleList">${(state.pricing || []).map((t) => `<option value="${esc(t.title)}"></option>`).join("")}</datalist>
      </div>
      <div><label class="f">Weekly capacity (hrs)</label><input type="number" id="pCap" value="${editing ? fmtH(p.capacity) : 40}" min="1" max="80"></div>
    </div>
    <div>
      <label class="f">Approved titles <span class="muted-note">(comma-separated — PMs may book only these)</span></label>
      <input id="pTitles" value="${editing ? esc((p.titles || []).join(", ")) : ""}" placeholder="home title is added automatically">
      <div class="muted-note" style="margin-top:5px">A PM can pick any of these per project. Booking a non-home title forces a comment and is flagged to you.</div>
    </div>
    <div class="assign-grid">
      <div><label class="f">Status</label>
        <select id="pActive"><option value="1" ${!editing || p.active !== 0 ? "selected" : ""}>Active</option>
        <option value="0" ${editing && p.active === 0 ? "selected" : ""}>Inactive</option></select>
      </div>
      <div><label class="f">Notes</label><input id="pNotes" value="${editing ? esc(p.notes || "") : ""}" placeholder="optional"></div>
    </div>
    <div class="muted-note">Capacity drives the 100% rule and utilization: 40 hrs/week = 100%.</div>
  `;
  showModalHTML(editing ? `Edit — ${p.name}` : "Add person", body);
  const okBtn = $("#modalOk");
  setModalOk(async () => {
    const payload = {
      name: $("#pName").value, country: $("#pCountry").value,
      home_title: $("#pHome").value, capacity: +$("#pCap").value || 40,
      active: +$("#pActive").value, notes: $("#pNotes").value,
      titles: $("#pTitles").value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    if (!payload.name.trim()) { toast("Name is required", true); return; }
    okBtn.disabled = true;
    try {
      if (editing) await api(`/api/people/${p.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/people", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      toast(editing ? "Person updated" : "Person added");
      await loadPeople(); await refreshLoadOnly();
    } catch (e) { toast(e.message || "Save failed", true); }
    finally { okBtn.disabled = false; }
  });
}

function openMergeModal(p) {
  const others = WB.people.filter((x) => x.id !== p.id);
  if (!others.length) { toast("Nobody to merge with", true); return; }
  const body = `
    <p class="muted-note">Use this when the same human was entered under two spellings (e.g. <b>Bajrang</b> and <b>Bajrang Lal</b>).
    All project assignments move onto <b>${esc(p.name)}</b>, so the 100% rule sees one person instead of two.</p>
    <label class="f">Merge these INTO ${esc(p.name)}</label>
    <select id="mSrc">${others.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.project_count} project(s))</option>`).join("")}</select>
    <div class="muted-note" style="margin-top:8px">Refused automatically if the two records are both on the same project — that is a real double-booking and needs your decision.</div>
    <!-- Names the exact damage BEFORE it happens. Rijoy could not tell what a
         merge had done after the fact (2026-10-01); saying it up front, in the
         dialog he actually reads, is the fix. -->
    <div id="mWarn" class="merge-warn"></div>
  `;
  showModalHTML(`Merge into ${p.name}`, body);
  const okBtn = $("#modalOk");
  okBtn.textContent = "Merge";
  // Live preview: spell out what merging the currently-selected record does.
  const warn = () => {
    const src = others.find((x) => x.id === +$("#mSrc").value);
    const el = $("#mWarn");
    if (!src || !el) return;
    const moves = (src.assignments || []).map((a) => `${a.client} · ${a.project}`);
    el.innerHTML =
      `<b>⚠ This will permanently:</b><ul>` +
      `<li>move <b>${moves.length}</b> project${moves.length === 1 ? "" : "s"} off <b>${esc(src.name)}</b>` +
      (moves.length ? ` (${moves.map(esc).join(", ")})` : "") + `</li>` +
      `<li>delete <b>${esc(src.name)}</b> as a person, and</li>` +
      `<li>record their hours against <b>${esc(p.name)}</b> on those projects</li></ul>` +
      `Neither the merge nor its undo is possible from the UI. Cancel if you are not sure.`;
  };
  $("#mSrc").addEventListener("change", warn);
  warn();
  setModalOk(async () => {
    const src = +$("#mSrc").value;
    okBtn.disabled = true;
    try {
      await api(`/api/people/${p.id}/merge`, { method: "POST", body: JSON.stringify({ merge_from: src }) });
      closeModal();
      toast("Merged");
      await loadPeople(); await refreshLoadOnly();
      loadActivity();   // show exactly what this merge did, immediately
      if (state.view === "workbench") await loadWorkbench();
    } catch (e) { toast(e.message || "Merge failed", true); }
    finally { okBtn.disabled = false; }
  });
}

/* ============================================================================
   OT approvals (admin) — the gate that keeps billable OT out of the Dashboard
   ========================================================================== */
async function loadOt() {
  let d;
  try { d = await api("/api/ot/pending"); } catch (e) {
    $("#otHead").innerHTML = ""; $("#otBody").innerHTML = "";
    $("#otNote").innerHTML = `<span class="dot off"></span>OT approvals unavailable: ${esc(e.message || "")}`;
    return;
  }
  const gate = $("#btnOtGate");
  gate.textContent = `Gate: ${d.gate_enabled ? "on" : "off"}`;
  gate.title = d.gate_enabled
    ? "Billable OT waits for your approval before it reaches the Dashboard."
    : "Gate is OFF — billable OT reaches the Dashboard immediately.";
  const pend = d.pending || [], appd = d.approved || [];
  $("#otNote").innerHTML = `<span class="dot ${pend.length ? "on" : "off"}"></span>
    <b>Billable OT approvals</b> — ${pend.length} awaiting you${pend.length ? ` ($${d.pending_revenue.toLocaleString()} revenue held)` : ""}.`;
  $("#otHead").innerHTML = `<tr>
    <th>Person</th><th>Project</th><th>Week</th><th class="num">OT hrs</th>
    <th class="num">OT rate</th><th>Reason</th><th>PM</th><th>Decision</th>
  </tr>`;
  if (!pend.length && !appd.length) {
    $("#otBody").innerHTML = `<tr><td colspan="8"><div class="wb-empty">No billable OT recorded yet.</div></td></tr>`;
    return;
  }
  const rowHTML = (x, approved) => `<tr data-nid="${x.id}">
    <td><b>${esc(x.person)}</b><div class="muted-note">${esc(x.title || "")}</div></td>
    <td>${esc(x.client)} · ${esc(x.project)}</td>
    <td>${esc(x.week_label)}</td>
    <td class="num">${fmtH(x.ot_hours)}</td>
    <td class="num">${money(x.ot_revenue / (x.ot_hours || 1), "USD")}${x.ot_multiplier !== 1 ? ` <span class="muted-note">×${x.ot_multiplier}</span>` : ""}</td>
    <td>${esc(x.reason || "—")}</td>
    <td>${esc(x.pm || "—")}</td>
    <td>${approved
      ? `<span class="pill wb-pill-ok">approved</span> <button class="btn mini" data-dec="0">Revoke</button>`
      : `<span class="pill wb-pill-over">pending</span> <button class="btn mini" data-dec="1">Approve</button>`}</td>
  </tr>`;
  $("#otBody").innerHTML = pend.map((x) => rowHTML(x, false)).join("")
    + appd.slice(0, 12).map((x) => rowHTML(x, true)).join("");
  $$("#otBody button[data-dec]").forEach((b) => b.addEventListener("click", async () => {
    const nid = +b.closest("tr").dataset.nid;
    const approve = b.dataset.dec === "1";
    b.disabled = true;
    try {
      await api(`/api/ot/${nid}/decision`, { method: "POST", body: JSON.stringify({ approve }) });
      toast(approve ? "OT approved — released to the Dashboard" : "OT approval revoked");
      await loadOt();
    } catch (e) { toast(e.message || "Failed", true); b.disabled = false; }
  }));
}

/* ---------------- "Add new joiner" (PM) ----------------
   Rijoy: a PM should be able to add a new hire "along with their availability
   and that title. the title should match the title we have where we align the
   pricing." So the title is a HARD-validated pick from the rate card: the server
   rejects an off-card title and tells them to ask an admin to add it on Rate
   Card. Availability here is the weekly capacity (40 = 100%). */
async function openJoinerModal() {
  // A PM has no state.pricing (admin-only), and WB.titles is filled by
  // loadWorkbench() — which a PM may never run, because they land on the week
  // sheet. Fetch the titles directly if we do not have them yet: the server sends
  // the title STRINGS only, never rates.
  let titles = (state.pricing || []).map((t) => t.title).filter(Boolean);
  if (!titles.length) titles = WB.titles || [];
  if (!titles.length) {
    try {
      const d = await api("/api/pm/load");
      titles = d.titles || [];
      WB.titles = titles;
    } catch (_) { titles = []; }
  }
  const body = `
    <div class="assign-grid">
      <div><label class="f">Name</label>
        <input id="jnName" placeholder="Full name as it should appear"></div>
      <div><label class="f">Country</label>
        <input id="jnCountry" placeholder="optional"></div>
    </div>
    <div class="assign-grid">
      <div><label class="f">Title <span class="muted-note">(from the rate card)</span></label>
        <input id="jnTitle" list="jnTitleList" placeholder="e.g. Quadient Developer">
        <datalist id="jnTitleList">${titles.map((t) => `<option value="${esc(t)}"></option>`).join("")}</datalist>
      </div>
      <div><label class="f">Availability — hrs/week</label>
        <input type="number" id="jnCap" value="40" min="1" max="168" step="1">
      </div>
    </div>
    <div class="wb-verdict ok" id="jnVerdict">40 hrs/week = 100% allocation. Their title decides how they are priced.</div>
    <div class="muted-note">The title must already exist on the <b>Rate Card</b> — rates are keyed by title, so a new
      title has to be added there by an admin first. If you type one that is not on the card, the save will
      tell you and stop.</div>
  `;
  showModalHTML("Add a new joiner", body);

  const capEl = $("#jnCap");
  const syncCap = () => {
    const v = +capEl.value || 0;
    const vd = $("#jnVerdict");
    vd.className = "wb-verdict ok";
    vd.innerHTML = `<b>${v} hrs/week</b> = 100% allocation for this person.`
      + (v !== 40 ? ` Full-time is 40, so ${v} makes them ${Math.round(v / 40 * 100)}% of a standard week.` : "");
  };
  capEl.addEventListener("input", syncCap);
  syncCap();

  // NOTE: setModalOk takes ONE argument — the handler. Passing a label first
  // made the handler a string, so the OK button silently did nothing.
  setModalOk(async () => {
    const payload = {
      name: $("#jnName").value.trim(),
      country: $("#jnCountry").value.trim(),
      home_title: $("#jnTitle").value.trim(),
      capacity: +capEl.value || 40,
    };
    if (!payload.name) { toast("A name is required", true); return false; }
    try {
      await api("/api/joiners", { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      // The server sends an OBJECT for the actionable cases (unknown title,
      // duplicate person). api() now attaches it as e.detail, so read that
      // rather than trying to JSON.parse a human sentence.
      let d = e.detail || null;
      if (!d) { try { d = JSON.parse(e.message); } catch (_) {} }
      if (d && d.code === "unknown_title") {
        showModalHTML("That title is not on the rate card",
          `<div class="wb-verdict bad">${esc(d.message)}</div>
           <div class="muted-note" style="margin-top:8px">Titles currently on the card:</div>
           <div class="jn-titles">${(d.known_titles || []).map((t) => `<span class="jn-tag">${esc(t)}</span>`).join("")}</div>`);
        return false;
      }
      if (d && d.code === "duplicate_person") {
        showModalHTML("Already on the roster", `<div class="wb-verdict bad">${esc(d.message)}</div>`);
        return false;
      }
      toast(e.message || "Could not add the joiner", true);
      return false;
    }
    toast(`${payload.name} added`);
    await loadWorkbench();
    return true;
  });
}

function bindPeopleAndOt() {
  // Bind every entry point: admins find it on Team & Access (People toolbar), PMs
  // find it on their week sheet. The SERVER decides who may actually add one.
  $$(".js-add-joiner").forEach((b) => b.addEventListener("click", () => openJoinerModal()));
  const add = $("#btnAddPerson");
  if (add) add.addEventListener("click", () => openPersonModal(null));
  const gate = $("#btnOtGate");
  if (gate) gate.addEventListener("click", async () => {
    const on = gate.textContent.includes("on");
    try {
      await api(`/api/ot/gate?enabled=${on ? 0 : 1}`, { method: "POST" });
      toast(`OT approval gate ${on ? "disabled" : "enabled"}`);
      await loadOt();
    } catch (e) { toast(e.message || "Failed", true); }
  });
  // GH-37: the PM's own "New project". Bound once; the server decides who may
  // actually create one (this is admin-or-PM), and writes the creator as owner.
  const np = $("#btnWbNewProject");
  if (np && np.dataset.bound !== "1") {
    np.dataset.bound = "1";
    np.addEventListener("click", () => openWbNewProject());
  }
}
