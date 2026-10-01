/* ============ Revenue Tracker — frontend logic ============
   Tabs (left-rail nav, order matters to the owner):
   - Dashboard: Planned vs actual money, by client/project.
   - Planned   : master entry — hours, rates and the weekly grid. Pick a Title
                 from the Rate Card to auto-fill both rates.
   - Actuals   : PM reconciliation — record ACTUAL hours, validated against
                 planned. Overage → OT flow; under → comment required.
   - Rate Card : what you bill the client vs what the title costs offshore,
                 per title (currency + margin). Was the top half of the old
                 "Pricing" tab, which was split on 2026-10-01.
   - Utilization: booked ÷ capacity per resource/month. Capacity (the
                 denominator) is edited here too, behind the ⚙ Capacity toggle.
   - Team & Access: PMs + project scope, admin accounts + granular permissions,
                 and DB security. Was the bottom half of the old "Pricing" tab.
   Roles: admin (permission-gated per tab) vs pm (Actuals only, scoped to their
   projects, never sees rates).
*/
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = { resources: [], weeks: [], months: [], pricing: [], view: "dash", gridEdit: { planned: false }, me: null, globalMonth: "all", utilMonth: "", utilMode: "month", utilFilters: { client: [], project: [], pm: [] }, availOpen: false };

/* Full admin permission key set — mirrors ADMIN_PERMISSIONS in app/main.py.
   Used only as a defensive fallback when /api/login omits `permissions`. */
const ADMIN_PERM_KEYS = ["pricing", "resources", "projects", "users", "dashboard",
                         "actuals", "utilization", "import_export", "db_security", "theming"];

/* 2026-10-01: "Team & Access" is one tab holding three independently-gated
   blocks (PMs, Admins, DB security). The nav only decides whether the TAB
   shows; these helpers hide the blocks a given admin may not touch.
   A PM (non-admin) is never granted any of them. */
function isAdminUser() { return !!(state.me && state.me.role === "admin"); }
function canPerm(p) {
  if (!isAdminUser()) return false;
  if (state.me.super_admin) return true;
  return new Set(state.me.permissions || []).has(p);
}
/* The PM + Admin blocks are user management, which the API gates behind the
   `users` permission (see _require_perm in app/main.py). */
function showBlock(el, on) { if (el) el.style.display = on ? "" : "none"; }

const dirty = new Map();   // resource rid -> {fields:{}, hours:bool}
const pDirty = new Map();  // pricing pid -> {title?, rate?, offshore_rate?}
const aDirty = new Map();  // actuals rid -> {hours:bool, notes:{}}
let flushTimer = null, pFlushTimer = null, aFlushTimer = null;

/* Global month filter: returns the week-index range for the selected month,
   or the full year when "all". Used by every tab to scope its columns/data. */
function globalWeekRange() {
  const m = state.globalMonth;
  if (!m || m === "all") return null; // null = all weeks
  const month = (state.months || []).find((x) => x.name === m);
  if (!month) return null;
  return { start: month.start, end: month.end };
}
function globalMonthLabel() {
  return state.globalMonth === "all" ? "All months" : state.globalMonth;
}
/* Array of week indices to display under the current global month filter
   (all weeks when "all"). */
function visibleWeekIndices() {
  const r = globalWeekRange();
  if (!r) return (state.weeks || []).map((_, i) => i);
  const out = [];
  for (let i = r.start; i <= r.end; i++) out.push(i);
  return out;
}

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
    // `detail` is sometimes an OBJECT (a structured, actionable error: unknown
    // title, duplicate person, rejected Excel rows). `new Error(object)` makes
    // e.message the string "[object Object]", which is useless to show and
    // unparseable. Keep the object on the error and give the message the
    // server's own human sentence.
    if (msg && typeof msg === "object") {
      const err = new Error(msg.message || res.statusText);
      err.detail = msg;
      throw err;
    }
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

/* Info-only modal (plain text body). For a modal that renders HTML AND needs a
   real OK action, use showModalHTML + setModalOk (see workbench.js) — this one
   deliberately holds no callback. */
function showModal(title, body) {
  setModalOk(null);
  $("#modalTitle").textContent = title;
  $("#modalBody").textContent = body;
  $("#modal").classList.remove("hidden");
}

/* The OK button is the ONLY close path that can be hijacked, so the handler is
   held in a single variable and always cleared on open. Without the
   clear-on-open, a later informational modal would silently re-run the previous
   screen's save action. */
let modalOkHandler = null;
function setModalOk(fn) { modalOkHandler = fn; }
function closeModal() { modalOkHandler = null; $("#modal").classList.add("hidden"); }

/* CANCEL — a guaranteed escape hatch from EVERY modal.
   Added 2026-10-01 after the owner accidentally clicked "Merge" in Team & Access and
   found the dialog offered only OK, so he had to confirm an irreversible merge
   (it folded Maya Foster into Ryan Doyle) just to close the box. Merge,
   delete and edit all share this one modal, so the missing Cancel affected all
   of them.

   SAFETY: this must NEVER run the OK handler. It deliberately does NOT call
   closeModal() — that clears modalOkHandler, and every caller closes the modal
   itself on success. Cancel only hides the box, so the pending handler stays
   set for the next open (which always calls setModalOk). If you "tidy" this
   into closeModal(), an in-flight save action can fire on a later unrelated
   dialog. */
$("#modalCancel").addEventListener("click", () => {
  $("#modal").classList.add("hidden");
});

$("#modalOk").addEventListener("click", async () => {
  if (modalOkHandler) {
    const fn = modalOkHandler;
    try { await fn(); } catch (e) { /* the modal reports its own errors */ }
    return;   // the handler decides whether to close
  }
  $("#modal").classList.add("hidden");
});

/* Escape closes any modal WITHOUT performing its action. Clicking the backdrop
   does the same. Neither runs the OK handler (see the Cancel note above). */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) {
    $("#modal").classList.add("hidden");
  }
});
$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") $("#modal").classList.add("hidden");
});

/* ---------------- auth / boot ---------------- */
async function boot() {
  try {
    const me = await api("/api/me");
    state.me = me;
    showApp();
  } catch (e) {
    showLogin();
  }
  checkForUpdate();
}

/* ---------------- update check (discreet flashing banner) ---------------- */
const UPDATE_REPO = "rijoymanghat84/revenue-tracker";
const UPDATE_BRANCH = "main";
let updateDismissed = false;

async function checkForUpdate() {
  try {
    const ver = await api("/api/version");
    const deployed = (ver.commit || "").toLowerCase();
    if (!deployed) return; // no git HEAD available — nothing to compare
    // Compare against the latest commit on the default branch (public repo).
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/commits/${UPDATE_BRANCH}`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return; // offline / rate-limited — stay quiet
    const latest = (await res.json()).sha || "";
    if (!latest) return;
    if (latest.toLowerCase().startsWith(deployed)) return; // up to date
    showUpdateBanner();
  } catch (_) {
    /* network hiccup — never block the app on the update check */
  }
}

function showUpdateBanner() {
  if (updateDismissed) return;
  const b = $("#updateBanner");
  if (!b) return;
  b.classList.remove("hidden");
}

$("#updateBannerClose").addEventListener("click", () => {
  updateDismissed = true;
  $("#updateBanner").classList.add("hidden");
});

function showLogin() {
  $("#loginView").classList.remove("hidden");
  // Feature #12: the rail + top strip now live inside #appShell, so hiding the
  // shell hides the nav, filters and account cluster together on the login
  // screen. #topbar alone would leave the rail visible behind the login box.
  $("#appShell").classList.add("hidden");
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#loginUser").focus();
}

function showApp() {
  $("#loginView").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  const isAdmin = state.me.role === "admin";
  // Defensive: /api/login and /api/me must both supply `permissions`. If the
  // field is ever missing, fall back to the full set for an admin instead of
  // hiding every tab (a refresh would mask the bug — see /api/me).
  const perms = new Set(
    state.me.permissions || (state.me.super_admin ? ADMIN_PERM_KEYS : [])
  );
  // A regular admin needs db_security (not `users`) to reach the DB-security panel.
  const hasDbSec = !isAdmin || perms.has("db_security");
  const can = (p) => !isAdmin || perms.has(p);
  initUserMenu();
  initThemeSwitcher();
  initRail();
  // Map each tab to the permission that unlocks it. PMs (non-admin) always see
  // Actuals + Utilization; admins see only what their permissions allow.
  // 2026-10-01: `pricing` split into `rates` (rate card) and `access` (people).
  // "Team & Access" is shown when EITHER `users` (manage PMs/admins) OR
  // `db_security` is granted, then each block inside is hidden individually —
  // otherwise a db_security-only admin would have no way to reach the panel.
  const tabPerm = {
    dash: "dashboard", planned: "resources", actuals: "actuals",
    rates: "pricing", util: "utilization",
    access: ["users", "db_security"],
    // Logs is admin-only and needs no specific permission: the API already gates
    // it to admins, and "what just happened?" is a question any admin may ask.
    logs: null,
  };
  const tabVisible = (t) => {
    // Logs: admins only, and no specific permission needed (the API gates it).
    // Must be an explicit early return — can() only grants admin-held
    // permissions, so a `null` permission would hide the tab from admins too.
    if (t.dataset.tab === "logs") return isAdmin;
    const p = tabPerm[t.dataset.tab];
    // A PM gets their OWN two tabs: the workbench (their projects + team load)
    // and Actuals. They never see Dashboard/Planned/Rate Card/Team & Access.
    // A PM's tabs: the workbench (projects + load rail), the WEEK SHEET (the
    // weekly entry job), and the read-only year grids.
    if (!isAdmin) return t.dataset.tab === "workbench" || t.dataset.tab === "week"
      || p === "actuals" || p === "utilization";
    return Array.isArray(p) ? p.some(can) : can(p);
  };
  // `.hidden` is the class-based hide; `style.display` is the permission gate.
  // Both must be cleared for a tab to appear, so clear .hidden for PM-only tabs
  // here rather than leaving them stuck invisible.
  $$(".tab").forEach((t) => {
    const on = tabVisible(t);
    if (on && t.classList.contains("pm-only") && !isAdmin) t.classList.remove("hidden");
    if (on && t.classList.contains("admin-only") && isAdmin) t.classList.remove("hidden");
    t.style.display = on ? "" : "none";
  });
  // Admin write actions gated by permissions (super-admin has all).
  $("#btnImport").style.display = (isAdmin && can("import_export")) ? "" : "none";
  $("#btnExport").style.display = (isAdmin && can("import_export")) ? "" : "none";
  $("#importMode").style.display = (isAdmin && can("import_export")) ? "" : "none";
  $("#btnAddProject").style.display = (isAdmin && can("projects")) ? "" : "none";
  $("#btnAdd").style.display = "none";
  const visibleTabs = $$(".tab").filter((t) => t.style.display !== "none");
  const names = visibleTabs.map((t) => t.textContent.trim()).join(" · ");
  $("#subLine").textContent = isAdmin
    ? (names ? names : "No permissions assigned")
    : `Weekly entry · My Projects · Actuals — signed in as ${esc(state.me.username)}`;
  // PMs land on Actuals. Admins land on their first permitted tab so they
  // never see a view they lack permission for.
  if (!isAdmin) {
    // A PM lands on the WORKBENCH (their projects + the load rail), which is the
    // screen they live in. Actuals stays reachable from the nav.
    // A PM lands on the WEEK SHEET: entering the week's hours is the recurring
    // job, and the workbench is one click away.
    state.view = "week";
    $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "week"));
    $$(".view").forEach((v) => v.classList.add("hidden"));
    $("#weekView").classList.remove("hidden");
    loadWeekSheet();
  } else {
    // Admins land on the first tab they actually have permission for. The
    // markup's default active tab is Dashboard, which an admin with no
    // `dashboard` permission cannot see — in that case fall through to the
    // first visible tab so they never start on a blank/forbidden screen.
    const dashVisible = $$(".tab").some((t) => t.dataset.tab === "dash" && t.style.display !== "none");
    const firstTab = visibleTabs[0];
    if (!dashVisible && firstTab) { switchView(firstTab.dataset.tab); return; }
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

/* ---------------- user section (feature #9) ----------------
 * A single account dropdown on the right of the topbar, replacing the loose
 * GitHub / Report-issue / Sign-out buttons that used to sit in the bar. Holds
 * identity, theme, password change, repo links and sign out.
 */
function initUserMenu() {
  const me = state.me || {};
  const name = me.username || "?";
  $("#userAvatar").textContent = (name[0] || "?").toUpperCase();
  $("#userName").textContent = name;
  $("#umName").textContent = name;
  $("#umRole").textContent = me.super_admin
    ? "Administrator (owner)"
    : (me.role === "admin" ? "Administrator" : "Project Manager");

  const menu = $("#userMenu");
  const btn = $("#btnUser");
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  const close = () => menu.classList.add("hidden");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  // Click-away and Escape both close it, like any normal menu.
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !e.target.closest(".user-wrap")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // Keep the theme <select> inside the menu from closing it.
  $("#themeSelMenu").addEventListener("click", (e) => e.stopPropagation());

  $("#umPassword").addEventListener("click", () => {
    close();
    openPasswordModal();
  });
  $("#umLogout").addEventListener("click", () => {
    close();
    $("#btnLogout").click();
  });
}

/* ---------------- change password (feature #9) ---------------- */
function openPasswordModal() {
  $("#pwErr").textContent = "";
  ["#pwCurrent", "#pwNew", "#pwConfirm"].forEach((s) => { $(s).value = ""; });
  $("#pwModal").classList.remove("hidden");
  $("#pwCurrent").focus();
}
function closePasswordModal() { $("#pwModal").classList.add("hidden"); }

function bindPasswordModal() {
  $("#pwCancel").addEventListener("click", closePasswordModal);
  $("#pwModal").addEventListener("click", (e) => {
    if (e.target.id === "pwModal") closePasswordModal();
  });
  $("#pwSave").addEventListener("click", async () => {
    const err = $("#pwErr");
    err.textContent = "";
    const cur = $("#pwCurrent").value;
    const nw = $("#pwNew").value;
    const cf = $("#pwConfirm").value;
    if (!cur) { err.textContent = "Enter your current password."; return; }
    if (nw.length < 8) { err.textContent = "New password must be at least 8 characters."; return; }
    if (nw !== cf) { err.textContent = "The two new passwords do not match."; return; }
    if (nw === cur) { err.textContent = "New password must differ from the current one."; return; }
    const btn = $("#pwSave");
    btn.disabled = true; btn.textContent = "Updating…";
    try {
      await api("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ current_password: cur, new_password: nw }),
      });
      closePasswordModal();
      alert("Password updated ✓  Use the new password next time you sign in.");
    } catch (ex) {
      err.textContent = ex.message || "Could not update the password.";
    } finally {
      btn.disabled = false; btn.textContent = "Update password";
    }
  });
}

/* ---------------- themes (feature #8, option C) ----------------
 * The theme itself is applied SERVER-SIDE: app/main.py injects an inline
 * `:root{...}` block plus window.__THEME__ into index.html, so the correct look
 * is painted on the first frame — a purely client-side apply would flash the
 * default theme on every load.
 *
 * This code fills the picker, hides it when the user may not change the theme,
 * POSTs the choice, and then reloads. The reload is deliberate: it is the only
 * way to get a result that is byte-identical to what the server renders next
 * time (including the light-theme status pills, which need a document-level
 * attribute, not just custom properties). On a local app the reload is instant.
 */
let THEME_LIST = [];

async function initThemeSwitcher() {
  const sel = $("#themeSelMenu");
  if (!sel) return;
  let data;
  try {
    data = await api("/api/themes");
  } catch (_) {
    return;
  }
  THEME_LIST = data.themes || [];
  const row = $("#umTheme");
  if (row) row.style.display = data.can_change ? "" : "none";
  if (!data.can_change) return;
  // Rebuild EVERY call (not just once): the previous early-return left a stale
  // empty list after a re-login, which is how a PM could see a blank dropdown.
  sel.innerHTML = THEME_LIST
    .map((t) => `<option value="${esc(t.key)}"${t.key === data.current ? " selected" : ""}>${esc(t.label)}</option>`)
    .join("");
  sel.classList.remove("hidden");
  // The old standalone picker is superseded by the one inside the user menu.
  const legacy = $("#themeSel");
  if (legacy) legacy.classList.add("hidden");

  if (sel.dataset.bound === "1") return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", async () => {
    const key = sel.value;
    const prev = data.current;
    sel.disabled = true;
    try {
      await api("/api/themes", { method: "POST", body: JSON.stringify({ theme: key }) });
      location.reload();
    } catch (ex) {
      sel.value = prev; // put it back — the server kept the old value
      sel.disabled = false;
      alert("Could not save theme: " + (ex.message || "unknown"));
    }
  });
}

/* ---------------- data load ---------------- */
async function loadState() {
  const s = await api("/api/state");
  Object.assign(state, s);
  populateGlobalMonth();
  renderView();
}

/* Fill the global month selector from the layout (once). */
function populateGlobalMonth() {
  const sel = $("#globalMonth");
  if (!sel || sel.options.length > 1) return;
  (state.months || []).forEach((m) => {
    const o = document.createElement("option");
    o.value = m.name; o.textContent = m.name;
    sel.appendChild(o);
  });
}
$("#globalMonth").addEventListener("change", (e) => {
  state.globalMonth = e.target.value;
  // re-render the current view with the new month scope
  if (state.view === "actuals") loadActuals();
  else if (state.view === "util") renderUtilization();
  else if (state.view === "dash") renderDashboard();
  else if (state.view === "planned") renderGrid();
});

const MODES = {
  planned: {
    note: "PLANNED hours — what you CHARGE (Rate) and what it COSTS (Offshore Rate). Enter hours & both rates. Pick a Title from Pricing to auto-fill both.",
    dot: "on",
  },
};

/* ---------------- combined grid (Planned: both rate sides) ---------------- */

/*
 * Column registry — single source of truth for BOTH grids.
 * Each def: key | header label | width | type (meta field / rate / calc subtotal).
 * `meta`/`rate` columns carry the group row's identity label; `calc` columns get
 * their own subtotal cell on the group row. Visibility + freeze are per-view,
 * persisted in localStorage (see viewPrefs / savePrefs).
 */
const COLUMNS = {
  /* Feature #14 (grid density, variant C): the child rows no longer repeat
     Country/Client/Project. The group row ALREADY prints "Client · Project", so
     those three columns were pure noise on every resource row — that is what made
     the grid feel unreadable and pushed the months off-screen. They are still in
     the registry (so ⚙ Columns can bring them back) but default to hidden. */
  planned: [
    { key: "country", h: "Country",       w: 70,  meta: true, field: "country", defaultHidden: true },
    { key: "client",  h: "Client",        w: 150, meta: true, field: "client",  defaultHidden: true },
    { key: "project", h: "Project",       w: 140, meta: true, field: "project", defaultHidden: true },
    { key: "name",    h: "Resource Name", w: 160, meta: true, field: "name" },
    { key: "title",   h: "Title",         w: 160, meta: true, field: "role", dropdown: true },
    { key: "rate",    h: "Rate",          w: 90,  rate: "rate" },
    { key: "offrate", h: "Offshore Rate", w: 90,  rate: "offshore_rate" },
    { key: "th",      h: "Total Hours",   w: 90,  calc: "total_hrs", dim: true },
    { key: "tr",      h: "Total Revenue", w: 110, calc: "total_rev" },
    { key: "te",      h: "Total Expense", w: 110, calc: "total_exp", dim: true },
    { key: "share",   h: "Share",         w: 120, calc: "share", bar: true },
  ],
  actuals: [
    { key: "country", h: "Country",       w: 70,  meta: true, defaultHidden: true },
    { key: "client",  h: "Client",        w: 150, meta: true, defaultHidden: true },
    { key: "project", h: "Project",       w: 140, meta: true, defaultHidden: true },
    { key: "name",    h: "Resource Name", w: 160, meta: true },
    { key: "title",   h: "Title",         w: 160, meta: true },
    { key: "planned", h: "Planned",       w: 70,  calc: "total_planned" },
    { key: "actual",  h: "Actual",        w: 70,  calc: "total_actual" },
    { key: "delta",   h: "Δ",             w: 70,  calc: "delta" },
    { key: "pvabar",  h: "Plan vs actual", w: 120, calc: "pvabar", bar: true },
  ],
};

/* ---------------- combined grid (Planned: both rate sides) ---------------- */

function defaultPrefs(view) {
  // Feature #14: columns flagged defaultHidden start hidden (Country/Client/
  // Project — the group row already names them). They stay in the registry so
  // ⚙ Columns can restore them.
  const hidden = COLUMNS[view].filter((c) => c.defaultHidden).map((c) => c.key);
  /* Freeze up to and including the last metric column, so Resource, Title, rates
     and the totals stay pinned while the weeks/months scroll past — that is what
     makes a wide grid readable. Previously this defaulted to ALL columns, which
     pinned everything and therefore scrolled nothing. */
  const vis = COLUMNS[view].filter((c) => !hidden.includes(c.key));
  const lastCalc = vis.map((c) => !!c.calc).lastIndexOf(true);
  const freeze = lastCalc === -1 ? vis.length : lastCalc + 1;
  return { hidden, freeze };
}

/* Feature #14: a small inline bar used by the Share (planned) and Plan vs actual
   (actuals) columns. `parts` = [{v, color}] drawn as a 100%-width track with the
   first part as the reference length. Returns "" when there is nothing to show. */
function barHTML(parts, scaleMax) {
  const max = scaleMax || Math.max(...parts.map((p) => p.v), 0);
  if (!max) return '<span class="bar-empty">—</span>';
  const rows = parts.map((p) => {
    const pct = Math.max(0, Math.min(100, (p.v / max) * 100));
    return `<span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%;background:${p.color}"></span></span>`;
  }).join("");
  return `<span class="bar-stack">${rows}</span>`;
}
/* Bump whenever COLUMNS or defaultPrefs change. Stored prefs from an older
   registry are discarded (see viewPrefs) — otherwise a layout saved before a
   column became default-hidden keeps overriding the new default forever, which
   is exactly why the identity columns kept showing on the Planned grid. */
const COLS_VERSION = 2;

function viewPrefs(view) {
  let p = null;
  try { p = JSON.parse(localStorage.getItem("revCols_" + view) || "null"); } catch (_) { p = null; }
  // Discard pre-change prefs: they may name columns that no longer exist, or omit
  // new ones, and either way they silently beat the new defaults.
  if (!p || typeof p !== "object" || Number(p.v) !== COLS_VERSION) p = defaultPrefs(view);
  const allKeys = COLUMNS[view].map((c) => c.key);
  const hidden = Array.isArray(p.hidden) ? p.hidden.filter((k) => allKeys.includes(k)) : [];
  let freeze = Number(p.freeze);
  if (!Number.isFinite(freeze)) freeze = COLUMNS[view].length;
  freeze = Math.max(0, Math.min(freeze, allKeys.length - hidden.length));
  return { hidden, freeze };
}
function savePrefs(view, prefs) {
  try { localStorage.setItem("revCols_" + view, JSON.stringify({ ...prefs, v: COLS_VERSION })); } catch (_) {}
}
function visibleCols(view) {
  const p = viewPrefs(view);
  return COLUMNS[view].filter((c) => !p.hidden.includes(c.key));
}
// effective contiguous freeze count = clamp(prefs.freeze) on the VISIBLE set
function frozenCount(view) {
  const p = viewPrefs(view);
  return Math.max(0, Math.min(p.freeze, visibleCols(view).length));
}
// does the group row's identity label stay frozen (i.e. the entire non-calc block is pinned)?
function labelFrozen(view) {
  const vis = visibleCols(view);
  const fz = frozenCount(view);
  const labelEnd = vis.findIndex((c) => c.calc) ; // first calc column position
  const labelCount = labelEnd === -1 ? vis.length : labelEnd;
  return fz >= labelCount;
}

/* Build the 3-row sticky header for ANY grid from the visible column registry.
   Frozen columns (idx <= frozenCount) get sc-pinned cells; unfrozen ones render
   as plain (non-sticky) headers that scroll away with the weeks. */
function gridHeadHTML() {
  const weeks = state.weeks, months = state.months;
  const view = state.view;
  const vis = visibleWeekIndices();
  const cols = visibleCols(view);
  const fz = frozenCount(view);
  const headCells = cols.map((c, i) => {
    const idx = i + 1;
    const cls = idx <= fz ? `sticky-h sc${idx} colh` : "colh";
    return `<th class="${cls}">${esc(c.h)}</th>`;
  }).join("");
  const headBlank = (n) => (n > 0 ? "<th></th>".repeat(n) : "");
  // month/week spacer row: frozen columns get a pinned blank; others are plain
  const spacers = cols.map((c, i) => {
    const idx = i + 1;
    return idx <= fz ? `<th class="sticky-h sc${idx}"></th>` : "<th></th>";
  }).join("");
  // Mark the month and week we are CURRENTLY in, so the year-long grid has an
  // anchor. `state.current` comes from the server so the grid and the PM load
  // rail can never disagree about what "now" is.
  const cur = state.current || {};
  const monthCells = months.filter((m) => m.end >= vis[0] && m.start <= vis[vis.length - 1])
    .map((m) => {
      const s = Math.max(m.start, vis[0]), e = Math.min(m.end, vis[vis.length - 1]);
      const isNow = cur.month && String(m.name).toUpperCase() === String(cur.month).toUpperCase();
      return `<th colspan="${e - s + 1}" class="${isNow ? "mo-now" : ""}" title="${esc(m.name)}${isNow ? " - current month" : ""}">${esc(m.name)}</th>`;
    }).join("");
  const weekCells = vis.map((i) => {
    const isNow = cur.week_index === i;
    const mon = (months.find((m) => m.start <= i && i <= m.end) || {}).name || "";
    const tip = isNow && cur.week_start
      ? `Current week - ${cur.week_start} to ${cur.week_end} (${mon} by month band)`
      : `${mon} ${weeks[i]}`;
    return `<th class="week-h ${isNow ? "wk-now" : ""}" title="${esc(tip)}">${esc(weeks[i])}</th>`;
  }).join("");
  const actionBlank = "<th></th>";
  return `<tr class="head-row">
            ${headCells}
            ${headBlank(vis.length)}${actionBlank}
          </tr>
          <tr class="month-row">${spacers}${monthCells}${actionBlank}</tr>
          <tr class="week-row">${spacers}${weekCells}${actionBlank}</tr>`;
}

function colgroupHTML() {
  const cols = visibleCols(state.view);
  let s = "<colgroup>";
  cols.forEach((c) => { s += `<col style="width:${c.w}px">`; });
  for (let i = 0; i < visibleWeekIndices().length; i++) s += '<col style="width:54px">';
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

/* Feature #14: per-resource planned revenue + owning group total, filled by
   renderGrid() before rows are built. Read by gridRowHTML for the Share column. */
let groupMetrics = new Map();

function gridRowHTML(r) {
  const es = gridEditState();
  const mode = MODES[state.view];
  const hours = r.hours || Array(state.weeks.length).fill(0);
  const vis = visibleWeekIndices();
  const rate = effRate(r);
  const offRate = effOffshore(r);
  const total = vis.reduce((a, i) => a + (hours[i] || 0), 0);
  const rev = (rate || 0) * total;
  const cost = (offRate || 0) * total;
  const weekCell = (h, i) => es.hours
    ? `<input class="inp" type="number" step="0.25" min="0" data-week="${i}" value="${h ? h : ""}" placeholder="0" inputmode="decimal">`
    : `<input class="inp mirror" type="number" step="0.25" min="0" disabled value="${h ? h : ""}" data-week="${i}">`;
  let weekCells = "";
  vis.forEach((i) => { const h = hours[i] || 0; weekCells += `<td class="week${es.hours ? "" : " mirror-cell"}">${weekCell(h, i)}</td>`; });
  const delBtn = es.meta ? `<button class="del" title="Delete resource">✕</button>` : "";
  const cur = gridCurrencyTag(r);
  // registry-driven cell emission (same order as the header / colgroup)
  const cols = visibleCols(state.view);
  const fz = frozenCount(state.view);
  const cells = cols.map((c, i) => {
    const idx = i + 1;
    const sticky = idx <= fz ? ` sticky-l sc${idx}` : "";
    if (c.meta && c.field) {
      const body = c.key === "title"
        ? (es.meta ? titleSelectHTML(r) : `<span class="mirror-val">${esc(r.role || "—")}</span>`)
        : metaCell(r, c.field, es.meta);
      return `<td class="${sticky} meta-col">${body}</td>`;
    }
    if (c.rate) {
      const val = c.rate === "offshore_rate" ? offRate : rate;
      const body = es.meta
        ? `${cur}<input class="inp num" type="number" min="0" step="any" data-field="${c.rate}" value="${val ?? ""}" placeholder="—" title="${c.h} (auto-fills from Title)">`
        : `<span class="mirror-val">${cur}${val !== null && val !== undefined ? fmt(val) : "—"}</span>`;
      return `<td class="${sticky} meta-col num-cell">${body}</td>`;
    }
    if (c.calc) {
      if (c.key === "share") {
        // Feature #14: this resource's slice of planned revenue for its group.
        const gt = groupMetrics.get(r.id);
        const share = gt && gt.total ? (gt.rev / gt.total) * 100 : 0;
        return `<td class="${sticky} calc bar-cell"><span class="bar-num">${share.toFixed(1)}%</span>`
             + barHTML([{ v: share, color: "linear-gradient(90deg,var(--accent),var(--accent2))" }], 100) + `</td>`;
      }
      const v = c.calc === "total_hrs" ? total : c.calc === "total_rev" ? rev : cost;
      const dimCls = c.dim ? " dim" : "";
      return `<td class="${sticky} calc${dimCls}" data-calc="${c.calc}">${fmt(v, c.calc === "total_hrs" ? 1 : 2)}</td>`;
    }
    return `<td${sticky ? ` class="${sticky}"` : ""}></td>`;
  }).join("");
  return `<tr class="resource-row" data-rid="${r.id}">
    ${cells}
    ${weekCells}
    <td>${es.meta ? `<button class="edit-res" title="Edit resource">✎</button>` : ""}${delBtn}</td>
  </tr>`;
}

/* Feature #14b: size the scroll container so its BOTTOM (the horizontal
   scrollbar) is always on screen. The old CSS used a fixed 100vh-210px, which
   broke as soon as pinning the sidebar narrowed the main column enough to make
   the top strip / toolbar wrap onto another line — the grid then began further
   down and its scrollbar fell below the fold ("the scrollbar is gone").
   Instead we measure where the wrap actually starts and take the rest of the
   viewport, clamped so it always keeps a usable number of rows. */
function syncGridHeight(wrap) {
  if (!wrap) return;
  if (wrap.classList.contains("hidden")) return;
  const top = wrap.getBoundingClientRect().top;
  const bottomPad = 18;                       // breathing room under the scrollbar
  const avail = window.innerHeight - top - bottomPad;
  if (avail < 140) return;                    // hidden/animating — leave it alone
  wrap.style.setProperty("--grid-h", `${Math.round(avail)}px`);
}
/* Re-measure both grids: on resize, on the rail pin/hover toggle (the column
   width change reflows the toolbar), and after a tab switch. */
function syncAllGridHeights() {
  syncGridHeight(document.getElementById("gridWrap"));
  syncGridHeight(document.getElementById("actualsWrap"));
  syncGridHeight(document.getElementById("utilWrap"));
}
window.addEventListener("resize", syncAllGridHeights);

function alignSticky() {
  const wrap = document.querySelector("#gridWrap");
  const table = document.querySelector("#gridTable");
  const probe = document.querySelector("#gridBody tr.resource-row");
  if (!wrap || !table || !probe) return;
  syncGridHeight(wrap);
  const prev = wrap.scrollLeft;
  wrap.scrollLeft = 0;
  const els = document.querySelectorAll("#gridHead [class*=sc], #gridBody [class*=sc]");
  els.forEach((el) => { el.style.left = ""; el.style.position = "static"; });
  const tLeft = table.getBoundingClientRect().left;
  const fz = frozenCount(state.view);
  const xs = [];
  for (let i = 0; i < fz; i++) {
    const cell = probe.children[i];
    xs.push(cell ? Math.round(cell.getBoundingClientRect().left - tLeft) : null);
  }
  els.forEach((el) => { el.style.position = ""; });
  for (let i = 0; i < fz; i++) {
    if (xs[i] === null) continue;
    const idx = i + 1;
    document.querySelectorAll(`#gridHead .sc${idx}, #gridBody .sc${idx}`).forEach((el) => {
      el.style.left = `${xs[i]}px`;
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
  /* Feature #14: the Share column needs each resource's planned revenue AND its
     group's total, so compute both in one pass up front (groupMetrics is read by
     gridRowHTML). Computed over the VISIBLE week range so it matches the totals
     shown in the row. */
  groupMetrics = new Map();
  const visIdx = visibleWeekIndices();
  for (const g of groups) {
    let total = 0;
    const per = [];
    for (const m of g.members) {
      const hrs = visIdx.reduce((a, i) => a + ((m.hours || [])[i] || 0), 0);
      const rev = (effRate(m) || 0) * hrs;
      per.push([m.id, rev]);
      total += rev;
    }
    for (const [rid, rev] of per) groupMetrics.set(rid, { rev, total });
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
    // group row: label spans the leading non-calc (meta/rate) columns; each calc
    // column gets its own subtotal cell. If the label block is fully frozen, the
    // label cell is pinned so it scrolls with the row identity.
    const vis = visibleWeekIndices();
    const cols = visibleCols(state.view);
    const fz = frozenCount(state.view);
    // accumulate group subtotals across member resources
    let hrs = 0, rev = 0, cost = 0;
    for (const m of g.members) {
      const mtot = vis.reduce((a, i) => a + ((m.hours || [])[i] || 0), 0);
      hrs += mtot; rev += (effRate(m) || 0) * mtot; cost += (effOffshore(m) || 0) * mtot;
    }
    const labelSpan = cols.findIndex((c) => c.calc);
    const nLabel = labelSpan === -1 ? cols.length : labelSpan;
    const labelSticky = labelFrozen(state.view) && nLabel > 0 ? " sticky-l sc1" : "";
    let grp = `<td class="${labelSticky}" colspan="${nLabel}"><span class="group-chevron">▼</span>${esc(g.client || "—")}${g.project ? ` · ${esc(g.project)}` : ""}<span class="proj-count-chip">${g.members.length} resource(s)</span></td>`;
    cols.forEach((c, i) => {
      if (!c.calc) return;
      const idx = i + 1;
      const sticky = idx <= fz ? ` sticky-l sc${idx}` : "";
      if (c.key === "share") {
        // Feature #14: a group's own share of itself is 100% — showing a full bar
        // makes the group row read as the reference the rows are measured against.
        grp += `<td class="${sticky} calc bar-cell">`
             + `<span class="bar-num">100%</span>`
             + barHTML([{ v: 1, color: "linear-gradient(90deg,var(--accent),var(--accent2))" }], 1)
             + `</td>`;
        return;
      }
      const v = c.calc === "total_hrs" ? hrs : c.calc === "total_rev" ? rev : cost;
      const dimCls = c.dim ? " dim" : "";
      grp += `<td class="${sticky} calc${dimCls}" data-calc="${c.calc}">${fmt(v, c.calc === "total_hrs" ? 1 : 2)}</td>`;
    });
    html += `<tr class="group-row" data-group="${gi}" title="Expand / collapse">
      ${grp}
      ${visibleWeekIndices().map(() => "<td></td>").join("")}
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
  const vcols = visibleCols("planned");
  const nVcols = vcols.length;
  const nVisWeeks = visibleWeekIndices().length;
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) { rowEl = nextResourceRow(rowEl); if (!rowEl) break; }
    const cols = lines[li].split("\t");
    for (let ci = 0; ci < cols.length; ci++) {
      const col = anchorCol + ci;
      const val = cols[ci].trim();
      if (!val) continue;
      const rid = +rowEl.dataset.rid;
      if (col < nVcols) {
        const c = vcols[col];
        if (!c) continue;
        if (c.meta && c.field && es.meta) {
          const mi = $(`input[data-field="${c.field}"]`, rowEl);
          if (mi) { mi.value = val; markDirty(rid, "fields", c.field, val); }
        } else if (c.rate && es.meta) {
          const ri = $(`input[data-field="${c.rate}"]`, rowEl);
          if (ri) { ri.value = val; markDirty(rid, "fields", c.rate, num(val) ?? null); }
        } else if (c.calc) {
          // calc (read-only totals) — ignore pasted values
        }
      } else if (col >= nVcols && col < nVcols + nVisWeeks) {
        if (!es.hours) continue;
        const w = visibleWeekIndices()[col - nVcols];
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
  const edit = e.target.closest(".edit-res");
  if (edit) {
    const tr = edit.closest("tr[data-rid]");
    openResModal(+tr.dataset.rid);
    return;
  }
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
/* Feature #11.3: collapse/expand-all state + a title filter. */
let pricingCollapsed = false;
let pricingFilter = "";

function curSym(code) { return CURR_SYM[code] || code || "$"; }

/* Margin = how much of the client rate you keep after the offshore cost.
   (rate - offshore_rate) / rate. Shown as a colour-coded % so a title billed at
   cost (e.g. Solution Architect: rate == offshore_rate) jumps out immediately.
   Blank titles (no rate) and zero-rate titles render an em dash, never 0%. */
function marginCell(p) {
  const r = +p.rate, o = +p.offshore_rate;
  if (!isFinite(r) || !isFinite(o) || r <= 0) return `<span class="p-empty">—</span>`;
  const pct = ((r - o) / r) * 100;
  const cls = pct >= 40 ? "m-good" : pct >= 10 ? "m-ok" : "m-bad";
  return `<span class="p-margin ${cls}" title="client ${fmt(r)} − offshore ${fmt(o)}">${pct.toFixed(0)}%</span>`;
}

function pricingRowHTML(p) {
  const isEdit = editingPid === p.id || (editingPid === -1 && p.id === -1);
  /* Feature #11.1: "Used by" is a button that opens the popup. Kept as plain
     text while editing, so it cannot be clicked mid-edit by accident. */
  const usedCell = (isEdit || !p.used_by)
    ? `<span class="dim">${p.used_by || 0} resource(s)</span>`
    : `<button class="used-btn" title="Who uses this title? Click for names, rates and projects"
         onclick="openPricingPopup(${p.id})">${p.used_by} resource(s)</button>`;
  if (isEdit) {
    const sel = ["USD", "GBP", "CAD"].map((c) =>
      `<option value="${c}"${(p.currency || "USD") === c ? " selected" : ""}>${curSym(c)}</option>`).join("");
    return `<tr class="p-res p-edit" data-pid="${p.id}">
      <td><input class="rate-inp txt" data-field="title" value="${esc(p.title)}" placeholder="Title (e.g. Sr. DevOps Engineer)"></td>
      <td class="num"><input class="rate-inp" type="number" min="0" step="any" data-field="rate" value="${p.rate ?? ""}" placeholder="—"></td>
      <td class="num"><input class="rate-inp" type="number" min="0" step="any" data-field="offshore_rate" value="${p.offshore_rate ?? ""}" placeholder="—"></td>
      <td class="num"><span class="dim">—</span></td>
      <td><select class="cur-sel" data-field="currency" title="Currency for this title">${sel}</select></td>
      <td class="num">${usedCell}</td>
      <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
    </tr>`;
  }
  const sym = curSym(p.currency);
  return `<tr class="p-res" data-pid="${p.id}">
    <td class="p-title-read">${esc(p.title)}</td>
    <td class="num"><span class="p-read">${sym}${p.rate !== null && p.rate !== undefined ? fmt(p.rate) : '<span class="p-empty">—</span>'}</span></td>
    <td class="num"><span class="p-read">${sym}${p.offshore_rate !== null && p.offshore_rate !== undefined ? fmt(p.offshore_rate) : '<span class="p-empty">—</span>'}</span></td>
    <td class="num">${marginCell(p)}</td>
    <td class="p-cur"><span class="cur-chip">${sym}</span></td>
    <td class="num">${usedCell}</td>
    <td><button class="btn mini edit">Edit</button> <button class="btn mini apply">Apply</button> <button class="del" title="Delete title">✕</button></td>
  </tr>`;
}

/* Feature #11.1 + follow-up: popup listing who uses a pricing title.
   One row PER PERSON (they may hold the title on several projects), their
   projects collapsed onto one line as "client/project", and an Allocation
   column showing that person's share of this title's planned hours.
   The header count is `data.count` = people, matching the button exactly. */
async function openPricingPopup(pid) {
  const box = $("#priceResModalBody"), title = $("#priceResModalTitle");
  title.textContent = "Used by";
  box.innerHTML = '<div class="res-empty">Loading…</div>';
  $("#priceResModal").classList.remove("hidden");
  let data;
  try {
    data = await api(`/api/pricing/${pid}/resources`);
  } catch (e) {
    box.innerHTML = `<div class="res-empty">Could not load: ${esc(e.message || "")}</div>`;
    return;
  }
  const p = data.pricing || {}, list = data.resources || [];
  const sym = curSym(p.currency);
  const n = data.count || 0;
  title.textContent = `${p.title || "Title"} — used by ${n} resource${n === 1 ? "" : "s"}`;
  if (!list.length) {
    box.innerHTML = '<div class="res-empty">No resources use this title yet.</div>';
    return;
  }
  const sum = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  const totalH = data.total_hours || 0;
  // Note the row-count behind the people count when they differ, so the number
  // on the button is explainable rather than just smaller than it used to be.
  const rowsNote = (data.rows && data.rows !== n)
    ? ` &nbsp;|&nbsp; ${data.rows} project assignment${data.rows === 1 ? "" : "s"}`
    : "";
  let html = `<div class="res-summary">
      Pricing library rate <b>${sym}${fmt(p.rate)}</b> · offshore <b>${sym}${fmt(p.offshore_rate)}</b>
      &nbsp;|&nbsp; ${n} resource${n === 1 ? "" : "s"}${rowsNote}
      · planned revenue <b>$${fmt(sum("planned_revenue"))}</b>
    </div>`;
  html += `<div class="res-scroll"><table class="res-table"><thead><tr>
      <th>Resource</th><th>Project(s)</th>
      <th class="num">Rate</th><th class="num">Offshore</th>
      <th class="num">Hours</th><th class="num">Allocation</th><th class="num">Planned Rev</th>
    </tr></thead><tbody>`;
  for (const r of list) {
    const hrs = r.planned_hours || 0;
    const pct = r.allocation_pct || 0;
    html += `<tr>
      <td class="res-name">${esc(r.name)}</td>
      <td class="res-projs">${esc(r.projects || r.project || "—")}</td>
      <td class="num">$${fmt(r.rate)}</td>
      <td class="num">$${fmt(r.offshore_rate)}</td>
      <td class="num">${fmt(hrs)}</td>
      <td class="num alloc-cell"><b>${pct}%</b><span class="alloc-sub">${fmt(hrs)}/${fmt(totalH)}h</span></td>
      <td class="num">$${fmt(r.planned_revenue)}</td>
    </tr>`;
  }
  html += `</tbody><tfoot><tr>
      <td class="res-name">Total — ${n} resource${n === 1 ? "" : "s"}</td>
      <td></td><td></td><td></td>
      <td class="num">${fmt(totalH)}</td><td class="num">100%</td>
      <td class="num">$${fmt(sum("planned_revenue"))}</td>
    </tr></tfoot></table></div>`;
  box.innerHTML = html;
}

function renderPricing() {
  const rows = state.pricing || [];
  /* Feature #11.3: collapse / expand all pricing titles. Collapsed by default
     is NOT applied here — the stored preference decides on load. */
  const collapsed = pricingCollapsed;
  const shown = collapsed ? [] : rows;
  let html = `<div class="p-tools glass">
      <span class="sheet-note">${rows.length} title${rows.length === 1 ? "" : "s"}${collapsed ? " · collapsed" : ""}</span>
      <span class="p-tools-right">
        <input type="search" id="pricingFilter" class="search" placeholder="Filter titles…" value="${esc(pricingFilter)}">
        <button class="btn mini" id="btnPricingExpand"${collapsed ? "" : " disabled"}>Expand all</button>
        <button class="btn mini" id="btnPricingCollapse"${collapsed ? " disabled" : ""}>Collapse all</button>
      </span>
    </div>
    <table class="p-table"><thead><tr>
    <th>Title</th><th class="num">Rate</th><th class="num">Offshore Rate</th><th class="num">Margin</th><th class="p-cur">Currency</th>
    <th class="num">Used By</th><th></th>
  </tr></thead><tbody>`;
  const filtered = rows.filter((p) =>
    !pricingFilter || (p.title || "").toLowerCase().includes(pricingFilter.toLowerCase()));
  if (!filtered.length && editingPid !== -1) {
    html += `<tr class="p-res"><td colspan="7" class="dim">${rows.length ? "No titles match the filter." : "No titles yet — click + Add Title or import an Excel file."}</td></tr>`;
  }
  for (const p of filtered) html += pricingRowHTML(p);
  if (editingPid === -1) html += pricingRowHTML({ id: -1, title: "", rate: null, offshore_rate: null, currency: "USD", used_by: 0 });
  html += "</tbody></table>";
  $("#pricingBody").innerHTML = html;
  const ex = $("#btnPricingExpand"), co = $("#btnPricingCollapse");
  if (ex) ex.addEventListener("click", () => { pricingCollapsed = false; renderPricing(); });
  if (co) co.addEventListener("click", () => { pricingCollapsed = true; renderPricing(); });
  const pf = $("#pricingFilter");
  if (pf) pf.addEventListener("input", () => { pricingFilter = pf.value; renderPricing(); pf.focus(); });
}

/* ---------------- Team & Access (PMs + admins + DB security) ----------------
   Was the bottom half of renderPricing(). Kept as its own entry point so the
   access tab owns its own data loading instead of piggy-backing on a pricing
   render. */
function renderAccess() {
  // The capacity editor lives on this screen now, so keep it in step.
  if (typeof renderCapacity === "function") renderCapacity();
  if (!loadPMDataStarted) loadPMDataStarted = true;
  loadPMData().then(() => {
    if (state.view !== "access") return;
    renderPMs();
    renderAdmins();
  });
  // People + OT approvals (2026-10-01). Each block is hidden individually by
  // its own permission so a people-only or ot_approval-only admin still has a
  // usable Team & Access page.
  // PMs see the People list too: they must pick from it when assigning, and a PM
  // may add a new joiner. The server scopes the list (no rates) and gates every
  // write, so this does not hand a PM admin powers.
  const isPmRole = !!(state.me && state.me.role === "pm");
  const showPeople = canPerm("people") || isPmRole;
  showBlock($("#peopleToolbar"), showPeople);
  showBlock($("#peopleWrap"), showPeople);
  if (showPeople) { loadPeople().then(() => { if (state.view === "access") renderPeople(); }); if (!WB.load.length) refreshLoadOnly(); }
  const showOt = canPerm("ot_approval");
  showBlock($("#otToolbar"), showOt);
  showBlock($("#otWrap"), showOt);
  if (showOt) loadOt();
  // Recent activity (2026-10-01). Admin-only: the API gates it, and it names
  // who changed what, so any admin who can reach this tab may see it.
  // The activity log moved to its own #logsView section in the rail (2026-10-01);
  // its old home at the bottom of this tab was removed with it.
  renderPMs();
  renderAdmins();
  renderDbSec();
}
/* ---------------- Recent activity (2026-10-01) ----------------
   Server-side log of destructive / money-affecting actions. Built because the owner
   confirmed an accidental person merge and could not find out what it had done.
   Labels are friendly (a raw "person.merge" string would be useless to him). */
const ACTIVITY_LABELS = {
  "person.merge":      ["🔀", "Person merged"],
  "person.create":     ["➕", "Person added"],
  "person.delete":     ["🗑", "Person deleted"],
  "person.update":     ["✎", "Person edited"],
  "user.delete":       ["🗑", "Account deleted"],
  "user.create":       ["➕", "Account created"],
  "pricing.delete":    ["🗑", "Rate card row deleted"],
  "pricing.create":    ["➕", "Rate card row added"],
  "pricing.apply_all": ["💱", "All rates pushed"],
  "assignment.delete": ["🗑", "Removed from project"],
};
/* Destructive actions render hot so they are easy to spot while scanning. */
const ACTIVITY_HOT = new Set(["person.merge", "person.delete", "user.delete",
                              "pricing.delete", "assignment.delete"]);

function activityWhen(ts) {
  // SQLite stores UTC ("YYYY-MM-DD HH:MM:SS"); render it as a relative age so
  // "recently" is obvious at a glance.
  if (!ts) return "—";
  const d = new Date(String(ts).replace(" ", "T") + "Z");
  if (isNaN(d)) return esc(String(ts));
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderActivity(rows) {
  $("#activityHead").innerHTML = `<tr><th>When</th><th>Action</th><th>Who</th><th>What changed</th></tr>`;
  let html = "<tbody>";
  if (!rows || !rows.length) {
    html += `<tr><td colspan="4" class="dim">Nothing recorded yet. Merges, deletes and rate pushes will appear here as they happen.</td></tr>`;
  }
  for (const a of rows || []) {
    const [ico, label] = ACTIVITY_LABELS[a.action] || ["•", a.action];
    const hot = ACTIVITY_HOT.has(a.action) ? " act-hot" : "";
    html += `<tr class="act-row${hot}">
      <td class="dim" title="${esc(a.ts)}">${esc(activityWhen(a.ts))}</td>
      <td class="act-kind">${ico} ${esc(label)}</td>
      <td class="dim">${esc(a.actor || "—")}</td>
      <td class="act-detail"><b>${esc(a.target || "")}</b>${a.details ? " — " + esc(a.details) : ""}</td>
    </tr>`;
  }
  html += "</tbody>";
  $("#activityBody").innerHTML = html;
}

function loadActivity() {
  const lim = ($("#logLimit") && $("#logLimit").value) || 60;
  api(`/api/activity?limit=${encodeURIComponent(lim)}`)
    .then((d) => { renderActivity(d.activity || []); filterActivity(); })
    .catch((e) => {
      $("#activityHead").innerHTML = "";
      $("#activityBody").innerHTML =
        `<tbody><tr><td class="dim">Activity log unavailable: ${esc(e.message || "")}</td></tr></tbody>`;
    });
}

/* Free-text filter over the rendered log — who, action or person, no refetch. */
function filterActivity() {
  const s = $("#logSearch");
  if (!s) return;
  const q = (s.value || "").trim().toLowerCase();
  $$("#activityBody tr").forEach((tr) => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? "" : "none";
  });
  const shown = $$("#activityBody tr").filter((tr) => tr.style.display !== "none").length;
  const note = $("#logsCount");
  if (note) note.textContent = q ? `${shown} match${shown === 1 ? "" : "es"}` : "";
}

function initLogsView() {
  const s = $("#logSearch");
  if (s && s.dataset.bound !== "1") { s.dataset.bound = "1"; s.addEventListener("input", filterActivity); }
  const lim = $("#logLimit");
  if (lim && lim.dataset.bound !== "1") { lim.dataset.bound = "1"; lim.addEventListener("change", loadActivity); }
  const r = $("#btnLogRefresh");
  if (r && r.dataset.bound !== "1") { r.dataset.bound = "1"; r.addEventListener("click", loadActivity); }
}
$("#btnActivityRefresh")?.addEventListener("click", loadActivity);
initLogsView();

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

/* ---------------- PM assignment + capacity + admin management ---------------- */
let users = [], projects = [], projectOwners = {};
let admins = [], permCatalog = [];
let editingUser = null, editingAdmin = null;
let loadPMDataStarted = false;

async function loadPMData() {
  try {
    const [u, p, o] = await Promise.all([api("/api/users"), api("/api/projects"), api("/api/project-owners")]);
    users = u; projects = p;
    admins = u.filter((x) => x.role === "admin");
    // projectOwners: map "client|project" -> pm username
    projectOwners = {};
    (o || []).forEach((x) => { projectOwners[`${x.client}|${x.project}`] = x.pm; });
    try { permCatalog = (await api("/api/permissions")).permissions || []; }
    catch (_) { permCatalog = []; }
  } catch (e) { toast(`PM data failed: ${e.message}`, true); }
}

/* A (client, project) checkbox is disabled when another PM already owns it
   (one PM per client+project). The PM being edited may keep its own. */
function projectCheckboxes(selected, selfUsername) {
  const sel = new Set((selected || []).map((s) => `${s.client}|${s.project}`));
  return projects.map((pr) => {
    const key = `${pr.client}|${pr.project}`;
    const owner = projectOwners[key];
    const taken = owner && owner !== selfUsername;
    const checked = sel.has(key);
    const dis = taken ? " disabled" : "";
    const tag = taken ? ` <span class="pm-taken">(${esc(owner)})</span>` : "";
    return `<label class="pm-proj${dis ? " pm-disabled" : ""}"><input type="checkbox" value="${esc(key)}" data-client="${esc(pr.client)}" data-project="${esc(pr.project)}"${checked ? " checked" : ""}${dis}> ${esc(pr.client)} / ${esc(pr.project)}${tag}</label>`;
  }).join("");
}

/* (client, project) pairs with NO PM. A project without an owner is invisible
   work — nobody reconciles its actuals and nothing flags drift — so both the PM
   table and the People table flag it. Computed on the client from `users` +
   their scope, so it updates the instant a PM is removed with no extra
   round-trip to go stale. */
function ownerMap() {
  const m = new Map();
  for (const u of (users || [])) {
    for (const p of (u.projects || [])) {
      const k = `${(p.client || "").trim().toUpperCase()}|${(p.project || "").trim().toUpperCase()}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(u.username);
    }
  }
  return m;
}
function allProjectPairs() {
  const seen = new Set(), out = [];
  for (const r of (state.resources || [])) {
    const c = (r.client || "").trim(), p = (r.project || "").trim();
    if (!p) continue;
    const k = `${c.toUpperCase()}|${p.toUpperCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ client: c, project: p, key: k });
  }
  return out.sort((a, b) => (a.client + a.project).localeCompare(b.client + b.project));
}
function unassignedProjects() {
  const owners = ownerMap();
  return allProjectPairs().filter((p) => !owners.has(p.key));
}

function renderPMs() {
  // PM block is user management → `users` permission.
  const showUsers = canPerm("users");
  showBlock($("#pmWrap"), showUsers);
  // Explicit id, NOT previousElementSibling: the People and OT toolbars carry
  // the same `pm-toolbar` class, so a sibling lookup silently hijacks whichever
  // block happens to sit above #pmWrap.
  showBlock($("#pmToolbar"), showUsers);
  if (!showUsers) { editingUser = null; return; }
  $("#pmHead").innerHTML = `<tr><th>PM</th><th>Assigned Client / Project</th><th></th></tr>`;
  const pms = users.filter((u) => u.role !== "admin");
  let html = "<tbody>";
  if (!pms.length) html += `<tr><td colspan="3" class="dim">No PMs yet — click + Add PM.</td></tr>`;
  const unassigned = unassignedProjects();
  if (unassigned.length) {
    // Removing a PM silently orphans their projects. Say so loudly, right where
    // the PMs live, so it cannot go unnoticed (the owner's requirement).
    html += `<tr class="noowner-row"><td colspan="3">
      <div class="noowner">
        <span class="noowner-ico">⚠</span>
        <div><b>${unassigned.length} project${unassigned.length === 1 ? "" : "s"} without a PM.</b>
        Nobody is reconciling actuals for these, and nothing will flag drift.
        <button class="btn mini" id="filterUnassigned">Show them</button>
        <div class="noowner-list">${unassigned.map((p) => `<span class="noowner-chip">${esc(p.client ? p.client + " · " : "")}${esc(p.project)}</span>`).join("")}</div></div>
      </div></td></tr>`;
  }
  for (const u of pms) {
    if (editingUser === u.id) {
      html += `<tr class="p-res p-edit" data-uid="${u.id}">
        <td>
          <input class="rate-inp txt" data-field="username" value="${esc(u.username)}" disabled>
          <input class="rate-inp txt pm-pw" data-field="password" type="password" placeholder="New password (leave blank to keep)" autocomplete="new-password">
        </td>
        <td><div class="pm-projs">${projectCheckboxes(u.projects, u.username)}</div></td>
        <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
      </tr>`;
    } else {
      const projTxt = (u.projects || []).map((p) => `${p.client ? p.client + " / " : ""}${p.project}`).join(", ") || "—";
      html += `<tr class="p-res" data-uid="${u.id}">
        <td>${esc(u.username)}</td>
        <td class="dim">${esc(projTxt)}</td>
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

/* Capacity editor — lives on Utilization (2026-10-01). Capacity is the
   denominator of every % on that page, so the editor sits right below the grid.
   Collapsed by default so the tab still opens as a clean read-only report. */
let capOpen = false;

function renderCapacity() {
  const resources = state.resources || [];
  // Badge: how many resources differ from the 40h/week default — a quick signal
  // that someone is part-time before you read a single percentage.
  const nonStd = resources.filter((r) => (r.capacity ?? 40) !== 40).length;
  const badgeText = nonStd
    ? `<b>${nonStd}</b> of ${resources.length} not at 40h/wk`
    : `${resources.length} resources · all at 40h/wk`;
  // The badge shows on Utilization (read-only signal); the editor's toolbar
  // carries its own copy on Team & Access.
  for (const sel of ["#capBadge", "#capBadge2"]) {
    const b = $(sel);
    if (b) b.innerHTML = badgeText;
  }
  $("#capHead").innerHTML = `<tr><th>Resource</th><th>Client · Project</th><th class="num">Capacity (hrs/wk)</th></tr>`;
  let html = "<tbody>";
  if (!resources.length) {
    html += `<tr><td colspan="3" class="dim">No resources yet — add them on the Planned tab or import a workbook.</td></tr>`;
  }
  for (const r of resources) {
    const cap = r.capacity ?? 40;
    const off = cap !== 40 ? ' style="border-color:rgba(251,191,36,.45)"' : "";
    html += `<tr class="p-res" data-rid="${r.id}">
      <td>${esc(r.name)}</td>
      <td class="dim">${esc(r.client)}${r.project ? " · " + esc(r.project) : ""}</td>
      <td class="num"><input class="rate-inp cap-inp" type="number" min="1" step="1" data-cap="${r.id}" value="${cap}"${off}></td>
    </tr>`;
  }
  html += "</tbody>";
  $("#capBody").innerHTML = html;
  const wrap = $("#capWrap");
  if (wrap) wrap.classList.toggle("hidden", !capOpen);
  const btn = $("#btnToggleCap");
  if (btn) {
    btn.classList.toggle("active-toggle", capOpen);
    btn.textContent = capOpen ? "✓ Done" : "⚙ Capacity";
  }
}
// Toggle the capacity editor; save any open capacity edit first.
$("#btnToggleCap").addEventListener("click", async () => {
  capOpen = !capOpen;
  renderCapacity();
  if (capOpen) {
    const w = $("#capWrap");
    if (w) w.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});
// "Open Utilization →" on the Rate Card tab.
$("#btnRatesToUtil").addEventListener("click", () => switchView("util"));

/* Granularity toggle for the Utilization board (feature #15b). Month is the
   at-a-glance read; Week is the drill-in. Purely a re-render — same data, same
   endpoint — so switching is instant and changes nothing on the server. */
function setUtilMode(mode) {
  state.utilMode = mode === "week" ? "week" : "month";
  $$("#utilModeSeg .seg-btn").forEach((b) => {
    const on = b.dataset.utilMode === state.utilMode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  if (state.view === "util") renderUtilization();
}
$$("#utilModeSeg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => setUtilMode(b.dataset.utilMode)));

/* ---------------- DB security (encryption) ---------------- */
function renderDbSec() {
  // DB security block → its own `db_security` permission. This is why the
  // Team & Access tab unlocks on users OR db_security: an admin trusted only
  // with encryption still needs somewhere to land.
  const showDbSec = canPerm("db_security");
  showBlock($("#dbSecWrap"), showDbSec);
  showBlock($("#dbSecToolbar"), showDbSec);
  if (!showDbSec) return;
  api("/api/db-security").then((s) => {
    const status = s.encrypted
      ? `<span class="db-sec-ok">🔒 Encrypted</span>`
      : `<span class="db-sec-warn">⚠ Not encrypted</span>`;
    $("#dbSecStatus").innerHTML = status;
    $("#dbSecHead").innerHTML = `<tr><th>Database Password</th><th></th></tr>`;
    $("#dbSecBody").innerHTML = `
      <tr class="p-res">
        <td>
          <input class="rate-inp txt db-pw" id="dbPw" type="password" placeholder="${s.encrypted ? "New DB password (min 6 chars)" : "Set DB password (min 6 chars)"}" autocomplete="new-password">
        </td>
        <td><button class="btn mini" id="btnSetDbPw">${s.encrypted ? "Change Password" : "Set Password"}</button></td>
      </tr>`;
    $("#btnSetDbPw").addEventListener("click", async () => {
      const pw = $("#dbPw").value.trim();
      if (pw.length < 6) { toast("DB password must be at least 6 characters", true); return; }
      const btn = $("#btnSetDbPw"); btn.disabled = true; btn.textContent = "…";
      try {
        await api("/api/db-password", { method: "POST", body: JSON.stringify({ password: pw }) });
        toast("Database password set — DB is now encrypted");
        renderDbSec();
      } catch (e) { toast(`Failed: ${e.message}`, true); }
      btn.disabled = false; btn.textContent = "Save";
    });
  }).catch((e) => toast(`DB security failed: ${e.message}`, true));
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
    const projs = Array.from(tr.querySelectorAll('input[type="checkbox"]:checked')).map((c) => ({
      client: c.dataset.client || "",
      project: c.dataset.project || "",
    }));
    if (!uname) { toast("PM username required", true); return; }
    if (uid === -1 && !pw) { toast("Password required for new PM", true); return; }
    const btn = tr.querySelector(".save"); btn.disabled = true; btn.textContent = "…";
    try {
      if (uid === -1) {
        await api("/api/users", { method: "POST", body: JSON.stringify({ username: uname, password: pw, projects: projs }) });
      } else {
        const body = { projects: projs };
        if (pw) body.password = pw;  // only send a new password if one was entered
        await api(`/api/users/${uid}`, { method: "PUT", body: JSON.stringify(body) });
      }
      editingUser = null;
      toast("PM saved");
      await loadPMData(); renderPMs();
    } catch (err) { toast(`PM save failed: ${err.message}`, true); btn.disabled = false; btn.textContent = "Save"; }
    return;
  }
  if (e.target.closest(".del")) {
    if (!confirm(`Delete PM "${unameOf(uid)}"?`)) return;
    try {
      await api(`/api/users/${uid}`, { method: "DELETE" });
      await loadPMData();
      renderPMs();
      // Removing a PM can orphan projects — refresh the People table too so its
      // "no PM owns this project" flags appear immediately, not on next visit.
      if (typeof renderPeople === "function" && state.view === "access") renderPeople();
    }
    catch (err) { toast(`Delete failed: ${err.message}`, true); }
  }
});
function unameOf(uid) { const u = users.find((x) => x.id === uid); return u ? u.username : "this PM"; }

$("#btnAddUser").addEventListener("click", () => { editingUser = -1; renderPMs(); });
/* Delegated: the warning banner is re-rendered constantly, so a direct binding
   would be lost on the next render (and would stack up duplicates). */
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#filterUnassigned")) return;
  const un = new Set(unassignedProjects().map((p) => p.key));
  // switchView() is async — it awaits flush() and loadState(), and loadState is
  // what RENDERS the grid. A fixed setTimeout raced it and highlighted nothing.
  await switchView("planned");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  {
    let first = null;
    $$("#gridBody tr[data-rid]").forEach((tr) => {
      const r = (state.resources || []).find((x) => String(x.id) === tr.dataset.rid);
      if (!r) return;
      const k = `${(r.client || "").trim().toUpperCase()}|${(r.project || "").trim().toUpperCase()}`;
      if (un.has(k)) { tr.classList.add("noowner-hl"); if (!first) first = tr; }
    });
    if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
    const n = $$("#gridBody tr.noowner-hl").length;
    toast(n ? `${n} row(s) on projects with no PM are highlighted` : "No unowned rows visible");
  }
});

/* ---------------- Admin management (mirrors PMs + granular permissions) ---------------- */
function permCheckboxes(selected) {
  const sel = new Set(selected || []);
  if (!permCatalog.length) return '<span class="dim">(no permissions catalog — reload)</span>';
  return permCatalog.map((p) => {
    const checked = sel.has(p.key);
    return `<label class="pm-proj"><input type="checkbox" value="${esc(p.key)}" data-perm="${esc(p.key)}"${checked ? " checked" : ""}> ${esc(p.label)}</label>`;
  }).join("");
}

function renderAdmins() {
  // Only the owner (super-admin) manages admin accounts. Regular admins and PMs
  // never see this section at all. (Managing admins needs the `users` perm AND
  // super-admin — the server enforces both via _require_super_admin.)
  const isSuper = state.me && state.me.super_admin;
  // Managing admins requires the `users` permission as well as super-admin.
  const showUsers = canPerm("users");
  const superAndUsers = isSuper && showUsers;
  $("#adminToolbar").style.display = superAndUsers ? "" : "none";
  $("#adminWrap").style.display = superAndUsers ? "" : "none";
  if (!superAndUsers) { editingAdmin = null; return; }
  const head = $("#adminHead");
  head.innerHTML = `<tr><th>Admin</th><th>Permissions</th><th></th></tr>`;
  let html = "<tbody>";
  if (!admins.length) html += `<tr><td colspan="3" class="dim">No admin accounts yet — click + Add Admin.</td></tr>`;
  for (const u of admins) {
    if (editingAdmin === u.id) {
      html += `<tr class="p-res p-edit" data-aid="${u.id}">
        <td>
          <input class="rate-inp txt" data-field="username" value="${esc(u.username)}" disabled>
          <input class="rate-inp txt pm-pw" data-field="password" type="password" placeholder="New password (leave blank to keep)" autocomplete="new-password">
        </td>
        <td><div class="pm-projs">${permCheckboxes(u.permissions)}</div></td>
        <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
      </tr>`;
    } else {
      const permTxt = (u.permissions || []).length
        ? u.permissions.map((p) => {
            const c = permCatalog.find((x) => x.key === p);
            return c ? c.label : p;
          }).join(", ")
        : "—";
      html += `<tr class="p-res" data-aid="${u.id}">
        <td>${esc(u.username)}</td>
        <td class="dim">${esc(permTxt)}</td>
        <td><button class="btn mini edit">Edit</button> <button class="del" title="Delete Admin">✕</button></td>
      </tr>`;
    }
  }
  if (editingAdmin === -1) {
    html += `<tr class="p-res p-edit" data-aid="-1">
      <td>
        <input class="rate-inp txt" data-field="username" placeholder="Admin username" autocomplete="off">
        <input class="rate-inp txt pm-pw" data-field="password" type="password" placeholder="Password" autocomplete="new-password">
      </td>
      <td><div class="pm-projs">${permCheckboxes([])}</div></td>
      <td><button class="btn mini save">Save</button> <button class="btn mini cancel">Cancel</button></td>
    </tr>`;
  }
  html += "</tbody>";
  $("#adminBody").innerHTML = html;
}

function adminUnameOf(aid) { const a = admins.find((x) => x.id === aid); return a ? a.username : "this Admin"; }

$("#adminBody").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-aid]");
  if (!tr) return;
  const aid = +tr.dataset.aid;
  if (e.target.closest(".edit")) { editingAdmin = aid; renderAdmins(); return; }
  if (e.target.closest(".cancel")) { editingAdmin = null; renderAdmins(); return; }
  if (e.target.closest(".save")) {
    const uname = (tr.querySelector('[data-field="username"]')?.value || "").trim();
    const pw = (tr.querySelector('[data-field="password"]')?.value || "").trim();
    const perms = Array.from(tr.querySelectorAll('input[data-perm]:checked')).map((c) => c.dataset.perm);
    if (!uname) { toast("Admin username required", true); return; }
    if (aid === -1 && !pw) { toast("Password required for new admin", true); return; }
    const btn = tr.querySelector(".save"); btn.disabled = true; btn.textContent = "…";
    try {
      if (aid === -1) {
        await api("/api/users", { method: "POST", body: JSON.stringify({ username: uname, password: pw, role: "admin", permissions: perms }) });
      } else {
        const body = { permissions: perms };
        if (pw) body.password = pw;
        await api(`/api/users/${aid}`, { method: "PUT", body: JSON.stringify(body) });
      }
      editingAdmin = null;
      toast("Admin saved");
      await loadPMData(); renderAdmins();
    } catch (err) { toast(`Admin save failed: ${err.message}`, true); btn.disabled = false; btn.textContent = "Save"; }
    return;
  }
  if (e.target.closest(".del")) {
    if (!confirm(`Delete admin "${adminUnameOf(aid)}"?`)) return;
    try { await api(`/api/users/${aid}`, { method: "DELETE" }); await loadPMData(); renderAdmins(); }
    catch (err) { toast(`Delete failed: ${err.message}`, true); }
  }
});
$("#btnAddAdmin").addEventListener("click", () => { editingAdmin = -1; renderAdmins(); });

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

/* Utilization renders the same numbers at two granularities (feature #15b):
     • Month (default) — the year at a glance. Each month is a Planned/Actual
       column PAIR and the month header SPANS that pair (colspan=2), so the name
       sits over both of its cells. Before this the month cell carried no colspan
       while its sub-row carried two cells: the table spanned them anyway, so JAN
       measured 51px sitting over a 102px pair — the "A" column dangled outside
       its own month.
     • Week — the drill-in. Months become bands over their weeks and a week is
       itself a P/A pair, so the hierarchy reads Month > Week > P|A. This is the
       "only if needed" view; Month stays the default.

   Both modes are read-only views of the same hours, and both fix a second bug:
   every util header row had inherited `top: 0`, so on vertical scroll the P/A
   row landed ON TOP of the month names (measured 30px of overlap). Each row now
   gets an explicit offset.

   The API is month-only — /api/utilization returns planned_pct/actual_pct per
   month — so WEEK figures are derived client-side. state.resources carries
   hours[53] and actual_hours[53] per person-project row, and those are summed per
   NAME to match the server's per-person aggregation, then divided by capacity.
   Verified: derived month figures equal the server's to the decimal. */
function utilWeeklyByName() {
  const n = (state.weeks || []).length;
  const map = new Map();
  for (const r of state.resources || []) {
    let e = map.get(r.name);
    if (!e) { e = { planned: new Array(n).fill(0), actual: new Array(n).fill(0) }; map.set(r.name, e); }
    (r.hours || []).forEach((h, i) => { if (i < n) e.planned[i] += (h || 0); });
    (r.actual_hours || []).forEach((h, i) => { if (i < n) e.actual[i] += (h || 0); });
  }
  return map;
}
/* "Jan-02" -> "02": the month is already carried by the band above the week, and
   the cells are only ~54px wide. */
function utilWkLabel(w) {
  const m = String(w || "").match(/(\d+)\s*$/);
  return m ? m[1] : String(w || "");
}
/* Week indices owned by a month, clamped to the weeks we actually have.
   IMPORTANT: /api/utilization returns `months` as NAME STRINGS, while the
   {start,end} week mapping lives in state.months (from /api/state). So this
   resolves the index against state.months — reading mo.start off the string was
   returning undefined and silently collapsing every month band to zero weeks. */
function utilWeeksOf(mi) {
  const all = state.months || [];
  const mo = all[mi];
  if (!mo) return [];
  const last = (state.weeks || []).length - 1;
  const out = [];
  for (let i = Math.max(0, mo.start); i <= Math.min(last, mo.end); i++) out.push(i);
  return out;
}

/* ---------------- Utilization filters + availability (GH-29) ----------------

   the owner: "there should an option to filter as well so that I can see the
   details, per project and per resource" and "a way to look which resources will
   be available for a given month based on the percentage."

   The filters reuse msHtml() (the Dashboard's cascading multi-select) but hold
   their OWN state in state.utilFilters rather than dashF, so filtering
   Utilization never disturbs the Dashboard's selection. Unlike the Dashboard —
   where a filter only picks which rows are listed — these are sent to the server
   and applied BEFORE the utilization aggregation, so picking a project shows
   that project's hours rather than the person's whole book.
*/
function utilFiltersQS() {
  const p = new URLSearchParams();
  const f = state.utilFilters || {};
  for (const k of ["client", "project", "pm"]) {
    if (f[k] && f[k].length) p.set(k, f[k].join(","));
  }
  if (state.globalMonth && state.globalMonth !== "all") p.set("month", state.globalMonth);
  return p.toString();
}

/* Keep the two PM-ish lists from fighting: a PM option can never match a project
   that was filtered out, so narrow the PM list to the owners of the surviving
   projects. Cascading downward only — a PM choice never empties the project list. */
function utilOptsCascaded(opts, f) {
  const un = "Unassigned";
  let pms = opts.pms || [];
  if (f.project && f.project.length) {
    const want = new Set(f.project);
    const owners = new Set();
    let anyUnassigned = false;
    for (const p of opts.projects || []) {
      if (!want.has(p.label) && !want.has(p.project)) continue;
      const o = (p.owner || "").trim();
      if (o) owners.add(o); else anyUnassigned = true;
    }
    pms = pms.filter((x) => owners.has(x));
    if (anyUnassigned && !pms.includes(un)) pms = pms.concat([un]);
  }
  if ((opts.pms || []).length && pms.length === 0 && !opts.has_unassigned) {
    pms = opts.pms; // never strand the user with an empty control
  }
  return pms;
}

function renderUtilFilters(opts) {
  const host = $("#utilFilterRow");
  if (!host || !opts) return;
  const f = state.utilFilters;
  const projOpts = (opts.projects || []).map((p) => ({ value: p.label, label: p.label }));
  const pms = utilOptsCascaded(opts, f);
  const pmOpts = pms.map((x) => ({ value: x, label: x }));

  let html = "";
  html += msHtml("u_client", "Client", "All clients",
                 (opts.clients || []).map((c) => ({ value: c, label: c })), f.client, "");
  html += msHtml("u_project", "Project", "All projects", projOpts, f.project,
                 f.client && f.client.length ? `Showing ${f.client.length} client(s)` : "");
  html += msHtml("u_pm", "PM", "All PMs", pmOpts, f.pm,
                 opts.has_unassigned ? "Includes Unassigned" : "");
  const anySel = f.client.length + f.project.length + f.pm.length;
  html += `<div class="uf-clear"><button class="btn mini" id="btnUtilClear"${anySel ? "" : " disabled"}>Clear${anySel ? ` (${anySel})` : ""}</button></div>`;

  host.innerHTML = `<div class="filterbar">${html}</div><div class="uf-scope" id="utilScope"></div>`;
  bindUtilFilters();
  updateUtilScope();
}

/* Plain-language statement of what the numbers currently cover — the thing that
   makes a filtered grid trustworthy rather than mysterious. */
function updateUtilScope() {
  const el = $("#utilScope");
  if (!el) return;
  const f = state.utilFilters || {};
  const bits = [];
  if (f.client.length) bits.push(`client${f.client.length > 1 ? "s" : ""} <b>${esc(f.client.join(", "))}</b>`);
  if (f.project.length) bits.push(`project${f.project.length > 1 ? "s" : ""} <b>${esc(f.project.join(", "))}</b>`);
  if (f.pm.length) bits.push(`PM <b>${esc(f.pm.join(", "))}</b>`);
  const mon = state.globalMonth && state.globalMonth !== "all" ? ` for <b>${esc(state.globalMonth)}</b>` : "";
  if (!bits.length) { el.innerHTML = ""; el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `<span class="dot on"></span>Showing <b>filtered</b> utilization — ${bits.join(" · ")}${mon}. Hours are scoped to these rows, so totals drop below the full-year figures.`;
}

function bindUtilFilters() {
  const closeAll = () => {
    $$("#utilFilterRow .ms-pop").forEach((p) => p.classList.add("hidden"));
    $$("#utilFilterRow [data-msbtn]").forEach((b) => b.classList.remove("open"));
  };
  const place = (btn, pop) => {
    const r = btn.getBoundingClientRect();
    pop.style.left = "0px"; pop.style.top = "0px";
    const w = pop.offsetWidth || 280;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    left = Math.max(8, left);
    const h = pop.offsetHeight || 300;
    const below = window.innerHeight - r.bottom - 10;
    const up = below < Math.min(h, 220) && r.top > below;
    pop.classList.toggle("drop-up", up);
    pop.style.left = left + "px";
    pop.style.top = (up ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6) + "px";
  };
  $$("#utilFilterRow [data-msbtn]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = $(`#msPop-${b.dataset.msbtn}`);
      if (!pop) return;
      const wasOpen = !pop.classList.contains("hidden");
      closeAll();
      if (!wasOpen) {
        document.body.appendChild(pop);   // portal out of the panel, same as the Dashboard
        pop.classList.remove("hidden");
        b.classList.add("open");
        place(b, pop);
        const s = pop.querySelector(".ms-search");
        if (s) s.focus();
      }
    });
  });
  $$("#utilFilterRow [data-msall]").forEach((c) => {
    c.addEventListener("change", () => {
      const key = c.dataset.msall;
      if (key === "u_client") state.utilFilters.client = [];
      else if (key === "u_project") state.utilFilters.project = [];
      else if (key === "u_pm") state.utilFilters.pm = [];
      renderUtilization();
    });
  });
  $$("#utilFilterRow [data-msopt]").forEach((c) => {
    c.addEventListener("change", () => {
      const key = c.dataset.msopt, v = c.value;
      const map = { u_client: "client", u_project: "project", u_pm: "pm" };
      const arr = state.utilFilters[map[key]];
      const i = arr.indexOf(v);
      if (c.checked && i === -1) arr.push(v);
      if (!c.checked && i !== -1) arr.splice(i, 1);
      renderUtilization();
    });
  });
  $$("#utilFilterRow .ms-search").forEach((s) => {
    s.addEventListener("input", () => {
      const q = s.value.trim().toLowerCase();
      Array.from(s.parentElement.querySelectorAll("label:not(.allrow)")).forEach((l) => {
        l.style.display = !q || l.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  });
  const clr = $("#btnUtilClear");
  if (clr) clr.addEventListener("click", () => {
    state.utilFilters = { client: [], project: [], pm: [] };
    renderUtilization();
  });
}

/* ---------------- Availability for a month (GH-29) ----------------
   "which resources will be available for a given month based on the percentage."

   Availability = capacity − planned hours for the chosen month, from the SAME
   month payload the grid shows, so the two can never disagree. Both figures were
   summed across the person's projects server-side, so no extra field is needed.

   The month follows the rail's month selector; with no month chosen we read the
   CURRENT month, which is the one a resourcing decision is actually about.

   Caveat worth stating on screen: this uses PLANNED hours. The Actual column is
   hours already recorded, not remaining capacity, so it is deliberately not used
   as the denominator here.
*/
function utilAvailMonth(data) {
  const months = data.months || [];
  if (!months.length) return { idx: -1, name: "" };
  let idx = months.indexOf(state.globalMonth);
  if (idx === -1) {
    // current month, matched on the month LABEL the payload uses (state.months
    // holds {name,start,end}, the payload holds plain names)
    const nm = String((state.current || {}).month || "").toUpperCase();
    idx = months.findIndex((m) => String(m).toUpperCase() === nm);
  }
  if (idx === -1) {
    // fall back to the calendar month of today
    const now = new Date();
    const guess = ["JAN", "FEB", "MARCH", "APRIL", "MAY", "JUNE",
                   "JULY", "AUG", "SEP", "OCT", "NOV", "DEC"][now.getMonth()];
    idx = months.findIndex((m) => String(m).toUpperCase() === guess);
  }
  if (idx === -1) idx = 0;
  return { idx, name: months[idx] };
}

function renderAvailability(data) {
  const wrap = $("#availWrap");
  if (!wrap) return;
  const { idx, name } = utilAvailMonth(data);
  const rows = (data.rows || []).map((r) => {
    const mo = r.months && r.months[idx];
    if (!mo) return null;
    const cap = mo.capacity || 0;
    const planned = mo.planned_hours || 0;
    const free = Math.max(0, cap - planned);
    const freePct = cap ? (free / cap) * 100 : 0;
    const bookedPct = mo.planned_pct || 0;
    return { name: r.name, projects: r.projects || [], cap, planned, free, freePct,
             bookedPct, actual: mo.actual_hours || 0 };
  }).filter(Boolean);

  // Who gets listed (the owner, 2026-10-01): "I only need the people who are not
  // fully booked or overbooked status" — i.e. hide ONLY the people sitting at
  // exactly 100%. Available (any headroom) AND over-allocated both stay, because
  // over-allocation is the thing you most need to see when resourcing.
  // `hasRoom` needs a real hour free, not a rounding crumb: 99.9% booked is full.
  const isOver = (r) => r.bookedPct > 100;
  const hasRoom = (r) => r.freePct >= 1 || r.free >= 1;
  const avail = rows.filter((r) => !isOver(r) && hasRoom(r));
  const over = rows.filter(isOver);
  const full = rows.filter((r) => !isOver(r) && !hasRoom(r));   // exactly 100%
  // Most available first; over-allocated naturally settle at the bottom (they
  // have 0 free) which is exactly where the problems should sit.
  const shown = avail.concat(over)
    .sort((a, b) => b.freePct - a.freePct || a.name.localeCompare(b.name));
  const benchHrs = avail.reduce((s, r) => s + r.free, 0);

  // The button carries the headline count, so a click has visible feedback even
  // before the panel is reached. Measured before this was added: the panel's top
  // landed at 944px on a 950px viewport — i.e. at the very bottom edge — so the
  // toggle looked like it did nothing at all.
  const btn = $("#btnToggleAvail");
  if (btn) btn.innerHTML = rows.length
    ? `☰ Available · <b>${avail.length}</b>${over.length ? ` <span class="avail-over">+${over.length} over</span>` : ""}`
    : "☰ Available";

  // Compute the summary BEFORE the collapsed early-return: it is useful on its
  // own (the panel header is where the "N hidden" answer lives) and used to be
  // blank unless the panel happened to be open at render time.
  $("#availTitle").textContent = `Availability — ${name || "current month"}`;
  $("#availNote").innerHTML =
    `<b>${avail.length}</b> available with <b>${fmt(benchHrs, 0)}h</b> free` +
    (over.length ? ` · <b>${over.length}</b> over-allocated (listed below)` : "") +
    (full.length ? ` · ${full.length} at exactly 100% (hidden)` : "") +
    `. Free = capacity − planned hours. ` +
    `Capacity lives on <b>Team & Access</b>.`;

  wrap.classList.toggle("hidden", !state.availOpen);
  if (!state.availOpen) return;

  // Bring the panel into view when it is opened (see above).
  if (state._awaitAvailScroll) {
    state._awaitAvailScroll = false;
    requestAnimationFrame(() => {
      const top = wrap.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  }

  $("#availHead").innerHTML = `<tr>
    <th>Resource</th><th>Projects</th>
    <th class="num">Cap/mo</th><th class="num">Planned</th><th class="num">Free</th>
    <th class="num">Free %</th><th class="num">Booked %</th><th>Status</th></tr>`;

  $("#availBody").innerHTML = shown.map((r) => {
    const cls = r.freePct >= 50 ? "green" : r.freePct >= 25 ? "yellow" : "red";
    const label = r.bookedPct > 100 ? "Over-allocated"
                : r.freePct >= 50 ? "Available"
                : r.freePct >= 25 ? "Partly free" : "Fully booked";
    return `<tr${isOver(r) ? ' class="avail-over-row"' : ""}>
      <td class="u-name-td"><div class="u-name">${esc(r.name)}</div></td>
      <td class="u-proj">${esc(r.projects.join(", ") || "—")}</td>
      <td class="u-cell num">${fmt(r.cap, 0)}</td>
      <td class="u-cell num">${fmt(r.planned, 0)}</td>
      <td class="u-cell ${cls} num">${fmt(r.free, 0)}</td>
      <td class="u-cell ${cls} num">${fmt(r.freePct, 0)}%</td>
      <td class="u-cell num">${fmt(r.bookedPct, 0)}%</td>
      <td class="u-cell">${label}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="empty">Nobody is available for this scope — everyone is at or over capacity.</td></tr>`;
}

/* Filter the availability list by name/project without refetching. */
function bindAvailSearch() {
  const s = $("#availSearch");
  if (!s || s.dataset.bound === "1") return;
  s.dataset.bound = "1";
  s.addEventListener("input", () => {
    const q = s.value.trim().toLowerCase();
    $$("#availBody tr").forEach((tr) => {
      const t = tr.textContent.toLowerCase();
      tr.style.display = !q || t.includes(q) ? "" : "none";
    });
  });
}

function initUtilExtras() {
  const b = $("#btnToggleAvail");
  if (b && b.dataset.bound !== "1") {
    b.dataset.bound = "1";
    b.addEventListener("click", () => {
      state.availOpen = !state.availOpen;
      state._awaitAvailScroll = state.availOpen;   // scroll it into view on open
      b.classList.toggle("active-toggle", state.availOpen);
      renderUtilization();
    });
  }
  bindAvailSearch();
}

function renderUtilization() {
  const m = state.globalMonth === "all" ? "" : state.globalMonth;
  api(`/api/utilization?${utilFiltersQS()}`).then((data) => {
    const months = data.months;
    const chosen = state.globalMonth;
    const weekMode = state.utilMode === "week";
    const cur = state.current || {};
    // GH-29: the pick-lists come off this same payload (built from the PRE-filter
    // set), so the Utilization tab is self-contained — no dependency on having
    // loaded the Dashboard first.
    state.utilOptions = data.options || null;
    renderUtilFilters(data.options);
    initUtilExtras();
    // The Month/Week toggle only means something on the full-year board; the
    // single-month drill-down is already one month.
    const seg = $("#utilModeSeg");
    if (seg) seg.classList.toggle("hidden", chosen !== "all");
    const sub = (lbl, mi) => `<th class="u-sub"${typeof mi === "number" ? ` data-month-idx="${mi}"` : ""}>${lbl}</th>`;
    const nowMo = (nm) => cur.month && String(nm).toUpperCase() === String(cur.month).toUpperCase();
    const wmap = weekMode ? utilWeeklyByName() : null;

    if (chosen !== "all") {
      // ---- ONE MONTH: per-resource detail ----
      const mi = months.indexOf(chosen);
      const ws = utilWeeksOf(mi);

      if (weekMode && ws.length) {
        // WEEK drill-down: this month's weeks as P/A pairs + the month total.
        let head = `<tr class="u-row-month"><th class="u-th-name" rowspan="2">Resource</th><th rowspan="2">Projects</th><th rowspan="2" class="num">Cap/wk</th>`;
        head += ws.map((i) => `<th class="num u-wk-head" colspan="2" data-month-idx="${mi}" title="${esc(chosen)} · week of ${esc(state.weeks[i])}">${esc(utilWkLabel(state.weeks[i]))}</th>`).join("");
        head += `<th class="num" colspan="2">${esc(chosen)} total</th></tr>`;
        head += `<tr class="u-row-sub">${ws.map(() => sub("P", mi) + sub("A", mi)).join("")}${sub("P")}${sub("A")}</tr>`;
        let rows = "";
        for (const row of data.rows) {
          const mo = row.months[mi];
          if (!mo) continue;
          const cap = row.capacity_week || 40;
          const e = wmap.get(row.name);
          rows += `<tr>
          <td class="u-name-td"><div class="u-name">${esc(row.name)}</div></td>
          <td class="u-proj">${esc(row.projects.join(", ") || "—")}</td>
          <td class="u-cell num">${cap}</td>`;
          ws.forEach((i) => {
            const pl = e ? e.planned[i] : 0;
            const ac = e ? e.actual[i] : 0;
            const pp = cap ? (pl / cap) * 100 : 0;
            const ap = cap ? (ac / cap) * 100 : 0;
            const wl = esc(utilWkLabel(state.weeks[i]));
            rows += `<td class="u-cell ${utilClass(pp)}" data-month-idx="${mi}" title="planned ${pl}h / ${cap}h = ${pp.toFixed(0)}%">${fmt(pp, 0)}%</td>`;
            rows += `<td class="u-cell ${utilClass(ap)}" data-month-idx="${mi}" title="actual ${ac}h / ${cap}h = ${ap.toFixed(0)}%">${fmt(ap, 0)}%</td>`;
          });
          rows += `<td class="u-cell ${utilClass(mo.planned_pct)}" title="planned ${(mo.planned_hours || 0).toLocaleString()}h / ${mo.capacity}h">${fmt(mo.planned_pct, 0)}%</td>`;
          rows += `<td class="u-cell ${utilClass(mo.actual_pct)}" title="actual ${(mo.actual_hours || 0).toLocaleString()}h / ${mo.capacity}h">${fmt(mo.actual_pct, 0)}%</td></tr>`;
        }
        $("#utilHead").innerHTML = head;
        $("#utilBody").innerHTML = rows;
        bindUtilMonthHeaders(months);
        alignUtilSticky();
        renderAvailability(data);
        return;
      }

      // MONTH drill-down (unchanged shape: hours + % for the chosen month)
      let head = `<tr class="u-row-month"><th class="u-th-name">Resource</th><th>Projects</th><th class="num">Cap/wk</th><th class="num">Planned hrs</th><th class="num">Actual hrs</th><th class="num">Planned %</th><th class="num">Actual %</th></tr>`;
      let rows = "";
      for (const row of data.rows) {
        const mo = row.months[mi];
        if (!mo) continue;
        const pc = utilClass(mo.planned_pct);
        const ac = utilClass(mo.actual_pct);
        rows += `<tr>
          <td class="u-name-td"><div class="u-name">${esc(row.name)}</div></td>
          <td class="u-proj">${esc(row.projects.join(", ") || "—")}</td>
          <td class="u-cell num">${row.capacity_week || 40}</td>
          <td class="u-cell num">${fmt(mo.planned_hours, 1)}</td>
          <td class="u-cell num">${fmt(mo.actual_hours, 1)}</td>
          <td class="u-cell ${pc}">${fmt(mo.planned_pct, 0)}%</td>
          <td class="u-cell ${ac}">${fmt(mo.actual_pct, 0)}%</td>
        </tr>`;
      }
      $("#utilHead").innerHTML = head;
      $("#utilBody").innerHTML = rows;
      alignUtilSticky();
      renderAvailability(data);
      return;
    }

    // ---- ALL MONTHS ----
    // #utilView has no month dropdown of its own; the rail's global month drives
    // it, so the drill-down branches above only fire when a month is chosen.
    // Month headers are CLICKABLE (feature #15) and highlight that month's
    // columns down every resource row — the grid is far too wide to track a
    // month by eye.
    if (weekMode) {
      // MONTH > WEEK > P|A. Month bands span all of their weeks' P/A columns.
      let head = `<tr class="u-row-month"><th class="u-th-name" rowspan="3">Resource</th><th rowspan="3">Projects</th><th rowspan="3" class="num">Cap/wk</th>`;
      head += months.map((mm, mi) => {
        const w = utilWeeksOf(mi);
        if (!w.length) return "";
        const on = nowMo(mm) ? " u-mo-now" : "";
        return `<th class="num u-month-head u-band${on}" colspan="${w.length * 2}" data-month-idx="${mi}" title="Highlight ${esc(mm)} for every resource">${esc(mm)}</th>`;
      }).join("");
      head += `<th class="num" colspan="2" rowspan="1">Overall</th></tr>`;
      head += `<tr class="u-row-week">` + months.map((mm, mi) =>
        utilWeeksOf(mi).map((i) => `<th class="num u-wk${cur.week_index === i ? " u-wk-now" : ""}" colspan="2" data-month-idx="${mi}" title="${esc(mm)} · week of ${esc(state.weeks[i])}${cur.week_index === i ? " (current week)" : ""}">${esc(utilWkLabel(state.weeks[i]))}</th>`).join("")
      ).join("") + `</tr>`;
      // GH-29: `u-band` marks the month band so it can be CENTRED. The band's
      // cell is wider than its label and it sits above a row of week numbers, so
      // right-aligning it (the .num default) pushed "JAN" to the far edge of its
      // own block — it read as if it belonged to the last week instead of the month.
      // P/A sub-cells carry the month index too, so the highlight spans the whole
      // month band (every week, both metrics) rather than just the header.
      head += `<tr class="u-row-sub u-row-sub-wk">` + months.map((mm, mi) =>
        utilWeeksOf(mi).map(() => sub("P", mi) + sub("A", mi)).join("")
      ).join("") + sub("P") + sub("A") + `</tr>`;

      let rows = "";
      for (const row of data.rows) {
        const cap = row.capacity_week || 40;
        const e = wmap.get(row.name);
        rows += `<tr>
        <td class="u-name-td"><div class="u-name">${esc(row.name)}</div></td>
        <td class="u-proj">${esc(row.projects.join(", ") || "—")}</td>
        <td class="u-cell num">${cap}</td>`;
        months.forEach((mm, mi) => {
          utilWeeksOf(mi).forEach((i) => {
            const pl = e ? e.planned[i] : 0;
            const ac = e ? e.actual[i] : 0;
            const pp = cap ? (pl / cap) * 100 : 0;
            const ap = cap ? (ac / cap) * 100 : 0;
            const wl = esc(utilWkLabel(state.weeks[i]));
            const mn = esc(String(mm));
            rows += `<td class="u-cell ${utilClass(pp)}" data-month-idx="${mi}" title="${mn} wk ${wl} · planned ${pl}h / ${cap}h = ${pp.toFixed(0)}%">${fmt(pp, 0)}%</td>`;
            rows += `<td class="u-cell ${utilClass(ap)}" data-month-idx="${mi}" title="${mn} wk ${wl} · actual ${ac}h / ${cap}h = ${ap.toFixed(0)}%">${fmt(ap, 0)}%</td>`;
          });
        });
        rows += `<td class="u-cell ${utilClass(row.planned_overall)}" title="planned ${(row.total_planned || 0).toLocaleString()}h total">${fmt(row.planned_overall, 0)}%</td>`;
        rows += `<td class="u-cell ${utilClass(row.actual_overall)}" title="actual ${(row.total_actual || 0).toLocaleString()}h total">${fmt(row.actual_overall, 0)}%</td></tr>`;
      }
      $("#utilHead").innerHTML = head;
      $("#utilBody").innerHTML = rows;
      bindUtilMonthHeaders(months);
      alignUtilSticky();
      return;
    }

    // MONTH mode: 12 months, each a P/A pair; the month cell spans its pair.
    let head = `<tr class="u-row-month"><th class="u-th-name" rowspan="2">Resource</th><th rowspan="2">Projects</th><th rowspan="2" class="num">Cap/wk</th>`;
    head += months.map((mm, mi) => {
      const on = state.globalMonth === mm ? " u-month-active" : "";
      return `<th class="num u-month-head${on}" colspan="2" data-month-idx="${mi}" title="Highlight ${esc(mm)} for every resource">${esc(mm)}</th>`;
    }).join("") + `<th class="num" colspan="2">Overall</th></tr>`;
    // sub-header cells carry the month index too, so the highlight spans BOTH the
    // P and A sub-columns of the selected month.
    head += `<tr class="u-row-sub">${months.map((mm, mi) =>
      sub("P", mi) + sub("A", mi)).join("")}${sub("P") + sub("A")}</tr>`;
    let rows = "";
    for (const row of data.rows) {
      rows += `<tr>
        <td class="u-name-td"><div class="u-name">${esc(row.name)}</div></td>
        <td class="u-proj">${esc(row.projects.join(", ") || "—")}</td>
        <td class="u-cell num">${row.capacity_week || 40}</td>`;
      row.months.forEach((mo, mi) => {
        const pc = utilClass(mo.planned_pct);
        const ac = utilClass(mo.actual_pct);
        const on = state.globalMonth === months[mi] ? " u-month-active" : "";
        rows += `<td class="u-cell ${pc}${on}" data-month-idx="${mi}" title="planned ${(mo.planned_hours||0).toLocaleString()}h / ${mo.capacity}h">${fmt(mo.planned_pct, 0)}%</td>`;
        rows += `<td class="u-cell ${ac}${on}" data-month-idx="${mi}" title="actual ${(mo.actual_hours||0).toLocaleString()}h / ${mo.capacity}h">${fmt(mo.actual_pct, 0)}%</td>`;
      });
      const poc = utilClass(row.planned_overall);
      const aoc = utilClass(row.actual_overall);
      rows += `<td class="u-cell ${poc}" title="planned ${(row.total_planned||0).toLocaleString()}h total">${fmt(row.planned_overall, 0)}%</td>`;
      rows += `<td class="u-cell ${aoc}" title="actual ${(row.total_actual||0).toLocaleString()}h total">${fmt(row.actual_overall, 0)}%</td></tr>`;
    }
    $("#utilHead").innerHTML = head;
    $("#utilBody").innerHTML = rows;
    bindUtilMonthHeaders(months);
    // sticky alignment for the 3-column frozen block (Resource + Projects + Cap/wk)
    alignUtilSticky();
    renderAvailability(data);
  }).catch((e) => toast(`Utilization failed: ${e.message}`, true));
  // The capacity editor lives on this tab (2026-10-01 split) — keep it in sync
  // with whatever the grid just rendered.
  renderCapacity();
}

/* Feature #15: month header cells on the Utilization grid are clickable — the
   whole P/A column pair for that month lights up down every row. Purely a
   highlight (client-side), so nothing about the numbers changes: the grid stays
   the read-only full-year board. Clicking the same month again clears it.
   `state.utilMonth` is deliberately separate from `state.globalMonth` — the
   global one filters tabs server-side, this one only tints a column pair. */
function bindUtilMonthHeaders(months) {
  $$("#utilHead th[data-month-idx]").forEach((th) => {
    th.addEventListener("click", () => {
      const name = months[Number(th.dataset.monthIdx)];
      state.utilMonth = state.utilMonth === name ? "" : name;
      applyUtilMonthHighlight();
    });
  });
  applyUtilMonthHighlight();
}
function applyUtilMonthHighlight() {
  const active = state.utilMonth || "";
  const months = state.months || [];
  const idx = months.findIndex((m) => (m.name || m) === active);
  $$("#utilHead [data-month-idx], #utilBody [data-month-idx]").forEach((el) => {
    el.classList.toggle("u-month-active", active !== "" && Number(el.dataset.monthIdx) === idx);
  });
  // Header cells need an extra class so the sticky/blended backgrounds are
  // overridden without fighting the existing th colours.
  $$("#utilHead [data-month-idx]").forEach((el) => {
    el.classList.toggle("u-month-head-on", active !== "" && Number(el.dataset.monthIdx) === idx);
  });
}

/* Pin Resource + Projects + Cap/wk; the "Resource" header cell also pins to
   the left. Projects & Cap/wk are intentionally NOT sticky (they scroll). */
function alignUtilSticky() {
  const table = document.getElementById("utilTable");
  const probe = document.querySelector("#utilBody tr");
  if (!table || !probe) return;
  syncGridHeight(document.getElementById("utilWrap"));
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
/* Feature #12 (redesign): multi-select Dashboard filters. Each holds an array
   of selected values, and an EMPTY array means "no filter at that level" —
   which is what makes client-only / client+project / +PM combinations work.
   The month stays global (state.globalMonth) because every tab uses it. */
const dashF = { project: [], pm: [], client: [] };
let dashCurrency = "all";
const UNASSIGNED = "Unassigned";

function dashQs() {
  const p = new URLSearchParams();
  if (state.globalMonth && state.globalMonth !== "all") p.set("month", state.globalMonth);
  if (dashF.client.length) p.set("client", dashF.client.join(","));
  if (dashF.project.length) p.set("project", dashF.project.join(","));
  if (dashF.pm.length) p.set("pm", dashF.pm.join(","));
  if (dashCurrency !== "all") p.set("currency", dashCurrency);
  return p.toString();
}

/* Money in the row's own currency — never blend USD and EUR into one number. */
function money(v, cur) {
  return (cur === "EUR" ? "€" : "$") + fmt(v);
}

/* One multi-select control. `opts` = [{value,label}]. */
function msHtml(key, label, allLabel, opts, sel, note) {
  const n = sel.length;
  let val = allLabel;
  if (n === 1) {
    const o = opts.find((x) => x.value === sel[0]);
    val = o ? o.label : sel[0];
  } else if (n > 1) {
    val = `${n} selected`;
  }
  const body = opts.length
    ? opts.map((o) => `<label><input type="checkbox" data-msopt="${key}" value="${esc(o.value)}"${sel.includes(o.value) ? " checked" : ""}> ${esc(o.label)}</label>`).join("")
    : '<div class="empty">Nothing available</div>';
  return `<div class="fgroup">
    <span class="fg-label">${esc(label)}</span>
    <div class="ms">
      <button class="ms-btn" data-msbtn="${key}"><span class="val">${esc(val)}</span>${n > 1 ? `<span class="ms-count">${n}</span>` : ""}<span class="caret">▾</span></button>
      <div class="ms-pop hidden" id="msPop-${key}">
        <input class="ms-search" placeholder="Search ${esc(label.toLowerCase())}…">
        ${note ? `<div class="casc">${esc(note)}</div>` : ""}
        <label class="allrow"><input type="checkbox" data-msall="${key}"${n === 0 ? " checked" : ""}> ${esc(allLabel)}</label>
        ${body}
      </div>
    </div>
  </div>`;
}

/* Wire the filter row's multi-selects, month and currency pickers.
   Feature #13: each popup is MOVED to <body> when it opens and positioned with
   `position: fixed` under its button. It has to be a body child — the filter
   panel is `overflow-x: auto` and glass has `backdrop-filter`, and either one
   clips/filters an absolutely-positioned descendant, which is why the option
   list used to get cut off inside the panel. */
function bindDashFilters() {
  const closeAll = () => {
    $$(".ms-pop").forEach((p) => p.classList.add("hidden"));
    $$("[data-msbtn]").forEach((b) => b.classList.remove("open"));
  };
  const place = (btn, pop) => {
    const r = btn.getBoundingClientRect();
    const mw = Math.min(320, Math.max(265, r.width));
    pop.style.left = "0px"; pop.style.top = "0px";  // measure at origin first
    const w = pop.offsetWidth || mw;
    // keep it on-screen horizontally, preferring the button's left edge
    let left = Math.min(r.left, window.innerWidth - w - 8);
    left = Math.max(8, left);
    // flip above the button when there isn't room below
    const h = pop.offsetHeight || 300;
    const below = window.innerHeight - r.bottom - 10;
    const up = below < Math.min(h, 220) && r.top > below;
    pop.classList.toggle("drop-up", up);
    pop.style.left = left + "px";
    pop.style.top = (up ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6) + "px";
  };
  $$("[data-msbtn]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = $(`#msPop-${b.dataset.msbtn}`);
      if (!pop) return;
      const wasOpen = !pop.classList.contains("hidden");
      closeAll();
      if (!wasOpen) {
        document.body.appendChild(pop);      // portal out of the filter panel
        pop.classList.remove("hidden");
        b.classList.add("open");
        place(b, pop);
        const s = pop.querySelector(".ms-search");
        if (s) s.focus();
      }
    });
  });
  $$("[data-msall]").forEach((c) => {
    c.addEventListener("change", () => {
      dashF[c.dataset.msall] = [];
      renderDashboard();
    });
  });
  $$("[data-msopt]").forEach((c) => {
    c.addEventListener("change", () => {
      const key = c.dataset.msopt, v = c.value;
      const arr = dashF[key];
      const i = arr.indexOf(v);
      if (c.checked && i === -1) arr.push(v);
      if (!c.checked && i !== -1) arr.splice(i, 1);
      renderDashboard();
    });
  });
  /* Search filters the visible labels without touching the selection. */
  $$(".ms-pop .ms-search").forEach((s) => {
    s.addEventListener("input", () => {
      const q = s.value.trim().toLowerCase();
      Array.from(s.parentElement.querySelectorAll("label:not(.allrow)")).forEach((l) => {
        l.style.display = !q || l.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  });
  const dm = $("#dashMonth");
  if (dm) dm.addEventListener("change", () => {
    state.globalMonth = dm.value;
    const gm = $("#globalMonth");
    if (gm) gm.value = state.globalMonth;   // keep the rail's month in step
    renderDashboard();
  });
  const dc = $("#dashCurrency");
  if (dc) dc.addEventListener("change", () => { dashCurrency = dc.value; renderDashboard(); });
  const rs = $("#dashReset");
  if (rs) rs.addEventListener("click", () => {
    dashF.project = []; dashF.pm = []; dashF.client = [];
    dashCurrency = "all";
    renderDashboard();
  });
}
/* Close popups on outside click, Escape, scroll, or resize. A portalled popup
   is fixed-positioned, so any of those would leave it stranded otherwise. */
function closeMsPopups() {
  $$(".ms-pop").forEach((p) => p.classList.add("hidden"));
  $$("[data-msbtn]").forEach((b) => b.classList.remove("open"));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ms") && !e.target.closest(".ms-pop")) closeMsPopups();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMsPopups();
});
/* Close on OUTSIDE scroll/resize only.
   These were bound with `true` (capture), which fires for scroll events from ANY
   element — including a scroll INSIDE the popup itself. The option list is taller
   than its 300px max-height, so the moment the user touched its own scrollbar (or
   wheeled over it) the popup closed and the list was unreachable. the owner hit this
   on Project: "I cannot scroll down when i try to click the scrollbar the dropdown
   goes back". Scrolling the page still closes it, because a page scroll targets
   document/window, not the popup. */
const scrollClosesPopups = (e) => {
  const t = e.target;
  if (t && t.closest && t.closest(".ms-pop")) return;   // scrolling the list itself
  closeMsPopups();
};
window.addEventListener("scroll", scrollClosesPopups, true);
window.addEventListener("resize", closeMsPopups);

/* ---------------- collapsible rail (feature #13) ----------------
   Desktop: icon-only by default; expands on hover (pure CSS) or when PINNED.
   The pin state is remembered per browser. Mobile uses an explicit drawer. */
function initRail() {
  const shell = $("#appShell"), rail = $("#rail"), pin = $("#btnRailPin");
  if (!shell || !rail) return;
  let pinned = false;
  try { pinned = localStorage.getItem("revenue.railPinned") === "1"; } catch (_) {}
  const apply = () => {
    shell.classList.toggle("rail-pinned", pinned);
    if (pin) pin.setAttribute("aria-pressed", pinned ? "true" : "false");
    // keep the grid column in step with the rail's real rendered width when pinned
    if (pinned) shell.style.setProperty("--rail-w", "246px");
    else shell.style.removeProperty("--rail-w");
    // Feature #14b: pinning changes the main column's width, so the toolbar can
    // reflow onto another line — re-measure the grid height AFTER the layout
    // settles, otherwise the bottom scrollbar ends up off-screen.
    requestAnimationFrame(syncAllGridHeights);
  };
  apply();
  if (pin && pin.dataset.bound !== "1") {
    pin.dataset.bound = "1";
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = !pinned;
      try { localStorage.setItem("revenue.railPinned", pinned ? "1" : "0"); } catch (_) {}
      apply();
    });
  }
  // Hover expand: driven by a class (not CSS :hover) so the whole rail —
  // labels, selects, buttons — expands as one unit, and so it works on devices
  // where :hover is unreliable. Pinned wins over hover.
  const setExpanded = (on) => {
    if (window.innerWidth <= 900) return;
    shell.classList.toggle("rail-expanded", on && !pinned);
    requestAnimationFrame(syncAllGridHeights);   // width changed → re-measure
  };
  rail.addEventListener("mouseenter", () => setExpanded(true));
  rail.addEventListener("mouseleave", () => setExpanded(false));
  // keyboard/touch affordance: focusing a control inside also expands
  rail.addEventListener("focusin", () => setExpanded(true));
  rail.addEventListener("focusout", () => { if (!pinned) setExpanded(false); });
  // tapping the collapsed rail (touch, wide screen) expands it too
  rail.addEventListener("click", (e) => {
    if (window.innerWidth <= 900) return;
    if (!pinned && !shell.classList.contains("rail-expanded") && e.target.closest(".rail-sec")) {
      setExpanded(true);
    }
  });

  // mobile drawer
  const toggle = $("#btnRailToggle"), backdrop = $("#railBackdrop");
  const openDrawer = (on) => {
    rail.classList.toggle("open", on);
    if (backdrop) backdrop.classList.toggle("show", on);
  };
  if (toggle && toggle.dataset.bound !== "1") {
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", (e) => { e.stopPropagation(); openDrawer(!rail.classList.contains("open")); });
  }
  if (backdrop && backdrop.dataset.bound !== "1") {
    backdrop.dataset.bound = "1";
    backdrop.addEventListener("click", () => openDrawer(false));
  }
  // picking a section closes the drawer so the content is visible
  $$("#tabs .tab").forEach((t) => t.addEventListener("click", () => openDrawer(false)));
  window.addEventListener("resize", () => { if (window.innerWidth > 900) openDrawer(false); });
}

function renderDashboard() {
  api(`/api/dashboard?${dashQs()}`).then((data) => {
    const groups = data.rows.groups, totals = data.rows.totals;
    const byCur = {};
    totals.forEach((t) => { byCur[t.currency] = t; });
    const curs = Object.keys(byCur).sort();

    /* ── filter row: Month · Project · PM · Client · Currency ───────
       Option lists come from the server's FULL set (never the filtered one),
       so choosing a filter never shrinks what you can pick next. */
    const projOpts = (data.projects || []).map((p) => ({ value: p.label, label: p.label }));
    const clientOpts = (data.clients || []).map((c) => ({ value: c, label: c }));
    const pmOpts = (data.pms || []).map((p) => ({ value: p, label: p }));
    if (data.has_unassigned) pmOpts.push({ value: UNASSIGNED, label: "Unassigned (no PM yet)" });
    const monthOpts = ['<option value="all">All months</option>']
      .concat((state.months || []).map((m) =>
        `<option value="${esc(m.name)}"${state.globalMonth === m.name ? " selected" : ""}>${esc(m.name)}</option>`))
      .join("");
    $("#dashFilters").innerHTML = `
      <div class="fgroup">
        <span class="fg-label">Month</span>
        <select class="cur-sel" id="dashMonth">${monthOpts}</select>
      </div>
      ${msHtml("project", "Project", "All projects", projOpts, dashF.project, "Grouped by client — picking a client narrows this list")}
      ${msHtml("pm", "PM", "All PMs", pmOpts, dashF.pm, "Projects with no PM assigned appear as Unassigned")}
      ${msHtml("client", "Client", "All clients", clientOpts, dashF.client, "Pick a client on its own for client-level totals")}
      <div class="fgroup">
        <span class="fg-label">Currency</span>
        <select class="cur-sel" id="dashCurrency">
          <option value="all"${dashCurrency === "all" ? " selected" : ""}>All</option>
          <option value="USD"${dashCurrency === "USD" ? " selected" : ""}>USD</option>
          <option value="EUR"${dashCurrency === "EUR" ? " selected" : ""}>EUR</option>
        </select>
      </div>
      <button class="fclear" id="dashReset">Reset filters</button>`;

    /* ── KPI bar: ONE horizontal row of metrics ────────────────────
       With more than one currency in scope the tiles show one line per
       currency rather than adding EUR to USD (which would be meaningless). */
    const perCur = (f, fmtv) => (curs.length
      ? curs.map((c) => fmtv(f(byCur[c]), c)).join("<br>")
      : "—");
    const anyNeg = (f) => curs.some((c) => f(byCur[c]) < 0);
    const sum = (f) => curs.reduce((a, c) => a + f(byCur[c]), 0);
    const resCount = groups.reduce((a, g) => a + (g.resources || 0), 0);
    const kpi = (k, v, cls, sub2) =>
      `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls || ""}">${v}</div>${sub2 ? `<div class="sub2">${esc(sub2)}</div>` : ""}</div>`;
    $("#dashCards").innerHTML =
      kpi("Planned Revenue", perCur((t) => t.revenue, money), "cyan", `${resCount} resources`)
      + kpi("Planned Expense", perCur((t) => t.expense, money), "", "offshore rate × hrs")
      + kpi("Planned Savings", perCur((t) => t.revenue - t.expense, money),
            anyNeg((t) => t.revenue - t.expense) ? "red" : "green", "revenue − expense")
      + kpi("Revenue till date", perCur((t) => t.actual_rev || 0, money), "cyan", "recorded actuals only")
      + kpi("Expense till date", perCur((t) => t.actual_exp || 0, money), "", "recorded actuals only")
      + kpi("Savings till date", perCur((t) => (t.actual_rev || 0) - (t.actual_exp || 0), money),
            anyNeg((t) => (t.actual_rev || 0) - (t.actual_exp || 0)) ? "red" : "green", "actuals − expenses")
      + kpi("Variance", perCur((t) => ((t.actual_rev || 0) - (t.actual_exp || 0)) - (t.revenue - t.expense), money),
            anyNeg((t) => ((t.actual_rev || 0) - (t.actual_exp || 0)) - (t.revenue - t.expense)) ? "red" : "green",
            "savings till date vs plan");

    bindDashFilters();
    syncExportLinks();

    let rows = `<thead><tr><th>Country</th><th>Client</th><th>Project</th><th>Resource(s)</th><th>Planned Revenue</th><th>Planned Expense</th><th>Planned Savings</th><th>Revenue till date</th><th>Expense till date</th><th>Savings till date</th></tr></thead><tbody>`;
    for (const g of groups) {
      const pSavings = g.revenue - g.expense;
      const aSavings = (g.actual_rev || 0) - (g.actual_exp || 0);
      const cur = g.currency || "USD";   // rows are per-currency; never blend
      /* Feature #10.2: the resource count is a BUTTON that opens a popup
         listing who they are, their rates, and their projects. */
      const resCell = g.resources
        ? `<button class="res-btn" title="Who are they? Click for names, rates and projects"
             onclick="openResourcePopup('${esc(g.client)}','${esc(g.project === "—" ? "" : g.project)}')">${g.resources}</button>`
        : "0";
      rows += `<tr>
        <td>${esc(g.country)}</td><td>${esc(g.client)}</td><td>${esc(g.project)}</td><td>${resCell}</td>
        <td>${money(g.revenue, cur)}</td><td>${money(g.expense, cur)}</td>
        <td style="color:${pSavings >= 0 ? "var(--green)" : "var(--red)"}">${money(pSavings, cur)}</td>
        <td>${money(g.actual_rev || 0, cur)}</td><td>${money(g.actual_exp || 0, cur)}</td>
        <td style="color:${aSavings >= 0 ? "var(--green)" : "var(--red)"}">${money(aSavings, cur)}</td></tr>`;
    }
    for (const t of totals) {
      const pSavings = t.revenue - t.expense;
      const aSavings = (t.actual_rev || 0) - (t.actual_exp || 0);
      const cur = t.currency || "USD";
      rows += `<tr class="total-row">
        <td>TOTAL ${esc(cur)}</td><td>—</td><td>—</td><td>—</td>
        <td>${money(t.revenue, cur)}</td><td>${money(t.expense, cur)}</td>
        <td style="color:${pSavings >= 0 ? "var(--green)" : "var(--red)"}">${money(pSavings, cur)}</td>
        <td>${money(t.actual_rev || 0, cur)}</td><td>${money(t.actual_exp || 0, cur)}</td>
        <td style="color:${aSavings >= 0 ? "var(--green)" : "var(--red)"}">${money(aSavings, cur)}</td></tr>`;
    }
    rows += "</tbody>";
    $("#dashTable").innerHTML = rows;
  }).catch((e) => toast(`Dashboard failed: ${e.message}`, true));
}

/* Feature #10.2: popup listing who is on a client/project, with rates and
   projects. Explains the number the user clicked instead of just naming people.
   The response is sorted by contribution server-side. */
async function openResourcePopup(client, project) {
  const box = $("#dashResModalBody");
  const title = $("#dashResModalTitle");
  title.textContent = project
    ? `Resources on ${project} (${client})`
    : `Resources for ${client}`;
  box.innerHTML = '<div class="res-empty">Loading…</div>';
  $("#dashResModal").classList.remove("hidden");
  let data;
  try {
    data = await api(`/api/dashboard/resources?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project || "")}`);
  } catch (e) {
    box.innerHTML = `<div class="res-empty">Could not load resources: ${esc(e.message || "")}</div>`;
    return;
  }
  const list = data.resources || [];
  if (!list.length) {
    box.innerHTML = '<div class="res-empty">No resources found for this selection.</div>';
    return;
  }
  const sum = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  let html = `<div class="res-summary">${list.length} resource${list.length === 1 ? "" : "s"}
    · planned revenue <b>$${fmt(sum("planned_revenue"))}</b>
    · planned expense <b>$${fmt(sum("planned_expense"))}</b></div>`;
  html += `<div class="res-scroll"><table class="res-table"><thead><tr>
      <th>Resource</th><th>Title</th><th>Country</th><th>Project</th>
      <th class="num">Rate</th><th class="num">Offshore</th>
      <th class="num">Hours</th><th class="num">Planned Rev</th>
    </tr></thead><tbody>`;
  for (const r of list) {
    html += `<tr>
      <td class="res-name">${esc(r.name)}</td>
      <td>${esc(r.title)}</td>
      <td>${esc(r.country)}</td>
      <td>${esc(r.project)}</td>
      <td class="num">$${fmt(r.rate)}</td>
      <td class="num">$${fmt(r.offshore_rate)}</td>
      <td class="num">${fmt(r.planned_hours)}</td>
      <td class="num">$${fmt(r.planned_revenue)}</td>
    </tr>`;
  }
  html += "</tbody></table></div>";
  box.innerHTML = html;
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
  const vis = visibleWeekIndices();
  const cols = visibleCols("actuals");
  const fz = frozenCount("actuals");
  const headCells = cols.map((c, i) => {
    const idx = i + 1;
    const cls = idx <= fz ? `sticky-h sc${idx} colh` : "colh";
    return `<th class="${cls}">${esc(c.h)}</th>`;
  }).join("");
  const spacers = cols.map((c, i) => {
    const idx = i + 1;
    return idx <= fz ? `<th class="sticky-h sc${idx}"></th>` : "<th></th>";
  }).join("");
  // Mark the month and week we are CURRENTLY in, so the year-long grid has an
  // anchor. `state.current` comes from the server so the grid and the PM load
  // rail can never disagree about what "now" is.
  const cur = state.current || {};
  const monthCells = months.filter((m) => m.end >= vis[0] && m.start <= vis[vis.length - 1])
    .map((m) => {
      const s = Math.max(m.start, vis[0]), e = Math.min(m.end, vis[vis.length - 1]);
      const isNow = cur.month && String(m.name).toUpperCase() === String(cur.month).toUpperCase();
      return `<th colspan="${e - s + 1}" class="${isNow ? "mo-now" : ""}" title="${esc(m.name)}${isNow ? " - current month" : ""}">${esc(m.name)}</th>`;
    }).join("");
  const weekCells = vis.map((i) => {
    const isNow = cur.week_index === i;
    const mon = (months.find((m) => m.start <= i && i <= m.end) || {}).name || "";
    const tip = isNow && cur.week_start
      ? `Current week - ${cur.week_start} to ${cur.week_end} (${mon} by month band)`
      : `${mon} ${weeks[i]}`;
    return `<th class="week-h ${isNow ? "wk-now" : ""}" title="${esc(tip)}">${esc(weeks[i])}</th>`;
  }).join("");
  // NOTE: the head row must hold BLANKS over the week area, not the week labels.
  // It used to render `${headCells}${weekCells}`, which drew every week label a
  // second time one row above the real week-row (the Planned grid does this
  // correctly with headBlank()). Harmless-looking, but it duplicated the header
  // and, once the current week is highlighted, marked two cells instead of one.
  const headBlanks = vis.map(() => "<th></th>").join("");
  return `<tr class="head-row">${headCells}${headBlanks}</tr>
          <tr class="month-row">${spacers}${monthCells}</tr>
          <tr class="week-row">${spacers}${weekCells}</tr>`;
}

function actualsColgroup() {
  const cols = visibleCols("actuals");
  let s = "<colgroup>";
  cols.forEach((c) => { s += `<col style="width:${c.w}px">`; });
  for (let i = 0; i < visibleWeekIndices().length; i++) s += '<col style="width:54px">';
  return s + "</colgroup>";
}

function actualsRowHTML(r) {
  const planned = r.hours || Array(actualsData.weeks.length).fill(0);
  const actual = r.actual_hours || Array(actualsData.weeks.length).fill(0);
  const notes = r.actual_notes || {};
  const vis = visibleWeekIndices();
  const totalPlanned = vis.reduce((a, i) => a + (planned[i] || 0), 0);
  const totalActual = vis.reduce((a, i) => a + (actual[i] || 0), 0);
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
  vis.forEach((i) => { weekCells += weekCell(planned[i] || 0, actual[i] || 0, i); });
  const deltaCls = delta > 0 ? "a-over" : delta < 0 ? "a-under" : "";
  const cols = visibleCols("actuals");
  const fz = frozenCount("actuals");
  const cells = cols.map((c, i) => {
    const idx = i + 1;
    const sticky = idx <= fz ? ` sticky-l sc${idx}` : "";
    if (c.key === "country") return `<td class="${sticky} meta-col">${esc(r.country || "—")}</td>`;
    if (c.key === "client") return `<td class="${sticky} meta-col">${esc(r.client || "—")}</td>`;
    if (c.key === "project") return `<td class="${sticky} meta-col">${esc(r.project || "—")}</td>`;
    if (c.key === "name") return `<td class="${sticky} meta-col">${esc(r.name)}</td>`;
    if (c.key === "title") return `<td class="${sticky} meta-col">${esc(r.role || "—")}</td>`;
    if (c.key === "planned") return `<td class="${sticky} calc dim" data-calc="total_planned">${fmt(totalPlanned, 1)}</td>`;
    if (c.key === "actual") return `<td class="${sticky} calc" data-calc="total_actual">${fmt(totalActual, 1)}</td>`;
    if (c.key === "delta") return `<td class="${sticky} calc ${deltaCls}" data-calc="delta">${delta > 0 ? "+" : ""}${fmt(delta, 1)}</td>`;
    if (c.key === "pvabar") {
      /* Feature #14: two stacked bars — plan (cyan) over actual (green when at or
         over plan, red when under) — so the shape of a whole project is readable
         without reading any numbers. Scales both bars to the larger of the two. */
      const color = delta >= 0 ? "var(--green)" : "var(--red)";
      return `<td class="${sticky} calc bar-cell">`
           + barHTML([{ v: totalPlanned, color: "linear-gradient(90deg,var(--accent),var(--accent2))" },
                      { v: totalActual, color }])
           + `</td>`;
    }
    return `<td${sticky ? ` class="${sticky}"` : ""}></td>`;
  }).join("");
  return `<tr class="resource-row" data-rid="${r.id}">
    ${cells}
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
  const vis0 = visibleWeekIndices();
  const cols0 = visibleCols("actuals");
  const fz0 = frozenCount("actuals");
  groups.forEach((g, gi) => {
    let p = 0, a = 0;
    const vis = visibleWeekIndices();
    for (const m of g.members) {
      p += vis.reduce((x, i) => x + ((m.hours || [])[i] || 0), 0);
      a += vis.reduce((x, i) => x + ((m.actual_hours || [])[i] || 0), 0);
    }
    const labelSpan = cols0.findIndex((c) => c.calc);
    const nLabel = labelSpan === -1 ? 5 : labelSpan;
    const labelSticky = labelFrozen("actuals") && nLabel > 0 ? " sticky-l sc1" : "";
    let grp = `<td class="${labelSticky}" colspan="${nLabel}"><span class="group-chevron">▼</span>${esc(g.client || "—")}${g.project ? ` · ${esc(g.project)}` : ""}<span class="proj-count-chip">${g.members.length} resource(s)</span></td>`;
    cols0.forEach((c, i) => {
      if (!c.calc) return;
      const idx = i + 1;
      const sticky = idx <= fz0 ? ` sticky-l sc${idx}` : "";
      if (c.key === "pvabar") {
        // Feature #14: group-level plan-vs-actual bar (same encoding as the rows).
        const color = a >= p ? "var(--green)" : "var(--red)";
        grp += `<td class="${sticky} calc bar-cell">`
             + barHTML([{ v: p, color: "linear-gradient(90deg,var(--accent),var(--accent2))" },
                        { v: a, color }])
             + `</td>`;
        return;
      }
      const v = c.key === "planned" ? p : c.key === "actual" ? a : (a - p);
      const dimCls = c.key === "planned" ? " dim" : "";
      grp += `<td class="${sticky} calc${dimCls}" data-calc="${c.calc}">${fmt(v, 1)}</td>`;
    });
    html += `<tr class="group-row" data-group="${gi}" title="Expand / collapse">
      ${grp}
      ${vis.map(() => "<td></td>").join("")}
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
  syncGridHeight(wrap);
  const prev = wrap.scrollLeft;
  wrap.scrollLeft = 0;
  const els = document.querySelectorAll("#actualsHead [class*=sc], #actualsBody [class*=sc]");
  els.forEach((el) => { el.style.left = ""; el.style.position = "static"; });
  const tLeft = table.getBoundingClientRect().left;
  const fz = frozenCount("actuals");
  const xs = [];
  for (let i = 0; i < fz; i++) {
    const cell = probe.children[i];
    xs.push(cell ? Math.round(cell.getBoundingClientRect().left - tLeft) : null);
  }
  els.forEach((el) => { el.style.position = ""; });
  for (let i = 0; i < fz; i++) {
    if (xs[i] === null) continue;
    const idx = i + 1;
    document.querySelectorAll(`#actualsHead .sc${idx}, #actualsBody .sc${idx}`).forEach((el) => { el.style.left = `${xs[i]}px`; });
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
    // Build the FULL 53-week hours array: start from the stored actual hours
    // so a month-filtered grid (only some weeks rendered) doesn't shrink it.
    const r = actualsData.resources.find((x) => x.id === rid);
    const hours = (r && r.actual_hours ? [...r.actual_hours] : Array(actualsData.weeks.length).fill(0));
    // overwrite the rendered weeks by their real week index (data-week)
    $$(`input[data-week]`, tr).forEach((inp) => {
      const w = parseInt(inp.dataset.week, 10);
      if (!isNaN(w) && w >= 0 && w < hours.length) hours[w] = num(inp.value) || 0;
    });
    const notes = {};
    // collect any notes already stored for this resource
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
      // yesLabel/noLabel let a question state the CONSEQUENCE ("Yes - billed in
      // full" / "No - revenue drops") instead of a bare Yes/No, which matters for
      // the money decisions on the week sheet.
      html += `<button class="btn primary ot-yes" data-v="yes">${esc(opts.yesLabel || "Yes")}</button>`;
      html += `<button class="btn ghost ot-no" data-v="no">${esc(opts.noLabel || "No")}</button>`;
    }
    // An input question gets a real Submit button (Enter also submits).
    if (opts.input) {
      html += `<button class="btn primary ot-submit" data-v="submit">${esc(opts.submitLabel || "Save")}</button>`;
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
    // Free-text questions need an explicit SUBMIT. They used to render only
    // Cancel (buttons:false + Enter-to-submit), so a prompt that says "(required)"
    // looked unanswerable — you had to guess that Enter submits. Enter still works.
    body.querySelector(".ot-submit")?.addEventListener("click", () => {
      const el = body.querySelector("#otInput");
      finish(el ? el.value.trim() : "");
    });
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
  const weekLabel = esc(actualsData.weeks[w] || `week ${w + 1}`);
  const who = esc(r ? r.name : "");

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

/* ---------------- Add / Edit Planned Hours wizard ---------------- */
let plannedEntry = { client: "", project: "", month: 0 };

function plannedClients() {
  return [...new Set(state.resources.map((r) => (r.client || "").trim()).filter(Boolean))].sort();
}
function plannedProjectsFor(client) {
  return [...new Set(state.resources
    .filter((r) => (r.client || "").trim() === client && (r.project || "").trim())
    .map((r) => (r.project || "").trim()))].sort();
}
function plannedResourcesFor(client, project) {
  return state.resources.filter((r) =>
    (r.client || "").trim() === client && (r.project || "").trim() === project);
}

function openPlannedModal() {
  plannedEntry = { client: "", project: "", month: 0 };
  renderPlannedModal();
  $("#plannedModal").classList.remove("hidden");
}
function closePlannedModal() { $("#plannedModal").classList.add("hidden"); }

function renderPlannedModal() {
  const e = plannedEntry;
  const clients = plannedClients();
  const projects = e.client ? plannedProjectsFor(e.client) : [];
  const months = state.months || [];
  let html = `
    <div class="a-wizard">
      <div class="a-pick-row">
        <label>Client
          <select id="pClient" class="cur-sel">
            <option value="">— Select client —</option>
            ${clients.map((c) => `<option value="${esc(c)}"${c === e.client ? " selected" : ""}>${esc(c)}</option>`).join("")}
          </select>
        </label>
        <label>Project
          <select id="pProject" class="cur-sel" ${e.client ? "" : "disabled"}>
            <option value="">— Select project —</option>
            ${projects.map((p) => `<option value="${esc(p)}"${p === e.project ? " selected" : ""}>${esc(p)}</option>`).join("")}
          </select>
        </label>
        <label>Month
          <select id="pMonth" class="cur-sel">
            ${months.map((m, i) => `<option value="${i}"${i === e.month ? " selected" : ""}>${esc(m.name)}</option>`).join("")}
          </select>
        </label>
        <label>Year <span class="a-year">2026</span></label>
      </div>
      <div id="pTeam"></div>
    </div>`;
  $("#plannedModalBody").innerHTML = html;
  $("#pClient").addEventListener("change", (ev) => { plannedEntry.client = ev.target.value; plannedEntry.project = ""; renderPlannedModal(); });
  $("#pProject").addEventListener("change", (ev) => { plannedEntry.project = ev.target.value; renderPlannedModal(); });
  $("#pMonth").addEventListener("change", (ev) => { plannedEntry.month = +ev.target.value; renderPlannedModal(); });
  if (e.client && e.project) renderPlannedTeam();
}

function renderPlannedTeam() {
  const e = plannedEntry;
  const resources = plannedResourcesFor(e.client, e.project);
  const months = state.months || [];
  const m = months[e.month];
  if (!m) { $("#pTeam").innerHTML = `<div class="dim">No month data.</div>`; return; }
  const weekIdx = [];
  for (let i = m.start; i <= m.end; i++) weekIdx.push(i);
  const weekLabels = weekIdx.map((i) => state.weeks[i] || `W${i + 1}`);
  let html = `<div class="a-team-head">${resources.length} resource(s) · ${esc(e.client)} / ${esc(e.project)} · ${esc(m.name)}</div>`;
  if (!resources.length) {
    html += `<div class="dim">No resources assigned to this project.</div>`;
    $("#pTeam").innerHTML = html;
    return;
  }
  html += `<table class="a-entry-table">
    <thead><tr><th>Resource</th><th>Title</th>${weekLabels.map((w) => `<th>${esc(w)}</th>`).join("")}<th>Total</th></tr></thead><tbody>`;
  for (const r of resources) {
    const planned = r.hours || [];
    let total = 0;
    html += `<tr data-rid="${r.id}">
      <td class="a-res-name">${esc(r.name)}</td>
      <td class="dim">${esc(r.role || "—")}</td>`;
    for (const i of weekIdx) {
      const p = planned[i] || 0;
      total += p;
      html += `<td class="a-week-cell" data-week="${i}">
        <input class="inp a-inp" type="number" step="0.25" min="0" data-week="${i}" value="${p ? p : ""}" placeholder="0" inputmode="decimal">
      </td>`;
    }
    html += `<td class="a-total" data-total>${total ? total : "—"}</td></tr>`;
  }
  html += `</tbody></table>`;
  $("#pTeam").innerHTML = html;
  // live total
  $$("#pTeam tr[data-rid]").forEach((tr) => {
    $$("input[data-week]", tr).forEach((inp) => {
      inp.addEventListener("input", () => {
        let t = 0;
        $$("input[data-week]", tr).forEach((x) => { t += num(x.value) || 0; });
        tr.querySelector("[data-total]").textContent = t ? t : "—";
      });
    });
  });
}

async function savePlannedModal() {
  const e = plannedEntry;
  const resources = plannedResourcesFor(e.client, e.project);
  const months = state.months || [];
  const m = months[e.month];
  if (!m) { toast("Select a month first", true); return; }
  const weekIdx = [];
  for (let i = m.start; i <= m.end; i++) weekIdx.push(i);
  let any = false;
  for (const r of resources) {
    const tr = $(`#pTeam tr[data-rid="${r.id}"]`);
    if (!tr) continue;
    const hours = [...(r.hours || [])];
    let changed = false;
    for (const i of weekIdx) {
      const inp = $(`input[data-week="${i}"]`, tr);
      if (!inp) continue;
      const v = num(inp.value) || 0;
      if (v !== (r.hours || [])[i]) changed = true;
      hours[i] = v;
    }
    if (!changed) continue;
    any = true;
    try {
      await api(`/api/resources/${r.id}/hours`, { method: "PUT", body: JSON.stringify({ hours }) });
    } catch (err) { toast(`Save failed: ${err.message}`, true); return; }
  }
  if (!any) { toast("No changes to save"); return; }
  toast("Planned hours saved");
  closePlannedModal();
  await loadState();
}

$("#btnAddPlanned").addEventListener("click", openPlannedModal);
$("#plannedModalCancel").addEventListener("click", closePlannedModal);
$("#plannedModalSave").addEventListener("click", savePlannedModal);

/* ---------------- Add / Edit Resource modal (Planned) ---------------- */
let resEditId = null; // null = add, else resource id being edited

function openResModal(rid) {
  resEditId = rid || null;
  renderResModal();
  $("#resModal").classList.remove("hidden");
}
function closeResModal() { $("#resModal").classList.add("hidden"); resEditId = null; }

/* Parse a week label like "Jan-02" into a date (assumes 2026). */
function weekLabelToDate(label) {
  const m = /^([A-Za-z]{3})-(\d{1,2})$/.exec(label || "");
  if (!m) return null;
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const mo = months[m[1].toUpperCase()];
  if (mo === undefined) return null;
  return new Date(2026, mo, parseInt(m[2], 10));
}
/* Map a start/end date to the week indices they cover (inclusive). */
function dateRangeToWeeks(startStr, endStr) {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const out = [];
  state.weeks.forEach((label, i) => {
    const d = weekLabelToDate(label);
    if (d && d >= start && d <= end) out.push(i);
  });
  return out;
}

function renderResModal() {
  const isEdit = resEditId !== null;
  const r = isEdit ? state.resources.find((x) => x.id === resEditId) : null;
  $("#resModalTitle").textContent = isEdit ? "Edit Resource" : "Add Resource";
  const clients = [...new Set(state.resources.map((x) => (x.client || "").trim()).filter(Boolean))].sort();
  const projects = [...new Set(state.resources.map((x) => (x.project || "").trim()).filter(Boolean))].sort();
  const titles = state.pricing.map((p) => p.title);
  // resource picker: "New resource" or an existing one to edit
  const resOpts = `<option value="">— New resource —</option>` +
    state.resources.map((x) => `<option value="${x.id}"${r && r.id === x.id ? " selected" : ""}>${esc(x.name)} (${esc(x.client)} / ${esc(x.project)})</option>`).join("");
  const clientOpts = `<option value="">—</option>` + clients.map((c) => `<option value="${esc(c)}"${r && r.client === c ? " selected" : ""}>${esc(c)}</option>`).join("");
  const projOpts = `<option value="">—</option>` + projects.map((p) => `<option value="${esc(p)}"${r && r.project === p ? " selected" : ""}>${esc(p)}</option>`).join("");
  const titleOpts = `<option value="">—</option>` + titles.map((t) => `<option value="${esc(t)}"${r && r.role === t ? " selected" : ""}>${esc(t)}</option>`).join("");
  const defStart = r ? "" : "2026-01-01";
  const defEnd = r ? "" : "2026-12-31";
  // --- max 2 titles per person (the owner, 2026-09-30) --------------------------
  // "A resource should be allocated as one title or the max 2 title — like I
  // could have a PM do BA for another project." A title lives on the
  // (client, project) row, so a SECOND title means a second row for the same
  // person on a different project — that is how Marcus Lane already holds
  // "Project manager" and "Solution Architect" at different rates.
  // This panel shows what they hold now and offers a one-click "Add a 2nd
  // title" that duplicates the person onto a fresh row, ready to pick a
  // different project + title. The server enforces the same max of 2.
  const nameTyped = (($("#resName") && $("#resName").value.trim()) || (r ? (r.name || "").trim() : "")).trim();
  const myRows = nameTyped ? state.resources.filter((x) => (x.name || "").trim() === nameTyped) : [];
  const held = [...new Set(myRows.map((x) => (x.role || "").trim()).filter(Boolean))];
  const heldLabel = held.length
    ? held.map((t) => {
        const row = myRows.find((x) => (x.role || "").trim() === t);
        const cp = row ? [row.client, row.project].filter(Boolean).join("/") : "";
        return esc(cp ? `${t} (${cp})` : t);
      }).join(" &nbsp;·&nbsp; ")
    : '<span class="dim">none yet</span>';
  const twoTitlePanel = (!isEdit && nameTyped) ? `
      <div class="res-row res-title-panel">
        <div class="res-titles-held">
          <b>${esc(nameTyped)}</b> holds <b>${held.length}</b> of 2 titles: ${heldLabel}
        </div>
        ${held.length >= 2
          ? '<div class="res-hint res-max-hint">Maximum of 2 titles reached — edit an existing row to change one.</div>'
          : `<button type="button" class="btn ghost" id="resAddTitle">+ Add a 2nd title on another project</button>
             <div class="res-hint res-add-hint">Adds a second row for this person. Pick the other project and its title (rates auto-fill).</div>
             <div class="res-hint res-max-hint" style="display:none">Maximum of 2 titles reached — edit an existing row to change one.</div>`}
      </div>` : "";
  $("#resModalBody").innerHTML = `
    <div class="res-form">
      <div class="res-row">
        <label>Resource <select id="resPick" class="cur-sel">${resOpts}</select></label>
        <label class="res-hint">Pick an existing resource to edit, or choose "New resource".</label>
      </div>
      <div class="res-row">
        <label>Client <select id="resClient" class="cur-sel">${clientOpts}</select></label>
        <label>Project <select id="resProject" class="cur-sel">${projOpts}</select></label>
      </div>
      <div class="res-row">
        <label>Resource Name <input class="inp res-inp" id="resName" value="${esc(r ? r.name : "")}" placeholder="e.g. John Doe"></label>
        <label>Title <select id="resTitle" class="cur-sel">${titleOpts}</select></label>
      </div>
      <div class="res-row">
        <label>Rate ($) <input class="inp res-inp num" id="resRate" type="number" min="0" step="any" value="${r && r.rate != null ? r.rate : ""}" placeholder="auto from Title"></label>
        <label>Offshore Rate ($) <input class="inp res-inp num" id="resOffRate" type="number" min="0" step="any" value="${r && r.offshore_rate != null ? r.offshore_rate : ""}" placeholder="auto from Title"></label>
      </div>
      <div class="res-row">
        <label>Utilization (hrs/week) <input class="inp res-inp num" id="resHpw" type="number" min="0" step="0.25" value="${r && r.capacity ? r.capacity : 40}" placeholder="40"></label>
        <label class="res-hint">Hours auto-filled for each week between Start and End.</label>
      </div>
      <div class="res-row">
        <label>Start Date <input class="inp res-inp" id="resStart" type="date" value="${r ? "" : defStart}"></label>
        <label>End Date <input class="inp res-inp" id="resEnd" type="date" value="${r ? "" : defEnd}"></label>
      </div>
      ${twoTitlePanel}
      <div class="modal-actions">
        <button class="btn ghost" id="resModalCancel">Cancel</button>
        <button class="btn primary" id="resModalSave">Save</button>
      </div>
    </div>`;
  // Wire Save/Cancel HERE — they are re-created by this innerHTML above, so a
  // one-time binding at load time would attach to nothing (Save would be dead).
  const sc = $("#resModalCancel"), sv = $("#resModalSave");
  if (sc) sc.addEventListener("click", closeResModal);
  if (sv) sv.addEventListener("click", saveResModal);
  // wire: keep the "holds N of 2 titles" panel in sync with the typed name.
  // PITFALL (hit live): calling renderResModal() here re-rendered the whole
  // form and WIPED the name the user had just typed (the field is rebuilt from
  // `r`, which is null on a new resource), so Save then failed "name required".
  // Update only the panel node instead — never re-render the form on input.
  const nameEl = $("#resName");
  if (nameEl && !nameEl.dataset.bound) {
    nameEl.dataset.bound = "1";
    const syncPanel = () => {
      const nm = (nameEl.value || "").trim();
      const panel = document.querySelector(".res-title-panel");
      if (!panel) return;
      const rows = nm ? state.resources.filter((x) => (x.name || "").trim() === nm) : [];
      const heldNow = [...new Set(rows.map((x) => (x.role || "").trim()).filter(Boolean))];
      const label = heldNow.length
        ? heldNow.map((t) => {
            const rw = rows.find((x) => (x.role || "").trim() === t);
            const cp = rw ? [rw.client, rw.project].filter(Boolean).join("/") : "";
            return esc(cp ? `${t} (${cp})` : t);
          }).join(" &nbsp;·&nbsp; ")
        : '<span class="dim">none yet</span>';
      panel.querySelector(".res-titles-held").innerHTML =
        `<b>${esc(nm)}</b> holds <b>${heldNow.length}</b> of 2 titles: ${label}`;
      // show/hide the "add a 2nd title" affordance without touching the form
      const btn = panel.querySelector("#resAddTitle");
      const hintFull = panel.querySelector(".res-max-hint");
      const hintAdd = panel.querySelector(".res-add-hint");
      const atMax = heldNow.length >= 2;
      if (btn) btn.style.display = atMax ? "none" : "";
      if (hintAdd) hintAdd.style.display = atMax ? "none" : "";
      if (hintFull) hintFull.style.display = atMax ? "" : "none";
    };
    nameEl.addEventListener("input", syncPanel);
    nameEl.addEventListener("change", syncPanel);
  }
  // wire: "Add a 2nd title" — save this person's current row, then reopen the
  // form as a NEW row for the same person so they can pick the 2nd project
  // and title. A second title is a second (client, project) row, so we must
  // not just re-render the same row.
  const addTitleBtn = $("#resAddTitle");
  if (addTitleBtn) {
    addTitleBtn.addEventListener("click", async () => {
      const nm = (nameEl.value || "").trim();
      const cl = $("#resClient").value.trim();
      const pr = $("#resProject").value.trim();
      addTitleBtn.disabled = true; addTitleBtn.textContent = "…";
      try {
        if (cl && pr && nm) {
          // persist the first title before moving on, so nothing is lost
          await api("/api/resources", { method: "POST", body: JSON.stringify({
            client: cl, project: pr, name: nm,
            role: $("#resTitle").value,
            rate: num($("#resRate").value),
            offshore_rate: num($("#resOffRate").value),
            capacity: num($("#resHpw").value) || 40,
          }) });
        }
        // reopen a blank form, same name, for the 2nd project + title
        await loadState();
        resEditId = null;
        renderResModal();
        const nn = $("#resName");
        if (nn) nn.value = nm;
        toast(`First title saved. Now pick the other project and its title for ${nm}.`);
      } catch (err) {
        toast(`Could not add the 2nd title: ${err.message}`, true);
        addTitleBtn.disabled = false;
        addTitleBtn.textContent = "+ Add a 2nd title on another project";
      }
    });
  }
  // wire: picking an existing resource pre-fills the form
  $("#resPick").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) { resEditId = null; renderResModal(); return; }
    resEditId = +id;
    renderResModal();
  });
  // wire: picking a Title auto-fills both rates from Pricing
  $("#resTitle").addEventListener("change", (e) => {
    const t = e.target.value;
    const p = state.pricing.find((x) => x.title === t);
    if (p) {
      if (p.rate != null) $("#resRate").value = p.rate;
      if (p.offshore_rate != null) $("#resOffRate").value = p.offshore_rate;
    }
  });
}

async function saveResModal() {
  const client = $("#resClient").value.trim();
  const project = $("#resProject").value.trim();
  const name = $("#resName").value.trim();
  const role = $("#resTitle").value;
  const rate = num($("#resRate").value);
  const offRate = num($("#resOffRate").value);
  const start = $("#resStart").value;
  const end = $("#resEnd").value;
  const hpw = num($("#resHpw").value) || 0;
  if (!name) { toast("Resource name is required", true); return; }
  if (!client) { toast("Client is required", true); return; }
  if (!project) { toast("Project is required", true); return; }
  const btn = $("#resModalSave"); btn.disabled = true; btn.textContent = "…";
  const wasEdit = resEditId !== null;
  try {
    let rid = resEditId;
    const payload = { client, project, name, role, rate, offshore_rate: offRate, capacity: hpw || 40 };
    if (rid === null) {
      const created = await api("/api/resources", { method: "POST", body: JSON.stringify(payload) });
      rid = created.id;
    } else {
      await api(`/api/resources/${rid}`, { method: "PUT", body: JSON.stringify(payload) });
    }
    // fill weekly hours from the date range
    if (start && end && hpw > 0) {
      const weeks = dateRangeToWeeks(start, end);
      const hours = Array(state.weeks.length).fill(0);
      weeks.forEach((i) => { hours[i] = hpw; });
      await api(`/api/resources/${rid}/hours`, { method: "PUT", body: JSON.stringify({ hours }) });
    }
    closeResModal();
    toast(wasEdit ? "Resource updated" : "Resource added");
    await loadState();
  } catch (e) { toast(`Save failed: ${e.message}`, true); }
  btn.disabled = false; btn.textContent = "Save";
}

/* Save/Cancel are rendered INSIDE #resModalBody by renderResModal (they need
   to sit in the scrollable body, not below it), so they do not exist at load
   time — binding them here once silently attached to nothing and Save became a
   dead button. Wire them on every render instead, right after innerHTML. */

/* ---------------- Add / Edit Client Project modal ---------------- */
let projEditId = null; // null = add, else project id being edited
let projList = [];

async function loadProjects() {
  try { projList = await api("/api/projects"); }
  catch (e) { toast(`Projects failed: ${e.message}`, true); }
}

function openProjModal(pid) {
  projEditId = pid || null;
  renderProjModal();
  $("#projModal").classList.remove("hidden");
}
function closeProjModal() { $("#projModal").classList.add("hidden"); projEditId = null; }

function renderProjModal() {
  const isEdit = projEditId !== null;
  const p = isEdit ? projList.find((x) => x.id === projEditId) : null;
  $("#projModalTitle").textContent = isEdit ? "Edit Client Project" : "Add Client Project";
  const pickOpts = `<option value="">— New client/project —</option>` +
    projList.map((x) => `<option value="${x.id}"${p && p.id === x.id ? " selected" : ""}>${esc(x.client)} / ${esc(x.project)}</option>`).join("");
  $("#projModalBody").innerHTML = `
    <div class="res-form">
      <div class="res-row">
        <label>Client / Project <select id="projPick" class="cur-sel">${pickOpts}</select></label>
        <label class="res-hint">Pick an existing one to edit, or choose "New client/project".</label>
      </div>
      <div class="res-row">
        <label>Client <input class="inp res-inp" id="projClient" value="${esc(p ? p.client : "")}" placeholder="e.g. Apple"></label>
        <label>Project <input class="inp res-inp" id="projName" value="${esc(p ? p.project : "")}" placeholder="e.g. Support"></label>
      </div>
      <div class="res-row">
        <label>Start Date <input class="inp res-inp" id="projStart" type="date" value="${p ? p.start_date : ""}"></label>
        <label>End Date <input class="inp res-inp" id="projEnd" type="date" value="${p ? p.end_date : ""}"></label>
      </div>
    </div>`;
  $("#projPick").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) { projEditId = null; renderProjModal(); return; }
    projEditId = +id;
    renderProjModal();
  });
}

async function saveProjModal() {
  const client = $("#projClient").value.trim();
  const project = $("#projName").value.trim();
  const start = $("#projStart").value;
  const end = $("#projEnd").value;
  if (!client) { toast("Client is required", true); return; }
  if (!project) { toast("Project is required", true); return; }
  const btn = $("#projModalSave"); btn.disabled = true; btn.textContent = "…";
  const wasEdit = projEditId !== null;
  try {
    if (projEditId === null) {
      await api("/api/projects", { method: "POST", body: JSON.stringify({ client, project, start_date: start, end_date: end }) });
    } else {
      await api(`/api/projects/${projEditId}`, { method: "PUT", body: JSON.stringify({ client, project, start_date: start, end_date: end }) });
    }
    closeProjModal();
    toast(wasEdit ? "Client project updated" : "Client project added");
    await loadProjects();
  } catch (e) { toast(`Save failed: ${e.message}`, true); }
  btn.disabled = false; btn.textContent = "Save";
}

$("#projModalCancel").addEventListener("click", closeProjModal);
$("#projModalSave").addEventListener("click", saveProjModal);

/* ---------------- toolbar ---------------- */
$("#btnAdd").addEventListener("click", () => openResModal(null));
$("#btnAddProject").addEventListener("click", () => { loadProjects().then(() => openProjModal(null)); });
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

/* ---------------- column panel (⚙) ---------------- */
function closeColPanel() {
  $("#colPanel").classList.add("hidden");
  $("#colPanel").innerHTML = "";
}
function rebuildColPanel(view) {
  const p = viewPrefs(view);
  const rows = COLUMNS[view].map((c) => {
    const checked = !p.hidden.includes(c.key) ? " checked" : "";
    const fz = frozenCount(view);
    const fzIdx = Math.min(fz, COLUMNS[view].length) - 1;
    const pinned = COLUMNS[view].indexOf(c) <= fzIdx ? " pinned" : "";
    return `<label class="col-row" data-key="${c.key}">
        <input type="checkbox" class="col-hide" data-view="${view}" data-key="${c.key}"${checked}>
        <span class="col-name${pinned}">${esc(c.h)}</span>
        <button class="col-pin" data-view="${view}" data-key="${c.key}" title="Lock / freeze up to and including this column" aria-pressed="${pinned ? "true" : "false"}">${pinned ? "📌" : "📍"}</button>
      </label>`;
  }).join("");
  $("#colPanel").innerHTML = `<div class="col-panel-head">Columns — <b>${view === "planned" ? "Planned grid" : "Actuals grid"}</b>
      <button class="col-close" title="Close">✕</button></div>
    <div class="col-panel-sub">Visible columns scroll horizontally; locked columns stay pinned on the left. Locking up to a column locks everything before it. Saved automatically per view.</div>
    <div class="col-list">${rows}</div>
    <div class="col-panel-actions"><button class="btn mini" data-reset="${view}">Reset</button></div>`;
  $("#colPanel").classList.remove("hidden");
  $("#colPanel").dataset.open = view;
}
function toggleColPanel(view, anchor) {
  const isOpen = !$("#colPanel").classList.contains("hidden");
  const sameView = $("#colPanel").dataset.open === view;
  if (isOpen && sameView) { closeColPanel(); return; }   // same ⚙ clicked again → close
  rebuildColPanel(view);
  const el = $("#colPanel");
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    el.style.top = `${Math.max(70, r.bottom + 8)}px`;
    el.style.left = `${Math.min(window.innerWidth - 320, Math.max(8, r.left))}px`;
  }
}
$("#btnColumnsPlanned").addEventListener("click", (e) => toggleColPanel("planned", e.currentTarget));
$("#btnColumnsActuals").addEventListener("click", (e) => toggleColPanel("actuals", e.currentTarget));
// hide checkbox → toggle visibility
$("#colPanel").addEventListener("change", (e) => {
  e.stopPropagation(); // rebuild detaches target; keep the panel open
  const t = e.target;
  if (!t.classList.contains("col-hide")) return;
  const view = t.dataset.view, key = t.dataset.key;
  const p = viewPrefs(view);
  if (t.checked) p.hidden = p.hidden.filter((k) => k !== key);
  else p.hidden = [...p.hidden.filter((k) => k !== key), key];
  savePrefs(view, p);
  rebuildColPanel(view);    // rebuild so pinned state updates
  renderColsFor(view);
});
// pin button → freeze up to and including this column (contiguous)
$("#colPanel").addEventListener("click", (e) => {
  // rebuild replaces innerHTML and detaches e.target; stopPropagation so the
  // document-level close-listener (which checks contains()) can't see the old,
  // detached target as "outside" and close the panel after every action.
  e.stopPropagation();
  const t = e.target;
  if (t.classList.contains("col-close")) { closeColPanel(); return; }
  if (t.classList.contains("col-pin")) {
    const view = t.dataset.view, key = t.dataset.key;
    const p = viewPrefs(view);
    const vis = visibleCols(view);
    const visIdx = vis.findIndex((c) => c.key === key);
    if (visIdx === -1) return;
    const cur = frozenCount(view);
    // if this is the trailing frozen column, clicking again unpins it down one;
    // otherwise set the freeze point AT this column (freezes it and everything before)
    p.freeze = (cur === visIdx + 1) ? Math.max(0, cur - 1) : (visIdx + 1);
    savePrefs(view, p);
    rebuildColPanel(view);
    renderColsFor(view);
    return;
  }
  if (t.dataset.reset) {
    savePrefs(t.dataset.reset, defaultPrefs(t.dataset.reset));
    rebuildColPanel(t.dataset.reset);
    renderColsFor(t.dataset.reset);
  }
});
function renderColsFor(view) {
  if (view === "planned") renderGrid();
  else if (view === "actuals") renderActuals();
}
document.addEventListener("click", (e) => {
  if ($("#colPanel").classList.contains("hidden")) return;
  if ($("#colPanel").contains(e.target)) return;
  if (e.target.closest("#btnColumnsPlanned, #btnColumnsActuals")) return;
  closeColPanel();
});

/* ---------------- import / export ---------------- */
/* Feature #12: the Data Panel's Export button offers BOTH downloads. The full
   workbook keeps the original /api/export path untouched; the filtered export
   passes the live Dashboard filters through ?scope=filtered. */
function syncExportLinks() {
  const full = $("#btnExport");
  if (full) full.setAttribute("href", "/api/export");
  const filt = $("#expFiltered");
  if (filt) filt.setAttribute("href", `/api/export?scope=filtered&${dashQs()}`);
  const note = $("#dataNote");
  if (note) {
    const active = dashF.client.length + dashF.project.length + dashF.pm.length
      + (dashCurrency !== "all" ? 1 : 0) + (state.globalMonth !== "all" ? 1 : 0);
    note.textContent = active
      ? `Export: whole workbook, or just the ${active} active filter${active === 1 ? "" : "s"}.`
      : "Export: the whole workbook, or only what the filters show.";
  }
}

/* Export split menu — portalled out of the rail (see .exp-menu CSS note).
   The rail is `overflow: hidden` and only ~64px wide when collapsed, so an
   absolutely-positioned menu inside it was clipped away. We move it to <body>
   and place it with fixed coordinates relative to the Export button. */
function placeExportMenu() {
  const menu = $("#exportMenu"), btn = $("#btnExportSplit");
  if (!menu || !btn || menu.classList.contains("hidden")) return;
  const r = btn.getBoundingClientRect();
  menu.classList.add("body");
  // Neutralise the CSS anchor before measuring.
  menu.style.left = "0px"; menu.style.top = "0px";
  const w = menu.offsetWidth || 250;
  const h = menu.offsetHeight || 140;
  // Prefer opening to the RIGHT of the collapsed rail; clamp to the viewport,
  // then fall back to the button's left edge if that would overflow.
  let left = r.right + 8;
  if (left + w > window.innerWidth - 8) left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  // Flip above the button when there isn't room below.
  const below = window.innerHeight - r.bottom - 10;
  const up = below < Math.min(h, 160) && r.top > below;
  let top = up ? (r.top - h - 6) : (r.bottom + 6);
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

$("#btnExportSplit")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#exportMenu");
  if (!menu) return;
  const opening = menu.classList.contains("hidden");
  if (opening) {
    document.body.appendChild(menu);   // portal out of the clipping rail
    menu.classList.remove("hidden");
    placeExportMenu();
    $("#btnExportSplit").classList.add("open");
  } else {
    menu.classList.add("hidden");
    $("#btnExportSplit").classList.remove("open");
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#exportMenu, #btnExportSplit")) {
    const menu = $("#exportMenu");
    if (menu) menu.classList.add("hidden");
    const b = $("#btnExportSplit");
    if (b) b.classList.remove("open");
  }
});
// A fixed-position menu would drift away from its button on scroll/resize.
window.addEventListener("scroll", () => {
  const menu = $("#exportMenu");
  if (menu && !menu.classList.contains("hidden")) menu.classList.add("hidden");
}, true);
window.addEventListener("resize", () => {
  const menu = $("#exportMenu");
  if (menu && !menu.classList.contains("hidden")) placeExportMenu();
});

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
  // Feature #12: renderView owns tab highlighting, view visibility, the top
  // strip's page title and the "+ Add/Edit Resource" gating. This function used
  // to duplicate all of that AND return early for Actuals/Utilization, which
  // meant renderView never ran on those two tabs and the top-strip title kept
  // showing the PREVIOUS section. Route everything through renderView instead.
  if (view === "actuals") { renderView(); loadActuals(); return; }
  if (view === "util") { renderView(); renderUtilization(); return; }
  if (view === "logs") { renderView(); initLogsView(); loadActivity(); return; }
  await loadState();   // loadState ends by calling renderView()
}

function renderView() {
  $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === state.view));
  const isGrid = state.view === "planned";
  $("#gridView").classList.toggle("hidden", !isGrid);
  $("#dashView").classList.toggle("hidden", state.view !== "dash");
  $("#ratesView").classList.toggle("hidden", state.view !== "rates");
  $("#accessView").classList.toggle("hidden", state.view !== "access");
  $("#utilView").classList.toggle("hidden", state.view !== "util");
  $("#actualsView").classList.toggle("hidden", state.view !== "actuals");
  $("#workbenchView").classList.toggle("hidden", state.view !== "workbench");
  $("#weekView").classList.toggle("hidden", state.view !== "week");
  $("#logsView").classList.toggle("hidden", state.view !== "logs");
  // Feature #12: the top strip reports which section you're in, since the nav
  // now lives in the rail and the title is no longer attached to the tabs.
  const title = $("#pageTitle"), sub = $("#pageSub");
  const META = {
    dash: ["Dashboard", "Planned vs actual, by client and project"],
    planned: ["Planned", "Master entry — hours, rates and the weekly grid"],
    actuals: ["Actuals", "PM reconciliation — recorded hours vs plan"],
    rates: ["Rate Card", "Client rate vs offshore rate, per title"],
    util: ["Utilization", "Booked hours ÷ capacity (40 hrs/week = 100%)"],
    access: ["Team & Access", "People, PMs, admins, permissions & database security"],
    workbench: ["My Projects", "Your projects, your team, and their week-by-week load"],
    week: ["Weekly entry", "Enter one week of actual hours for everyone on your projects"],
    logs: ["Activity log", "Every change that touched people, money or access — newest first"],
  };
  if (title && META[state.view]) {
    title.textContent = META[state.view][0];
    if (sub) sub.textContent = META[state.view][1];
  }
  // Feature #14b: the toolbar/top-strip height differs per tab, so re-measure the
  // grid height after the view is shown — otherwise a grid whose toolbar is taller
  // than the last one's gets its bottom scrollbar pushed off-screen.
  requestAnimationFrame(syncAllGridHeights);
  // "+ Add/Edit Resource" only applies to the Planned grid — but the button now
  // lives in the rail, so hide the whole cluster rather than a single button.
  $("#btnAdd").style.display = isGrid ? "initial" : "none";
  if (isGrid) renderGrid();
  else if (state.view === "dash") renderDashboard();
  else if (state.view === "util") renderUtilization();
  else if (state.view === "actuals") renderActuals();
  else if (state.view === "rates") renderPricing();
  else if (state.view === "access") renderAccess();
  else if (state.view === "workbench") loadWorkbench();
  else if (state.view === "week") loadWeekSheet();
}

$$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.tab)));
bindPasswordModal();
/* Guarded calls: these live in workbench.js. An unguarded call threw
   "bindWorkbench is not defined" when that file loaded late, and because this
   runs at top level it aborted the rest of the file — boot() included — leaving
   the app completely dead. A missing/unloaded feature file must degrade, never
   brick the app. */
if (typeof bindWorkbench === "function") bindWorkbench();
else console.warn("workbench.js not loaded — My Projects will be unavailable");
if (typeof bindWeekSheet === "function") bindWeekSheet();
else console.warn("weeksheet.js not loaded — Weekly entry will be unavailable");
if (typeof bindPeopleAndOt === "function") bindPeopleAndOt();
else console.warn("workbench.js not loaded — People/OT controls unavailable");
/* Feature #10.2: dashboard resource popup close (button + backdrop + Escape).
   Targets #dashResModal — it must NOT touch #resModal (Add/Edit Resource). */
$("#dashResModalClose").addEventListener("click", () => $("#dashResModal").classList.add("hidden"));
$("#dashResModal").addEventListener("click", (e) => {
  if (e.target.id === "dashResModal") $("#dashResModal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#dashResModal").classList.add("hidden");
});
/* Feature #11.1: pricing "Used by" popup close (button + backdrop + Escape). */
$("#priceResModalClose").addEventListener("click", () => $("#priceResModal").classList.add("hidden"));
$("#priceResModal").addEventListener("click", (e) => {
  if (e.target.id === "priceResModal") $("#priceResModal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#priceResModal").classList.add("hidden");
});

/* ---------------- boot ---------------- */
window.addEventListener("error", (e) => {
  console.error("Revenue tracker error:", e.message, e.filename, e.lineno);
  toast(`App error: ${e.message} (${e.filename ? e.filename.split("/").pop() : ""}:${e.lineno || "?"})`, true);
});
boot();
setInterval(() => flush(), 3000);
setInterval(() => pFlush(), 3000);
setInterval(() => aFlush(), 3000);
