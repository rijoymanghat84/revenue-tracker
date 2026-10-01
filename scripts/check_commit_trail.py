#!/usr/bin/env python3
"""Enforce the commit-trail rule (see CONTRIBUTING.md).

Every commit that changes behaviour must cite its issue as (GH-N) — or say
plainly why it doesn't ("no issue: <reason>"). This makes the trail a gate
rather than a good intention: Rijoy's instruction on 2026-10-01 was that future
fixes to already-delivered work must be traceable in git.

Docs-only / test-only / chore commits are exempt.

Usage:
    python3 scripts/check_commit_trail.py            # check commits not yet on origin/main
    python3 scripts/check_commit_trail.py <rev>       # e.g. HEAD~3..HEAD or a single sha
    python3 scripts/check_commit_trail.py --all       # walk main since 2026-10-01

Exit 0 = trail intact, 1 = offending commits listed.
"""
import re
import subprocess
import sys

ISSUE_RE = re.compile(r"\(GH-\d+\)|GH-\d+", re.I)
# An explicit opt-out with a reason. Both halves required — a bare "no issue"
# or an empty marker does NOT count.
NO_ISSUE_RE = re.compile(r"no issue\s*[:\-]\s*\S+", re.I)
# Paths that don't need a trail entry: nothing user-facing changes.
EXEMPT_PREFIXES = ("docs/",)
EXEMPT_FILES = {
    "README.md", "README1.md", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md",
    ".gitignore",
}
EXEMPT_EXT = (".md",)

# Commits at or before this one predate the rule (added 2026-10-01) and are
# already mapped to issues in CHANGELOG.md, so rewriting their subjects would
# mean rewriting published history. They are grandfathered: `--all` audits
# everything AFTER this point, which is what makes it a real regression check.
BASELINE = "e27695a"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True,
                          cwd="/opt/data/revenue-tracker").stdout.strip()


def is_exempt(files):
    """True when every changed file is docs/tests only (no behaviour change)."""
    if not files:
        return False
    for f in files:
        if f.startswith(EXEMPT_PREFIXES) or f in EXEMPT_FILES:
            continue
        if f.startswith("tests/") or f.endswith(EXEMPT_EXT):
            continue
        return False
    return True


def check(rev_range=None, walk_all=False):
    if walk_all:
        revs = git("log", f"{BASELINE}..main", "--format=%H").split()
    elif rev_range:
        if ".." in rev_range:
            revs = git("log", "--format=%H", rev_range).split()
        else:
            # A single ref or sha means THAT commit only. Without this, passing
            # e.g. "HEAD" fell through to `git log HEAD`, which walks the ENTIRE
            # history and reported 76 commits instead of one.
            sha = git("rev-parse", "--verify", f"{rev_range}^{{commit}}")
            revs = [sha] if sha else []
    else:
        revs = git("log", "--format=%H", "origin/main..HEAD").split()

    if not revs:
        print("No commits in range — nothing to check.")
        return 0

    bad = []
    ok = 0
    for sha in revs:
        subject = git("log", "-1", "--format=%s", sha)
        body = git("log", "-1", "--format=%b", sha)
        files = [f for f in git("show", "--name-only", "--format=", sha).split("\n") if f]
        blob = subject + "\n" + body
        if ISSUE_RE.search(blob) or NO_ISSUE_RE.search(blob):
            ok += 1
            continue
        if is_exempt(files):
            ok += 1
            continue
        bad.append((sha[:8], subject, files[:4]))

    print(f"checked {len(revs)} commit(s): {ok} with a trail, {len(bad)} without")
    if bad:
        print("\nMISSING A TRAIL — add (GH-N) to the subject, or 'no issue: <reason>' to the body:")
        for sha, subj, files in bad:
            print(f"  {sha}  {subj[:68]}")
            print(f"            touched: {', '.join(files)}")
        print("\nSee CONTRIBUTING.md. Never close Rijoy's issues for him; cite "
              "existing issues as GH-N (the code's 'Feature #N' labels are NOT issues).")
        return 1
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    if "--all" in args:
        sys.exit(check(walk_all=True))
    sys.exit(check(args[0] if args else None))
