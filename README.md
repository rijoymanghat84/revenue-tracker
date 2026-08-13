# Revenue Recon

Web replacement for `Revenue_2026.xlsm` — resources × 53 weeks, with billing
(On-Site) and expense (Off-Shore) rates, plus a **planned-vs-actual
reconciliation** layer (Actuals) and role-based access for PMs.

**URL:** https://revenue.rijoybmanghat.com (login — admin `rijoy`, password in
`/opt/data/revenue-tracker/.password`; PMs created in-app)
**Local:** http://127.0.0.1:8802 (healthz open, everything else behind login)
**Stack:** FastAPI + SQLite + vanilla JS (dark frost-glass theme, no build step)

## PWA / Mobile
Installable progressive web app: manifest + icons (`static/icons/`), service
worker `static/sw.js` (caches the app shell only — API calls are never cached).
Open on a phone → "Add to Home Screen" → installs standalone with notch-safe
padding and bigger touch targets.

## Tabs (in order)
**Dashboard · Planned · Actuals · Pricing · Utilization**

- **Dashboard** — Country · Client · Project · Resource(s) · **Planned
  Revenue · Planned Expense · Planned Savings · Actual Revenue · Actual
  Expense · Actual Savings**. Actual figures come from recorded actuals only
  (zero actuals → $0). Savings = revenue − expense.
- **Planned** — master entry. Country · Client · Project · Resource Name ·
  Title (dropdown from Pricing) · **Rate · Offshore Rate** · Total Hours ·
  Total Revenue · Total Expense · Month+Week columns. **+ Add/Edit Resource**
  opens a form (client, project, resource name, title → auto-fills rates from
  Pricing, utilization hrs/week, start/end dates → auto-fills weekly hours).
  **+ Add/Edit Client Project** manages client/project entities with their own
  start/end dates.
- **Actuals** — PM reconciliation. Full-year read-only grid (planned vs actual
  vs Δ) + **+ Add/Edit Actuals** wizard (Client → Project → Month → resource
  weeks). OT flow: any overage → is-OT → approved → billed → reason if not
  billed; under → mandatory comment; no unassigned entries. Every write
  attributed to the PM.
- **Pricing** — title library (Title / Rate / Offshore Rate / Currency) +
  **Project → PM assignment** (one PM per client/project) + per-resource
  **capacity** override.
- **Utilization** — planned AND actual utilization (P/A columns per month),
  capacity-aware, month drill-down. PMs see only their clients.

## Global month filter
A **Month** selector in the top bar filters every tab (Dashboard, Planned,
Actuals, Utilization) to a single month for all users. "All months" = full year.

## Roles
- **Admin** (`rijoy`): all tabs + user/PM management.
- **PM**: Actuals + Utilization only, scoped to their assigned
  (client, project) pairs, no rates. PM export/import = Actuals-only workbook
  scoped to their projects.

## Import / Export
- **Import Excel** — header-name-aware (Country · Client · Project · Resource
  Name · Title · Rate · Total Hours · Total Revenue · weeks). **Merge** updates
  matching Client+Name rows, adds new ones, never deletes. **Replace** wipes
  resources/hours first (after confirm + DB backup, pricing kept). Reads the
  original Revenue_2026 layout; full-year files rewire the week layout.
- **Export Excel** — Dashboard + On-Site + Off-Shore + Pricing + Utilization +
  Actuals sheets, same headings so it round-trips. Admin gets all sheets; PM
  gets an Actuals-only workbook scoped to their projects.

## Replicating this app elsewhere
This repo is **code only** — no data, no credentials.

```bash
git clone <this-repo> revenue-tracker && cd revenue-tracker
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn openpyxl
# create .password (admin password); admin user is "rijoy"
/usr/bin/python3 scripts/seed.py /path/to/any_workbook.xlsm   # optional seed
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802
```

## Operations
- **Start/restart:** `bash /opt/data/scripts/revenue-tracker-watchdog.sh`
  (health → silent; unhealthy → kill + relaunch + log to
  `/opt/data/logs/revenue-tracker-watchdog.log`)
- **Data:** SQLite at `data/revenue.db`. Backed up with the regular Sunday
  full-backup (it's under /opt/data).
- **Run manually:** `cd /opt/data/revenue-tracker && /usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802`

## API
| Endpoint | Meaning |
|---|---|
| `GET /api/state` | weeks, months, resources (+ computed totals) |
| `POST /api/resources` | add resource |
| `PUT /api/resources/{id}` | update fields (incl. capacity) |
| `PUT /api/resources/{id}/hours` | `{hours:[53]}` bulk or `{week,value}` single cell |
| `PUT /api/resources/{id}/actuals` | save actual hours + OT/comment notes |
| `GET /api/actuals` | PM-scoped actuals grid |
| `GET /api/dashboard?month=` | grouped report + actuals reconciliation |
| `GET /api/utilization?month=` | planned + actual utilization |
| `GET/POST/PUT/DELETE /api/projects` | client/project entities with dates |
| `GET/POST/PUT/DELETE /api/users` | PM accounts + project assignment |
| `GET /api/project-owners` | which PM owns each client/project |
| `POST /api/import` | multipart file upload (xlsm/xlsx) |
| `GET /api/export` | downloads Revenue_Recon_export.xlsx |
| `GET /healthz` | liveness for the watchdog |

## Notes & known quirks
- **IMS total bug fixed:** the Excel macro's Dashboard double-counted IMS in
  the TOTAL rows; the app dedupes.
- 2026 is fixed for now; new year files upload cleanly and rewire the layout.
- Exposed via Cloudflare Tunnel at `revenue.rijoybmanghat.com` (VPS tunnel
  `4c1ab785…`, ingress in `/opt/data/dashboard/config/config.yml`).
