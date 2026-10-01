# AGENTS.md — read this FIRST

**This repository IS the complete, finished application.** It is NOT a
specification or a starting point. Do NOT rebuild, re-scaffold, redesign, or
"improve" it. Do NOT write a new version from the README description.

**Also read `README1.md`** — it is the full look-and-behavior spec (colors,
tabs, columns, math, import/export rules). Use it to VERIFY your result matches
exactly; do not use it as a reason to rebuild.

Your ONLY job: run the existing code exactly as described below and verify it
works. If you instead generate your own implementation, you will produce
something that looks completely different and wastes the owner's time.

## What this app is

Revenue Recon — replaces `Revenue_2026.xlsm`:

- Tabs: **Dashboard · Planned · Actuals · Rate Card · Utilization ·
  Team & Access** (PMs also get a **Workbench** tab)
  - *2026-10-01:* the old **Pricing** tab was split by purpose. Rate library →
    **Rate Card**; people/permissions/DB security → **Team & Access**;
    per-resource capacity → **Utilization** (behind `⚙ Capacity`).
    `#pricingView` and `data-tab="pricing"` no longer exist — `pricing` survives
    only as a permission key.
- Planned = billing + cost side (Country, Client, Project, Resource Name,
  Title, Rate, Offshore Rate, Total Hours, Total Revenue, Total Expense,
  53 week columns) — master sheet
- Actuals = PM reconciliation (planned vs actual vs Δ, OT flow, wizard entry)
- Rate Card = title library (rate, offshore rate, currency, margin)
- Team & Access = PMs + admins + permissions + DB security + People + OT
  approvals + Recent activity log
- Utilization = planned + actual capacity report (40 hrs/week = 100%)
- Dashboard = per-client/project planned vs actual revenue/expense/savings
- Global month filter across all tabs
- Roles: admin (permission-gated per tab) vs PM (Workbench + Actuals,
  scoped to their projects, never sees rates)
- FastAPI + SQLite + vanilla JS, dark frost-glass theme, PWA installable

## Before you change anything: the trail

**Read `CHANGELOG.md` first.** It maps every change to its GitHub issue and
records decisions that were reversed.

**Issue numbering — two systems, and they collide.** GitHub issues are cited as
**`GH-12`**. Code comments contain internal plan labels written as
`Feature #12`; these are **NOT** GitHub issues. `feature #11` in a comment does
not mean GH-11. Code comments should be migrated to `GH-` style as they are
touched. The full mapping table is at the top of `CHANGELOG.md`.

Before closing or implementing any issue, **read the code** — do not trust a
commit title. GH-7 was nearly closed as "done" because a PM *filter* had been
added; the issue asks for a PM *column*.

## Run it (the ONLY correct path)

```bash
git clone <this repo> revenue-tracker && cd revenue-tracker

# Python 3.10+ required
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn openpyxl

# Auth gate: create a file named  .password  containing one line with your
# chosen password. Or run:
#   bash scripts/setup.sh   (does all of the above for you)

# Seed data (optional but recommended): point at an exported Revenue workbook
#   /usr/bin/python3 scripts/seed.py /path/to/Revenue_2026_export.xlsx
#   OR start empty and use the Import Excel button (Merge mode) later.

# Start
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802
# → open http://127.0.0.1:8802  (enter your .password)
```

## Verification checklist (report back on these)

- [ ] `curl -s http://127.0.0.1:8802/healthz` returns `{"ok": true}`
- [ ] The page loads with the dark theme and all six tabs (PMs see Workbench)
- [ ] Planned shows the header + month/week grid (columns exist even with no
      data; rows appear after upload/seed)
- [ ] Import Excel (Merge) works with an exported workbook
- [ ] `python3 tests/test_admin_mgmt.py` and
      `python3 tests/test_issue4_pm_admin_separation.py` both print ALL PASSED

Note: `data/` is gitignored, so a fresh clone has none — `init_db()` creates it
(added 2026-10-01; previously a fresh clone died with
"unable to open database file").

## DO NOT

- ✗ Rebuild any part of the UI from scratch
- ✗ Add a build step / framework (there is none — vanilla HTML/CSS/JS)
- ✗ Upload or commit any data, `.password`, `data/` (gitignored)
- ✗ Remove the auth gate or make `/api/*` public
