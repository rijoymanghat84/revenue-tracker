# CHARTER.md — what this app is for

**Status:** v0.1 draft, approved 2026-10-02. Grows as issues come in — amend rather than rewrite.
**Used by:** the Git triage board. Every issue verdict is measured against this file, and a
verdict may cite a numbered clause below.

---

## What it is

Revenue Recon — the web replacement for `Revenue_2026.xlsm`. Resources × 53 weeks, with
billing (On-Site) and expense (Off-Shore) rates, a planned-vs-actual reconciliation layer,
and role-based access for PMs.

- **Admin** — permission-gated per tab, can see rates
- **PM** — Workbench + Actuals only, scoped to their own projects
- 40 hrs/week = 100% capacity
- FastAPI + SQLite + vanilla JS, dark frost-glass theme, PWA

## The one job

**One reconciled source of truth for what was planned versus what was actually billed.**

Everything else — the grid, the rate library, the capacity report, the permissions — exists to
serve that number being right and being trusted.

## Must never

1. **Show rates to a PM.** The spec is explicit: PMs are scoped to their projects and *never
   see rates*. Any change that widens what a PM can read is a conflict.
2. **Let a number reach a client without reconciliation.** The actual-vs-planned step is the
   control, not a formality. Removing or weakening it is a conflict.
3. **Silently drop or alter a week of entry.** Data loss must be loud and reversible.
4. **Break the 53-week grid**, or the capacity definition (40 hrs/week = 100%).
5. **Let an Excel import bypass the capacity or permission rules.** A bulk path must enforce
   exactly what the UI enforces, or the rules aren't real.

## How to read a conflict

A 🔴 verdict here does not mean "refuse". It means: *this collides with clause N, so the
owner must decide.* The usual good answer is to reduce the friction without removing the
control — not to delete the control.

## Change history

- 2026-10-02 — v0.1 drafted from `AGENTS.md` + `README.md`, approved by the owner.
