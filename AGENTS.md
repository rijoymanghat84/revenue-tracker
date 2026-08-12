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

Revenue Tracker — replaces `Revenue_2026.xlsm`:

- Tabs: **Dashboard · Pricing · Utilization · Onsite · Offshore**
- Onsite = billing side (Country, Client, Project, Resource Name, Title, Rate,
  Total Hours, Total Revenue, 53 week columns) — master sheet
- Offshore = cost side (same layout, Offshore Rate)
- Pricing = title library (14 canonical roles, rate + offshore rate + currency)
- Utilization = auto-calculated capacity report (40 hrs/week = 100%)
- Dashboard = per-client/project revenue vs expense summary
- FastAPI + SQLite + vanilla JS, dark frost-glass theme, PWA installable

## Run it (the ONLY correct path)

```bash
git clone <this repo> revenue-tracker && cd revenue-tracker

# Python 3.10+ required
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn openpyxl

# Auth gate: create a file named  .password  containing one line with your
# chosen password (the app logs in as user "rijoy"). Or run:
#   bash scripts/setup.sh   (does all of the above for you)

# Seed data (optional but recommended): point at an exported Revenue workbook
#   /usr/bin/python3 scripts/seed.py /path/to/Revenue_2026_export.xlsx
#   OR start empty and use the Import Excel button (Merge mode) later.

# Start
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802
# → open http://127.0.0.1:8802  (login: user rijoy, your .password)
```

## Verification checklist (report back on these)

- [ ] `curl -s http://127.0.0.1:8802/healthz` returns `{"ok": true}`
- [ ] The page loads with the dark theme and all five tabs
- [ ] Onsite shows the 8-column header + month/week grid (columns exist even
      with no data; rows appear after upload/seed)
- [ ] Import Excel (Merge) works with an exported workbook

## DO NOT

- ✗ Rebuild any part of the UI from scratch
- ✗ Add a build step / framework (there is none — vanilla HTML/CSS/JS)
- ✗ Upload or commit any data, `.password`, `data/` (gitignored)
- ✗ Remove the auth gate or make `/api/*` public
