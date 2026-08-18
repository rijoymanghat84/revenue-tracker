# Actuals Tab — Design Spec (v1)

Feature: a new **Actuals** tab (after Offshore) where PMs record the *actual*
hours a resource worked each week, validated against the *planned* hours in
the Onsite/Offshore grid. The reconciliation feeds new **Additional
Revenue / Additional Expense / Adjustment** sections on the Dashboard.

Author: Rijoy + Friday. Status: agreed, in build.

---

## 1. Core model — three parallel hour layers

| Layer | Table | Who writes | Meaning |
|---|---|---|---|
| Planned | `weekly_hours` (existing) | Admin (Onsite/Offshore) | Contracted / on-the-books hours |
| Actual | `actual_hours` (new) | PMs (Actuals tab) | What really happened |
| Trail | `actual_notes` (new) | PMs (auto) | Per resource·week: PM, overage, comments, OT/approved/billed/reason |

Actuals **never overwrite** planned hours. They are a parallel set.

## 2. Schema additions

```sql
-- per-resource weekly capacity override (default 40h)
ALTER TABLE resources ADD COLUMN capacity REAL NOT NULL DEFAULT 40;

-- actual hours, parallel to weekly_hours
CREATE TABLE actual_hours (
  resource_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  hours REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, week)
);

-- per resource·week reconciliation trail
CREATE TABLE actual_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  pm TEXT NOT NULL DEFAULT '',          -- who recorded (username)
  overage REAL NOT NULL DEFAULT 0,      -- actual - planned (positive = over)
  comment TEXT NOT NULL DEFAULT '',     -- why-less / not-billed reason
  is_ot INTEGER NOT NULL DEFAULT 0,     -- 0/1
  approved INTEGER NOT NULL DEFAULT 0,  -- 0/1 (PM self-approves)
  billed INTEGER NOT NULL DEFAULT 0,     -- 0/1 billed to client
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- users + PM↔project scoping
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- salted hash, never plaintext
  role TEXT NOT NULL DEFAULT 'pm',      -- 'admin' | 'pm'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE user_projects (
  user_id INTEGER NOT NULL,
  project TEXT NOT NULL,                -- normalized project name
  PRIMARY KEY (user_id, project)
);
```

## 3. Reconciliation state machine (per resource·week, on save)

Every actual-hours write is **attributed to the recording PM** (username +
overage amount stored in `actual_notes`). The future audit tab reads this trail.

| Actual vs Planned | Action |
|---|---|
| = planned | nothing |
| < planned | **mandatory comment** (why + did the time move to another project). Base stays; negative **Adjustment** line on both revenue & expense. |
| > planned → **OT flow** (ANY overage) | |
| ├ OT? **No** | record overage (attributed), save → **Additional Expense only** (paid more, not charging) |
| ├ OT? **Yes** → **Approved?** | |
| │ ├ **No** | **BLOCK save.** PM must mark approved OR decline-as-non-OT. No unapproved OT can exist. |
| │ └ **Yes** → **Billed to client?** | |
| │ ├ **Yes** | save → **Additional Revenue + Additional Expense** |
| │ └ **No** | **require reason**, save → **Additional Expense only** (un-billed OT leak visible) |

Capacity is **informational only** (not a gate): shown on the Actuals row and
feeds the existing Utilization tab, with a visual flag when crossed.

## 4. Dashboard additions

| | Base (planned × rate) | Adjustment (under) | Additional (over) |
|---|---|---|---|
| **Revenue** | ✓ | −Δ × onsite | + overage × onsite *(OT billed only)* |
| **Expense** | ✓ | −Δ × offshore | + overage × offshore *(all overage)* |

Net = Revenue − Expense. Example: 40→50h, onsite $50 offshore $20, billed →
Rev +$500, Exp +$200. Un-billed → Rev +$0, Exp +$200 (visible leak).

## 5. Auth & roles

- **Admin** (existing admin user): all tabs + user management.
- **PM**: signs in → sees **only the Actuals tab**, scoped to their assigned
  projects, no rates/revenue. Planned hours shown as comparison baseline.
- Sign-in screen → role-based routing. Session via signed token (cookie).

## 6. Pricing tab — new section

Below the title library: **Project → PM assignment** grid (drives PM scoping)
+ per-resource **capacity override** (default 40h).

## 7. Export / Import round-trip

- Export adds an **Actuals** sheet (hours) + **Actuals Trail** sheet
  (comments/OT/approval/billing). Import **reads** the Actuals sheet
  (merge by resource·week) — so Excel is both crash-restore backup AND bulk
  entry. Imported batches attributed to **admin** (not a logged-in PM).
- **Role-scoped**: admin export/import = all tabs. **PM** export = Actuals-only
  workbook scoped to their projects (no rates, no other tabs); PM import =
  Actuals sheet only, writes actual_hours for their projects only.

## 8. Actuals entry — wizard popup (v2)

The Actuals tab keeps the full-year read-only grid, plus a **"+ Add / Edit
Actuals"** button that opens a wizard popup:
1. **Client** dropdown → filters to **Project** dropdown → populates
2. **Month + Year** picker (e.g. March 2026)
3. Lists the project's **resources**, each with that month's **week columns** —
   **planned** hours shown read-only as baseline, **actual** inputs editable.
4. **OT workflow runs inline in the popup** (overage → OT/approved/billed/reason;
   under → comment) — radio/dropdown controls, not browser dialogs.
5. **Save** validates all entered weeks at once, then writes actual_hours + notes.

Rules:
- **No unassigned entries**: a PM cannot enter actuals for a week with **zero
  planned hours** — blocked with an error.
- **Edit pre-fill**: picking a client/project/month that already has actuals
  pre-fills them; OT flow only re-fires for weeks the PM changes.
- PMs see only their assigned clients/projects in the dropdowns; admin sees all.

## 9. Open items / future

- Dedicated **audit tab** (per-PM record of who recorded what, by how much).
- OT approval could later require admin sign-off (currently PM self-approves).
