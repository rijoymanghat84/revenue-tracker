# README1 — Complete App Specification (Revenue Tracker)

> **READ THIS FIRST.** This document is the FULL specification of the app's look,
> behavior, and data rules. The GitHub repo contains the working implementation —
> **run it, don't rebuild** (see AGENTS.md and `scripts/setup.sh`). If for any
> reason you must recreate it, this file is the contract: follow it precisely so
> the result looks and works EXACTLY the same.

---

## 1. What the app is

A web replacement for the Excel workbook `Revenue_2026.xlsm`. It tracks
consulting resources across projects for a full year (53 weeks), with two
pricing lenses:

- **Onsite** = what the client is CHARGED (billing rate) → Revenue
- **Offshore** = what it COSTS to deliver (offshore rate) → Expense
- **Difference** = profit per client/project
- **Pricing** = a title library (role → rate + offshore rate + currency) that
  auto-fills both grids
- **Utilization** = booked hours vs capacity (40 hrs/week = 100%)

Data lives in **SQLite** (never in git). Code lives in the repo (never data).

---

## 2. Tech stack & running it

- Backend: **Python 3.10+ / FastAPI + uvicorn**, port **8802**, bound to 127.0.0.1
- Database: **SQLite** at `data/revenue.db` (auto-created)
- Frontend: **vanilla HTML/CSS/JS** — no frameworks, no build step
- Excel: **openpyxl**
- Run: `bash scripts/setup.sh` then
  `source .venv/bin/activate && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802`
- Health: `GET /healthz` → `{"ok": true}` (no auth)
- Verify every screen renders the five tabs before reporting done.

---

## 3. Authentication

- **Basic auth** on every route except `/healthz`.
- Username: `rijoy`. Password: read from a file named `.password` (one line) at
  the app root; create it during setup. NEVER commit `.password` or any data.
- On wrong/missing credentials return `401` with `WWW-Authenticate: Basic realm="Revenue Tracker"`.

---

## 4. Visual design (EXACT)

Dark "frost-glass" theme. Use these values everywhere:

| Element | Value |
|---|---|
| Page background | `#0b1020` + radial glows (cyan 0.16 top-left, violet 0.13 top-right, green 0.08 bottom) |
| Panels ("glass") | `rgba(255,255,255,0.05)`, border `rgba(255,255,255,0.10)`, `backdrop-filter: blur(14px)`, radius 14px |
| Text | `#e6ecf5`; muted `#93a1b8` |
| Accent (primary button/gradient) | cyan `#22d3ee` → violet `#a78bfa` |
| Green / Red / Amber | `#34d399` / `#f87171` / `#fbbf24` |
| Grid table surface | `#0b101f` (fully OPAQUE — nothing see-through) |
| Header cells | `#0d1326` |
| Frozen/sticky cells | `#0e1428` (solid, hover `#1a2238`) |
| Group/project band rows | `#151e36` (solid) |
| Column borders | `1px solid rgba(255,255,255,0.26)` (VISIBLE between every column) |
| Font | system-ui stack; 12.5px grid text; tabular numbers for figures |
| Scrollbars | visible dark bars (`rgba(148,163,184,0.4)`, rounded, hover 0.65) |

Layout: top bar (title "Revenue Tracker 2026", subtitle "Onsite · Offshore ·
Dashboard · Pricing"), tab buttons, Import mode select, Import/Export buttons,
"+ Add Resource". Alignment: **text left, numbers right, week hours centered**.
Number inputs have **no spinner arrows**.

PWA: manifest + icons + service worker; installable standalone; safe-area
padding; 40px touch targets on mobile.

---

## 5. Tabs (order + defaults)

`Dashboard · Pricing · Utilization · Onsite · Offshore`

- **Default landing tab = Dashboard.**
- **NO tab opens in edit mode.** Onsite and Offshore both start LOCKED
  (read-only). Each grid has an **Edit / Done · Lock** toggle in the toolbar.

---

## 6. Onsite grid (master)

Column order, left → right:
`Country | Client | Project | Resource Name | Title | Rate | Total Hours | Total Revenue | [53 weekly columns] | [✕]`

- Weekly columns: **Jan-02 … Dec-28 2026** (53), grouped under a month band
  (JAN FEB MARCH … DEC — Jan has 5 weeks, Feb 4, etc.).
- **All 8 leading columns are frozen** (sticky-left, solid) when scrolling
  right; weeks scroll beneath. The header is a **3-row block** — column
  headings, month band, week labels — all pinned together over the frozen area.
- Fixed column widths: Country 70 · Client 150 · Project 140 · Resource Name
  160 · Title 160 · Rate 90 · Total Hours 90 · Total Revenue 110 · weeks 54.
- **Title = dropdown** sourced from the Pricing tab; picking a title
  auto-fills the Rate (and saves the offshore rate too) from Pricing. The
  dropdown contains ONLY Pricing titles — resources with any other role have
  their Title blanked, and imports blank unknown roles too.
- Rows grouped by **Client · Project** (group header shows
  `▼ Client · Project  [N resource(s)]  hours  revenue`). Collapse-all shows
  only group rows with name + count + hours + revenue; Expand restores.
- Edit toggle unlocks inline editing; everything auto-saves (debounced).

## 7. Offshore grid (cost lens)

Same columns, but the rate column is **Offshore Rate** (the cost). Hours mirror
Onsite automatically (same data). Starts **locked**; Edit unlocks everything
(hours/names/roles/rates — one shared database).

## 8. Dashboard

Columns: `Country | Client | Project | Resource(s) | Revenue (Onsite) | Expense (Offshore) | Difference | Cur`
- Rows grouped per **Client · Project**; totals row(s) per currency
  (EUR if EU country else USD); 4 KPI cards: Total Revenue, Total Expense,
  Profit, By currency.
- Difference cells show a small horizontal bar scaled to the max |diff|.

## 9. Pricing tab (title library)

- **14 canonical titles, in this order**, with rates:
  1. Project manager — 42.7 / 34.5
  2. Solution Architect — 75 / 75
  3. Principal Architect — (blank)
  4. Quadient Developer — 42.72 / 42.72
  5. Sr. Quadient Developer — (blank)
  6. Java Developer — 75 / 12
  7. Sr. Java Developer — (blank)
  8. Open text developer — 42.7 / 17.35
  9. Sr. Open text developer — (blank)
  10. PhP Developer — 52 / 52
  11. Sr. PHP Developer — (blank)
  12. BCC — 70 / 70
  13. QA — 35.5 / 35.5
  14. QA Lead — (blank)
- Columns: `Title | Rate | Offshore Rate | Currency | Used By | actions`
- Rows are **locked** until **Edit**; Edit enables Title + Rate + Offshore +
  **Currency ($ / £ / CA$)** together; Save / Cancel. "+ Add Title" opens a new
  row in edit mode.
- **Apply** pushes one title's rates to all resources using it (skips blank
  rates). **Update All Pricing** pushes EVERY title's rates to all resources.
- A resource's rate auto-fills from Pricing when its Title is chosen.

## 10. Utilization tab (auto-calculated, never editable)

- One row per resource: `Resource | Projects | JAN … DEC | Overall`
- Projects column lists every client/project the person works (aggregated).
- **Math:** capacity = **40 hrs/week**. Monthly capacity = weeks in that month ×
  40. Overall = total hours ÷ (53 weeks × 40). Monthly % = month hours ÷ month
  capacity.
- **Colors:** 🔴 >100% · 🟢 80–100% · 🟡 50–80% · 🟠 <50% — **solid opaque
  fills** (no transparency): red `#3a1b22`, green `#10301f`, yellow `#332a12`,
  orange `#33200f`.
- **Resource column AND its header are sticky-left**, fully opaque.
- Tooltip on each cell: `123h / 200h`.

---

## 11. Data model

- `resources`: id, country, client, project, name, role (title), rate,
  offshore_rate, sort_order
- `weekly_hours`: resource_id, week (0–52), hours
- `pricing`: id, title (unique), rate, offshore_rate, currency (USD/GBP/CAD),
  sort_order
- `meta`: key/value (week layout: weeks + month bands)

---

## 12. Excel import / export

**Export** produces 5 sheets: `Dashboard` (report, regenerated), `On-Site`
(editable), `Off-Shore` (editable — NOT protected), `Pricing` (Title | Rate |
Offshore Rate | Currency), `Utilization` (locked/protected, computed values).

**Import** (header-name aware — reads by column heading, works with the export
or your own file):
- **Merge** (default): updates rows matching Client+Name in place, adds new,
  renames unique-name rows when Client/Project changed, NEVER deletes.
- **Replace**: wipes all resources/hours first (confirm dialog + automatic DB
  backup to `data/backups/`), keeps Pricing, loads the file as the whole DB.
- Pricing sheet updates existing titles (rate/offshore/currency).
- **Utilization sheet is ignored** — always recalculated.
- Rows with empty Resource Name are skipped. Full-year files (≥50 weeks) set
  the week layout; short files don't.

**Header names the import/export use (On-Site):**
`Country | Client | Project | Resource Name | Title | Rate | Total Hours | Total Revenue | Jan-02 …`
**Off-Shore:** same but `Offshore Rate` in the rate position.

---

## 13. GitHub / data safety

- Repo = code only. `.password`, `data/`, env files are gitignored. NEVER
  commit data or credentials.
- The app is public at `revenue.rijoybmanghat.com` (Cloudflare Tunnel) behind
  basic auth. Clone repo → `bash scripts/setup.sh` → run → log in (user
  `rijoy`, your `.password`).
- To populate data on a new instance: **Export Excel** from the live app, then
  **Import Excel → Merge** on the new machine (all sections auto-fill: 64
  resources, projects, pricing, totals).

---

## 14. Verification checklist (report each)

- [ ] `GET /healthz` → `{"ok":true}`
- [ ] Dark theme, five tabs, Dashboard first, nothing in edit mode
- [ ] Onsite: 8-column header + month/week grid, frozen columns, solid, borders
- [ ] Offsite: mirrors Onsite, locked by default
- [ ] Pricing: 14 titles, Edit/Save, currency, Update All works
- [ ] Utilization: 52+ rows, colors, sticky name + header, locked
- [ ] Import Merge and Replace work; Utilization ignored; Pricing updates
- [ ] Export has 5 sheets; Off-Shore editable; Utilization locked

---

## 15. DO NOT

- ✗ Rebuild/redesign anything if the repo already runs — just run it
- ✗ Add frameworks/build steps
- ✗ Upload data, `.password`, `data/` to git
- ✗ Remove auth or expose `/api/*` publicly
- ✗ Change tab order, canonical titles, colors, or the 40h/wk capacity rule
