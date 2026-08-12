#!/bin/bash
# One-command setup for the Revenue Tracker (run, don't rebuild — see AGENTS.md)
set -e
cd "$(dirname "$0")/.."

echo "→ Setting up Revenue Tracker (Python 3.10+ required)"
if ! python3 -c 'import sys; assert sys.version_info >= (3,10)' 2>/dev/null; then
  echo "ERROR: Python 3.10+ required."; exit 1
fi

if [ ! -d .venv ]; then
  echo "→ Creating virtualenv"
  python3 -m venv .venv
fi
source .venv/bin/activate
echo "→ Installing dependencies (fastapi, uvicorn, openpyxl)"
pip install -q fastapi uvicorn openpyxl

if [ ! -f .password ]; then
  read -s -p "→ Create the app password (login user is 'rijoy'): " PW; echo
  if [ -z "$PW" ]; then echo "Password cannot be empty."; exit 1; fi
  umask 077
  printf '%s' "$PW" > .password
  echo "→ .password created (chmod 600)"
else
  echo "→ .password already exists"
fi

echo ""
echo "Done. Start the app with:"
echo "  source .venv/bin/activate && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802"
echo "Then open http://127.0.0.1:8802 (user: rijoy)."
