# CHANGELOG — Revenue Recon

Running record of **what changed, why, and which issue it belongs to**, so a
future change can be checked against the original intent instead of
re-litigating it.

Newest first. Every entry names the GitHub issue (or says plainly that there
wasn't one) and the commit.

---

## ⚠️ Read this before citing an issue number

The app has **two different numbering systems** and they collide:

| | Range | Meaning |
|---|---|---|
| **GitHub issues** | `#1`–`#22` | Rijoy's requests, filed on GitHub |
| **Internal "Feature #N"** | `#8`–`#14` | Design labels written into the code by the agent, from a local plan. **Not** GitHub issues. |

Concretely, `feature #11` in a code comment does **not** mean GitHub issue #11.
Before today, GitHub issues stopped at #11, so `feature #12`, `#13` and `#14`
could not collide. **They can now** — backfilling created GitHub #12–#19.

**Convention from 2026-10-01:** GitHub issues are referenced as **`GH-12`**;
internal plan labels stay as `Feature #12` and must never be shortened to `#12`.
Code comments should be migrated to `GH-` as they are touched.

Known pre-existing collisions:

| Code says | Actually means | GitHub issue with that number |
|---|---|---|
| `feature #8` (themes) | internal feature 8 | **GH-8** — Themes Options (coincidentally the same topic) |
| `feature #9` (user section) | internal feature 9 | **GH-9** — Have a user section (same topic) |
| `feature #10` (dashboard popup / Used-by) | internal feature 10 | **GH-10** — Dashboard Changes, **GH-11** part 1 |
| `feature #11` (pricing collapse) | internal feature 11 | **GH-11** part 3 |
| `feature #12` (rail/filters/KPI) | internal feature 12 | **GH-18** |
| `feature #13` (collapsible sidebar, clipped popups) | internal feature 13 | **GH-19** |
| `feature #14` (grid density / bars) | internal feature 14 | **GH-17** |

---

## 2026-10-01 — Backfill: issues created for work done in chat

This work happened in conversation with no GitHub issue. Issues **GH-12** to
**GH-22** were created retrospectively so the trail exists.

| GH | What | Commits |
|---|---|---|
| [#12](../../issues/12) | Export dropdown clipped inside the collapsed rail | `3711b61` |
| [#13](../../issues/13) | Modals had no Cancel — accidental Merge could only be confirmed | `0069fda` |
| [#14](../../issues/14) | No record of destructive actions (activity log) | `0069fda` |
| [#15](../../issues/15) | Merge dialog did not say what it was about to do | `0069fda` |
| [#16](../../issues/16) | CI never ran; `init_db()` + tests broken on a fresh clone | `884022b` |
| [#17](../../issues/17) | Grid density — repeated identity columns pushed months off-screen | `ecce7a0`, `e8b42ae` |
| [#18](../../issues/18) | Dashboard redesign — left rail, cascading filters, KPI bar | `817c196`, `9539fe6` |
| [#19](../../issues/19) | Collapsible sidebar + clipped filter dropdowns | `51676d5` |
| [#20](../../issues/20) | Regression — account dropdown painted under the filter bar | `8a16242` |
| [#21](../../issues/21) | Duplicate modal ids left Add/Edit Resource Save dead | `954edb3` |
| [#22](../../issues/22) | Allocations not visible for multi-project people — **open, needs review** | — |
| [#8](../../issues/8) | Themes — done (9 themes shipped); **left open** | `a994fdb`+ |
| [#6](../../issues/6) | Update check — done (`/api/version` + banner); **left open** | — |
| [#7](../../issues/7) | PM name in grids/exports — **NOT done** (no PM column exists) | — |

**Not closed deliberately:** Rijoy closes his own issues. These were commented
with the evidence instead.

### Rijoy's issues that today's work did NOT deliver — do not assume otherwise

- **GH-7 — PM names in Dashboard/Planned/Actuals/Utilization and in the Excel
  export.** Verified absent: no `pm` column in the column registry, none in
  `importer.py`'s exporters. The PM *filter* on the Dashboard is a different
  thing and does not satisfy this.
- **GH-10 item 3 — "revenue till date and expense should be total till today."**
  The KPI bar carries *till date* tiles, but they come from recorded **Actuals**,
  not a date-scoped cut of Planned. Needs a decision.

---

## 2026-10-01 — PM access rework (GH-4, GH-7 area, GH-3)

Commit `a994fdb` — People master list, project assignment with a 100% weekly
hard block, billable-OT approval gate.
Then `2f8bf8c` — `user_projects` primary key corrected from
`(user_id, project)` to `(user_id, client, project)`; without it a PM could not
own the same project name under two clients.

Introduces the **Workbench** tab for PMs and the **People / OT approvals**
blocks on Team & Access. Adds `people`, `person_titles`, `actual_notes` reason
and `under_billed` columns.

---

## 2026-10-01 — Rate Card / Team & Access split (GH-11 part 1, GH-10)

The old **Pricing** tab was doing six unrelated jobs in one long scroll. Split
by purpose:

| Was buried in "Pricing" | Now lives in |
|---|---|
| Title → client rate / offshore rate | **Rate Card** (+ new Margin % column) |
| Project → PM assignment | **Team & Access** |
| Admin accounts + permissions | **Team & Access** |
| Per-resource capacity | **Utilization** (behind `⚙ Capacity`) |
| SQLCipher DB password | **Team & Access** |

Tabs are now: **Dashboard · Planned · Actuals · Rate Card · Utilization ·
Team & Access** (plus Workbench for PMs).

> **Renamed ids.** `#pricingView` and `data-tab="pricing"` are gone. `pricing`
> now exists **only** as a permission key. `switchView("pricing")` silently does
> nothing — a real trap for future work.

---

## 2026-09-30 / 10-01 — Earlier same-day work (GH-8, GH-9, GH-10, GH-11)

- GH-8 — Themes: **9 themes** (`midnight` default, BelWo, Apple, Paper, Nord,
  Solarized, Forest, Sunset, High contrast). Injected server-side into
  `index.html` so there is no flash of the wrong theme. Every signed-in user may
  switch, PMs included.
- GH-9 — Account cluster top-right: identity, theme, change password, GitHub
  link, raise bug/feature, sign out. The loose topbar GitHub/issue links were
  removed per this issue.
- GH-10 — Dashboard: client/project filtering, resource-count popup, KPI bar.
- GH-11 — Pricing: Used-by popup (one row per person + Allocation), centred
  numeric columns, collapse/expand all.

---

## How to keep this useful

1. **Every commit that changes behaviour cites its issue** — `GH-12` style.
   If there is genuinely no issue, say so in the body rather than leaving it
   blank; that is still a trail.
2. **Add a CHANGELOG entry** when a change is more than a typo.
3. **If a change contradicts an earlier entry, say so explicitly** — name the
   entry and why it changed. Silent reversals are what this file exists to
   prevent.
4. **Never mark work delivered without checking the code.** GH-7 was nearly
   closed as "done" because the dashboard gained a PM *filter*; the issue asks
   for a PM *column*. Read the code, not the commit titles.
