# CHANGELOG — Revenue Recon

Running record of **what changed, why, and which issue it belongs to**, so a
future change can be checked against the original intent instead of
re-litigating it.

Newest first. Every entry names the GitHub issue (or says plainly that there
wasn't one) and the commit.

---

## 2026-10-02 — My Projects panel: fill the allocation, Edit pre-fills it, Remove asks resigned vs bench (GH-54)

**Rijoy (PM login → My Projects → click a project):** three changes to the right-hand
resource panel, where each resource has Edit and Remove and some details.

1. **The planned/allocation must not come up empty.** ⚠️ **Measured: 62 of the 66
   resource rows have `resources.allocation_pct` = NULL** — the original Excel
   import carried per-week *hours*, never an allocation %, and only rows created
   through the assignment dialog ever got one. So the panel's `Allocation` and
   `Weekly hrs` columns, and the Edit dialog's seed, rendered `—` for almost the
   whole book even though the plan is fully populated (`weekly_hours`, 1,898 rows,
   63,710.25 h).
   **Fix: derive it, don't migrate it.** The % is computed from each resource's
   **peak** week ÷ its capacity, rounded to the nearest quarter with a **25%
   floor** for any positive plan (4h → 25%, 20h → 50%, 40h → 100%). **Nothing is
   written** — `weekly_hours` is untouched, so the money cannot move (planned total
   unchanged at 63,710.25 through every deploy). Marked **"from plan"** on screen so
   a derived number is never mistaken for one someone typed; a real Edit save
   stores it. A row with no planned hours still shows —, not 0%.
   *Why the floor:* flooring (112% → 100%, correct for *benching*) rendered a
   4h/week plan as **0%**, which reads as "not allocated at all". Caught by
   measuring live: 8 resources were still blank after the first deploy.

2. **Edit pre-fills the resource — you don't re-select it.** Four real defects, all
   fixed:
   - the dialog rendered a **full person picker** even when editing, so a PM had to
     re-find the person they had just clicked Edit on;
   - it seeded the person's **home title**, not the title the row is actually booked
     under. **8 live rows are booked under a different title** (a QA booked as a
     Quadient Developer) — so Edit showed the wrong title and a save silently
     re-titled the booking;
   - allocation defaulted to a flat **50%** and the dates came up **blank**;
   - **and those 8 rows were unsaveable**: `PUT /api/assignments/{rid}` refused a
     non-home title with no reason, which was true of all 8. The reason is now
     required only when the title actually **changes** (a PM still cannot introduce
     a non-approved title), so legacy bookings edit cleanly.

3. **Edit only rewrites the plan when the allocation really changes.** Rijoy:
   *"leave the weeks exactly as they are unless I actually change the allocation %"*.
   Every save used to re-spread `pct × capacity` across the window, so opening Edit
   to fix a title **flattened a varied plan** (40h most weeks, 20h in others). The
   write now happens only on a real change, and a **blank posted date is not read as
   "clear the window"** — with legacy rows the window is derived, so a no-op save
   posts blanks and would otherwise have re-spread the plan as full-year.

4. **Remove asks "did they resign?"** — a real in-app dialog replaces the browser
   `confirm()` (which only warned about deleted hours). It names the hours that go
   with the removal and offers:
   - **Not resigned → back on Bench** for the share that actually **frees up**,
     measured *after* the removal (50% here + 50% elsewhere benches **50%**, not
     100%), through the same 100% validator as any assignment, on a **zero-rate**
     Bench row so it is financially inert;
   - **Resigned → the person is marked Inactive** (`people.active = 0`, badged
     "Inactive" on the admin People list).
   Resigning while still on **another** project **warns and needs a second press**;
   the server re-checks (409 `still_assigned`) and never silently clears another
   project's data. Removing the **Bench row itself does not re-bench** (circular),
   and a resource with no person record says so instead of pretending to bench.

**Commits:** `087cefa` (feature), `2797398` (the 25% floor), `556d24d` (superseded
attempt, reverted by a concurrent writer).
**Verified:** `tests/test_gh54_panel.py` (37 assertions, temp DB) covers the
derivation, plan preservation, the grandfather rule and **every** Remove branch
including the 409 and the Bench/unlinked edges — added to `scripts/run-tests.sh`
(now 5 suites, all green). A 24-assertion Node harness over the shipped
`workbench.js` proves the dialog payloads and the pre-fill. Then driven **live**:
assign → no-op edit (weeks byte-identical) → remove → Bench (zero-rate, person still
active), with every touched table restored to baseline (66 resources / 49 people /
17 projects / 63,710.25 h).

---

## 2026-10-02 — PM landing page, and the compare panel's buttons (GH-53)

**Rijoy, 2026-10-02:**
> "first the default page the PM login should be my projects"
> "second, The move button and the x out butoon in the compare panel is not
> properly displayed it should be proper button"

### 1. A PM now lands on My Projects

`showApp()` opened the **Week sheet** for a PM (data entry). It now opens the
**workbench**. Two details worth keeping:

- The old branch carried **two contradictory comments stacked on top of each
  other** — one asserting the PM lands on the workbench, the next asserting the
  week sheet — each claiming to be the rule. That is exactly how a default drifts
  without anyone noticing a change. There is now ONE statement of it.
- The first attempt set `state.view` by hand, which rendered the workbench but
  left the top-strip title reading **"Dashboard"**. The tab said *My Projects*
  while the heading above it said *Dashboard* — worse than the original bug,
  because the app contradicted itself. The branch now routes through
  `switchView()`, which owns tab highlight, visibility **and** the page title.

Verified live as a throwaway PM: view=`workbenchView`, active tab **My Projects**,
title **My Projects**, sub *"Your projects, your team, and their week-by-week
load"*. Throwaway PM deleted afterwards.

### 2. The compare panel's buttons are proper buttons

**Same root cause as the bell panel earlier the same day.** `.wb-compare` wore
`.glass`, and `.glass` is `--panel: rgba(255,255,255,0.05)` — five percent white.
The table inside had no background of its own, so the resource list showed
straight through the rows and both controls read as floating glyphs.

- The panel is now opaque: `--surface-1` + `--border-strong`, no backdrop blur,
  and the dead `glass` class dropped from the markup so the bug cannot return.
- `.wb-cmp-act .btn` gets a real button box — border, `--surface-3` fill, padding,
  radius, weight, shadow, hover/active. Tokens are theme-aware (every theme in
  `main.py`'s `THEMES` overrides them), so it holds on light themes.
- The bare **`✕` became `Remove`**. An unlabelled glyph in a table cell is a
  puzzle, not a control; Move keeps primary styling and Remove turns red on hover.

**A second defect caught by measuring, not looking.** `Move…` carried `.primary`
but computed the **same** background as `Remove` — `rgb(60,56,54)` for both.
`.wb-cmp-act .btn` and `.wb-cmp-act .btn.primary` tie on specificity (0,2,0), so
source order decides and the flat fill won. The primary rule is now declared after
it: Move is `rgba(34,211,238,0.16)` with an accent border, Remove is
`rgb(26,34,56)` muted. Measured live.

Reference GH-53.

---

## 2026-10-02 — Reallocation requests: propose → releasing-PM approval → 🔔 → trail (GH-53)

**Rijoy's spec**, stage 3 of the Resources plan:

> "lets say I want to move Deepak who is allocated 100% to FOP and I want to take
> his 50% from fop to a new project … then I can do that but the allocation happen
> once FOP PM approved, so there should be a notiication bell icon on the top right
> hand side … I can approve or reject and all these get tracked and noted. and the
> same option the admin should have too and incase of admin he can do it for any
> client and project and resource including PM"

### The five decisions he locked, implemented

| # | Decision | Behaviour |
|---|---|---|
| Q1 | Permanent **or** loan | Optional return date; blank = permanent |
| Q2 | Admin moves apply **immediately** | Button reads "Move now (applies immediately)"; still recorded in the bell + trail |
| Q3 | **Any PM** may request any resource | The releasing project's PM decides. **No PM on the source project → an admin decides**, or the request would have no decider at all |
| Q4 | Finder lives only on Resources | Built in GH-51 |
| Q5 | Loans end **automatically** | Returns on the date with a 7-day heads-up to both sides (daily 4am sweep, idempotent) |

### The two rules that are enforced, not documented

- **The past is immutable** (CHARTER #2). `effective_from_week` is clamped to the
  current week, and the source row is reduced with a **phase split** — so every
  week before the effective week keeps its original booking. Verified live: the
  week before the move still held its full 40h.
- **The 100% weekly hard block is checked TWICE** — at request time (so the PM
  learns early) and again at approval (the world moves in between). When it no
  longer fits the request **expires with a reason** instead of failing silently.

Plus a guard the tests forced out: **you cannot release more than the source
project actually holds** — asking for 100% off a 25% booking is refused, rather
than clamped to zero and quietly over-crediting the target.

### Two real defects the backend suite could not see

Both found only by **driving the actual form in a browser** — the suite exercises
endpoints, not DOM wiring:

1. **The Move modal's buttons never attached.** The close listener was bound to
   `#mvClose` but the element is `#moveClose` (it lives in the modal header,
   outside the body the JS writes). The unguarded `addEventListener` threw before
   the submit listener was reached, so "Move now" did nothing at all and the
   console showed `Cannot read properties of null` at `workbench.js:996`.
2. **The release guard ignored the DERIVED allocation.** 62 of the 66 rows have
   `allocation_pct = NULL` — the Excel import carried weekly hours, never a %. The
   guard read the raw column, so it reported *"Deepak Kumar is only at 0% on
   FOP/Support — you cannot release 25%"* when he is at 100%. Worse, the reduction
   had the same bug: reading 0 there would have **zeroed a whole booking instead
   of halving it**. Both now fall back to the derived share the rest of the app
   shows.

### Pipeline: the new pre-push guard refused my own deploy

Two honest "Deploy failed — #53" events fired at 18:59/19:00. Cause: the
`check-commit-autoclose.py` guard added earlier the same day blocked the push
because a merge summary read `Deploy (GH-53): Allocation: fix Move modal button
wiring (GH-53)` — GitHub parses "fix … (GH-53)" as an auto-close despite the
`(GH-N)` tag. The deploy had merged locally but could not push. **Fixed at the
source:** `repo-deploy.sh` now sanitises the summary's verbs (`fix`→`repair`,
`close`→`complete`, `resolve`→`settle`) before building the merge message, so the
pattern cannot be generated from there again. The three locally-merged commits
were collapsed into one clean commit (`1141276`) rather than rewriting anything
already pushed.

### Verified

43-assertion backend suite (`tests/test_allocation_requests.py`, now part of
`scripts/run-tests.sh` — 5/5 suites green) plus a full end-to-end browser run:
raised a move, watched the source drop 50%→25% from Sep-28 while earlier weeks
kept 50%, the new row appear, and the bell report *applied by rijoy* with the
trail. **Test data reverted** — production back at 66 resources / 63,710.25h
planned / 39,620.25h actual.

Commit `1141276`, deployed 2026-10-02 19:00 UTC. Cron `c19ea37b6719` runs the
loan sweep daily at 4am.

---

## 2026-10-02 — Multi-select compare: availability + current allocations (GH-52)

**Rijoy:** *"there should be a way to select multiple resource to compare and see
their availability and while doing that we should know where they are currently
allocated for which project."* Stage 2 of the Resources plan.

Tick **Compare** on any resource row and the selected people line up above the
list: availability over the chosen window, and where each person is actually
booked right now.

- **Availability side by side** — % free (averaged over the window), whether a
  **full slot** is available, and booked average/peak, so "free on average" is
  never confused with "free next week".
- **Current allocations per person** — each project with its peak % of capacity,
  the weeks it touches, the week span, and total hours. This is what makes
  "move 50% of Deepak off FOP" concrete: live, Deepak Kumar reads
  `FOP/Support · 100% (5 wks, Sep-28–Oct-26, 160h)` next to
  `Print Mail/Quadient · 100% (9 wks, Oct-19–Dec-14, 320h)` — a phased handover
  visible only as a week span.
- **Over-allocation is flagged, not hidden.** Someone whose projects SUM past
  100% in a week cannot be created through the UI (the hard block refuses it) but
  exists in imported data: **Ritik Kango is at 125%** (TSG/Quadient 100% +
  Vision Direct/Quadient 25%), and the row says so with the week. A staffing view
  that hides that is a staffing view that lies.
- Rates render for **admins only** (CHARTER clause 1) — the columns appear only
  when `/api/state` is available; the compare data itself carries no money.

**Why allocations come from the per-week `detail` array and not
`resources.allocation_pct`:** that column is NULL on **62 of the 66** resource rows
(legacy imports), so reading it would print "—" for almost everyone. Collapsing
`detail` across the window gives the real share per project *and* the weeks it
spans.

**Verified:** 9-assertion Node harness over the shipped functions against the live
payload (allocations reconcile exactly with the raw weekly detail; over-allocation
detected and flagged; "% free"/"full slot?" derive from each person's own series;
"no project work booked" is real, not a rendering gap), then driven live: 3 rows
compared, admin rates 42.72 / 17.55 shown, over-allocation called out.

Commit `515b051`, branch `feat/52_compare`, deployed 2026-10-02 18:48 UTC —
**the first deploy where the 🚀 event posted automatically**, after the wrapper was
repointed at `repo-deploy.sh`. A pre-push hook now refuses any commit message that
would auto-close an issue, so GH-52 stayed open.

---

## 2026-10-02 — Availability is averaged over the window, not the worst week (GH-51)

**Rijoy, on the Resources tab:** *"the list should have all the resources not just
few all available, non available ones too. and the percentage free should be
properly updated."* Both halves were real bugs.

### The % free was measuring the wrong thing

`wbAvailability` reported `100 − worst week in the window`. That collapses *busy
this week* into *no capacity at all*. Measured on live data:

| person | per-week booked % over 12 weeks | old | new |
|---|---|---|---|
| Ankish Mittal | `[100,0,0,0,0,0,0,0,0,0,0,0]` | **0% free, hidden as unavailable** | **92% free** |
| Khushi Bhatia | `[100,0,0,0,0,0,0,0,0,0,0,0]` | **0% free, hidden as unavailable** | **92% free** |
| Deepak Kumar | `[100] × 12` | 0% free | 0% free (correct) |

Two people who were free eleven weeks out of twelve were being listed as having no
capacity. The metric is now two numbers, because a PM asks two questions:

- **`free%` = 100 − AVERAGE booked% over the window** — the headline, and what
  the 100 / 75–99 / 50–74 / under-50 buckets use. *How much of this person can I
  use over this period?*
- **`fullSlot` = 100 − WORST week** — surfaced as **"part-time only"** plus the
  reason line (*"No full-time capacity — fully booked Sep-28 (FOP/Support)"*).
  *Can they take a full-time slot?* The worst-week signal is kept, just not as
  the headline.

Effect on live data: **17 available / 32 fully booked → 41 / 8.**

### The unavailable group looked missing

It was a collapsed `<details>`, so more than half the roster sat one click away
and read as absent. It is now **open by default** (still collapsible), and the tab
states the count up front: *"49 of 49 resources — 41 with free capacity, 8 fully
booked."* Each row also shows **`free N/12 wks`** so the average is auditable at a
glance, and unbooked people read "no project work booked" rather than a bare dash.

### Verified

24-assertion Node harness over the shipped functions against the live payload —
the whole roster is accounted for in every window mode, every listed row has
`free% > 0`, every fully-booked row is 0% free, ranking stays monotonic, and
widening the window never invents new fully-booked people (the old peak metric
did exactly that). Then driven live: 49 of 49 rendered, 41 open / 8 in an expanded
group, Ankish and Khushi at 92% free.

Commit `ba49edf`, branch `feat/51b_availability_metric`, deployed 2026-10-02 18:45 UTC.

### Root cause of the deploy pipeline's silent failures (found here)

Chasing why the 🚀 event still did not post uncovered it: there are **two deploy
scripts**. `revenue-safe-upgrade.sh` was calling the legacy
`revenue-deploy.sh` — which still used the `Fix #N` merge message (that is what
auto-closed GH-50 *and* GH-51) and had **no notify step at all**. Every fix
applied to `repo-deploy.sh` was therefore never exercised by a single deploy made
through the wrapper. The wrapper now calls
`repo-deploy.sh deploy revenue-tracker …`, and the legacy script carries a
SUPERSEDED banner.

---

## 2026-10-02 — Resources tab: the whole roster, unavailable people included (GH-51)

**GH-51**, stage 1 of the Resources/reallocation plan (the feature came from Rijoy):

> "lets also include the unavailable folks too and we will move this to another
> tab on the left called Resources."

### Why this mattered more than it sounds

GH-50 deliberately **hid** everyone whose window peak was ≥ 100%. Measured on
live data, that hid **32 of 49 people** — more than half the roster was invisible
on the one screen built for finding people. The fix is not cosmetic: a PM looking
for someone to take a project could not see two-thirds of their options, and had
no way to learn *why* someone was unavailable.

### What changed

- **New left-rail tab `Resources`** (`data-tab="resources"` → `#resourcesView`),
  next to My Projects. The Find-a-person rail **moved** there; My Projects kept
  its project list, team table and the GH-49 progress chart. One shared renderer
  (`renderWbLoad` / `wbLoadCard`) — the rail is not duplicated.
- **`Not available in this window`** is a collapsed `<details>` section listing
  every person who cannot take work, each with the reason: the week they are
  fully booked and the project(s) consuming it
  (`Abhishek Verma — 100% booked — Fully booked Sep-28 — Doxim/Regular`).
  Sorted least-booked first, so the nearly-free are easiest to spot.
- **Window selector** — auto (selected project's own range, else the near-term
  horizon) · next 12 weeks · next 26 weeks · all of 2026 — with the horizon
  always named. A 26-week ask in October reports `the next 14 weeks (to year
  end)` rather than claiming 26.
- Available people keep the freest-first 100 / 75–99 / 50–74 / under-50 buckets.

### The permission decision (worth remembering)

No new permission key. A regular admin's permissions are **stored explicitly**
in `users.permissions`, so adding a fresh key to `ADMIN_PERMISSIONS` would have
hidden the tab from **every existing admin** — a silent regression. The tab is
gated on the `people` / `resources` capabilities they already hold; the API is
`_require_people`. PMs get the tab via an explicit allow (they need the whole
roster to staff a project).

### Verified

24-assertion Node harness (`/opt/data/home/workspace/test-gh51.js`) over the
shipped functions against the live payload, then driven live in a browser:
17 available / 32 unavailable at 12 weeks; the year view shifts to 11 / 38; the
collapsed section opens with reasons.

Commit `5b9541f`, branch `feat/51_resources_tab`, deployed 2026-10-02 18:35 UTC.

### Data note (not from this deploy)

Planned hours read **+40h** across this deploy (63,710.25 vs 63,670.25). Diffed
snapshot-vs-live to locate it exactly rather than assume: it is
**`Akshay Rathi` — Doxim/PHP (resource 190)**, whose `allocation_pct` went
`NULL → 50` and whose weeks 44 / 50 / 51 / 52 moved 12–16h → 20h (the rest of his
weeks were already 20h). That is an **in-app assignment edit made between 18:17
and 18:35**, almost certainly the new assign/partial-allocation path being
exercised — this deploy writes no resource rows, and actual hours (39,620.25) are
unchanged. Resource and hour edits are not written to the activity log, so the
log cannot name the actor; flagged rather than altered.

---

## 2026-10-02 — Find a person: title filter, ranked by real availability (GH-50)

**GH-50**, a feature requested by **saloni (PM)** from the in-app form:

> "The Find a person section should be much more informative, like have dropdown
> based on title and when the user selects a title, it will list the resource
> under that title and it will be listed with 100% available resource first,
> then 75%, then 50% and then 25%. People who are not available can be skipped."

Option **A** chosen by Rijoy (availability over the project's own date range).

### What the rail was, and why that was the wrong question

`#wbLoadFilter` was a name-substring search over `/api/pm/load`, sorted
**busiest-first by peak-of-year booked %**. That ordering answers "who is over
capacity, avoid them" — useful, but not the job a PM is doing on this panel,
which is *staffing*: "who can I pull onto this project". The rail is now a
finder.

### What changed

- **Title dropdown** (`#wbLoadTitle`), fed from the rate-card titles already on
  `/api/pm/load`. No new endpoint, no rate or revenue value fetched or rendered
  — CHARTER clause 1 stays intact.
- **Availability ranking.** `availability = 100 − worst booked% across the
  project's own date range`, so "free in January" cannot pose as "free when the
  work runs". Grouped into **100 / 75–99 / 50–74 / under 50** buckets, most free
  first, with the window named in the header (project range, or "the next 12
  weeks").
- **Unavailable people are skipped** — anyone whose window peak is ≥ 100% is not
  shown, per the request.
- The name search box stays beside the dropdown, so the two filters compose.

### The one design call worth recording

A project with **no dates** cannot use "the project window", and the obvious
fallback — the whole year — is *worse than useless here*. Measured on live data:
a 53-week window leaves only **11 of 49** people "available", because 38 are
booked to ≥100% at some point in the year; a **12-week** near-term horizon shows
**20**. 14 of the 16 projects are legacy imports with no dates, so the fallback
is the 12-week horizon — otherwise the finder collapses to a handful of people
on most projects. The header always says which horizon produced the number.

### Verified

15-assertion Node harness (`/opt/data/home/workspace/test-gh50.js`) running the
**shipped** functions against the live payload: ranking monotonic; nobody ≥100%
listed; shown + skipped == full roster; title filter exact; unknown title → empty
(not a crash); both dated projects (one spanning into 2027) produce a valid
window; money-leak sweep over the payload keys. Then driven live in a browser on
production: dropdown holds the 15 titles, buckets render, `Quadient Developer`
filters to 6 people (all free-first), Print Mail / Quadient shows window
`2026-10-19 → 2027-01-18` with max window-peak 75% (nobody over).

Commit `30da211`, branch `feat/50_find_person`, deployed 2026-10-02 18:17 UTC via
`revenue-safe-upgrade.sh` (data intact: 66 resources / 15 pricing / 5 users /
17 projects, both hour totals unchanged).

---

## 2026-10-02 — Bug form: Next no longer waits on an unrelated control (GH-46)

**GH-46**, reported while using the form: the **Console errors** toggle appeared to
be required to leave step 2, even though it is off by default.

### The console toggle was innocent — `missing` was captured too early

`fbNav()` computed readiness once, when the action bar was drawn, and the Next
handler closed over it:

```js
const missing = step === 2 ? (hasText ? "" : "Add a line in ...") : "";
next.addEventListener("click", () => {
  if (missing) { fbNeed(); return; }   // stale value
  advance();
});
```

Typing cleared the dimming and hid the warning — a *different*, live listener did
that — but left the captured `missing` truthy. So Next still refused and asked for a
line that had already been written. Clicking **Console errors** called `fbRender()`,
which recomputed the flag, and the very next click worked. Hence the illusion.

Readiness is now a **function evaluated at click time** (`missingNow()`). Nothing
depends on the user having *touched* a control: every default in `fbState` is a
valid answer and readiness is derived from state, not from interaction history.

### Related bug in the same code path

Clicking the **already-active** option in `Console errors` or `This is a…`
re-rendered the whole step and **erased both textareas mid-sentence**. Both handlers
now return early when the value has not changed.

### Verified by driving the real form

- Step 2 empty → Next refuses, and says what is missing.
- Type into *"What actually happened?"* only, console left `off` → dimming clears
  and **Next advances to step 3**.
- Clear the text → Next refuses again (correct).
- Full 1 → 2 → 3 with the console toggle never touched: `consoleTouched: "off"`,
  reached step 3, issue body generated correctly, all three suites pass.
- Clicking the active console option preserves typed text.
- Step 1 still requires an area (intentional); step 3 has no gate.

All three test suites pass.

---

## 2026-10-02 — Bug form offers every real control, read off the live screen (GH-44)

**GH-44**, raised by Rijoy from a PM login: *"there are options on the left side
then there are options at the beginning like select week, different buttons etc
and on the left the option to export and import — currently lots of these options
are missing ... if any new button comes in future then that should be listed."*

### Why they were missing

`FB_MODULES` was a **hand-written list** of four "screens" per area — concepts, not
controls — so real buttons were never in it, and because nothing derived it,
**every future button would be missing too**. The fix had to change where the list
comes from, not add four entries to it.

### What it is now

Options are **discovered from the live DOM** (`fbScanControls`): sections carry
`data-view`, controls are found by semantics rather than an inventory, labels
prefer visible text then `aria-label`/title then id then class, and ids are the
stable key so a rename reads as a change.

**54 controls across 11 areas**, including everything he named — Import, Export,
the week selector, This week, Bench, Save week, Columns, Expand/Collapse, Update
All Pricing, Add Person/PM/Admin.

**The test that matters:** injecting a brand-new button into the Planned DOM is
picked up with no code change (`newButtonKey: "#btnFutureThing"`). That is the
requirement — a new button lists itself.

Also added: multi-select (one report often covers several controls), a free-text
"Something else" escape hatch, a *whole screen* option, and a *Not sure / whole
app* area. Picked controls appear in the issue body under `### Control(s)`.

### Three things this took to get right

- **A hidden section measures as zero.** Scanning only the visible tab reported
  Dashboard as 1 control and Logs as 0. Each section is now measured with its
  `hidden` class lifted and positioned off-screen, then restored — off-screen
  `position:absolute`, *not* `visibility:hidden`, which would make the scanner's own
  visibility check reject everything it was hunting for.
- **Import / Export are in the left rail, outside every view section** — scanning
  sections alone could never find them. The rail is its own area now; its nav tabs
  are excluded, since "Planned" as a *control* is meaningless when it is already an
  area chip.
- **A `<select>` reported its concatenated options** ("Last 60 Last 150 Last 400")
  because `textContent` includes every `<option>`. Selects and inputs now use their
  own label.

### A second bug found by testing: the form was unreadable on light themes

Written dark-only. Measured on Paper / Ledger / Sepia:

| element | before | after |
|---|---|---|
| `.fb-notice` (privacy warning) | **1.0:1** — invisible | 4.60:1 |
| `.fb-step.on`, `.fb-chip.on`, `.fb-path b`, `.fb-seg button.on` | 1.2:1 | 4.60:1 |
| `.fb-step.on .n` | 2.5–3.1:1 | 4.60:1 |
| `.fb-step.done .n` | 2.5–2.9:1 | 4.60:1 |
| `.fb-preview` (review pane) | 1.3:1 | 4.60:1 |

`#eafbff` / `#cdd8ea` / `#f6dd9a` / `#05202a` / `#062b1d` became themed tokens, plus
one **new token `--on-green`** (ink on the green fill) which nothing covered —
added to all 15 themes and to `:root` for midnight. `.fb-badge`'s white wash under
muted text (4.23:1 on nord) became a themed surface.

The irony is not lost: the unreadable thing was the form you use to report
unreadable things.

### Verification

- Real `fbScanControls()` against the real shell: 11 areas, 54 controls.
- Future-button injection test passes.
- Real `fbStep1/2/3` rendered and measured for all 15 themes × 3 steps — AA on every
  themed element.
- Theme picker unchanged and still passing; swatch verifier clean.
- All three test suites pass.

### Not done

- Controls that only exist AFTER an interaction (a row's Edit button, a popup's
  Save) are not listed until the row/popup is on screen. The "Something else" field
  and the whole-screen option cover that case; scanning inside every popup was not
  built.
- The scanner reads the DOM, so a control rendered from data the user has not loaded
  yet (an empty project list) will not appear. Same fallbacks apply.

---

## 2026-10-02 — Theme picker becomes a swatch list (GH-42)

**GH-42**, follow-on from GH-41. The picker was a flat `<select>` of 15 names.
A name cannot convey a palette — which was the original complaint — and the list
had just grown from 9 to 15.

Replaced with a **swatch list**: each theme is a row carrying its own page +
accent colours, grouped **Dark (12) / Light (3)**, in a height-capped scrolling
list. A quick swatch in the top strip makes switching one click.

### The bug this surfaced: the menu fell off the bottom of the screen

The account menu grew ~250px. On a narrow screen the rail collapses to a block
**above** the topbar, so the menu's anchor can start well down the page — and the
last items (Change password, Sign out) landed below the fold with no way to reach
them. Measured: with the anchor 200px down, the menu ended **771px below a 437px
viewport**.

`max-height: 100vh` does **not** fix this. The problem is *where the menu starts*,
not how tall it is. The menu is now clamped to the space actually available below
its anchor (`innerHeight - menuTop - 12`) and scrolls when that is too little.

Ordering mattered and cost a cycle: the clamp has to be measured **after** the
`scrollIntoView` that reveals the current theme, because that call scrolls the
page and moves the anchor. Measuring first left the menu overflowing at every low
anchor position. Fixed, then verified at offsets 0 / 200 / 300 / 420 — all
clamped, all with Sign out still reachable.

### Selected-row contrast

The picker sits in `--surface-7`, but a **selected row** is on `--surface-3` —
a different surface, and one the GH-41 hardening pass never targeted because
nothing muted used to sit there. Accent-as-text on `--surface-3` measured
**2.66:1** (`drift`). The selected state therefore marks itself with an **accent
bar** and keeps the label in `--text`, rather than colouring the text with the
accent.

Verified: all 15 themes clear WCAG AA on 41 text elements in the real markup,
measured in a browser with full alpha compositing.

### The swatch map is duplicated data — and it had already drifted

`/api/themes` returns key/label/dark, not colours, so `THEME_SWATCH` in `app.js`
mirrors them. That drifts silently when a theme is retuned, and it **already
had**: sepia's accent moved `#a35a14` → `#915318` during the GH-41 hardening and
the swatch still held the old value. `verify_swatches.py` now diffs the map
against `THEMES` in `main.py` and fails on any mismatch, missing key, or orphan.

### Deliberate choices

- The quick button **delegates to `#btnUser`** rather than re-implementing the
  open. One owner for the list and one for the open/fit logic; they cannot drift
  apart. (The first attempt duplicated the open and would have skipped the clamp.)
- `#themeSel` (the old standalone picker hook) is still hidden, not deleted, so
  nothing that references it breaks.

### Verification

- The **real** `initThemeSwitcher()` and `initUserMenu()` run against the real
  markup extracted from `index.html`, fed the live `/api/themes` payload: 15 rows,
  both groups, 15 swatches painted, correct current row.
- Clicking a row POSTs `{"theme":"<key>"}` — asserted with a spy — and disables
  the rows during the save.
- Served `app.js` cache-buster equals `sha1(app.js)[:10]`; zero stale
  `themeSelMenu` references anywhere.
- All three test suites pass.

### Not done

- Hover preview (painting the app in a theme before committing) was in the
  variant C mock-up but is **not** implemented — choosing still reloads.
- The swatch colours remain a hand-maintained mirror rather than coming from the
  API. A `/api/themes?colors=1` field would remove the duplication; the verifier
  is the guard until then.

---

## 2026-10-02 — Six new themes, and the text that went unreadable (GH-41)

**GH-41**, reported by Rijoy: *"they all look mediocre and then have issues where
I cant read the text when I change the theme."*

### The readability bug was a hardcoded ink on a themed fill

`styles.css` painted a near-black literal onto `var(--accent)` / `var(--amber)` /
`var(--red)`:

```css
.wb-modetab.on { background: var(--accent); color: #04202a; }
```

That is only correct while the accent is bright. On any theme with a dark accent
— every light theme — it failed, and two of those rules (`th.u-month-head-on` /
`u-wk-now`, and `.wb-modetab.on`) had **no light-theme override at all**, so they
were broken in every light theme, not just Paper.

Measured before → after, on the element's real backdrop:

| element | before | after |
|---|---|---|
| `th.u-month-head-on` / `u-wk-now` | 3.95:1 | 4.83:1 |
| `.wb-modetab.on` (Hours / %) | 3.49:1 | 4.83:1 |
| `.wb-wk.booked / .warn / .hot` | 3.35–3.50:1 | 4.58–5.52:1 |

16 literals → three solved tokens (`--on-accent`, `--on-warn`, `--on-hot`), so a
theme added later inherits the fix instead of re-introducing the bug.

### `.cur-chip` / `.cur-tag` were self-referential

Amber text on its **own** amber tint (`rgba(var(--amber-rgb), 0.12)`). Lightening
`--amber` lightens the tint too, so the ratio barely moves — Solarized sat at
3.95:1 however the hue was tuned. Now `--amber-ink`, solved per theme against the
composited backdrop; the hardcoded `#7a4d00` light-theme override is gone.

### The nine pre-existing themes had never been measured properly

The earlier audit compared ink against `--bg` / `--surface-1`, but most label and
metadata text sits on a `.glass` panel — a **translucent wash over the page**, a
different colour from both. Measured correctly:

| theme | token | before | after |
|---|---|---|---|
| paper | `--orange` | 1.91:1 | 4.62:1 |
| solarized | `--accent2` | 2.96:1 | 4.61:1 |
| nord | `--red` | 3.46:1 | 4.61:1 |
| solarized | `--red` | 3.69:1 | 4.62:1 |
| nord | `--accent2` | 3.79:1 | 4.62:1 |
| paper | `--amber` | 3.88:1 | 4.62:1 |
| solarized | `--green` / `--amber` | 4.05 / 4.04:1 | 4.62 / 4.60:1 |
| paper | `--muted` / `--accent` | 4.21 / 4.09:1 | 4.60 / 4.60:1 |
| paper | `--pill-amber-bg` / `--pill-orange-bg` | 4.35 / 4.25:1 | 4.60 / 4.62:1 |

`--accent` needed care: it is used as a **fill** and as **text** (`.card .v.cyan`,
`.ts-on`, `.update-banner a`), which pull opposite ways. It is now solved against
the panel and the ink on top of it re-derived, so both roles clear.

**BelWo and Apple** set `--text` / `--muted` / `--bg` without their `-rgb`
triplets, so every translucent overlay rendered in Midnight's hue. All triplets
are now derived from each theme's own colour, which also stops the drift
re-appearing when a theme is edited.

### Six themes added ALONGSIDE the existing nine (15 total)

Rijoy chose "add them" over "replace". Each is built on a published palette with
a real designer, so none reads as machine-generated:

| key | label | source |
|---|---|---|
| `ember` | Ember Dusk | Gruvbox Material |
| `fog` | Harbor Fog | Catppuccin Mocha |
| `night` | Night Shift | Tokyo Night |
| `drift` | Indigo Drift | Kanagawa |
| `ledger` | Daylight Ledger | Catppuccin Latte |
| `sepia` | Archive Sepia | Gruvbox Light, warmed to sepia |

### A CSS comment is not nestable — and this nearly shipped broken

The first attempt inserted a comment containing `*/`, which **closed the comment
early**; the remaining text became top-level CSS and the parser discarded the
`--on-accent` / `--on-warn` / `--on-hot` declarations along with it. Midnight
then measured **1.52:1** on the accent-filled table headers. Caught by reading
`getComputedStyle().getPropertyValue('--on-accent')` in the browser, which
returned an empty string — the token was not defined at all, despite being
plainly present in the file. A nested-comment scan is now part of the check.

### Verification

- All **15 themes pass WCAG AA 4.5:1 on 26 sampled components**, measured in a
  real browser against the served stylesheet with full alpha compositing — not
  modelled offline. An offline model was ~5 units off on the green/blue channels
  and produced inks that still failed at 4.38:1.
- `midnight` keeps an empty override set on purpose and resolves to `:root` for
  every token; its ink values therefore live in `:root` (it injects nothing inline).
- No regression: the worst case across the nine original themes improved.
- All three suites pass (`scripts/run-tests.sh`).

### Not done

- Divider (`--hairline`), focus rings and scrollbars were **not** audited to 3:1;
  dividers are a deliberate low-contrast aesthetic here and were left alone.
- The theme picker still lists all 15 in one dropdown. Grouping them (dark /
  light) or previewing on hover was not part of this change.

---

## 2026-10-02 — "Why the shortfall?" asked for hours that were not short (GH-40)

Commits `654a8e1`, `6d00a99` — **GH-40**, reported live by Rijoy on the PM
*Weekly entry* tab.

### The reproduction was a lie I had to earn back

The prompt fired for **weeks the PM never opened**, and separately for
**weeks that were exactly on plan**. Two different bugs, same sentence.

**Bug 1 — on target asked for a shortfall reason.** `wkPreFlight`'s
under-delivery block was guarded only by the overage `return true` above it, so
`d === 0` fell straight through into it. The modal literally read
*"Planned 40h, actual 40h (0h under). Why the shortfall? (required)"* —
self-contradicting, and it made an on-plan week unsavable. Fixed with an
explicit `if (d === 0) return true;` before that block, and the same guard in
`actualsPrompt` (app.js) for a flagged week that resolves on target.

**Bug 2 — one unrelated week blocked every save.** A save posts the full
53-week array (the API requires a full-length row) and the server validated
**every** week in it. Any other week already sitting below plan with no recorded
reason therefore blocked the whole sheet and raised the under-delivery prompt
for a week nobody opened. Live data had **5 such weeks** — Bhupesh Nandan
(IMS/Quadient), 32h vs 40h planned in weeks 3, 8, 20, 23, 25 — so *every*
weekly save for him asked about a week from March.

A third, quieter defect sat in the same payload: the unrendered weeks carry the
value the grid *rendered* — the **planned** hours — so the old write path stored
planned hours back as if they were entered actuals. The write is now a merge:
stored values, plus the edited weeks only.

Fix: the client declares `edited: [weeks]`; the server judges only those and
keeps every other week at its stored value. Backward compatible — with no
`edited`, the server applies "weeks whose value actually moved". A week flagged
in a prompt chain is added to `edited` so its verdict is written, while genuine
edits are never dropped on a retry.

`weeksheet.js` also called `wkWeekLabel(WK.week)` and wrote `notes[WK.week]`
instead of the week being asked about (`w`), so the billing question named the
wrong week and filed its note against it.

### Verified on live, not just in tests

`tests/test_actuals_save_scope.py` — 16 checks: save scope, data integrity, and
all five under/over × billed/not-billed money outcomes. Driven through the real
UI against a real account:

- on target (40h vs 40h) → **no modal**, "Week saved — 1 person"
- under (32h) → *Why the shortfall?* → *Will the client still be billed the
  planned hours?* → not billed → optional note
- over (48h) → *Is this OVERTIME?* → *Will this OT be BILLED to the client?*

Every UI test wrote to real rows; each was reverted and the DB re-checked
against the pre-work baseline (`actual_hrs 39540.25`, 65 resources) at each step
via `revenue-safe-upgrade.sh`. No net data change.

> **Deliberate, not a bug:** a week whose stored note already answers the OT
> question (`is_ot` set) is **not** re-asked on re-entry. To be asked again, the
> hours must change — which clears that week's note. This is what made the first
> two OT probes come back silent; it is the recorded verdict being respected.

---

## 2026-10-02 — Archive on admin delete too; the odd buttons fixed (GH-39)

Commit `0bbce39` — **GH-39**. Two things from Rijoy, both about the recoverable
delete shipped in GH-38.

### The Reactivate / Delete buttons looked wrong — three causes, all real

Measured before touching anything:

```
cell: 46px wide, display=flex     ← flex on a <td> kills table-cell layout
"↺ Reactivate"  95px  but 14px tall   colour rgb(26,34,51)  ← DEFAULT text colour
"🗑 Delete"      73px  but 14px tall   opacity 0.35          ← looked disabled
```

**168px of buttons in a 46px cell.** The causes:

1. `#dashTable td.dash-actions { width: 46px }` was written for a single icon;
   two labelled buttons need a real cell.
2. `.dash-arch-actions { display: flex }` on a `<td>` destroys table-cell layout —
   the buttons were laid out as flex children in a 46px box.
3. **Specificity.** The action rules sat *before* the base `.btn` rules in the
   file, and `.btn` also sets `color` / `padding` at the same (0,1,0) specificity
   — so `.dash-reactivate` lost and the buttons rendered in the default text colour
   with Delete's icon style (opacity 0.35) still applying. Every rule is now
   id-scoped (`#dashTable …`), so file order cannot win against it again.

Now: **cell 212px, buttons 26px tall, `inline-flex`, green Reactivate
(`rgb(15,122,74)`, opacity 1) and red Delete (`rgb(255,154,154)`, opacity 1).**
Measured that the archived row demands **no extra table width** (−13px versus a
normal row), so nothing was pushed off-screen.

### An admin delete now archives too

Previously an admin `DELETE` purged immediately. Now `purge=false` **ARCHIVES for
any role**, so an admin's mistake is as recoverable as a PM's: the project leaves
every live figure and appears on the Dashboard under the red
`DELETED BY <admin>` strip with Reactivate / Delete. Only Delete on an
already-archived row purges (`purge=true`) — the deliberate second step.

Because archiving destroys nothing, the first click **no longer warns about losing
hours**; that warning now belongs to the purge, where it is actually true.

| Verified in the browser as admin | Result |
|---|---|
| 🗑 on a live row | `archived=true`, badge `deleted by rijoy`, Reactivate + Delete offered |
| Toast | "…deleted — it is on the Dashboard in red until you Reactivate or Delete it for good" |
| Reactivate | row un-flagged, `archived:false`, PM sees it again |
| Delete on the archived row | purged; `include_archived=1` empty |
| API plain DELETE | returns `archived: True` (was `purged: True`), `archived_by` = the admin |
| DB | 17 projects, 0 archived rows, **0 orphaned resources**, integrity `ok` |

---

## 2026-10-02 — PM project delete is recoverable: red strip, Reactivate or Delete (GH-38)

Commit `4d7addf` — **GH-38**. Rijoy: _"if PM delete the project, then it will go
away from the PMs view, it should still be there for admin with a red strip on it
so that if PM delete by accident the admin can revert … reactivate will show it
back for the PM and delete will delete it from the app permanently."_

**A PM delete is now an ARCHIVE, not a removal.** Nothing is destroyed — the row,
its team, its planned hours and its actuals all stay. The project leaves:

- the PM's workbench and `/api/projects`
- the Dashboard's rows **and its totals**
- Utilization, the PM load rail, the Planned grid, exports

…while the admin keeps it under a **red strip** reading `DELETED BY <pm>` with
exactly two actions: **↺ Reactivate** and **🗑 Delete**. An **admin** delete stays
permanent, so the two acts are distinct: PM = recoverable, admin = final.

Schema: `projects` gains `archived_at` / `archived_by` / `archived_note` through
the existing idempotent migration. Existing rows untouched (0 archived after).

The hide rule lives in **`_all_resources()`**, which every live read path already
shares — so a future reader inherits it instead of forgetting it, rather than
patching each call site.

### Two bugs found by testing, not by review

1. **The buttons were dead.** `bindDashDelete()` / `bindDashReactivate()` were
   called near the *top* of `renderDashboard`, **before** the table's
   `innerHTML` was assigned. `querySelectorAll` therefore matched nothing and no
   handler was ever attached — the API was correct but clicking did nothing.
   Caught by clicking one and seeing `dataset.bound` was `undefined`. Both now
   bind after the rows exist.
2. **The archived project rendered twice** — a plain "no team" row *plus* the
   flagged one, because `_empty_project_groups()` treats a project with no live
   resource rows as empty. It now skips archived keys, so exactly one row shows.

| Check (throwaway PMs, created and removed) | Result |
|---|---|
| PM archives | 200, `archived: True`; DB row still present with its stamp |
| PM's workbench + `/api/projects` | project gone |
| Admin Dashboard | exactly **one** row, red strip, `deleted by zz_vis`, $0.00, excluded from TOTAL |
| **Reactivate clicked in the browser** | row un-flagged, toast confirms, API `archived: false`, PM sees it again |
| **Delete clicked on the archived row** | permanently removed; `include_archived=1` returns nothing |
| PM calls reactivate | **403** — only an admin can undo |
| Money | untouched by my operations (2,743,311.02 before and after) |
| DB | 17 projects, **0 orphaned resources**, integrity `ok` |

**Concurrent-writer note:** the tree was being edited throughout by another agent
(Rijoy's column-sorting request, `e2b0d5f`), which also swept up my UI files into
its own commit. I verified my work was nonetheless fully present at HEAD, that the
live tree matched HEAD byte-for-byte, and that **0 of 11** remaining DB diffs were
mine — all 11 were one edit on `resource 215` (Bhupesh Nandan, IMS/Quadient: ten
weeks 32h→40h and a new week 52), which I deliberately did **not** revert.

---

## 2026-10-01 — Delete projects from the Dashboard; PMs create/delete their own (GH-37)

Commit `814387b` — **GH-37**. Rijoy asked for two things: a delete option on the
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
Doxim · Support still has 5 person(s) assigned (Sunil Antharvedi, Aryan Thakur,
Harsh Kumar Gautam, Tanya Bhardwaj, Bajrang Lal) with 236 planned week(s) and
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
| Money | **unchanged** at $2,738,187.02 / $1,172,786.05 |

**Two bugs in my own work, caught by testing rather than review:** the shared SQL
predicate was built with a `res` alias and then reused in a statement where
`resources` is unaliased, so every delete raised `no such column: res.client` and
returned a bare 500; and the PM's test login appeared to fail only because
`/api/me` returned `None` for a login that had not actually succeeded.

---

## 2026-10-01 — Add Project takes PM + allocation; uploads enforce capacity (GH-34, GH-35)

Commits `99289ed` (**GH-34**) and `b080998` (**GH-35**).

### GH-34 — Add Project must ask for the PM and the allocation

Rijoy: _"While adding project, it asked the name and other details but it should
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
100% would push Abhishek Verma over 100% in 52 week(s).
First clash: Jan-02 would reach 200.0%.
```

The submission is rolled back on refusal, so a project is never half-created, and
the conflict list is returned so the dialog renders it **inline** under the
allocation field — the weeks ARE the explanation.

### GH-35 — the bulk Excel upload now enforces the capacity rule

Rijoy: _"if in the upload a resource is utilized for more than 100 hours in total
then the upload should fail giving the reason for the fails."_

`_validate_import_capacity()` runs **before any write**, on a simulation of the
resulting state, so a rejected file leaves the database exactly as it was. It
groups by person **name** — the key `compute_utilization` and the 100% rule use —
because a spreadsheet has no person ids and a person legitimately holds one row
per project.

**The rule is "the upload must not introduce or worsen an over-capacity week",
NOT "nobody may ever exceed capacity".** That distinction is load-bearing: the
live book already has **103 person-weeks over capacity** (Deepak Kumar at 130%
and 160%), because the app deliberately never retro-breaks existing bookings. A
blanket rule refused **every** upload — including a round-trip of the untouched
export — which testing on real data caught and review did not.

Real output for a 100h week against a 40h capacity:

```
Import rejected — 1 week(s) exceed a person's weekly capacity. Nothing was saved.
Sunil Antharvedi @ Jan-02: planned 100.0h exceeds the 40h weekly capacity
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

Rijoy: _"In the dashboard I added a project and it didn't get added"_ and _"The
Bench project and all project that we add should be there in dashboard."_

The Dashboard is built from **resource** rows, so a project with nobody assigned
to it totals to nothing and produced **no row at all**. Measured: the `projects`
table held **16** rows, the Dashboard showed **14**. Missing were
`Internal / Bench` and `Print Mail / Quadient` — the project just added — both
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
rows badge correctly, Planned Revenue still **$2,738,187.02** with 64 resources.

### GH-33 — popup fields collided; Active/Inactive moved to the first column

Rijoy: _"when i click on edit/ merge a popup window opens they all details in the
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

Rijoy: _"when i click on project it list the project but i cannot scroll down
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

Rijoy: _"where is the logs? ... there should be an option on the left panel to
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

**Availability** was narrowed in the same pass at Rijoy's request: the panel now
lists **available + over-allocated** and hides only the people at *exactly* 100%
— 20 available + 3 over = 23 of 48, with the hidden count stated. Over-allocated
rows are tinted and badge-counted on the button.

---

Commit `a6bee72` — **GH-29**. Rijoy asked for three things on the Utilization
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
| `Doxim · Indy` | 2 | 1,280.0h | hours scoped to that project |
| `Doxim` (client) | 18 | 26,914.3h | only 1 person still spans >1 project |
| `testPM` | 16 | 25,227.3h | owner-based |
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

Rijoy's instruction: _"if there is anything we are fixing and it's already a bug
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
