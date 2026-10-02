#!/usr/bin/env bash
# Run every test suite in one command.
#
# Why this exists: .github/workflows/tests.yml cannot be pushed until the PAT
# carries the `workflow` scope (it currently has repo, write:discussion,
# write:packages — pushing a workflow file is refused, and the Contents API
# answers 404 for that path on purpose). Until the scope is granted, CI cannot
# run at all, so this is the runnable entry point.
#
# Each suite monkeypatches app.main.DB_PATH / DATA_DIR into a temp dir, so none
# of them touch the live database. Safe to run any time.
#
# Usage:  bash scripts/run-tests.sh
# Exits non-zero if any suite fails.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
PY="${PYTHON:-/usr/bin/python3}"

# tests/test_admin_mgmt.py needs python-multipart for Starlette's TestClient
# form parsing unless it is already installed.
if ! "$PY" -c "import multipart" 2>/dev/null; then
  echo "note: python-multipart not importable — login POSTs may fail."
  echo "      install with: $PY -m pip install --user python-multipart"
  echo
fi

SUITES=(
  tests/test_admin_mgmt.py
  tests/test_issue4_pm_admin_separation.py
  tests/test_actuals_save_scope.py
  tests/test_gh54_panel.py
  tests/test_allocation_requests.py
)

fail=0
for t in "${SUITES[@]}"; do
  printf '\n\033[1m═══ %s\033[0m\n' "$t"
  if [ ! -f "$t" ]; then echo "MISSING: $t"; fail=1; continue; fi
  if "$PY" "$t"; then
    printf '\033[32mPASS\033[0m  %s\n' "$t"
  else
    printf '\033[31mFAIL\033[0m  %s\n' "$t"
    fail=1
  fi
done

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32mALL SUITES PASSED\033[0m (%d)\n' "${#SUITES[@]}"
else
  printf '\033[31mSOME SUITES FAILED\033[0m\n'
fi
exit "$fail"
