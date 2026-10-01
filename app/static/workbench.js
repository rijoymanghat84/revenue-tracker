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
  renderWbLoad();
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
      </div>
    </div>`;
  }).join("");
  $$("#wbProjects .wb-pitem").forEach((el) => el.addEventListener("click", () => {
    WB.selKey = el.dataset.k;
    renderWorkbench();
  }));
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
    const pct = t.allocation_pct;
    const weekly = pct == null ? "—" : Math.round(pct / 100 * cap * 10) / 10;
    const status = peak == null ? `<span class="pill">no load data</span>`
      : peak > 100 ? `<span class="pill wb-pill-over">Over ${peak}%</span>`
      : peak >= 80 ? `<span class="pill wb-pill-ok">Healthy ${peak}%</span>`
      : peak >= 50 ? `<span class="pill wb-pill-warn">${peak}%</span>`
      : `<span class="pill wb-pill-free">${peak}%</span>`;
    const exc = (t.title_exception || "").trim();
    return `<tr data-rid="${t.id}" data-pid="${t.person_id}">
      <td><b>${esc(t.name)}</b>${exc ? `<div class="muted-note">⚑ ${esc(exc)}</div>` : ""}</td>
      <td>${esc(t.role || "—")}</td>
      <td class="num">${pct == null ? "—" : esc(pct) + "%"}${
        (t.phases && t.phases.length > 1)
          ? `<div class="muted-note" title="${esc((t.phases || []).map((x) => x.allocation_pct + "% from " + (x.start_date || "start")).join(" · "))}">${t.phases.length} phases</div>`
          : ""}</td>
      <td>${esc(t.start_date || "—")}</td>
      <td>${esc(t.end_date || "—")}</td>
      <td class="num">${weekly}</td>
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
      if (b.dataset.act === "edit") return openAssignModal(p, pid, rid);
      const t = p.team.find((x) => x.id === rid);
      if (!confirm(`Remove ${t.name} from ${p.client} · ${p.project}?\n\nThis deletes their planned and actual hours on this project.`)) return;
      try {
        await api(`/api/assignments/${rid}`, { method: "DELETE" });
        toast(`${t.name} removed from ${p.project}`);
        await loadWorkbench();
      } catch (e) { toast(e.message || "Remove failed", true); }
    }));
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

/* ---------------- the load rail ---------------- */
function renderWbLoad() {
  const box = $("#wbLoad");
  if (!box) return;
  const f = WB.loadFilter.trim().toLowerCase();
  let list = WB.load.filter((x) => !f || x.name.toLowerCase().includes(f));
  // Busiest first — the people who can't take work are the ones you must know about.
  list = list.slice().sort((a, b) => (b.peak_pct - a.peak_pct) || a.name.localeCompare(b.name));
  if (!list.length) { box.innerHTML = `<div class="wb-empty">No people match.</div>`; return; }
  box.innerHTML = list.map((x) => {
    const pill = x.peak_pct > 100 ? `<span class="pill wb-pill-over">Over — ${x.peak_pct}% (${esc(x.peak_week)})</span>`
      : x.peak_pct >= 80 ? `<span class="pill wb-pill-ok">${x.peak_pct}%</span>`
      : x.peak_pct >= 1 ? `<span class="pill wb-pill-warn">${x.peak_pct}%</span>`
      : `<span class="pill wb-pill-free">bench</span>`;
    const projs = (x.projects || []).length
      ? x.projects.map(esc).join(" + ")
      : "no project work booked";
    return `<div class="wb-load" data-pid="${x.id}">
      <div class="h">
        <div><b>${esc(x.name)}</b> <span class="sub">${esc(x.home_title || "—")}</span></div>
        <div>${pill} <button class="btn mini" data-act="view">Assign…</button></div>
      </div>
      <div class="sub">${projs}</div>
      ${weekGridHTML(x)}
    </div>`;
  }).join("");
  $$("#wbLoad .wb-load button[data-act=view]").forEach((b) => b.addEventListener("click", () => {
    const pid = +b.closest(".wb-load").dataset.pid;
    openAssignModal(wbSel(), pid, null);
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
  // On create, only offer people not already on this project — the server
  // refuses duplicates anyway, but there is no reason to let the PM pick one.
  const choices = WB.people.filter((p) =>
    (editing ? true : !alreadyIds.includes(p.id)) &&
    !(p.active === 0));
  if (!choices.length) {
    showModalHTML("Add team member",
      `<p class="muted-note">Nobody left to add — everyone in the People list is already on this project.</p>`);
    return;
  }
  const cur = editing ? team.find((t) => t.id === rid) : null;
  const selPid = cur ? cur.person_id : pid || choices[0].id;
  const p = WB.people.find((x) => x.id === selPid) || choices[0];

  const body = `
    <div class="assign-grid">
      <div>
        <label class="f">Person</label>
        <select id="wbPerson">
          ${choices.map((x) => `<option value="${x.id}" ${x.id === selPid ? "selected" : ""}>
            ${esc(x.name)} — ${esc(x.home_title || "no title")} — ${esc(peakLabel(x.id))}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="f">Title <span class="muted-note">(approved titles only)</span></label>
        <select id="wbTitle"></select>
      </div>
    </div>
    <div id="wbExcWrap" class="hidden">
      <label class="f">Why a different title? <span style="color:var(--red)">*required</span></label>
      <textarea id="wbExc" placeholder="e.g. covering BA work on this engagement while the home title is Developer"></textarea>
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
          <input type="range" id="wbPct" min="0" max="100" step="25" value="${cur && cur.allocation_pct != null ? cur.allocation_pct : 50}">
          <span class="wb-pctval" id="wbPctVal">50%</span>
        </div>
        <div class="wb-chips" id="wbChips">
          ${[25, 50, 75, 100].map((v) => `<div class="wb-chip" data-v="${v}">${v}%</div>`).join("")}
        </div>
      </div>
      <div class="assign-grid" style="margin-top:14px">
        <div><label class="f">Start date</label><input type="date" id="wbStart" value="${cur ? esc(cur.start_date || "") : ""}"></div>
        <div><label class="f">End date</label><input type="date" id="wbEnd" value="${cur ? esc(cur.end_date || "") : ""}"></div>
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
    <div class="muted-note" id="wbFillNote">Leave the dates blank to spread the allocation across the whole year. The app fills the weekly grid; you can fine-tune individual weeks afterwards on Planned.</div>
  `;
  showModalHTML(editing ? "Edit assignment" : `Add team member — ${project.client} · ${project.project}`, body);

  const $p = $("#wbPerson");
  function fillTitles() {
    const pidv = +$p.value;
    const list = approvedTitles(pidv);
    const home = (WB.people.find((x) => x.id === pidv) || {}).home_title || "";
    $("#wbTitle").innerHTML = list.length
      ? list.map((t) => `<option value="${esc(t)}" ${t === home ? "selected" : ""}>${esc(t)}${t === home ? " (home)" : ""}</option>`).join("")
      : `<option value="">— no approved title —</option>`;
    syncException();
  }
  function syncException() {
    const pidv = +$p.value;
    const home = (WB.people.find((x) => x.id === pidv) || {}).home_title || "";
    const ttl = $("#wbTitle").value;
    const diff = !home || (ttl && ttl !== home);
    $("#wbExcWrap").classList.toggle("hidden", !diff);
  }
  function syncChips() {
    const v = +$("#wbPct").value;
    $("#wbPctVal").textContent = v + "%";
    $$("#wbChips .wb-chip").forEach((c) => c.classList.toggle("on", +c.dataset.v === v));
  }
  function check() {
    clearTimeout(wbCheckTimer);
    wbCheckTimer = setTimeout(async () => {
      const pidv = +$p.value;
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

  $p.addEventListener("change", () => { fillTitles(); check(); });
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
  function snapToWeek(iso, which) {
    if (!iso || !(WB.weekLabels || []).length) return iso;
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    // If the date is ALREADY a valid week boundary (Monday for a start, Sunday
    // for an end) leave it exactly as typed. Snapping a correct boundary used to
    // push an end date forward a full week (typing Sun Mar-29 became Sun Apr-05),
    // silently stretching the phase.
    const dow = d.getDay();                      // 0=Sun, 1=Mon
    if (which === "end" && dow === 0) return iso;
    if (which === "start" && dow === 1) return iso;

    let best = "", bestDiff = Infinity;
    for (const lbl of WB.weekLabels) {
      const mon = weekLabelToDate(lbl);
      if (!mon) continue;
      const diff = which === "end" ? (mon.getTime() - d.getTime()) : (d.getTime() - mon.getTime());
      // For a start we want the latest Monday <= d; for an end the earliest
      // Monday >= d. Falling back to nearest keeps a mid-year date usable.
      if (diff >= 0 && diff < bestDiff) { bestDiff = diff; best = lbl; }
    }
    if (!best) {   // outside the year — fall back to nearest either side
      for (const lbl of WB.weekLabels) {
        const mon = weekLabelToDate(lbl); if (!mon) continue;
        const diff = Math.abs(mon.getTime() - d.getTime());
        if (diff < bestDiff) { bestDiff = diff; best = lbl; }
      }
    }
    const mon = weekLabelToDate(best);
    if (!mon) return iso;
    // The week runs Mon..Sun; its END is the Sunday, which is what an inclusive
    // end_date should carry so the whole week is owned.
    const out = which === "end" ? new Date(mon.getTime() + 6 * 86400000) : mon;
    return out.toISOString().slice(0, 10);
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
      // Split the last phase at its midpoint: same span, halved % on each side.
      const sd = new Date((last.start_date || "") + "T00:00:00");
      const ed = new Date((last.end_date || "") + "T00:00:00");
      if (isNaN(sd) || isNaN(ed) || ed <= sd) { toast("Give the last phase both dates before splitting it", true); return; }
      const mid = new Date(sd.getTime() + Math.floor((ed - sd) / 2 / 86400000) * 86400000);
      last.end_date = mid.toISOString().slice(0, 10);
      phaseRows.push({ allocation_pct: last.allocation_pct,
                       start_date: new Date(mid.getTime() + 86400000).toISOString().slice(0, 10),
                       end_date: ed.toISOString().slice(0, 10) });
    }
    renderPhaseRows(); check();
  });
  setMode(mode);

  // The modal's OK button performs the save; closeModal() clears the handler.
  const okBtn = $("#modalOk");
  setModalOk(async () => {
    const pidv = +$p.value;
    const payload = {
      person_id: pidv, client: project.client, project: project.project,
      title: $("#wbTitle").value,
      title_exception: ($("#wbExc") && $("#wbExc").value) || "",
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
  head.innerHTML = `<tr>
    <th>Person</th><th>Home title</th><th>Approved titles</th>
    <th class="num">Capacity</th><th class="num">Projects</th><th>Load</th><th>Status</th><th></th>
  </tr>`;
  if (!WB.people.length) {
    body.innerHTML = `<tr><td colspan="8"><div class="wb-empty">No people yet.</div></td></tr>`;
    return;
  }
  const sorted = WB.people.slice().sort((a, b) => a.name.localeCompare(b.name));
  body.innerHTML = sorted.map((p) => {
    const l = WB.load.find((x) => x.id === p.id);
    const peak = l ? l.peak_pct : null;
    const status = p.active === 0 ? `<span class="pill">inactive</span>`
      : peak == null ? `<span class="pill">—</span>`
      : peak > 100 ? `<span class="pill wb-pill-over">over ${peak}%</span>`
      : peak >= 80 ? `<span class="pill wb-pill-ok">${peak}%</span>`
      : `<span class="pill wb-pill-warn">${peak}%</span>`;
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
    return `<tr data-pid="${p.id}">
      <td><b>${esc(p.name)}</b>${p.country ? `<div class="muted-note">${esc(p.country)}</div>` : ""}${ownerFlag}</td>
      <td>${esc(p.home_title || "—")}</td>
      <td>${titles}</td>
      <td class="num">${fmtH(p.capacity)}</td>
      <td class="num">${p.project_count}</td>
      <td>${peak == null ? "—" : loadBarHTML(peak)}</td>
      <td>${status}</td>
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

async /* ---------------- "Add new joiner" (PM) ----------------
   Rijoy: a PM should be able to add a new hire "along with their availability
   and that title. the title should match the title we have where we align the
   pricing." So the title is a HARD-validated pick from the rate card: the server
   rejects an off-card title and tells them to ask an admin to add it on Rate
   Card. Availability here is the weekly capacity (40 = 100%). */
function openJoinerModal() {
  const titles = (state.pricing || []).map((t) => t.title).filter(Boolean);
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

  setModalOk("Add joiner", async () => {
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
      // duplicate person). Show it usefully rather than "[object Object]".
      let d = null;
      try { d = JSON.parse(e.message); } catch (_) {}
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
}
