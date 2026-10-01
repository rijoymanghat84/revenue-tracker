# Contributing to Revenue Recon — the trail rules

the owner's standing instruction (2026-10-01):

> _"going forward we will make sure that if there is anything we are fixing and
> it's already a bug or a fix or feature to an already done thing, will be
> accordingly make the changes in git also, so that the tracking is there."_

Translation into rules. These are not optional.

---

## 1. Every behaviour change carries an issue reference

Commit subjects end with the issue: **`… (GH-14)`**.

| Situation | What to do |
|---|---|
| It fixes something **already delivered** | Reference **the original issue**, not a new one. Say in the body that it is a regression/fix. |
| It **changes or contradicts** an earlier decision | Reference the original issue **and** state plainly what it reverses and why. Add a `CHANGELOG.md` entry. |
| It **completes** an open issue | Reference that issue; add a comment with the evidence. |
| It is genuinely **new** work | Create an issue first (or in the same session), then reference it. |
| There is **no issue and no time** | Say so explicitly in the commit body — *"no issue: <reason>"*. A stated gap is still a trail; a silent one is not. |

## 2. Cite GitHub issues as `GH-N`, never `#N`

The code contains internal design labels written as `Feature #12`. Those are
**not** GitHub issues — and the two numbering systems now collide (GitHub has
reached #23). `#12` alone is ambiguous; `GH-12` is not. The full mapping is at
the top of `CHANGELOG.md`.

## 3. Never close the owner's issues for him

He closes his own. Comment the evidence and leave the state. If one is closed
mid-flight, **flag it** — a close is not a cancellation, so don't silently drop
the work.

## 4. Verify against the code before claiming something is delivered

Read the source, don't trust a commit title. GH-7 was nearly closed as done
because the Dashboard gained a PM *filter* — the issue asks for a PM *column*,
and no `pm` column exists anywhere. Check the actual behaviour.

## 5. Never reverse something silently

If a change undoes, contradicts, or narrows earlier work, name the earlier entry
and the reason. Silent reversals are the specific failure this whole trail
exists to prevent. Real example: the **Pricing tab was split** into Rate Card /
Team & Access / Utilization — anyone who later "restores the Pricing tab" is
undoing a deliberate decision, and the trail must make that obvious.

## 6. Update `CHANGELOG.md` for anything beyond a typo

Per area, newest first, with the issue and the reasoning — not just the
headline. Include what was **not** done, so nobody assumes it was.

---

## Before you commit, check

```bash
# 1. does every behaviour-change commit cite an issue?
git log --oneline -20 | grep -vE "\(GH-[0-9]+\)|no issue:"

# 2. is there uncommitted work from another writer in the tree?
#    (a second agent edits this repo live — NEVER `git add .`)
git status --short

# 3. syntax
python3 -m py_compile app/main.py && node --check app/static/app.js

# 4. does the money still reconcile?
#    (see the query in the revenue-tracker skill; totals must not drift)
```

## Two traps specific to this repo

- **A second agent edits the live tree concurrently.** Check `git diff` and file
  mtimes before committing, and stage files by name — never `git add .`.
- **The GitHub PAT has no `workflow` scope.** A push touching
  `.github/workflows/*` is rejected **atomically**, taking your unrelated
  commits down with it. Commit and push those files separately, and flag the
  workflow file as pending.
