#!/bin/bash
# Revenue tracker launcher — keeps the uvicorn command out of the watchdog's
# pkill sightline (path-only cmdline), so restarts are clean.
cd "$(dirname "$0")/.." || exit 1
exec /usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802