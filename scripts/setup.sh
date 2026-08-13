#!/bin/bash
# One-command setup for Revenue Recon (run, don't rebuild — see AGENTS.md)
set -e
cd "$(dirname "$0")/.."

echo "→ Setting up Revenue Recon (Python 3.10+ required)"
if ! python3 -c 'import sys; assert sys.version_info >= (3,10)' 2>/dev/null; then
  echo "ERROR: Python 3.10+ required."; exit 1
fi

if [ ! -d .venv ]; then
  echo "→ Creating virtualenv"
  python3 -m venv .venv
fi
source .venv/bin/activate
echo "→ Installing dependencies (fastapi, uvicorn, openpyxl, sqlcipher3)"
pip install -q fastapi uvicorn openpyxl
# sqlcipher3 = real SQLCipher encryption for the finance DB. Prebuilt wheel for
# cp313 manylinux; falls back to source build (needs libsqlcipher-dev) if absent.
pip install -q sqlcipher3 2>/dev/null || pip install -q --break-system-packages sqlcipher3 2>/dev/null || \
  echo "WARNING: sqlcipher3 not installed — DB will NOT be encrypted. Install libsqlcipher-dev + retry."

if [ ! -f .password ]; then
  read -s -p "→ Create the app password (login user is 'rijoy'): " PW; echo
  if [ -z "$PW" ]; then echo "Password cannot be empty."; exit 1; fi
  umask 077
  printf '%s' "$PW" > .password
  echo "→ .password created (chmod 600)"
else
  echo "→ .password already exists"
fi

# DB encryption password (finance data). Stored in data/.dbkey (gitignored).
if [ ! -f data/.dbkey ]; then
  read -s -p "→ Create the DATABASE encryption password (min 6 chars, protects finance data at rest): " DBPW; echo
  if [ -z "$DBPW" ] || [ ${#DBPW} -lt 6 ]; then echo "DB password must be at least 6 characters."; exit 1; fi
  umask 077
  mkdir -p data
  printf '%s' "$DBPW" > data/.dbkey
  echo "→ data/.dbkey created (chmod 600)"
else
  echo "→ data/.dbkey already exists"
fi

echo ""
echo "Done. Start the app with:"
echo "  source .venv/bin/activate && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802"
echo "Then open http://127.0.0.1:8802 (user: rijoy)."
echo "The database is encrypted with SQLCipher using the password in data/.dbkey."
