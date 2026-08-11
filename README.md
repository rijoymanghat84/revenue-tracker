# Revenue 2026 Tracker

Web replacement for `Revenue_2026.xlsm` — resources × 53 weeks, with billing
(On-Site) and expense (Off-Shore) rates, plus an auto-computed client dashboard.

**URL:** https://revenue.rijoybmanghat.com (basic auth — user `rijoy`, same
password as your other WebUIs; stored in `/opt/data/revenue-tracker/.password`)
**Local:** http://127.0.0.1:8802 (healthz open, everything else behind auth)
**Stack:** FastAPI + SQLite + vanilla JS (dark frost-glass theme, no build step)

## What it does
Four tabs (in order): **Dashboard · Pricing · Onsite · Offshore**
- **Onsite** — Country, Client, Project, Resource Name, Title (dropdown),
  **Rate**, Total Hours, Total Revenue, then Month+Week columns. Master sheet:
  hours and resources entered here (UI or Excel upload).
- **Offshore** — same columns with your **Offshore Rate** (cost side). Created
  automatically from Onsite — hours mirror (read-only) and both rates come from
  the Pricing tab; pick a Title anywhere and BOTH rates auto-fill and persist.
- **Pricing** — the title library: **Title / Rate / Offshore Rate**. Pre-set to
  Rijoy's canonical list: Project manager, Solution Architect, Principal
  Architect, Quadient Developer, Sr. Quadient Developer, Java Developer, Sr.
  Java Developer, Open text developer, Sr. Open text developer, PhP Developer,
  Sr. PHP Developer, BCC, QA, QA Lead. **+ Add Title** adds any new role — it
  then appears in the Onsite/Offshore dropdowns instantly and auto-fills BOTH
  rates from Pricing when selected. "Apply" pushes a title's rates onto every
  resource using it; renaming cascades. Blank-rate titles display as-is (0
  until priced). Script to (re)set the canonical list:
  `scripts/set_canonical_pricing.py`.
- **Dashboard** — Country, Client, Resource(s), Revenue (Onsite), Expense
  (Offshore), Difference, Currency; per-currency totals + KPI cards.
- Totals auto-computed live; grouped by client with subtotal rows; collapsible
  groups; sticky headers; paste-friendly into Onsite (meta + weeks map
  automatically). Auto-save (debounced ~1.2s + 3s flush).
- **Import Excel** — header-name-aware: upload the exported file OR your own
  workbook with the same headings (Country · Client · Project · Resource Name ·
  Title · Rate · Total Hours · Total Revenue · Month/Week columns). Two modes:
  **Merge** (default) updates matching Client+Name rows and adds new ones —
  never deletes anything. **Replace** wipes all resources/hours first (after a
  confirm + automatic DB backup to `data/backups/`, pricing kept) so the file
  becomes the whole database. Reads the original Revenue_2026 layout too;
  full-year files (≥50 weeks) rewire the week layout, short files don't.
- **Export Excel** — Dashboard + On-Site + Off-Shore (formulas, Off-Shore
  protected `offshore2024`) + Pricing, with the same headings so it
  round-trips.

## Replicating this app elsewhere (another machine/agent)

This repo is the **code only** — no data, no credentials. To run it anywhere:

```bash
# 1. Get the code
git clone <this-repo> revenue-tracker && cd revenue-tracker

# 2. Dependencies (Python 3.10+)
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn openpyxl

# 3. Auth gate
#    Create a file named  .password  (next to app/) with your chosen password.
#    The app answers to user "rijoy" (override with REVENUE_AUTH_USER env).

# 4. Seed from a Revenue_2026-style workbook (or start empty — UI creates all data)
#    /usr/bin/python3 scripts/seed.py /path/to/any_workbook.xlsm

# 5. Run
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802
#    → open http://127.0.0.1:8802, login, and all four sections (Dashboard,
#      Pricing, Onsite, Offshore) work against a fresh SQLite DB in ./data/
```

- The canonical role list + rates live in the DB; to reset them run
  `python3 scripts/set_canonical_pricing.py` (edit the list in that file first).
- Import/Export Excel round-trips through the same headings documented above;
  Off-Shore sheet exports protected with password `offshore2024` (only in the
  generated Excel file, for parity with the original workbook).
- Basic auth reads `./.password` at runtime; `/healthz` stays open for
  watchdogs. Expose publicly only behind a tunnel/reverse proxy + TLS.

## Local deployment notes (VPS)

**URL:** https://revenue.rijoybmanghat.com (basic auth — user `rijoy`)

## Operations
- **Start/restart:** `bash /opt/data/scripts/revenue-tracker-watchdog.sh`
  (health → silent; unhealthy → kill + relaunch + log to
  `/opt/data/logs/revenue-tracker-watchdog.log`)
- **Reseed from scratch:** `/usr/bin/python3 /opt/data/revenue-tracker/scripts/seed.py`
- **Data:** SQLite at `data/revenue.db`. Backed up with the regular Sunday
  full-backup (it's under /opt/data).
- **Run manually:** `cd /opt/data/revenue-tracker && /usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802`

## API
| Endpoint | Meaning |
|---|---|
| `GET /api/state` | weeks, months, resources (+ computed totals) |
| `POST /api/resources` | add resource |
| `PUT /api/resources/{id}` | update fields (country/client/name/role/rate/offshore_rate) |
| `PUT /api/resources/{id}/hours` | `{hours:[53]}` bulk or `{week,v,alue}` single cell |
| `DELETE /api/resources/{id}` | remove |
| `GET /api/dashboard` | grouped country/client report + currency totals |
| `POST /api/import` | multipart file upload (xlsm/xlsx) |
| `GET /api/export` | downloads Revenue_2026_export.xlsx |
| `GET /healthz` | liveness for the watchdog |

## Notes & known quirks
- **IMS total bug fixed:** the Excel macro's Dashboard double-counted IMS in the
  TOTAL rows (a subtotal row with an empty Country leaked into the group list).
  Expected totals here: Revenue $2,605,218.48, Expense $2,288,199.85, Profit
  $317,018.63 (Excel showed the inflated $3,351,382.64 / $3,034,364.01).
- **Vision Direct** resources have no rates in the source file → $0 revenue/expense.
- Column headers keep the original spellings only in exported files
  ("Resoruce Name", "Utlilization"); the UI uses clean labels.
- Single-user basic auth (user `rijoy`, password in `.password`, same as the
  other WebUIs). Exposed via Cloudflare Tunnel at `revenue.rijoybmanghat.com`
  (VPS tunnel `4c1ab785…`, ingress in `/opt/data/dashboard/config/config.yml`,
  DNS CNAME proxied). `/healthz` stays unauthenticated for the watchdog.
- The Cloudflare API token cannot create Access policies — auth is app-level
  basic auth by design (consistent password, zero dashboard clicking).
- 2026 is fixed for now; new year files upload cleanly and rewire the layout.

## Ideas for v2 (per "start with basic, build over it")
- Multi-user + logins, editor vs read-only roles
- Logged change history / audit trail per cell
- Month & quarter rollups, charts on the Dashboard
- Attach to Cloudflare Tunnel for phone access