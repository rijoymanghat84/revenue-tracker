# CHANGELOG — Revenue Recon

Running record of **what changed, why, and which issue it belongs to**, so a
future change can be checked against the original intent instead of
re-litigating it.

Newest first. Every entry names the GitHub issue (or says plainly that there
wasn't one) and the commit.

---

## 2026-10-01 — Delete projects from the Dashboard; PMs create/delete their own (GH-37)

Commit `814387b` — **GH-37**. the owner asked for two things: a delete option on the
Admin Dashboard, and for PMs to be able to create a project (without any dollar
values), have it show on the Dashboard, and delete what they created.

### The delete was also an integrity bug

`DELETE /api/projects/{pid}` was a bare `DELETE FROM projects WHERE id=?`. It
removed the definition and **left every `resources` row — plus its
`weekly_hours`, `actual_hours` and `actual_notes` children — pointing at a project
that no longer existed.** Those rows still appeared in the Planned grid and still
counted in Utilization and the Dashboard.

It now clears children → riders → PM assignment → definition in one transaction,
matched with `TRIM(UPPER(...))` the way the rest of the app keys projects.
Measured: **18 projects → 17, with 0 orphaned resources.**

### Deleting a staffed project is refused, and says why

```
Apple · Support still has 5 person(s) assigned (Ethan Caldwell, Mason Reyes,
Noah Bennett, Olivia Grant, Liam Foster) with 236 planned week(s) and
136 actual week(s). Deleting it discards those hours.
```

`?force=true` overrides. Both UIs are **two-step**: the first attempt is refused
with the real numbers, and only then does the second confirm ask again — so a
stray click can never destroy a team.

### Permissions

New `_may_manage_projects()` lets a PM reach the project routes. Ownership still
decides everything through `_pm_may_touch()`, so a PM may only create, edit or
delete projects **they own**. `GET /api/projects` is now scoped for PMs instead of
403 (they could create a project but never list one). A PM creating a project is
written as its **owner** automatically; an explicit `pm` from an admin still wins.

### UI

- **Admin:** a 🗑 column on the Dashboard, rendered only when the user holds the
  `projects` permission.
- **PM:** a **+ New project** button on the workbench — client, project and
  optional dates only, **no rate, no revenue, no dollar field** — plus a 🗑 on
  each of their project rows.

### Found while testing

`/api/my-projects` built its list from **resource** rows, so a project the PM
owned with nobody on it yet did not appear. The create returned 200 but the
project vanished from the very list it was created for — the same class of bug as
GH-32. Owned-but-empty projects are now included.

| Check (throwaway PM, created and removed for the test) | Result |
|---|---|
| PM creates a project | **200**, auto-assigned as owner |
| Appears on the admin Dashboard | **yes**, empty "no team" row |
| Visible in the PM's workbench | **yes**, "+ Add team member" enabled |
| PM deletes **another** PM's project | **403** |
| PM renames **another** PM's project | **403** |
| PM deletes **their own** project | **200**, ownership row released |
| PM sees money (dashboard/pricing/users/activity) | **403 on all four** |
| DB after the round-trip | 17 projects, 65 resources, 1,885 weeks, **0 orphans**, `ok` |
| Money | **unchanged** at $2,000,000.00 / $1,000,000.00 |

**Two bugs in my own work, caught by testing rather than review:** the shared SQL
predicate was built with a `res` alias and then reused in a statement where
`resources` is unaliased, so every delete raised `no such column: res.client` and
returned a bare 500; and the PM's test login appeared to fail only because
`/api/me` returned `None` for a login that had not actually succeeded.

---

## 2026-10-01 — Add Project takes PM + allocation; uploads enforce capacity (GH-34, GH-35)

Commits `99289ed` (**GH-34**) and `b080998` (**GH-35**).

### GH-34 — Add Project must ask for the PM and the allocation

the owner: _"While adding project, it asked the name and other details but it should
also ask for the PM and then the percentage allocation phase or full time etc and
then if it exceed the allocation it should error."_

The create dialog asked only for client / project / dates, so a new project
landed ownerless with nobody on it — and therefore appeared nowhere the user
looked (the GH-32 symptom).

`POST /api/projects` now accepts:

- **`pm`** — writes `user_projects`, the single source of truth for ownership. An
  unknown PM, or a project another PM already owns, returns a **non-fatal
  warning** rather than discarding the submission.
- **`capacity_mode`** (`full` | `partial`) with `allocation_pct` and `person_id`
  — "full time" is 100% of one person; "partial" takes a 25%-step percentage.

The 100% weekly rule is enforced **server-side** via `validate_assignment()` and
the refusal names the clashing weeks:

```
100% would push Ryan Doyle over 100% in 52 week(s).
First clash: Jan-02 would reach 200.0%.
```

The submission is rolled back on refusal, so a project is never half-created, and
the conflict list is returned so the dialog renders it **inline** under the
allocation field — the weeks ARE the explanation.

### GH-35 — the bulk Excel upload now enforces the capacity rule

the owner: _"if in the upload a resource is utilized for more than 100 hours in total
then the upload should fail giving the reason for the fails."_

`_validate_import_capacity()` runs **before any write**, on a simulation of the
resulting state, so a rejected file leaves the database exactly as it was. It
groups by person **name** — the key `compute_utilization` and the 100% rule use —
because a spreadsheet has no person ids and a person legitimately holds one row
per project.

**The rule is "the upload must not introduce or worsen an over-capacity week",
NOT "nobody may ever exceed capacity".** That distinction is load-bearing: the
live book already has **103 person-weeks over capacity** (Nathan Rowe at 130%
and 160%), because the app deliberately never retro-breaks existing bookings. A
blanket rule refused **every** upload — including a round-trip of the untouched
export — which testing on real data caught and review did not.

Real output for a 100h week against a 40h capacity:

```
Import rejected — 1 week(s) exceed a person's weekly capacity. Nothing was saved.
Ethan Caldwell @ Jan-02: planned 100.0h exceeds the 40h weekly capacity
by 60.0h (250.0%)
fix: reduce this week to 40h or less, raise the capacity, or move hours to another week
```

| Check | Result |
|---|---|
| 100h file | **400**, reason + fix named, nothing written |
| Before / after hours | 63,190.3h — **unchanged** |
| Untouched export | **200**, 64 rows updated, **+40h** exactly |
| Problems capped at 60 | with a total count returned |
| Both repo test suites | **ALL PASSED** |

---

## 2026-10-01 — Dashboard visibility, Active flag, popup formatting (GH-32, GH-33)

Commits `43be591` (**GH-32**) and `aab483e` (**GH-33**).

### GH-32 — a project with no resources never appeared on the Dashboard

the owner: _"In the dashboard I added a project and it didn't get added"_ and _"The
Bench project and all project that we add should be there in dashboard."_

The Dashboard is built from **resource** rows, so a project with nobody assigned
to it totals to nothing and produced **no row at all**. Measured: the `projects`
table held **16** rows, the Dashboard showed **14**. Missing were
`Internal / Bench` and `Meta / Platform` — the project just added — both
with 0 resources. So adding a project looked like it had silently failed, and it
could not even be selected in the Dashboard project filter (also built from
resource rows), leaving no way anywhere on the Dashboard to confirm it existed.

- `_empty_project_groups()` emits an explicit zero row for any defined project
  with no resources, flagged `empty`.
- The row renders with a **"no team"** badge and a tinted background, so
  all-zeros reads as "awaiting its first person" rather than a broken row.
- The project filter's option list is unioned with the `projects` table.
- Filters still apply, so client / project / PM filtering is unchanged.

Verified: **16/16** projects on the Dashboard, **16** filter options, both empty
rows badge correctly, Planned Revenue still **$2,000,000.00** with 64 resources.

### GH-33 — popup fields collided; Active/Inactive moved to the first column

the owner: _"when i click on edit/ merge a popup window opens they all details in the
popup is not properly formatted ... should look professional"_ and _"the active
or inactive flag ... should be the first flag to make sure that the resource is
available — if inactive then they are no longer in the company."_

**Popup cause was layout, not taste.** `.modal-body label.f` set only a colour,
so a `<label>` stayed inline *beside* its input inside the grid cell. A long
label ("Weekly capacity (hrs)", "Approved titles (comma-separated — PMs may book
only these)") filled the cell and pushed the input against the next column — two
fields read as one crammed blob. Fields are now **stacked label-over-control**,
so a long label can only make its own row taller. Applies to every popup using
`.assign-grid` / `.wb-field` (person, merge, project, assignment, new joiner).
Verified: all 6 person-dialog fields stack with `overlap=false`.

**Active/Inactive** is now column 1 and is a **toggle**, so status is changed
where it is read instead of two clicks away inside Edit. Inactive rows are
dimmed; the load bar keeps its own column so both signals stay visible.

### A data-loss bug the toggle work exposed

`api_person_update` declared `country` / `home_title` as `str | None = ""`. A
request carrying only `{active}` therefore arrived with `country=""` and
`home_title=""`, and the endpoint **wrote those blanks** — so toggling someone's
status silently **erased their home title**. Caught by test: `'QA'` → `''`.

Every field now defaults to `None`, so "omitted" is distinguishable from
"explicitly cleared": `None` keeps the stored value, `""` clears it. The title is
re-canonicalised against the rate card on save, matching the joiner path.

| Check | Result |
|---|---|
| `PUT {active:0}` → 200 with `home_title` intact | **pass** |
| Legacy full-edit payload | still 200 |
| DB scanned after the fix | **0 of 49** people missing a home title |
| Integrity | `ok` |
| Console errors | 0 |

**Process note:** two commits in this batch had to be re-issued because the
citation was guessed instead of read back from GitHub (`#30/#31`, not `#33/#34`;
then `#33`, not `#35`). Rewriting was done with `format-patch` + `reset --hard` +
`am`, and the tree comparison caught that `sed` had also rewritten the same
number inside code comments — harmless, but worth knowing that a "tree differ"
after a message-only rewrite is not automatically a problem.

---

Two fixes from the same review pass. Commits `ed4a0c3` (**GH-30**) and
`89ec9ed` (**GH-31**).

### GH-30 — the filter dropdown closed when you touched its own scrollbar

the owner: _"when i click on project it list the project but i cannot scroll down
when i try to click the scrollbar the dropdown goes back. I can click and drag
the scroll bar either."_

Reproduced before touching anything: the option list was **genuinely
scrollable** (`scrollHeight 580` inside `clientHeight 298`), but closed the
instant its scrollbar moved. `closeMsPopups` was bound as

```js
window.addEventListener("scroll", closeMsPopups, true);   // capture!
```

Capture fires for scroll events from **any** element, so a scroll *inside the
popup* closed the popup. Now gated on the event target: a scroll originating
inside `.ms-pop` is ignored; everything else (page scroll, resize, Escape,
outside click) still closes it. Verified: survives inner scroll **and** wheel,
still closes on outside scroll.

### The stale-asset bug class, killed properly

This is why "my fix isn't in the app" kept recurring. The served shell carried
`app.js?v=110` while the cache-first service worker already held a **previous**
`v=110` — so the browser executed pre-edit code even though the server was
serving the new bytes, and `fetch(..., {cache:'reload'})` still returned the
stale copy. Bumping the number is not a fix, because the number can always
collide with one served earlier.

- `index_page` now sends **`Cache-Control: no-store, must-revalidate`**.
- New `_stamp_asset_versions()` rewrites every asset URL to a short **content
  hash** (`app.js?v=7da3c74ecd`), which cannot collide with a previous build.
  Verified: all four hashes match `sha1sum` of the files on disk.

Nobody has to remember to bump a version number again.

### GH-31 — Logs in the left panel

the owner: _"where is the logs? ... there should be an option on the left panel to
see the logs for admin."_

The backend (`/api/activity`) and the renderer already existed — the panel was
just buried at the bottom of **Team & Access**, the wrong place to look when
asking "what just happened?". It is now a **🕘 Logs** tab in the Section Panel.

- Admin-only, gated by an explicit `isAdmin` check rather than a permission key:
  `can()` only grants admin-*held* permissions, so a `null` permission entry hid
  the tab from admins too (caught in the browser test, not in review).
- The old activity markup was **removed** from Team & Access rather than
  duplicated — both blocks declared `id=activityHead`/`activityBody`, which would
  have made `getElementById` bind the wrong one.
- Adds a free-text filter (who / action / person, no refetch) and a 60/150/400
  limit selector that refetches.

| Check | Result |
|---|---|
| Dropdown survives inner scroll + wheel | **pass** (still closes on outside scroll) |
| Asset hashes vs files on disk | all 4 **match** |
| Logs tab appears for admin / opens / filters | **pass** |
| `getElementById('activityHead')` count | **1** (no duplicate) |
| Team & Access still renders | 48 people |
| Console errors | 0 |
| `tests/test_admin_mgmt.py` | **ALL PASSED** |
| `tests/test_issue4_pm_admin_separation.py` | **ALL PASSED** |

**Availability** was narrowed in the same pass at the owner's request: the panel now
lists **available + over-allocated** and hides only the people at *exactly* 100%
— 20 available + 3 over = 23 of 48, with the hidden count stated. Over-allocated
rows are tinted and badge-counted on the button.

---

Commit `a6bee72` — **GH-29**. the owner asked for three things on the Utilization
page: filters "per project and per resource", "a way to look which resources
will be available for a given month based on the percentage", and "the month
name in the week view should be in middle not right aligned".

**1. Filters (Client / Project / PM).** The Dashboard's cascading multi-select
is reused but holds its **own** state (`state.utilFilters`), so filtering
Utilization never disturbs the Dashboard's selection. They are sent to the
server and applied to the per-project resource rows **before**
`compute_utilization` aggregates them — which is the whole point:
`_all_resources` returns one row per `(name, client, project)`, so filtering it
**drops the hours of the projects you did not ask for** instead of merely
hiding people.

| Filter | People | Planned | Note |
|---|---|---|---|
| none | 48 | 63,190.3h | baseline |
| `Apple · Indy` | 2 | 1,280.0h | hours scoped to that project |
| `Apple` (client) | 18 | 25,000.0h | only 1 person still spans >1 project |
| `demoPM` | 16 | 24,000.0h | owner-based |
| `Unassigned` | 40 | 37,963.0h | projects with no PM |

Option lists are built from the **pre-filter** set, so choosing a filter never
shrinks what you can pick next; `has_unassigned` drives the Unassigned option. A
scope line states in plain words what the numbers currently cover.

**2. Availability.** An "Available" panel lists, for the chosen month, every
resource's capacity, planned hours, free hours and free %, sorted **most-free
first** so the bench is visible at a glance (10 people at 100% free, down to 0%,
with over-allocated people flagged). Capacity and planned hours come off the
**same** month payload the grid shows, so the two cannot disagree, and a project
filter narrows availability along with it. The month follows the rail selector
and falls back to the current month.

**3. Centred month band.** In Week view the month cell is far wider than its
label and sits above a row of week numbers, so the `.num` right-align pushed
"JAN" hard against the last week of its block — it read as a label for *that
week* rather than the month. The band row is now centred; P/A and Overall keep
their numeric alignment.

**Also fixed:** week-mode cell tooltips used `esc(mm.name)` where `mm` is already
a month **name** string, so every title rendered `undefined wk …`.

| Check | Result |
|---|---|
| Availability maths vs raw API, all 48 rows | **0 mismatches** |
| Sort order | monotonic non-increasing |
| Month band centring | 12/12 centred; band-over-weeks still 0px |
| Console errors | 0 |
| Mobile 390px overflow | 0px; popups stay on screen |
| `tests/test_admin_mgmt.py` | **ALL PASSED** |
| `tests/test_issue4_pm_admin_separation.py` | **ALL PASSED** |

**Usability fix found by measuring, not assuming:** the Availability panel's top
landed at **944px on a 950px viewport** — the bottom edge — so clicking
"Available" looked like it did nothing. It now scrolls into view on open and the
button carries the bench count (`☰ Available · 16`).

**No DB or schema change.** `/api/utilization` keeps its old response shape and
simply gains three optional query params (`client`, `project`, `pm`).

**Pitfall confirmed again:** editing `app.js` without bumping `?v=` means the
service worker serves the **cached** copy and the change looks undeployed —
happened twice in this task (`v=107` reused after an edit). Every static edit
needs a **new** version number.

---

Commit `59989a4` — **GH-28**. Reported from the board: _"all the month is now
together, design wise it should be proper like Jan month and then the 4 weeks
below it"_ and _"make sure that the month and the Planned and Actual are aligned
properly for that month."_

Two separate rendering bugs, both measured in the live app before touching
anything:

1. **The month header did not span its own pair.** Each month renders as a
   **Planned** and an **Actual** column, but the month `<th>` had no `colspan`
   while its sub-row had two cells. `JAN` measured **51px sitting over a 102px
   pair** — `MISALIGN_RIGHT = -51px` — so the month name covered its Planned
   column only and the Actual column dangled outside its own month. Fixed with
   `colspan="2"`; all 12 months now measure **0px** on both edges.
2. **Header rows overlapped on scroll.** `thead th` is `position: sticky` and
   every row kept `top: auto`, so all rows pinned to the *same* offset. After
   scrolling, row 0 sat at `top=169 bottom=199` and row 1 at `top=169 bottom=197`
   — **30px of overlap on a 30px row**, i.e. the month names were completely
   covered. Each header row now pins to its own offset.

**New: a Month / Week toggle** on the Utilization toolbar.

- **Month** (default) — the year at a glance, unchanged numbers.
- **Week** — each month is a band over its weeks and a week is itself a P/A
  pair, so the hierarchy reads **Month > Week > P|A**. Hidden on the single-month
  drill-down; Week also works inside a chosen month.

`/api/utilization` is month-only, so weekly figures are derived client-side from
`state.resources` (`hours[53]` / `actual_hours[53]`), **summed per person name**
to match the server's per-person aggregation. **No server, schema or DB change.**

| Check | Before | After |
|---|---|---|
| Month header vs its P/A pair | `-51px` | **0px**, all 12 months |
| Header overlap on scroll | 30px (names covered) | **none** |
| Month figures | — | **identical** to pre-change |
| Week columns | — | 53 weeks, 111 cells/row |
| Frozen columns (header vs body) | — | `d=0` in both modes |
| Month-column highlight | 96 cells | **96 cells** (unchanged) |

**Pitfall worth remembering:** the service worker caches assets cache-first, so
re-bumping to a *previously used* version string (I reused `?v=105`) serves the
old file from cache and the fix looks undeployed. Every deploy needs a **new**
version number.

---

the owner's instruction: _"if there is anything we are fixing and it's already a bug
or a fix or feature to an already done thing, make the changes in git also, so
that the tracking is there."_

Codified in **`CONTRIBUTING.md`** (the rules) and
**`scripts/check_commit_trail.py`** (the gate):

```bash
python3 scripts/check_commit_trail.py          # commits not yet on origin/main
python3 scripts/check_commit_trail.py --all    # audit since the baseline
python3 scripts/check_commit_trail.py <sha>    # one commit
```

Every behaviour-changing commit must cite `(GH-N)` in its subject, or carry
`no issue: <reason>` in its body. Docs/test-only commits are exempt. Commits at
or before `e27695a` are grandfathered.

## 2026-10-01 — Theme, popup and PM-usability pass (GH-24 … GH-27)

Commit `961fbdf`.

| GH | What |
|---|---|
| [#24](../../issues/24) | Popups unreadable on light themes — a bare `<select>` inherited light text on the UA's light-grey background, measured contrast **1.0 (invisible)**. Fixed across every popup, plus removed hardcoded colours that ignored the theme. |
| [#25](../../issues/25) | PMs could not change their own theme — `_can_change_theme` required an admin permission, leaving a locked (sometimes blank) picker. Now open to every signed-in user. |
| [#26](../../issues/26) | Removing a PM now surfaces the projects left without an owner (banner + 'Show them' highlight). |
| [#27](../../issues/27) | `_dedupe_person_titles` stops the People list showing the same title twice via whitespace variants. |

Verified in a real browser on Paper (light) and Midnight (dark): 9 popups,
worst contrast **4.58 light / 6.76 dark**.

---

## ⚠️ Read this before citing an issue number

The app has **two different numbering systems** and they collide:

| | Range | Meaning |
|---|---|---|
| **GitHub issues** | `#1`–`#22` | the owner's requests, filed on GitHub |
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

**Not closed deliberately:** the owner closes his own issues. These were commented
with the evidence instead.

### the owner's issues that today's work did NOT deliver — do not assume otherwise

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
