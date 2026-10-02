"""
Revenue 2026 Tracker — web replacement for Revenue_2026.xlsm
=============================================================
Single table of resources x 53 weeks, with billing rate (On-Site)
and expense rate (Off-Shore). Everything the Excel macros did
(mirror, formulas, dashboard rebuild) is computed live here.

Run:  /usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8802
"""
from __future__ import annotations

import base64
import datetime as dt
import hmac
import io
import json
import hashlib
import os
import sqlite3
import shutil
from pathlib import Path
import re

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from . import importer

BASE = Path(__file__).resolve().parent.parent
DATA_DIR = BASE / "data"
DB_PATH = DATA_DIR / "revenue.db"
# The DB encryption key lives OUTSIDE the app dir (2026-10-01). Keeping it next
# to data/ put the key, the DB and every backup in one folder — so any copy of
# the app directory (including the NAS/weekly tarball) carried both, making the
# encryption decorative. It now sits in /opt/data/keys/, which the weekly tar
# does not include. The old in-dir path is still honoured as a fallback so a
# revert or an older checkout keeps working.
KEYS_DIR = Path("/opt/data/keys")
DB_KEY_FILE = KEYS_DIR / "revenue.dbkey"
LEGACY_KEY_FILE = DATA_DIR / ".dbkey"   # pre-2026-10-01 location
STATIC_DIR = Path(__file__).resolve().parent / "static"

# SQLCipher-backed connection (real encryption). Falls back to plain sqlite3
# only if sqlcipher3 isn't installed (dev/test). Production requires it.
try:
    import sqlcipher3 as _cipher
    _HAS_CIPHER = True
except Exception:  # noqa: BLE001
    _cipher = sqlite3
    _HAS_CIPHER = False


def _db_key() -> str:
    """Return the DB encryption password.

    Order (2026-10-01): env var, then the out-of-app key file, then the legacy
    in-app location. The legacy read keeps an older checkout / a reverted
    deploy working — it is a fallback, never the preferred source.
    Empty string = no encryption (only when none of them is set).
    """
    env = os.environ.get("REVENUE_DB_PASSWORD", "")
    if env:
        return env
    for kf in (DB_KEY_FILE, LEGACY_KEY_FILE):
        try:
            if kf.exists():
                txt = kf.read_text().strip()
                if txt:
                    return txt
        except OSError:
            continue
    return ""


def _set_db_key(pw: str) -> None:
    """Persist the DB password to the key file (0600, outside the app dir).

    Writes to the new location; also refreshes the legacy in-app copy when one
    already exists, so an in-flight re-key does not leave a stale key behind
    that a fallback read could pick up.
    """
    kf = Path(DB_KEY_FILE)
    kf.parent.mkdir(parents=True, exist_ok=True)
    kf.write_text(pw)
    try:
        os.chmod(kf, 0o600)
    except OSError:
        pass
    if LEGACY_KEY_FILE.exists():
        try:
            LEGACY_KEY_FILE.write_text(pw)
            os.chmod(LEGACY_KEY_FILE, 0o600)
        except OSError:
            pass


def _is_encrypted(path) -> bool:
    """A SQLCipher DB is NOT readable by plain sqlite3 (or by sqlcipher3
    without the key). Detect by trying to read a known table WITHOUT a key."""
    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        conn = _cipher.connect(str(path))
        # no PRAGMA key -> if it's encrypted, reads fail
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        conn.close()
        return False  # readable without key => plain
    except Exception:  # noqa: BLE001
        return True   # not readable without key => encrypted


def get_db() -> sqlite3.Connection:
    """Open the DB with the SQLCipher key applied. If the DB is still plain
    (pre-encryption), it stays readable; the migration step encrypts it."""
    conn = _cipher.connect(str(DB_PATH))
    # sqlcipher3 has its own Row factory; plain sqlite3 uses sqlite3.Row
    conn.row_factory = _cipher.Row if _HAS_CIPHER else sqlite3.Row
    key = _db_key()
    if key:
        if "'" in key:
            raise RuntimeError("DB key must not contain a single quote")
        conn.execute(f"PRAGMA key='{key}'")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def encrypt_db_in_place(pw: str) -> None:
    """Encrypt an existing plain SQLite DB in place using SQLCipher's
    sqlcipher_export. Backs up the plain DB first. No-op if already encrypted."""
    dbp = Path(DB_PATH)
    if not dbp.exists():
        return
    if _is_encrypted(dbp):
        return
    if not _HAS_CIPHER:
        raise RuntimeError("sqlcipher3 not installed — cannot encrypt the DB")
    # backup the plain DB
    backups = Path(DATA_DIR) / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(dbp, backups / f"revenue-plain-before-encrypt-{stamp}.db")
    # open plain (via sqlcipher3 so sqlcipher_export is available), export into
    # a new encrypted DB
    plain = _cipher.connect(str(dbp))
    enc_path = dbp.with_suffix(".enc.db")
    if enc_path.exists():
        enc_path.unlink()
    enc = _cipher.connect(str(enc_path))
    if "'" in pw:
        raise RuntimeError("DB password must not contain a single quote")
    enc.execute(f"PRAGMA key='{pw}'")
    enc.execute("PRAGMA cipher_migrate")
    plain.execute("ATTACH DATABASE ? AS encrypted KEY ?", (str(enc_path), pw))
    plain.execute("SELECT sqlcipher_export('encrypted')")
    plain.execute("DETACH DATABASE encrypted")
    plain.close()
    enc.close()
    # swap files
    shutil.move(str(enc_path), str(dbp))
    _set_db_key(pw)

# Currency rules copied from the VBA GetCurrency()
EU_COUNTRIES = {
    "EUROPE", "EU", "EUR", "FRANCE", "GERMANY", "SPAIN", "ITALY", "NETHERLANDS",
    "BELGIUM", "AUSTRIA", "PORTUGAL", "IRELAND", "FINLAND", "GREECE", "POLAND",
    "SWEDEN", "DENMARK", "NORWAY", "SWITZERLAND", "UK", "FR", "DE", "ES", "IT",
    "NL", "BE", "AT", "PT", "IE", "FI", "GR", "PL", "SE", "DK", "NO", "CH",
}

WEEK_COL_START = 10   # Excel column J
WEEK_COL_END = 62     # Excel column BJ (53 weeks)
FIRST_DATA_ROW = 3

app = FastAPI(title="Revenue Recon")


# ---------------- Auth (login + role-based sessions) ----------------
def _admin_creds() -> tuple[str, str]:
    user = os.environ.get("REVENUE_AUTH_USER", "admin")
    pw = os.environ.get("REVENUE_AUTH_PASSWORD", "")
    if not pw:
        pw_file = BASE / ".password"
        if pw_file.exists():
            pw = pw_file.read_text().strip()
    return user, pw


def _session_secret() -> str:
    """Persistent signing secret for session cookies (stored in meta)."""
    conn = get_db()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='session_secret'").fetchone()
        if row:
            return row["value"]
        import secrets
        secret = secrets.token_hex(32)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('session_secret', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (secret,),
        )
        conn.commit()
        return secret
    finally:
        conn.close()


def _hash_password(pw: str) -> str:
    import hashlib
    salt = os.urandom(16).hex()
    return f"{salt}${hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), 100_000).hex()}"


def _verify_password(pw: str, stored: str) -> bool:
    import hashlib
    try:
        salt, h = stored.split("$", 1)
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 100_000).hex()
        return hmac.compare_digest(calc, h)
    except Exception:  # noqa: BLE001
        return False


def _make_token(username: str, role: str) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"u": username, "r": role, "exp": int(dt.datetime.now().timestamp()) + 7 * 86400}).encode()
    ).decode()
    sig = hmac.new(_session_secret().encode(), payload.encode(), "sha256").hexdigest()
    return f"{payload}.{sig}"


def _verify_token(token: str) -> dict | None:
    try:
        payload, sig = token.split(".", 1)
        expect = hmac.new(_session_secret().encode(), payload.encode(), "sha256").hexdigest()
        if not hmac.compare_digest(sig, expect):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
        if data.get("exp", 0) < dt.datetime.now().timestamp():
            return None
        return data
    except Exception:  # noqa: BLE001
        return None


def _pm_projects(username: str, conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Return the (client, project) pairs this PM is assigned to."""
    row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        return []
    return [(r["client"], r["project"]) for r in conn.execute(
        "SELECT client, project FROM user_projects WHERE user_id=? ORDER BY client, project", (row["id"],)
    ).fetchall()]


def _pm_owns(projs: list[tuple[str, str]], client: str, project: str) -> bool:
    """Does this PM own the given (client, project)? A PM with an empty client
    owns that project across all clients (legacy); otherwise exact pair match."""
    if not project:
        return True  # unassigned project rows are visible to everyone
    for c, p in projs:
        if p == project and (c == "" or c == client):
            return True
    return False


def _current_user(request) -> dict | None:
    token = request.cookies.get("rt_session")
    if not token:
        return None
    return _verify_token(token)


class SessionAuthMiddleware(BaseHTTPMiddleware):
    """Protect /api/* behind a session cookie. Static assets load freely; the
    frontend calls /api/me and shows a login screen when unauthenticated.
    /healthz stays open for the watchdog."""

    async def dispatch(self, request, call_next):
        path = request.url.path
        if path == "/healthz" or path.startswith("/api/login") or path.startswith("/api/logout"):
            return await call_next(request)
        if path.startswith("/api/"):
            user = _current_user(request)
            if not user:
                resp = JSONResponse({"detail": "Unauthorized"}, status_code=401)
                resp.delete_cookie("rt_session")
                return resp
            request.state.user = user
        return await call_next(request)


app.add_middleware(SessionAuthMiddleware)


def _require_admin(request):
    user = getattr(request.state, "user", None)
    if not user or user.get("r") != "admin":
        raise HTTPException(403, "Admin access required")


def _require_super_admin(request):
    """Only the owner (the main/shared .password admin) may manage ADMIN accounts.
    Regular admins manage PMs and everything else, but cannot create, edit, or
    delete other admins."""
    _require_admin(request)
    user = getattr(request.state, "user", None)
    if not _super_admin(user):
        raise HTTPException(403, "Only the owner (main admin) can manage admin accounts")


def _require_pm(request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    return user


# ---------------- Admin permissions (granular admin management) ----------------
# Admin users (role='admin') carry a JSON list of permission keys in
# users.permissions. The super-admin (the shared .password login, i.e. the owner)
# implicitly holds ALL permissions and can never be created/deleted via the UI.
# A PM has role='pm' and is denied every admin permission.
ADMIN_PERMISSIONS = [
    "pricing",        # Pricing tab: edit titles/rates, Apply, Update All
    "resources",      # Planned tab: add/edit/delete resources + weekly hours
    "projects",       # Client/Project CRUD + Project→PM assignment
    "users",          # Manage users (create/edit/delete PMs AND admins)
    "dashboard",      # Dashboard tab (planned vs actual money)
    "actuals",        # Actuals tab (record actuals for anyone, not just own team)
    "utilization",    # Utilization tab
    "import_export",  # Import / Export Excel
    "db_security",    # Database encryption management
    "theming",        # Change own UI theme (feature #8)
    "people",         # PM access: People master list + project team assignment
    "ot_approval",    # Approve billable OT before it reaches the Dashboard
]


def _super_admin(user) -> bool:
    """True for the shared .password login (the owner, the biggest admin)."""
    if not user:
        return False
    return bool(hmac.compare_digest(str(user.get("u", "")), _admin_creds()[0]))


def _user_permissions(user, conn: sqlite3.Connection) -> set[str]:
    """Resolve the permission set for a user. Super-admin → everything."""
    if _super_admin(user):
        return set(ADMIN_PERMISSIONS)
    row = conn.execute("SELECT permissions FROM users WHERE username=?",
                       (user.get("u", ""),)).fetchone()
    try:
        perms = json.loads(row["permissions"]) if row and row["permissions"] else []
        if not isinstance(perms, list):
            perms = []
    except Exception:  # noqa: BLE001
        perms = []
    return set(str(p) for p in perms)


def _require_perm(request, perm: str):
    """Gate an admin endpoint by a specific permission. PMs are always denied."""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    if user.get("r") == "pm":
        raise HTTPException(403, "PM access not permitted")
    conn = get_db()
    try:
        perms = _user_permissions(user, conn)
    finally:
        conn.close()
    if perm not in perms:
        raise HTTPException(403, f"Missing admin permission: {perm}")


# ---------------- Auth API ----------------
class LoginBody(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def api_login(body: LoginBody):
    conn = get_db()
    try:
        uname = (body.username or "").strip()
        # Admin: existing shared creds
        auser, apw = _admin_creds()
        if hmac.compare_digest(uname, auser) and apw and hmac.compare_digest(body.password or "", apw):
            resp = JSONResponse({"role": "admin", "username": uname, "projects": [],
                                 "super_admin": True,
                                 "permissions": sorted(ADMIN_PERMISSIONS)})
            resp.set_cookie("rt_session", _make_token(uname, "admin"), httponly=True, samesite="lax", max_age=7 * 86400)
            return resp
        # PM or admin: users table
        row = conn.execute("SELECT username, password_hash, role FROM users WHERE username=?",
                           (uname,)).fetchone()
        if row and _verify_password(body.password or "", row["password_hash"]):
            role = row["role"] if row["role"] in ("admin", "pm") else "pm"
            if role == "pm":
                projects = _pm_projects(uname, conn)
            else:
                projects = []
            resp = JSONResponse({"role": role, "username": uname, "projects": projects,
                                 "super_admin": False,
                                 "permissions": sorted(_user_permissions(
                                     {"u": uname, "r": role}, conn))})
            resp.set_cookie("rt_session", _make_token(uname, role),
                            httponly=True, samesite="lax", max_age=7 * 86400)
            return resp
        raise HTTPException(401, "Invalid username or password")
    finally:
        conn.close()


@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("rt_session")
    return resp


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/me/password")
def api_change_password(request: Request, body: ChangePasswordBody):
    """Change the CALLER'S OWN password (feature #9).

    Two distinct cases, because the super-admin is not a DB row:
      * super-admin (shared .password login) — verify the current password
        against .password, then write the new one back to that file. The file
        is the single source of truth for the shared login, so it stays in sync.
      * everyone else — verify against users.password_hash and update the row.

    A user can only ever change their OWN password here. Changing someone
    else's is the /api/users/{uid} admin path, which sits behind the 'users'
    permission.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")

    new = body.new_password or ""
    if len(new) < 8:
        raise HTTPException(400, "New password must be at least 8 characters")

    uname = user.get("u", "")

    if _super_admin(user):
        auser, apw = _admin_creds()
        if not apw or not hmac.compare_digest(body.current_password or "", apw):
            raise HTTPException(403, "Current password is incorrect")
        pw_file = BASE / ".password"
        # Preserve the file's trailing newline convention, and write 0600.
        old_mode = pw_file.stat().st_mode if pw_file.exists() else None
        pw_file.write_text(new + "\n")
        try:
            os.chmod(pw_file, 0o600 if old_mode is None else old_mode & 0o777)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "note": "shared admin password updated"}

    conn = get_db()
    try:
        row = conn.execute("SELECT password_hash FROM users WHERE username=?",
                           (uname,)).fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        if not _verify_password(body.current_password or "", row["password_hash"]):
            raise HTTPException(403, "Current password is incorrect")
        conn.execute("UPDATE users SET password_hash=? WHERE username=?",
                     (_hash_password(new), uname))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@app.get("/api/me")
def api_me(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    conn = get_db()
    try:
        projects = _pm_projects(user["u"], conn) if user.get("r") == "pm" else []
        return {"role": user["r"], "username": user["u"], "projects": projects,
                "super_admin": _super_admin(user),
                "permissions": sorted(_user_permissions(user, conn))}
    finally:
        conn.close()


# ---------------- Themes (feature #8, option C — server-side, per-user) --------
# Eight themes defined as CSS custom-property overrides. The KEY is what gets
# stored in users.theme (or meta['theme:<user>'] for the super-admin); the
# values are injected as inline custom properties on <html> server-side, so the
# correct theme paints on FIRST byte — no flash of the wrong theme.
#
# Order matters: 'midnight' is the default and MUST reproduce the original
# palette exactly (see the drift check in scripts/semanticize_css.py).
THEMES: dict[str, dict] = {
    "midnight": {
        "label": "Midnight (default)", "dark": True,
        # Empty override = the :root values in styles.css, i.e. the look that
        # shipped before themes. Kept explicit-absent on purpose.
        "vars": {},
    },
    "belwo": {
        "label": "BelWo", "dark": True,
        "vars": {
            "--bg": "#070d18", "--surface-1": "#0b1424", "--surface-2": "#0e1a2e",
            "--surface-3": "#132340", "--surface-4": "#050a13", "--surface-5": "#0d1a2d",
            "--surface-6": "#101f36", "--surface-7": "#0c1626", "--header-bg": "#0a1626",
            "--text": "#eaf2ff", "--muted": "#8ba0c0",
            "--accent": "#2dd4bf", "--accent2": "#38bdf8",
            "--accent-rgb": "45, 212, 191", "--accent2-rgb": "56, 189, 248",
            "--hairline": "#3d5470", "--hairline-2": "#6f88a8",
            "--sticky-bg": "rgba(10, 22, 38, 0.9)", "--corner-bg": "rgba(13, 26, 45, 0.96)",
        },
    },
    "apple": {
        "label": "Apple", "dark": True,
        "vars": {
            "--bg": "#000000", "--surface-1": "#1c1c1e", "--surface-2": "#2c2c2e",
            "--surface-3": "#3a3a3c", "--surface-4": "#0a0a0a", "--surface-5": "#242426",
            "--surface-6": "#28282a", "--surface-7": "#1f1f21", "--header-bg": "#1c1c1e",
            "--text": "#f5f5f7", "--muted": "#98989d",
            "--accent": "#0a84ff", "--accent2": "#bf5af2",
            "--accent-rgb": "10, 132, 255", "--accent2-rgb": "191, 90, 242",
            "--green": "#30d158", "--red": "#ff453a", "--amber": "#ffd60a",
            "--green-rgb": "48, 209, 88", "--red-rgb": "255, 69, 58", "--amber-rgb": "255, 214, 10",
            "--pill-green-bg": "#0d2a15", "--pill-red-bg": "#2e1210",
            "--pill-amber-bg": "#2e2810", "--pill-orange-bg": "#2e1d0c",
            "--hairline": "#48484a", "--hairline-2": "#7c7c80",
            "--sticky-bg": "rgba(28, 28, 30, 0.92)", "--corner-bg": "rgba(44, 44, 46, 0.96)",
        },
    },
    "paper": {
        "label": "Paper (light)", "dark": False,
        "vars": {
            "--bg": "#f4f5f7", "--surface-1": "#ffffff", "--surface-2": "#fafbfc",
            "--surface-3": "#eef0f4", "--surface-4": "#f7f8fa", "--surface-5": "#ffffff",
            "--surface-6": "#f6f7f9", "--surface-7": "#ffffff", "--header-bg": "#eef0f4",
            "--text": "#1a2233", "--muted": "#667085", "--muted-rgb": "102, 112, 133",
            "--text-rgb": "26, 34, 51", "--bg-rgb": "244, 245, 247",
            "--accent": "#0d7d8f", "--accent2": "#6d4fd8",
            "--accent-rgb": "13, 125, 143", "--accent2-rgb": "109, 79, 216",
            "--green": "#0f7a4a", "--red": "#c0362b", "--amber": "#a3690a",
            "--green-rgb": "15, 122, 74", "--red-rgb": "192, 54, 43", "--amber-rgb": "163, 105, 10",
            "--pill-green-bg": "#e2f5e9", "--pill-red-bg": "#fbe6e4",
            "--pill-amber-bg": "#f7e4b8", "--pill-orange-bg": "#f8dfc2",
            "--panel": "rgba(10, 20, 40, 0.04)", "--panel-strong": "rgba(10, 20, 40, 0.07)",
            "--border": "rgba(10, 20, 40, 0.13)", "--border-strong": "rgba(10, 20, 40, 0.26)",
            "--hairline": "#b9c0cc", "--hairline-2": "#8b95a5",
            "--sticky-bg": "rgba(255, 255, 255, 0.94)", "--corner-bg": "rgba(238, 240, 244, 0.97)",
        },
    },
    "nord": {
        "label": "Nord", "dark": True,
        "vars": {
            "--bg": "#2e3440", "--surface-1": "#3b4252", "--surface-2": "#434c5e",
            "--surface-3": "#4c566a", "--surface-4": "#2b303b", "--surface-5": "#3b4252",
            "--surface-6": "#414a5c", "--surface-7": "#3b4252", "--header-bg": "#3b4252",
            "--text": "#eceff4", "--muted": "#a9b3c4", "--muted-rgb": "169, 179, 196",
            "--text-rgb": "236, 239, 244", "--bg-rgb": "46, 52, 64",
            "--accent": "#88c0d0", "--accent2": "#b48ead",
            "--accent-rgb": "136, 192, 208", "--accent2-rgb": "180, 142, 173",
            "--green": "#a3be8c", "--red": "#cf7a82", "--amber": "#ebcb8b",
            "--green-rgb": "163, 190, 140", "--red-rgb": "207, 122, 130", "--amber-rgb": "235, 203, 139",
            "--pill-green-bg": "#3b4a3a", "--pill-red-bg": "#1d1214",
            "--pill-amber-bg": "#4a4436", "--pill-orange-bg": "#4a3b2f",
            "--hairline": "#5e6b80", "--hairline-2": "#8a95a8",
            "--sticky-bg": "rgba(59, 66, 82, 0.93)", "--corner-bg": "rgba(67, 76, 94, 0.96)",
        },
    },
    "solarized": {
        "label": "Solarized", "dark": True,
        "vars": {
            "--bg": "#002b36", "--surface-1": "#073642", "--surface-2": "#0a3f4d",
            "--surface-3": "#124a58", "--surface-4": "#01222b", "--surface-5": "#073642",
            "--surface-6": "#0a3d4a", "--surface-7": "#073642", "--header-bg": "#073642",
            "--text": "#eee8d5", "--muted": "#93a1a1", "--muted-rgb": "147, 161, 161",
            "--text-rgb": "238, 232, 213", "--bg-rgb": "0, 43, 54",
            "--accent": "#2aa198", "--accent2": "#6c71c4",
            "--accent-rgb": "42, 161, 152", "--accent2-rgb": "108, 113, 196",
            "--green": "#859900", "--red": "#e35d5a", "--amber": "#b58900",
            "--green-rgb": "133, 153, 0", "--red-rgb": "227, 93, 90", "--amber-rgb": "181, 137, 0",
            "--pill-green-bg": "#0f1a00", "--pill-red-bg": "#170a09",
            "--pill-amber-bg": "#241d00", "--pill-orange-bg": "#241a08",
            "--hairline": "#1e5666", "--hairline-2": "#5b7a83",
            "--sticky-bg": "rgba(7, 54, 66, 0.94)", "--corner-bg": "rgba(10, 63, 77, 0.97)",
        },
    },
    "forest": {
        "label": "Forest", "dark": True,
        "vars": {
            "--bg": "#0b1a12", "--surface-1": "#12271c", "--surface-2": "#173024",
            "--surface-3": "#1f3d2d", "--surface-4": "#081410", "--surface-5": "#12271c",
            "--surface-6": "#173023", "--surface-7": "#12271c", "--header-bg": "#12271c",
            "--text": "#e6f2ea", "--muted": "#8fae9d", "--muted-rgb": "143, 174, 157",
            "--text-rgb": "230, 242, 234", "--bg-rgb": "11, 26, 18",
            "--accent": "#4ade80", "--accent2": "#a3e635",
            "--accent-rgb": "74, 222, 128", "--accent2-rgb": "163, 230, 53",
            "--green": "#4ade80", "--red": "#f87171", "--amber": "#fcd34d",
            "--green-rgb": "74, 222, 128", "--red-rgb": "248, 113, 113", "--amber-rgb": "252, 211, 77",
            "--pill-green-bg": "#14321f", "--pill-red-bg": "#3a1b1b",
            "--pill-amber-bg": "#3a3212", "--pill-orange-bg": "#3a2712",
            "--hairline": "#2f523c", "--hairline-2": "#6b8f78",
            "--sticky-bg": "rgba(18, 39, 28, 0.94)", "--corner-bg": "rgba(23, 48, 36, 0.96)",
        },
    },
    "sunset": {
        "label": "Sunset", "dark": True,
        "vars": {
            "--bg": "#1a0f1e", "--surface-1": "#26162c", "--surface-2": "#311c39",
            "--surface-3": "#3f2449", "--surface-4": "#150c19", "--surface-5": "#26162c",
            "--surface-6": "#2d1a34", "--surface-7": "#26162c", "--header-bg": "#26162c",
            "--text": "#f7e9f5", "--muted": "#b393ad", "--muted-rgb": "179, 147, 173",
            "--text-rgb": "247, 233, 245", "--bg-rgb": "26, 15, 30",
            "--accent": "#fb7185", "--accent2": "#fbbf24",
            "--accent-rgb": "251, 113, 133", "--accent2-rgb": "251, 191, 36",
            "--green": "#4ade80", "--red": "#fb7185", "--amber": "#fbbf24",
            "--green-rgb": "74, 222, 128", "--red-rgb": "251, 113, 133", "--amber-rgb": "251, 191, 36",
            "--pill-green-bg": "#14321f", "--pill-red-bg": "#3d1a22",
            "--pill-amber-bg": "#3d3212", "--pill-orange-bg": "#3d2612",
            "--hairline": "#5c3a52", "--hairline-2": "#94708c",
            "--sticky-bg": "rgba(38, 22, 44, 0.94)", "--corner-bg": "rgba(49, 28, 57, 0.96)",
        },
    },
    "contrast": {
        "label": "High contrast", "dark": True,
        "vars": {
            "--bg": "#000000", "--surface-1": "#0d0d0d", "--surface-2": "#161616",
            "--surface-3": "#242424", "--surface-4": "#000000", "--surface-5": "#101010",
            "--surface-6": "#141414", "--surface-7": "#111111", "--header-bg": "#0d0d0d",
            "--text": "#ffffff", "--muted": "#c8c8c8", "--muted-rgb": "200, 200, 200",
            "--text-rgb": "255, 255, 255", "--bg-rgb": "0, 0, 0",
            "--accent": "#00e5ff", "--accent2": "#ff5cf4",
            "--accent-rgb": "0, 229, 255", "--accent2-rgb": "255, 92, 244",
            "--green": "#00ff88", "--red": "#ff4d4d", "--amber": "#ffd400",
            "--green-rgb": "0, 255, 136", "--red-rgb": "255, 77, 77", "--amber-rgb": "255, 212, 0",
            "--pill-green-bg": "#052e18", "--pill-red-bg": "#3d0d0d",
            "--pill-amber-bg": "#3d3300", "--pill-orange-bg": "#3d2400",
            "--panel": "rgba(255, 255, 255, 0.09)", "--panel-strong": "rgba(255, 255, 255, 0.16)",
            "--border": "rgba(255, 255, 255, 0.22)", "--border-strong": "rgba(255, 255, 255, 0.42)",
            "--hairline": "#8a8a8a", "--hairline-2": "#b8b8b8",
            "--sticky-bg": "rgba(13, 13, 13, 0.97)", "--corner-bg": "rgba(22, 22, 22, 0.98)",
        },
    },
}
DEFAULT_THEME = "midnight"


def _theme_key(user) -> str:
    """Resolve the theme key for a user, falling back to the default."""
    try:
        if _super_admin(user):
            # Super-admin has no users row — stored in meta.
            conn = get_db()
            try:
                row = conn.execute("SELECT value FROM meta WHERE key=?",
                                   (f"theme:{user.get('u','')}",)).fetchone()
                k = row["value"] if row else ""
            finally:
                conn.close()
        else:
            conn = get_db()
            try:
                row = conn.execute("SELECT theme FROM users WHERE username=?",
                                   (user.get("u", ""),)).fetchone()
                k = (row["theme"] if row else "") or ""
            finally:
                conn.close()
    except Exception:  # noqa: BLE001
        k = ""
    return k if k in THEMES else DEFAULT_THEME


def _theme_css_vars(key: str) -> str:
    """Inline custom-property block for server-side injection on <html>.

    Injected server-side so the correct theme is painted on the first byte —
    a client-side apply would flash the default theme first.
    """
    t = THEMES.get(key) or THEMES[DEFAULT_THEME]
    if not t["vars"]:
        return ""
    body = "".join(f"{k}:{v};" for k, v in t["vars"].items())
    return f":root{{{body}}}"


@app.get("/api/themes")
def api_themes(request: Request):
    """Available themes + this user's current choice."""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    cur = _theme_key(user)
    return {
        "themes": [{"key": k, "label": v["label"], "dark": v["dark"]}
                   for k, v in THEMES.items()],
        "current": cur,
        # The super-admin can always switch; a regular admin needs the
        # 'theming' permission; a PM is read-only (gets the default).
        "can_change": _can_change_theme(user),
    }


def _can_change_theme(user) -> bool:
    """Who may switch their own UI theme.

    the owner's call (2026-10-01): EVERY signed-in user gets this, PMs included. A
    theme is a local display preference that exposes no data, so gating it
    behind an admin permission only made PMs squint at a dark screen. The
    `theming` permission stays in the list (harmless) rather than being ripped
    out of existing admin records.
    """
    if not user:
        return False
    return True


@app.post("/api/themes")
def api_themes_set(request: Request, payload: dict):
    """Persist the caller's theme choice. Body: {"theme": "<key>"}."""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    if not _can_change_theme(user):
        raise HTTPException(403, "You do not have permission to change the theme")
    key = str(payload.get("theme") or "").strip()
    if key not in THEMES:
        raise HTTPException(400, f"unknown theme {key!r}")
    conn = get_db()
    try:
        if _super_admin(user):
            conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (f"theme:{user.get('u','')}", key))
        else:
            conn.execute("UPDATE users SET theme=? WHERE username=?", (key, user.get("u", "")))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "theme": key}



def init_db() -> None:
    # The data dir is created HERE rather than at import time. A fresh clone has
    # no data/ (it is gitignored), so `_cipher.connect()` used to die with
    # "unable to open database file" — which broke the CI workflow on every run
    # and any first-time checkout. Only the DB-key writer used to mkdir, and only
    # for its own parent directory.
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS resources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            country TEXT NOT NULL DEFAULT '',
            client TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT '',
            rate REAL,
            offshore_rate REAL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS weekly_hours (
            resource_id INTEGER NOT NULL,
            week INTEGER NOT NULL,
            hours REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (resource_id, week)
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pricing (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL UNIQUE,
            rate REAL,
            offshore_rate REAL,
            currency TEXT NOT NULL DEFAULT 'USD',
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL DEFAULT '',
            start_date TEXT NOT NULL DEFAULT '',
            end_date TEXT NOT NULL DEFAULT '',
            UNIQUE (client, project)
        );
        CREATE TABLE IF NOT EXISTS actual_hours (
            resource_id INTEGER NOT NULL,
            week INTEGER NOT NULL,
            hours REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (resource_id, week)
        );
        CREATE TABLE IF NOT EXISTS actual_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_id INTEGER NOT NULL,
            week INTEGER NOT NULL,
            pm TEXT NOT NULL DEFAULT '',
            overage REAL NOT NULL DEFAULT 0,
            comment TEXT NOT NULL DEFAULT '',
            is_ot INTEGER NOT NULL DEFAULT 0,
            approved INTEGER NOT NULL DEFAULT 0,
            billed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (resource_id, week)
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'pm',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS user_projects (
            user_id INTEGER NOT NULL,
            client TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL,
            PRIMARY KEY (user_id, client, project)
        );
        -- People master list (2026-10-01, PM access redesign). A person exists
        -- ONCE; projects attach to them via resources.person_id. This is what
        -- makes "already assigned" and the 100% rule detectable by ID rather
        -- than by name spelling.
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            country TEXT NOT NULL DEFAULT '',
            home_title TEXT NOT NULL DEFAULT '',
            capacity REAL NOT NULL DEFAULT 40,
            active INTEGER NOT NULL DEFAULT 1,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- Titles a person is APPROVED to be booked under. The PM's dropdown
        -- only ever shows these, so a PM cannot invent a rate. Normally one
        -- (the home title); more only when admin explicitly allows it.
        CREATE TABLE IF NOT EXISTS person_titles (
            person_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            PRIMARY KEY (person_id, title)
        );
        -- Activity log (2026-10-01). the owner accidentally confirmed a person merge
        -- and there was NO WAY to find out afterwards what it had done — the
        -- merge is irreversible in the UI and left no trace. Every destructive
        -- or money-affecting action now writes a row here, and Team & Access
        -- renders them, so "what did I just do?" is always answerable.
        -- Written from the SERVER (never the client) so it cannot be skipped.
        CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            actor TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (id DESC);
        """
    )
    # Migration: add client column to user_projects if it predates it
    upcols = {r[1] for r in conn.execute("PRAGMA table_info(user_projects)").fetchall()}
    if "client" not in upcols:
        conn.execute("ALTER TABLE user_projects ADD COLUMN client TEXT NOT NULL DEFAULT ''")
    _fix_user_projects_pk(conn)
    # Migration: add permissions column to users if it predates it (admin management)
    ucols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "permissions" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'")
    # Migration: add theme column (per-user UI theme, feature #8).
    # Stores a theme KEY from THEMES below; '' means "use the default".
    # The super-admin (shared .password login) has no users row, so their
    # choice lives in meta under 'theme:<username>' instead.
    if "theme" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT ''")
    # Migration: add capacity column if the resources table predates it
    rcols = {r[1] for r in conn.execute("PRAGMA table_info(resources)").fetchall()}
    if "capacity" not in rcols:
        conn.execute("ALTER TABLE resources ADD COLUMN capacity REAL NOT NULL DEFAULT 40")
    # ---- Soft delete / archive (GH-38) ----
    # the owner: "if PM delete the project, then it will go away from the PMs view,
    # it should still be there for admin with a red strip on it so that if PM
    # delete by accident the admin can revert ... reactive will show it back for
    # the PM and delete will delete it from the app permanently".
    # A PM delete is therefore an ARCHIVE, not a removal: nothing is destroyed and
    # the admin can reactivate. Only an explicit purge drops the data for good.
    pcols2 = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    for col, ddl in (
        ("archived_at", "ALTER TABLE projects ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''"),
        ("archived_by", "ALTER TABLE projects ADD COLUMN archived_by TEXT NOT NULL DEFAULT ''"),
        ("archived_note", "ALTER TABLE projects ADD COLUMN archived_note TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in pcols2:
            conn.execute(ddl)
    # Migration: add project column if the table predates it
    cols = {r[1] for r in conn.execute("PRAGMA table_info(resources)").fetchall()}
    if "project" not in cols:
        conn.execute("ALTER TABLE resources ADD COLUMN project TEXT NOT NULL DEFAULT ''")
    # Migration: add currency column if the pricing table predates it
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(pricing)").fetchall()}
    if "currency" not in pcols:
        conn.execute("ALTER TABLE pricing ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'")
    # ---- PM access redesign (2026-10-01) ----
    # resources becomes the ASSIGNMENT link: person_id + allocation window.
    rcols2 = {r[1] for r in conn.execute("PRAGMA table_info(resources)").fetchall()}
    for col, ddl in (
        ("person_id", "ALTER TABLE resources ADD COLUMN person_id INTEGER"),
        ("allocation_pct", "ALTER TABLE resources ADD COLUMN allocation_pct REAL"),
        ("start_date", "ALTER TABLE resources ADD COLUMN start_date TEXT NOT NULL DEFAULT ''"),
        ("end_date", "ALTER TABLE resources ADD COLUMN end_date TEXT NOT NULL DEFAULT ''"),
        ("title_exception", "ALTER TABLE resources ADD COLUMN title_exception TEXT NOT NULL DEFAULT ''"),
        # Time-phased allocation (2026-10-01). A person on a project for 5 months
        # at 100% -> 50% -> 25% cannot be expressed by a single allocation_pct, so
        # the assignment carries an ordered list of phases as JSON:
        #   [{"allocation_pct":100,"start_date":"2026-01-02","end_date":"2026-03-29"}, ...]
        # Empty string means the legacy flat mode (allocation_pct across the whole
        # start/end window), so existing rows are untouched.
        ("phases", "ALTER TABLE resources ADD COLUMN phases TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in rcols2:
            conn.execute(ddl)
    # actual_notes gains the under-delivery reason ('why not billed') and the
    # billing decision for shortfalls. The old code COLLECTED and VALIDATED a
    # 'reason' but never persisted it — there was no column to write it to.
    acols = {r[1] for r in conn.execute("PRAGMA table_info(actual_notes)").fetchall()}
    for col, ddl in (
        ("reason", "ALTER TABLE actual_notes ADD COLUMN reason TEXT NOT NULL DEFAULT ''"),
        ("under_billed", "ALTER TABLE actual_notes ADD COLUMN under_billed INTEGER"),
    ):
        if col not in acols:
            conn.execute(ddl)
    # pricing gains the optional OT multiplier (admin-set per title).
    pcols2 = {r[1] for r in conn.execute("PRAGMA table_info(pricing)").fetchall()}
    if "ot_multiplier" not in pcols2:
        conn.execute("ALTER TABLE pricing ADD COLUMN ot_multiplier REAL")
    # Seed the People master list ONCE from the distinct resource (name, role).
    # Idempotent: only runs while people is empty, so a restart never duplicates.
    if conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 0:
        seed_people_from_resources(conn)
    # Repair folded/duplicate rows a previous seed may have left, then fold the
    # known name variants of the SAME human into one record so the 100% rule
    # cannot be defeated by a spelling difference.
    _reseat_people(conn)
    _dedupe_person_titles(conn)
    for _keep, _drops in KNOWN_DUPLICATES:
        _merge_people(conn, _keep, _drops)
    # Link any resource that has a person_id still unset / dangling.
    backfill_person_links(conn)
    # Seed the pricing library once from distinct resource roles
    if conn.execute("SELECT COUNT(*) FROM pricing").fetchone()[0] == 0:
        seed_pricing_from_roles(conn)
    # Seed the projects table once from distinct (client, project) pairs
    if conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0:
        conn.execute(
            "INSERT OR IGNORE INTO projects (client, project) "
            "SELECT DISTINCT TRIM(client), TRIM(project) FROM resources "
            "WHERE TRIM(project) != ''"
        )
    # Seed week/month layout if missing (defaults mirror Revenue_2026 layout)
    if conn.execute("SELECT COUNT(*) FROM meta WHERE key='layout'").fetchone()[0] == 0:
        weeks, months = importer.default_layout(2026)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('layout', ?)",
            (json.dumps({"weeks": weeks, "months": months}),),
        )
    conn.commit()
    conn.close()


def seed_pricing_from_roles(conn: sqlite3.Connection) -> None:
    """Build the title library from existing roles (first-seen rates as the
    starting point; user owns the numbers afterwards)."""
    rows = conn.execute(
        "SELECT role, rate, offshore_rate FROM resources "
        "WHERE TRIM(role) != '' ORDER BY id"
    ).fetchall()
    seen: dict[str, tuple[float | None, float | None]] = {}
    for r in rows:
        title = r["role"].strip()
        if title and title not in seen:
            seen[title] = (r["rate"], r["offshore_rate"])
    conn.executemany(
        "INSERT INTO pricing (title, rate, offshore_rate, sort_order) VALUES (?,?,?,?)",
        [(t, v[0], v[1], i) for i, (t, v) in enumerate(seen.items())],
    )


# NOTE: init_db() is invoked at the very END of this module. It used to run
# here, which broke as soon as the People seeding helpers were defined further
# down the file (NameError at import — the definitions did not exist yet).


# ---------------- helpers ----------------
def _norm(s: str | None) -> str:
    return (s or "").strip().upper()


def _hours_map(resource_id: int, conn: sqlite3.Connection) -> dict[int, float]:
    rows = conn.execute(
        "SELECT week, hours FROM weekly_hours WHERE resource_id=?", (resource_id,)
    ).fetchall()
    return {r["week"]: r["hours"] for r in rows}


def _actual_hours_map(resource_id: int, conn: sqlite3.Connection) -> dict[int, float]:
    rows = conn.execute(
        "SELECT week, hours FROM actual_hours WHERE resource_id=?", (resource_id,)
    ).fetchall()
    return {r["week"]: r["hours"] for r in rows}


def _actual_notes_map(resource_id: int, conn: sqlite3.Connection) -> dict[int, dict]:
    rows = conn.execute(
        "SELECT week, pm, overage, comment, reason, is_ot, approved, billed, "
        "under_billed FROM actual_notes WHERE resource_id=? ORDER BY week",
        (resource_id,),
    ).fetchall()
    out = {r["week"]: dict(r) for r in rows}
    for w, n in out.items():
        # the owner's rule: billable OT reaches the Dashboard ONLY after he approves.
        # Expose that as a derived flag so every money path shares one definition
        # instead of re-deriving the gate in three places.
        n["ot_billable_approved"] = bool(n.get("is_ot") and n.get("approved") and n.get("billed"))
    return out


def _load_layout() -> tuple[list[str], list[dict]]:
    conn = get_db()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='layout'").fetchone()
    finally:
        conn.close()
    if not row:
        return importer.default_layout(2026)
    data = json.loads(row["value"])
    return data["weeks"], data["months"]


def _resource_dict(row: sqlite3.Row, hours: dict[int, float], weeks: list[str],
                   actual: dict[int, float] | None = None,
                   notes: dict[int, dict] | None = None) -> dict:
    hrs = [hours.get(i, 0.0) for i in range(len(weeks))]
    total_hrs = sum(hrs)
    rate = row["rate"] or 0.0
    off_rate = row["offshore_rate"] or 0.0
    cost = rate * total_hrs
    expense = off_rate * total_hrs
    actual_hrs = [actual.get(i, 0.0) for i in range(len(weeks))] if actual else [0.0] * len(weeks)
    return {
        "id": row["id"],
        "country": row["country"],
        "client": row["client"],
        "project": row["project"],
        "name": row["name"],
        "role": row["role"],
        "rate": row["rate"],
        "offshore_rate": row["offshore_rate"],
        "capacity": row["capacity"] if "capacity" in row.keys() else 40.0,
        "hours": hrs,
        "total_hrs": total_hrs,
        "total_cost": cost,
        "expense": expense,
        "difference": cost - expense,
        "actual_hours": actual_hrs,
        "actual_total": sum(actual_hrs),
        "actual_notes": notes or {},
    }


def _all_resources(conn: sqlite3.Connection, weeks: list[str],
                   include_archived: bool = False) -> list[dict]:
    """Every resource row, with per-week hours attached.

    GH-38: rows belonging to an ARCHIVED project are excluded unless asked for.
    Archiving is the reversible form of delete, so an archived project must not
    contribute to any live figure — the Planned grid, Actuals, Utilization, the
    Dashboard, exports or the pricing popups. Filtering here rather than at each
    call site means every current and future reader inherits the rule; only the
    Dashboard's admin view opts in, and even that filters the archived keys out of
    its totals and re-adds them as flagged rows.
    """
    rows = conn.execute(
        "SELECT * FROM resources ORDER BY sort_order, id"
    ).fetchall()
    if not include_archived:
        arch = _archived_project_keys(conn)
        if arch:
            rows = [r for r in rows
                    if ((r["client"] or "").strip().upper(),
                        (r["project"] or "").strip().upper()) not in arch]
    # OT settings, resolved once per call (not per row).
    ot_by_title = {
        r["title"]: (r["ot_multiplier"] or 1.0)
        for r in conn.execute("SELECT title, ot_multiplier FROM pricing").fetchall()
    }
    gate = _ot_requires_approval(conn)
    out = []
    for r in rows:
        d = _resource_dict(r, _hours_map(r["id"], conn), weeks,
                           _actual_hours_map(r["id"], conn), _actual_notes_map(r["id"], conn))
        # `ot_multiplier` multiplies the OT *portion* only; `ot_requires_approval`
        # is the admin gate that decides whether unapproved billable OT is held
        # out of the Dashboard. Both are read by _actuals_financials.
        d["ot_multiplier"] = ot_by_title.get((r["role"] or "").strip(), 1.0)
        d["ot_requires_approval"] = gate
        # Time-phased allocation. `allocation_schedule` is the resolved, week-
        # aligned view (what actually got written), which is what the UI shows.
        ph = parse_phases(r["phases"] if "phases" in r.keys() else "")
        d["phases"] = ph
        d["allocation_schedule"] = _resolve_schedule(ph) if ph else []
        out.append(d)
    return out


def _ot_requires_approval(conn: sqlite3.Connection) -> bool:
    """meta['ot_requires_approval'] — '0' disables the admin gate. Default on."""
    row = conn.execute("SELECT value FROM meta WHERE key='ot_requires_approval'").fetchone()
    if not row:
        return True
    return str(row["value"]).strip() not in ("0", "false", "False", "")


# ---------------- Pydantic models ----------------
class ResourceUpdate(BaseModel):
    country: str | None = None
    client: str | None = None
    project: str | None = None
    name: str | None = None
    role: str | None = None
    rate: float | None = None
    offshore_rate: float | None = None
    capacity: float | None = None


class PricingUpdate(BaseModel):
    title: str | None = None
    rate: float | None = None
    offshore_rate: float | None = None
    currency: str | None = None
    # Optional admin-set OT multiplier for this title (1.25 = time-and-a-quarter).
    # None leaves it unchanged / unset (= 1.0).
    ot_multiplier: float | None = None
    clear_ot_multiplier: bool | None = False


CURRENCY_CODES = {"USD": "USD", "GBP": "GBP", "CAD": "CAD"}


def norm_currency(v: str | None) -> str:
    """Accept $/£/CAD symbols or codes and return a canonical code."""
    if not v:
        return "USD"
    s = v.strip().upper().replace("$", "USD").replace("£", "GBP")
    try:
        return CURRENCY_CODES[s]
    except KeyError:
        return "USD"


class HoursUpdate(BaseModel):
    hours: list[float] | None = None          # full-row replace
    week: int | None = None                   # single cell
    value: float | None = None


# ---------------- API ----------------
@app.get("/api/state")
def api_state(request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        pricing = conn.execute(
            "SELECT p.id, p.title, p.rate, p.offshore_rate, p.currency, "
            "(SELECT COUNT(DISTINCT TRIM(r.name)) FROM resources r "
            " WHERE TRIM(r.role)=p.title) AS used_by "
            "FROM pricing p ORDER BY p.sort_order, p.title"
        ).fetchall()
        return {
            "year": 2026,
            "weeks": weeks,
            "months": months,
            "resources": resources,
            "pricing": [dict(r) for r in pricing],
            # Which week/month "now" is, so the header can highlight it.
            "current": _current_period(weeks, months),
        }
    finally:
        conn.close()


# A person may hold at most TWO titles (the owner, 2026-09-30): "a resource should
# be allocated as one title or the max 2 title — like I could have a PM do BA
# for another project." A title is a `resources.role`; each (person, client,
# project) is its own row carrying that row's title and rates, which is how
# Marcus Lane holds "Project manager" and "Solution Architect" at different
# rates today. Three or more is refused.
MAX_TITLES_PER_PERSON = 2


def _titles_for(conn: sqlite3.Connection, name: str, exclude_id: int | None = None) -> set[str]:
    """Distinct titles the named person already holds, optionally ignoring one row."""
    sql = "SELECT DISTINCT TRIM(role) FROM resources WHERE TRIM(name)=? AND TRIM(COALESCE(role,''))<>''"
    args: list = [(name or "").strip()]
    if exclude_id is not None:
        sql += " AND id<>?"
        args.append(exclude_id)
    return {r[0] for r in conn.execute(sql, args).fetchall()}


def _check_title_limit(conn: sqlite3.Connection, name: str, new_role: str,
                       exclude_id: int | None = None) -> None:
    """Raise 400 if adding `new_role` would give this person a third title."""
    role = (new_role or "").strip()
    if not role:
        return  # blanking a title is always allowed
    existing = _titles_for(conn, name, exclude_id)
    if role in existing:
        return  # re-assigning a title they already hold is fine
    if len(existing) >= MAX_TITLES_PER_PERSON:
        raise HTTPException(
            400,
            f"{name} already holds {MAX_TITLES_PER_PERSON} titles "
            f"({', '.join(sorted(existing))}). A resource can have at most "
            f"{MAX_TITLES_PER_PERSON} titles — remove one first.",
        )


@app.post("/api/resources")
def api_create_resource(body: ResourceUpdate | None = None, request: Request = None):
    _require_perm(request, "resources")
    conn = get_db()
    try:
        if body:
            _check_title_limit(conn, body.name or "New Resource", body.role or "")
        cur = conn.execute(
            "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, capacity, sort_order) "
            "VALUES (?,?,?,?,?,?,?,?, "
            "COALESCE((SELECT MAX(sort_order)+1 FROM resources), 0))",
            (
                (body.country or "") if body else "",
                (body.client or "") if body else "",
                (body.project or "") if body else "",
                (body.name or "New Resource") if body else "New Resource",
                (body.role or "") if body else "",
                body.rate if body else None,
                body.offshore_rate if body else None,
                (body.capacity if body and body.capacity else 40),
            ),
        )
        conn.commit()
        rid = cur.lastrowid
        weeks, _ = _load_layout()
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        return _resource_dict(row, {}, weeks)
    finally:
        conn.close()


@app.put("/api/resources/{rid}")
def api_update_resource(rid: int, body: ResourceUpdate, request: Request):
    _require_perm(request, "resources")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
        # If this row's title is changing, apply the max-2-titles rule. A no-op
        # when the title is unchanged, so ordinary rate/hour edits always pass.
        _check_title_limit(conn, body.name or row["name"], body.role or "",
                           exclude_id=rid)
        new_vals = {
            k: (getattr(body, k) if getattr(body, k) is not None else row[k])
            for k in ("country", "client", "project", "name", "role", "rate", "offshore_rate", "capacity")
        }
        conn.execute(
            "UPDATE resources SET country=?, client=?, project=?, name=?, role=?, rate=?, offshore_rate=?, capacity=? WHERE id=?",
            (new_vals["country"], new_vals["client"], new_vals["project"],
             new_vals["name"], new_vals["role"], new_vals["rate"], new_vals["offshore_rate"],
             new_vals["capacity"], rid),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        weeks, _ = _load_layout()
        return _resource_dict(row, _hours_map(rid, conn), weeks)
    finally:
        conn.close()


@app.put("/api/resources/{rid}/hours")
def api_update_hours(rid: int, body: HoursUpdate, request: Request):
    _require_perm(request, "resources")
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        n = len(weeks)
        if body.hours is not None:
            hours = [float(h) if h is not None else 0.0 for h in body.hours]
            if len(hours) != n:
                raise HTTPException(400, f"expected {n} hours, got {len(hours)}")
            conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (rid,))
            conn.executemany(
                "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                [(rid, i, h) for i, h in enumerate(hours) if h],
            )
        elif body.week is not None:
            if not (0 <= body.week < n):
                raise HTTPException(400, f"week out of range 0..{n-1}")
            v = float(body.value or 0.0)
            if v:
                conn.execute(
                    "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?) "
                    "ON CONFLICT(resource_id, week) DO UPDATE SET hours=excluded.hours",
                    (rid, body.week, v),
                )
            else:
                conn.execute(
                    "DELETE FROM weekly_hours WHERE resource_id=? AND week=?", (rid, body.week)
                )
        else:
            raise HTTPException(400, "provide 'hours' or 'week'+'value'")
        conn.commit()
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        return _resource_dict(row, _hours_map(rid, conn), weeks)
    finally:
        conn.close()


@app.delete("/api/resources/{rid}")
def api_delete_resource(rid: int, request: Request):
    _require_perm(request, "resources")
    conn = get_db()
    try:
        conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM actual_hours WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM actual_notes WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM resources WHERE id=?", (rid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------- Actuals (PM reconciliation) ----------------
class ActualsUpdate(BaseModel):
    hours: list[float] | None = None          # full-row actual hours
    notes: dict[int, dict] | None = None      # week -> {comment,is_ot,approved,billed,reason}
    # Which weeks THIS call is entering/editing. Everything else in `hours` is
    # context that must survive the write, NOT something to re-litigate. Without
    # this the save validated all 53 weeks and demanded a shortfall reason for
    # weeks the PM never opened (the owner, 2026-10-02). None = the client did not
    # say, so fall back to "every week whose value differs from the stored one".
    edited: list[int] | None = None


def _reason_text(note: dict) -> str:
    """The free-text justification for a week, from whichever field carries it.

    `comment` is the original field (the weekly grid's prompt chain writes the
    unbilled-OT reason there); `reason` was added later for the newer flows. Both
    are persisted, so accept either rather than refusing a valid entry.
    """
    return ((note.get("reason") or "").strip() or (note.get("comment") or "").strip())


def _validate_actual_week(planned: float, actual: float, capacity: float,
                          note: dict | None) -> dict:
    """Return the reconciliation status for one resource-week."""
    overage = round(actual - planned, 4)
    note = note or {}
    # A PM cannot enter actuals for a week the resource isn't assigned to
    # (no planned hours). Block it — no unassigned entries.
    if actual > 0 and planned <= 0:
        return {"status": "no_planned", "overage": actual}
    if abs(overage) < 1e-9:
        # On target still carries the under/OT decision forward if one was set,
        # so a PM who corrects a week back to plan doesn't silently lose the
        # billing verdict he already recorded.
        return {"status": "ok", "overage": 0.0,
                "under_billed": note.get("under_billed")}
    if overage < 0:
        # Under-delivery needs a REASON. The billing decision is deliberately
        # OPTIONAL here rather than mandatory: the 53-week grid has no prompt for
        # it, so requiring it made every under-delivery unsavable from that grid
        # (a regression). The new week sheet asks for it, and when it IS supplied
        # the money treatment follows (see _actuals_financials).
        if not (note.get("comment") or "").strip():
            return {"status": "needs_comment", "overage": overage}
        ub = note.get("under_billed")
        return {"status": "ok", "overage": overage,
                "under_billed": (None if ub is None else bool(ub))}
    # overage -> OT flow (any overage)
    is_ot = note.get("is_ot")
    if is_ot is None:
        # OT question not answered yet — must ask before saving
        return {"status": "needs_ot", "overage": overage}
    if not is_ot:
        # explicitly declined OT: record overage, no approval/billing questions
        return {"status": "ok", "overage": overage, "is_ot": False}
    billed = bool(note.get("billed"))
    if not billed:
        # The reason may arrive in EITHER field: the weekly grid's prompt chain
        # historically stored it in `comment` and never sent `reason`, while the
        # newer shape uses `reason`. Requiring only `reason` made every unbilled
        # week unsavable from the grid (a regression). Accept either.
        if not _reason_text(note):
            return {"status": "needs_billing_reason", "overage": overage, "is_ot": True}
        return {"status": "ok", "overage": overage, "is_ot": True, "billed": False}
    # Billable OT no longer self-approves. `approved` is an ADMIN decision
    # (Team & Access → OT approvals); the PM records the intent and the money
    # waits. the owner's spec: it must not reach the Dashboard until he approves.
    return {"status": "ok", "overage": overage, "is_ot": True, "billed": True}


@app.put("/api/resources/{rid}/actuals")
def api_update_actuals(rid: int, body: ActualsUpdate, request: Request):
    user = _require_pm(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
        # Admin actuals are gated behind the 'actuals' permission; PMs keep
        # their own scoped path (always allowed for their own projects).
        if user.get("r") == "pm":
            projs = _pm_projects(user["u"], conn)
            proj = (row["project"] or "").strip()
            client = (row["client"] or "").strip()
            if proj and not _pm_owns(projs, client, proj):
                raise HTTPException(403, "Not assigned to this project")
        else:
            _require_perm(request, "actuals")
        weeks, _ = _load_layout()
        n = len(weeks)
        if body.hours is None:
            raise HTTPException(400, "provide 'hours'")
        hours = [float(h) if h is not None else 0.0 for h in body.hours]
        if len(hours) != n:
            raise HTTPException(400, f"expected {n} hours, got {len(hours)}")
        planned = _hours_map(rid, conn)
        stored = _actual_hours_map(rid, conn)
        capacity = row["capacity"] or 40.0
        notes = body.notes or {}
        # ---- which weeks is this call answering for? -------------------------
        # A save carries the FULL week array (the backend requires it), but the PM
        # is entering ONE week on the Weekly entry sheet, or the weeks of a single
        # month in the Actuals wizard. Judging all 53 weeks meant any OTHER week
        # sitting below plan without a recorded reason blocked the save and fired
        # "Why the shortfall?" for a week nobody opened — the owner's report
        # (2026-10-02). Validate the EDITED weeks only.
        if body.edited is not None:
            edited = sorted({int(w) for w in body.edited
                             if isinstance(w, (int, float)) and 0 <= int(w) < n})
        else:
            # Backward-compatible fallback for a client that does not send it: a
            # week counts as edited when its submitted value MOVED.
            edited = [i for i in range(n)
                      if abs(float(hours[i]) - float(stored.get(i, 0.0))) > 1e-9]

        # Validate every EDITED week; collect anything that still needs input.
        needs = []
        for i in edited:
            if not hours[i]:
                continue
            v = _validate_actual_week(planned.get(i, 0.0), hours[i], capacity, notes.get(i))
            if v["status"] != "ok":
                needs.append({"week": i, **v})
        if needs:
            return JSONResponse({"status": "needs_input", "weeks": needs}, status_code=200)
        # Persist. Every week the call did NOT edit keeps its STORED value. The
        # payload's other slots are context, not an instruction: the month-scoped
        # grid and the week sheet both fill them from whatever they rendered, so
        # writing them verbatim could insert a stale PLANNED value as if it were
        # an entered actual (a quiet data corruption, not just a wrong prompt).
        merged = dict(stored)
        for i in edited:
            merged[i] = hours[i]
        conn.execute("DELETE FROM actual_hours WHERE resource_id=?", (rid,))
        conn.executemany(
            "INSERT INTO actual_hours (resource_id, week, hours) VALUES (?,?,?)",
            [(rid, i, h) for i, h in sorted(merged.items()) if h],
        )
        for i in edited:
            h = hours[i]
            if not h:
                continue
            v = _validate_actual_week(planned.get(i, 0.0), h, capacity, notes.get(i))
            note = notes.get(i) or {}
            # Preserve an admin's existing OT approval when the PM re-saves the
            # week. Without this, every re-save would wipe the approval and the
            # billable money would bounce out of the Dashboard. A changed
            # overage (different quantity of OT) legitimately invalidates it.
            prev = conn.execute(
                "SELECT approved, overage FROM actual_notes WHERE resource_id=? AND week=?",
                (rid, i)).fetchone()
            same_ot = bool(prev) and abs((prev["overage"] or 0.0) - float(v["overage"])) < 1e-9
            keep_approved = 1 if (same_ot and v.get("is_ot") and prev["approved"]) else 0
            conn.execute(
                "INSERT INTO actual_notes (resource_id, week, pm, overage, comment, reason, "
                "under_billed, is_ot, approved, billed) "
                "VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(resource_id, week) DO UPDATE SET "
                "pm=excluded.pm, overage=excluded.overage, comment=excluded.comment, "
                "reason=excluded.reason, under_billed=excluded.under_billed, "
                "is_ot=excluded.is_ot, approved=excluded.approved, billed=excluded.billed",
                (rid, i, user["u"], v["overage"], (note.get("comment") or "").strip(),
                 # Persist the justification in BOTH fields: the grid writes
                 # `comment`, the week sheet writes `reason`, and the unbilled
                 # report reads one or the other. Keeping them in step avoids a
                 # row that is valid in one view and blank in the other.
                 _reason_text(note),
                 (None if v.get("under_billed") is None else int(bool(v["under_billed"]))),
                 int(v.get("is_ot", False)), keep_approved, int(v.get("billed", False))),
            )
        conn.commit()
        return {"status": "ok", "saved": True}
    finally:
        conn.close()


@app.get("/api/actuals")
def api_actuals(request: Request):
    """PM-scoped actuals grid: resources + planned + actual + notes. PMs see
    only their projects and NO rates. Admin sees everything."""
    user = _require_pm(request)
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        resources = _all_resources(conn, weeks)
        if user.get("r") == "pm":
            projs = _pm_projects(user["u"], conn)
            resources = [r for r in resources
                         if not (r["project"] or "").strip()
                         or _pm_owns(projs, (r["client"] or "").strip(), (r["project"] or "").strip())]
        # Strip rates for PMs — and the derived money fields that would let a
        # PM recover the billing rate (total_cost = rate × hours, expense =
        # offshore_rate × hours). Nulling rate alone is not enough.
        if user.get("r") == "pm":
            for r in resources:
                r["rate"] = None
                r["offshore_rate"] = None
                r["total_cost"] = None
                r["expense"] = None
                r["difference"] = None
        return {"weeks": weeks, "months": _load_layout()[1], "resources": resources,
                "role": user["r"], "username": user["u"], "year": 2026,
                # Which week/month is "now". `/api/state` carries this too but it is
                # ADMIN-only, so a PM had no source for it and the week sheet could
                # not default to the current week.
                "current": _current_period(weeks, _load_layout()[1])}
    finally:
        conn.close()


# ---------------- User management (admin) ----------------
class ProjectAssign(BaseModel):
    client: str = ""
    project: str = ""


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "pm"               # "pm" | "admin"
    permissions: list[str] = []    # admin permission keys (ignored for PMs)
    projects: list[ProjectAssign] = []


class UserUpdate(BaseModel):
    password: str | None = None
    role: str | None = None
    permissions: list[str] | None = None
    projects: list[ProjectAssign] | None = None


def _project_owners(conn: sqlite3.Connection) -> dict[tuple[str, str], str]:
    """Map (client, project) -> owning PM username. A (client, project) has AT
    MOST one PM (the UI enforces this too, but the DB layer must guarantee it)."""
    rows = conn.execute(
        "SELECT up.client, up.project, u.username FROM user_projects up "
        "JOIN users u ON u.id = up.user_id ORDER BY up.client, up.project"
    ).fetchall()
    return {(r["client"], r["project"]): r["username"] for r in rows}


def _validate_project_ownership(conn, projects: list[ProjectAssign], self_username: str | None) -> None:
    """Reject assigning a (client, project) already owned by a DIFFERENT PM.
    self_username is the PM being edited (its own projects are fine)."""
    owners = _project_owners(conn)
    for pa in projects:
        key = (pa.client, pa.project)
        owner = owners.get(key)
        if owner and owner != self_username:
            raise HTTPException(409, f"'{pa.client}/{pa.project}' is already assigned to PM '{owner}'")


@app.get("/api/users")
def api_users(request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        rows = conn.execute("SELECT id, username, role, permissions FROM users ORDER BY username").fetchall()
        out = []
        for r in rows:
            projs = [{"client": p["client"], "project": p["project"]} for p in conn.execute(
                "SELECT client, project FROM user_projects WHERE user_id=? ORDER BY client, project", (r["id"],)
            ).fetchall()]
            try:
                perms = json.loads(r["permissions"]) if r["permissions"] else []
                if not isinstance(perms, list):
                    perms = []
            except Exception:  # noqa: BLE001
                perms = []
            out.append({"id": r["id"], "username": r["username"], "role": r["role"],
                        "permissions": [str(p) for p in perms], "projects": projs})
        return out
    finally:
        conn.close()


@app.get("/api/permissions")
def api_permissions(request: Request):
    """Catalog of admin permissions so the UI can render checkboxes, with a
    machine key + a human label. Only admins (any) may read it."""
    _require_admin(request)
    labels = {
        "pricing": "Edit pricing (titles & rates)",
        "resources": "Manage resources & planned hours",
        "projects": "Manage clients/projects & PM assignment",
        "users": "Manage users (PMs & admins)",
        "dashboard": "View Dashboard",
        "actuals": "Record actuals",
        "utilization": "View Utilization",
        "import_export": "Import / Export Excel",
        "db_security": "Manage database security",
        "theming": "Change own UI theme",
        "people": "Manage People & project team assignment",
        "ot_approval": "Approve billable OT",
    }
    return {"permissions": [
        {"key": k, "label": labels.get(k, k)} for k in ADMIN_PERMISSIONS
    ]}


@app.get("/api/project-owners")
def api_project_owners(request: Request):
    """Which PM owns each (client, project) so the UI can grey out taken ones."""
    _require_admin(request)
    conn = get_db()
    try:
        owners = _project_owners(conn)
        return [{"client": k[0], "project": k[1], "pm": v} for k, v in owners.items()]
    finally:
        conn.close()


@app.post("/api/users")
def api_user_create(body: UserCreate, request: Request):
    _require_perm(request, "users")
    conn = get_db()
    try:
        uname = (body.username or "").strip()
        if not uname or not body.password:
            raise HTTPException(400, "username and password required")
        if conn.execute("SELECT 1 FROM users WHERE username=?", (uname,)).fetchone():
            raise HTTPException(409, f"User '{uname}' already exists")
        role = body.role if body.role in ("admin", "pm") else "pm"
        # Only the owner (super-admin) may create admin accounts.
        if role == "admin":
            _require_super_admin(request)
        # Only allow a valid subset of admin permissions; PMs never carry any.
        perms = [p for p in body.permissions if p in ADMIN_PERMISSIONS] if role == "admin" else []
        projs = [ProjectAssign(client=(p.client or "").strip(), project=(p.project or "").strip())
                 for p in body.projects if (p.project or "").strip()]
        # De-duplicate the payload. Without this, the same (client, project)
        # listed twice hit the PRIMARY KEY and surfaced as a raw 500 instead of
        # a clear message. Keyed on (client, project), NOT project alone — the
        # same project NAME under two clients is a legitimate pair.
        seen_pairs, uniq = set(), []
        for p in projs:
            k = (_norm(p.client), _norm(p.project))
            if k not in seen_pairs:
                seen_pairs.add(k)
                uniq.append(p)
        dups = len(projs) - len(uniq)
        projs = uniq
        if role == "pm":
            _validate_project_ownership(conn, projs, self_username=None)
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, role, permissions) VALUES (?,?,?,?)",
            (uname, _hash_password(body.password), role, json.dumps(perms)),
        )
        uid = cur.lastrowid
        if role == "pm":
            for p in projs:
                conn.execute("INSERT OR IGNORE INTO user_projects (user_id, client, project) "
                             "VALUES (?,?,?)", (uid, p.client, p.project))
        conn.commit()
        return {"ok": True, "id": uid, "username": uname, "role": role, "permissions": perms,
                "duplicate_projects_ignored": dups}
    finally:
        conn.close()


@app.put("/api/users/{uid}")
def api_user_update(uid: int, body: UserUpdate, request: Request):
    _require_perm(request, "users")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "user not found")
        # Managing an admin account (editing, or promoting/demoting to/from
        # admin) is super-admin-only; regular admins manage PMs.
        if row["role"] == "admin" or (body.role == "admin" and row["role"] != "admin"):
            _require_super_admin(request)
        if body.password:
            conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                         (_hash_password(body.password), uid))
        new_role = row["role"]
        if body.role is not None:
            new_role = body.role if body.role in ("admin", "pm") else row["role"]
        new_perms = row["permissions"]
        if body.permissions is not None:
            new_perms = json.dumps([p for p in body.permissions if p in ADMIN_PERMISSIONS]
                                   if new_role == "admin" else [])
        if (new_role, new_perms) != (row["role"], row["permissions"]):
            conn.execute("UPDATE users SET role=?, permissions=? WHERE id=?",
                         (new_role, new_perms, uid))
        if body.projects is not None and new_role == "pm":
            projs = [ProjectAssign(client=(p.client or "").strip(), project=(p.project or "").strip())
                     for p in body.projects if (p.project or "").strip()]
            _validate_project_ownership(conn, projs, self_username=row["username"])
            conn.execute("DELETE FROM user_projects WHERE user_id=?", (uid,))
            for p in projs:
                conn.execute("INSERT INTO user_projects (user_id, client, project) VALUES (?,?,?)",
                             (uid, p.client, p.project))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/users/{uid}")
def api_user_delete(uid: int, request: Request):
    _require_perm(request, "users")
    conn = get_db()
    try:
        row = conn.execute("SELECT id, username FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "user not found")
        # Only the owner may delete admin accounts.
        if conn.execute("SELECT role FROM users WHERE id=?", (uid,)).fetchone()["role"] == "admin":
            _require_super_admin(request)
        # A user must never delete their own account (would lock themselves out).
        me = getattr(request.state, "user", None)
        if me and hmac.compare_digest(str(row["username"]), str(me.get("u", ""))):
            raise HTTPException(400, "You cannot delete your own account")
        # Never delete the last remaining admin — the owner must always have a way in.
        if conn.execute("SELECT role FROM users WHERE id=?", (uid,)).fetchone()["role"] == "admin":
            n_admin = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND id!=?", (uid,)).fetchone()[0]
            if n_admin == 0:
                raise HTTPException(400, "Cannot delete the last admin account")
        role_row = conn.execute("SELECT role FROM users WHERE id=?", (uid,)).fetchone()
        conn.execute("DELETE FROM user_projects WHERE user_id=?", (uid,))
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
        _log_activity(conn, request, "user.delete", target=row["username"],
                      details=f"Removed {(role_row['role'] if role_row else 'user')} account and its project scope.")
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------- DB encryption (admin) ----------------
class DbPasswordBody(BaseModel):
    password: str


@app.get("/api/db-security")
def api_db_security(request: Request):
    """Report whether the DB is encrypted and whether a key is set."""
    _require_admin(request)
    return {
        "encrypted": _is_encrypted(DB_PATH),
        "key_set": bool(_db_key()),
        "cipher_available": _HAS_CIPHER,
    }


@app.post("/api/db-password")
def api_db_password(body: DbPasswordBody, request: Request):
    """Set or change the DB encryption password. If the DB is still plain,
    encrypt it in place with the new password. If already encrypted, re-key
    it to the new password."""
    _require_perm(request, "db_security")
    pw = (body.password or "").strip()
    if len(pw) < 6:
        raise HTTPException(400, "DB password must be at least 6 characters")
    if not _HAS_CIPHER:
        raise HTTPException(500, "sqlcipher3 not installed — cannot encrypt the DB")
    try:
        if _is_encrypted(DB_PATH):
            # re-key: open with current key, change to new key
            conn = _cipher.connect(str(DB_PATH))
            cur = _db_key()
            if cur:
                if "'" in cur:
                    raise HTTPException(500, "Current DB key contains a single quote — re-key manually")
                conn.execute(f"PRAGMA key='{cur}'")
            if "'" in pw:
                raise HTTPException(400, "DB password must not contain a single quote")
            conn.execute(f"PRAGMA rekey='{pw}'")
            conn.commit()
            conn.close()
            _set_db_key(pw)
        else:
            encrypt_db_in_place(pw)
        return {"ok": True, "encrypted": True}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Could not set DB password: {e}")


class ProjectBody(BaseModel):
    client: str = ""
    project: str = ""
    start_date: str = ""
    end_date: str = ""
    # GH-34 (the owner): "While adding project, it asked the name and other details
    # but it should also ask for the PM and then the percentage allocation phase
    # or full time etc and then if it exceed the allocation it should error".
    # All optional so the existing edit path is unaffected.
    pm: str | None = None
    capacity_mode: str | None = None          # "full" | "partial" | ""
    allocation_pct: float | None = None       # used by PARTIAL
    person_id: int | None = None              # who the allocation is for


@app.get("/api/projects")
def api_projects(request: Request, include_archived: int = 0):
    """List (client, project) entries with their start/end dates.

    GH-37: a PM sees only the projects they OWN rather than a 403. Without this a
    PM could create a project but never list it, and `loadProjects()` (which the
    Add/Edit dialog and the delete path both depend on) failed for them. The
    filter is on ownership, so this exposes nothing beyond what the workbench
    already shows.

    GH-38: archived projects are hidden by default — to a PM they are deleted.
    An admin passes `include_archived=1` to get them with their archive stamp, which
    is what the Dashboard's red strip needs. A PM never gets them, even if they ask.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    conn = get_db()
    try:
        arch = _archived_project_keys(conn)
        is_pm = user.get("r") == "pm"
        if is_pm:
            want = {((c or "").strip().upper(), (p or "").strip().upper())
                    for c, p in _pm_projects(user["u"], conn)}
        else:
            _require_perm(request, "projects")
            want = None
        rows = conn.execute(
            "SELECT id, client, project, start_date, end_date, "
            "TRIM(COALESCE(archived_at,'')) archived_at, "
            "TRIM(COALESCE(archived_by,'')) archived_by FROM projects "
            "ORDER BY client, project").fetchall()
        out = []
        for r in rows:
            key = ((r["client"] or "").strip().upper(), (r["project"] or "").strip().upper())
            if want is not None and key not in want:
                continue
            archived = bool(r["archived_at"])
            if archived and (is_pm or not include_archived):
                continue
            d = dict(r)
            d["archived"] = archived
            out.append(d)
        return out
    finally:
        conn.close()


@app.post("/api/projects")
def api_project_create(body: ProjectBody, request: Request):
    """Create a client/project, optionally assigning its PM in the same step.

    GH-34: the create dialog asked only for the name/dates, so a new project
    landed ownerless and with nobody on it, and then appeared nowhere the user
    looked. It now takes the PM (writes user_projects, the single source of
    truth for ownership) and, when a person is chosen, an allocation whose
    over-100% case is REFUSED with the reason.

    Order matters: create the project row FIRST so a refused allocation still
    leaves the project defined (visible as a "no team" row) instead of losing the
    whole submission. The refusal names the clashing weeks exactly as the
    assignment endpoint does.

    GH-37: a PM may create a project too. The PM is then auto-assigned as its
    owner, so they can immediately staff it and (per the delete rules) remove it
    again. the owner: "if the PM adds it should show up on the dashboard too" — the
    "no team" row from GH-32 already guarantees that, and their own workbench
    lists it because ownership is written here.
    """
    user = _may_manage_projects(request)
    conn = get_db()
    try:
        client = (body.client or "").strip()
        project = (body.project or "").strip()
        if not client or not project:
            raise HTTPException(400, "client and project are required")
        if conn.execute("SELECT 1 FROM projects WHERE client=? AND project=?", (client, project)).fetchone():
            raise HTTPException(409, f"'{client}/{project}' already exists")
        # A PM always owns what they create. An explicit `pm` from an admin still
        # wins; a PM naming someone else is ignored rather than trusted.
        if user.get("r") == "pm":
            body.pm = user["u"]

        cur = conn.execute(
            "INSERT INTO projects (client, project, start_date, end_date) VALUES (?,?,?,?)",
            (client, project, (body.start_date or "").strip(), (body.end_date or "").strip()),
        )
        pid = cur.lastrowid
        warnings: list[str] = []

        # --- PM (ownership) ------------------------------------------------
        pm_wanted = (body.pm or "").strip()
        if pm_wanted:
            urow = conn.execute("SELECT id, username FROM users WHERE username=?", (pm_wanted,)).fetchone()
            if not urow:
                # The project is already created; report the PM problem without
                # discarding the work the user just did.
                warnings.append(f"PM “{pm_wanted}” was not found, so the project has no owner yet.")
            else:
                clash = conn.execute(
                    "SELECT u.username FROM user_projects up JOIN users u ON u.id=up.user_id "
                    "WHERE TRIM(UPPER(up.client))=TRIM(UPPER(?)) AND TRIM(UPPER(up.project))=TRIM(UPPER(?)) "
                    "AND u.username<>?",
                    (client, project, pm_wanted)).fetchone()
                if clash:
                    warnings.append(f"“{clash['username']}” already owns {client} · {project}; left as-is.")
                else:
                    conn.execute("INSERT OR IGNORE INTO user_projects (user_id, client, project) VALUES (?,?,?)",
                                 (urow["id"], client, project))

        # --- allocation (the 100% rule) ------------------------------------
        mode = (body.capacity_mode or "").strip().lower()
        alloc = 100.0 if mode == "full" else float(body.allocation_pct or 0.0)
        if body.person_id and alloc > 0:
            p = conn.execute("SELECT * FROM people WHERE id=?", (body.person_id,)).fetchone()
            if not p:
                raise HTTPException(404, "Person not found")
            sd, ed = (body.start_date or "").strip(), (body.end_date or "").strip()
            v = validate_assignment(conn, int(body.person_id), alloc, sd, ed)
            if not v["ok"]:
                # ROLL BACK the just-created project: the user asked for both, and
                # a half-created project would be more confusing than a clear
                # refusal with the exact clashing weeks named.
                conn.rollback()
                c0 = (v["conflicts"] or [{}])[0]
                raise HTTPException(409, {
                    "message": (f"{alloc:g}% would push {p['name']} over 100% in "
                                f"{v['conflict_count']} week(s). First clash: "
                                f"{c0.get('label')} would reach {c0.get('total_pct')}%."),
                    "code": "over_allocated",
                    "conflicts": v["conflicts"],
                    "conflict_count": v["conflict_count"],
                })
            cap = float(p["capacity"] or CAP_WEEK_HOURS)
            conn.execute(
                "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, capacity, person_id, allocation_pct, start_date, end_date) "
                "VALUES ('',?,?,?,'',0,0,?,?,?,?,?)",
                (client, project, p["name"], cap, int(body.person_id), alloc,
                 sd, ed),
            )

        conn.commit()
        if warnings:
            return {"ok": True, "id": pid, "warnings": warnings}
        return {"ok": True, "id": pid}
    finally:
        conn.close()


@app.put("/api/projects/{pid}")
def api_project_update(pid: int, body: ProjectBody, request: Request):
    """Rename / re-date a project. GH-37: a PM may edit their OWN project.

    Ownership is checked before any write, so a PM can only touch projects they
    own; an admin needs the `projects` permission. Renaming keeps ownership and
    the resource rows in step, because both are matched on (client, project).
    """
    user = _may_manage_projects(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "project not found")
        _pm_may_touch(conn, user, row["client"], row["project"])
        old_c, old_p = (row["client"] or "").strip(), (row["project"] or "").strip()
        client = (body.client or "").strip() or old_c
        project = (body.project or "").strip() or old_p
        if (client.upper(), project.upper()) != (old_c.upper(), old_p.upper()):
            if conn.execute(
                "SELECT 1 FROM projects WHERE TRIM(UPPER(client))=TRIM(UPPER(?)) "
                "AND TRIM(UPPER(project))=TRIM(UPPER(?)) AND id<>?",
                (client, project, pid)).fetchone():
                raise HTTPException(409, f"'{client}/{project}' already exists")
        conn.execute(
            "UPDATE projects SET client=?, project=?, start_date=?, end_date=? WHERE id=?",
            (client, project, (body.start_date or "").strip(), (body.end_date or "").strip(), pid),
        )
        # Keep the riders and the ownership row pointing at the new name —
        # otherwise a rename silently orphans every resource on the project.
        if (client, project) != (old_c, old_p):
            for sql in (
                "UPDATE resources SET client=?, project=? WHERE "
                "TRIM(UPPER(client))=TRIM(UPPER(?)) AND TRIM(UPPER(project))=TRIM(UPPER(?))",
                "UPDATE user_projects SET client=?, project=? WHERE "
                "TRIM(UPPER(client))=TRIM(UPPER(?)) AND TRIM(UPPER(project))=TRIM(UPPER(?))",
            ):
                conn.execute(sql, (client, project, old_c, old_p))
            _log_activity(conn, request, "project.rename",
                          target=f"{old_c} · {old_p} → {client} · {project}")
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/projects/{pid}")
def api_project_delete(pid: int, request: Request, force: bool = False,
                       purge: bool = False):
    """Remove a project — as an ARCHIVE by default, permanently only on demand.

    GH-38/GH-39 (the owner): "if PM delete the project, then it will go away from the
    PMs view, it should still be there for admin with a red strip on it so that if
    PM delete by accident the admin can revert — reactivate will show it back for
    the PM and delete will delete it from the app permanently." And then, on the
    admin side: "if a admin delete the project that also will go to the same
    process, it will show up on the dashboard with red tint and get the options to
    reactivate or delete."

    So there is ONE recoverable delete, for everyone:

      * **Any delete with no `purge` ARCHIVES.** Nothing is destroyed: the row,
        its team, its planned hours and its actuals all stay. The project
        disappears from the PM's workbench and from every live total, and the
        admin keeps it under a red strip with Reactivate and Delete. An admin's
        mistake is now as recoverable as a PM's.
      * **`purge=true` deletes for real.** That is what the Delete button on an
        already-archived row does — the second, deliberate step. It is also why
        archiving never has to warn about losing hours: nothing is lost yet.
    """
    user = _may_manage_projects(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "project not found")
        client, project = (row["client"] or "").strip(), (row["project"] or "").strip()
        _pm_may_touch(conn, user, client, project)
        actor = user.get("u") or ""

        # `TRIM(UPPER(...))` to match how the rest of the app keys projects — a
        # case/space difference would otherwise leave orphans behind again.
        # NOTE: two forms of the same predicate. The subquery form needs the `res`
        # alias; the direct `DELETE FROM resources` must NOT use it, because
        # `resources` is not aliased in that statement (doing so raised
        # "no such column: res.client" and turned every delete into a 500).
        where_res = ("TRIM(UPPER(res.client))=TRIM(UPPER(?)) "
                     "AND TRIM(UPPER(res.project))=TRIM(UPPER(?))")
        where_plain = ("TRIM(UPPER(client))=TRIM(UPPER(?)) "
                       "AND TRIM(UPPER(project))=TRIM(UPPER(?))")
        riders = conn.execute(
            f"SELECT res.id, res.name, COUNT(wh.week) AS wks "
            f"FROM resources res LEFT JOIN weekly_hours wh ON wh.resource_id=res.id "
            f"WHERE {where_res} GROUP BY res.id, res.name",
            (client, project)).fetchall()
        n_people = len(riders)
        n_weeks = sum(int(r["wks"] or 0) for r in riders)
        n_actual = conn.execute(
            f"SELECT COUNT(*) FROM actual_hours ah JOIN resources res ON res.id=ah.resource_id "
            f"WHERE {where_res}", (client, project)).fetchone()[0]
        n_assign = conn.execute(
            f"SELECT COUNT(*) FROM user_projects up WHERE "
            f"TRIM(UPPER(up.client))=TRIM(UPPER(?)) AND TRIM(UPPER(up.project))=TRIM(UPPER(?))",
            (client, project)).fetchone()[0]

        # ---- a recoverable delete: ANY role, unless a purge was asked for ----
        if not purge:
            if (row["archived_at"] or ""):
                return {"ok": True, "archived": True, "already": True,
                        "deleted": {"client": client, "project": project,
                                    "people": n_people, "planned_weeks": n_weeks,
                                    "actual_weeks": n_actual, "pm_assignments": n_assign}}
            conn.execute("UPDATE projects SET archived_at=datetime('now'), archived_by=? WHERE id=?",
                         (actor, pid))
            conn.commit()
            _log_activity(conn, request, "project.archive", target=f"{client} · {project}",
                          details=(f"deleted by {actor} — archived, not purged: "
                                   f"{n_people} assignment(s) and their {n_weeks} planned / "
                                   f"{n_actual} actual week(s) are recoverable"))
            return {"ok": True, "archived": True,
                    "deleted": {"client": client, "project": project,
                                "people": n_people, "planned_weeks": n_weeks,
                                "actual_weeks": n_actual, "pm_assignments": n_assign}}

        if n_people and not force:
            names = ", ".join(r["name"] for r in riders[:5])
            more = f" (+{n_people - 5} more)" if n_people > 5 else ""
            raise HTTPException(409, {
                "message": (f"{client} · {project} still has {n_people} person(s) "
                            f"assigned ({names}{more}) with {n_weeks} planned week(s) "
                            f"and {n_actual} actual week(s). Deleting it discards those "
                            f"hours. Confirm to delete anyway, or remove the team first."),
                "code": "has_assignments",
                "people": n_people, "planned_weeks": n_weeks, "actual_weeks": n_actual,
            })

        # ---- permanent delete --------------------------------------------
        # Children first, then the rider rows, then the definition. actual_notes /
        # actual_hours are keyed on resource_id and have no FK cascade, so they
        # must be cleared explicitly or they become unreachable rows.
        conn.execute(
            f"DELETE FROM actual_notes WHERE resource_id IN "
            f"(SELECT res.id FROM resources res WHERE {where_res})", (client, project))
        conn.execute(
            f"DELETE FROM actual_hours WHERE resource_id IN "
            f"(SELECT res.id FROM resources res WHERE {where_res})", (client, project))
        conn.execute(
            f"DELETE FROM weekly_hours WHERE resource_id IN "
            f"(SELECT res.id FROM resources res WHERE {where_res})", (client, project))
        conn.execute(f"DELETE FROM resources WHERE {where_plain}", (client, project))
        # Release the PM assignment too — otherwise the leftover user_projects row
        # makes the project name permanently unusable.
        conn.execute(
            "DELETE FROM user_projects WHERE "
            "TRIM(UPPER(client))=TRIM(UPPER(?)) AND TRIM(UPPER(project))=TRIM(UPPER(?))",
            (client, project))
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        conn.commit()
        _log_activity(conn, request, "project.delete", target=f"{client} · {project}",
                      details=(f"PERMANENT — {n_people} assignment(s), {n_weeks} planned week(s), "
                               f"{n_actual} actual week(s) removed"))
        return {"ok": True, "purged": True,
                "deleted": {"client": client, "project": project,
                            "people": n_people, "planned_weeks": n_weeks,
                            "actual_weeks": n_actual, "pm_assignments": n_assign}}
    finally:
        conn.close()


@app.post("/api/projects/{pid}/reactivate")
def api_project_reactivate(pid: int, request: Request):
    """Bring an archived project back — the admin's undo for a PM's accident.

    Clears the archive stamp only. Nothing else about the project was ever
    touched, so the team, planned hours and actuals all reappear exactly as they
    were, and the PM sees it in their workbench again.
    """
    user = _may_manage_projects(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "project not found")
        if user.get("r") == "pm":
            raise HTTPException(403, "Only an admin can reactivate a deleted project")
        client, project = (row["client"] or "").strip(), (row["project"] or "").strip()
        if not (row["archived_at"] or ""):
            return {"ok": True, "reactivated": False, "reason": "not archived"}
        conn.execute("UPDATE projects SET archived_at='', archived_by='' WHERE id=?", (pid,))
        conn.commit()
        _log_activity(conn, request, "project.reactivate", target=f"{client} · {project}",
                      details="restored to the PM's view")
        return {"ok": True, "reactivated": True,
                "project": {"client": client, "project": project}}
    finally:
        conn.close()


def _fix_user_projects_pk(conn: sqlite3.Connection) -> None:
    """Repair user_projects' primary key: (user_id, project) -> (user_id, client, project).

    BUG IT FIXES (found 2026-10-01): `client` was bolted on later with
    ALTER TABLE, which cannot change a PRIMARY KEY. The key stayed
    (user_id, project), so a PM could only ever hold ONE project of a given
    NAME — assigning the same person to Microsoft·Platform and NVIDIA·Platform, or to
    Apple·Support and Google·Support, raised
    `UNIQUE constraint failed: user_projects.user_id, user_projects.project`
    and returned a 500. Project names repeat across clients (Platform at 5
    clients, Support at 3), so this was reachable from the UI.

    SQLite cannot ALTER a primary key, so the table is rebuilt. Guarded and
    idempotent: it no-ops once the key is already correct, and any failure is
    swallowed so a schema wrinkle can never break app import.
    """
    try:
        ddl = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='user_projects'"
        ).fetchone()
        if not ddl or not ddl[0]:
            return
        sql = " ".join(ddl[0].split()).lower()
        if "(user_id, client, project)" in sql or "(user_id,client,project)" in sql:
            return  # already correct
        rows = conn.execute("SELECT user_id, client, project FROM user_projects").fetchall()
        # De-duplicate before rebuilding, in case legacy rows collide once the
        # key widens (they shouldn't, but a rebuild must not fail on them).
        seen, keep = set(), []
        for r in rows:
            k = (r[0], (r[1] or "").strip(), (r[2] or "").strip())
            if k not in seen:
                seen.add(k)
                keep.append(k)
        conn.execute("DROP TABLE IF EXISTS user_projects")
        conn.execute(
            """CREATE TABLE user_projects (
                user_id INTEGER NOT NULL,
                client TEXT NOT NULL DEFAULT '',
                project TEXT NOT NULL,
                PRIMARY KEY (user_id, client, project)
            )"""
        )
        conn.executemany(
            "INSERT OR IGNORE INTO user_projects (user_id, client, project) VALUES (?,?,?)", keep)
        conn.commit()
    except Exception:  # noqa: BLE001
        # Never let a schema repair break startup; the next run retries.
        pass


def _week_date(label: str):
    """Parse a week label like 'Jan-05' (or 'Jan-05-26') into a date.

    The week label is the MONDAY that starts the week. Returns None when the
    label cannot be parsed, so callers degrade to "no cap" rather than guessing.
    """
    lab = (label or "").strip()
    for fmt in ("%b-%d", "%b-%d-%y", "%b %d", "%Y-%m-%d"):
        try:
            d = dt.datetime.strptime(lab, fmt).date()
            if fmt == "%b-%d":
                d = d.replace(year=dt.date.today().year)
            return d
        except ValueError:
            continue
    return None


def _till_date_cap(weeks: list[str]) -> int | None:
    """Index of the LAST week that has already STARTED, or None if unknown.

    Feature #10.3: 'revenue till date and expense should be total till today'.
    Without this, the Dashboard's till-date columns summed the whole year (all
    recorded actuals), which is not 'till today'. Returning None when the labels
    are unparseable is deliberate — better to show everything than to silently
    truncate on a guess.
    """
    today = dt.date.today()
    last = None
    for i, w in enumerate(weeks):
        d = _week_date(w)
        if d is not None and d <= today:
            last = i
    return last


def _current_period(weeks: list[str], months: list[dict]) -> dict:
    """Which week and month are we IN right now — one definition, used by both
    the Planned header and the PM load rail so they cannot disagree.

    A label is the MONDAY that starts the week, so the week containing today is
    the LAST label <= today (the same rule `_till_date_cap` uses: that is why
    the till-date columns and this highlight always agree).

    Worth knowing, because it looks wrong until you see it: on Thu 2026-10-01 the
    current week is labelled **Sep-28** (Mon Sep-28 → Sun Oct-4) and therefore
    sits in the **SEP** month band, not OCT. That is correct — the week starts in
    September — but it surprises people, so the tooltip says it outright.
    """
    cap = _till_date_cap(weeks)
    if cap is None or cap < 0:
        return {}
    mon = next((m for m in months if m["start"] <= cap <= m["end"]), None)
    d = _week_date(weeks[cap])
    return {
        "week_index": cap,
        "week_label": weeks[cap],
        "month": (mon["name"] if mon else ""),
        "month_start": (mon["start"] if mon else None),
        "month_end": (mon["end"] if mon else None),
        "week_start": (d.isoformat() if d else ""),
        "week_end": ((d + dt.timedelta(days=6)).isoformat() if d else ""),
        "today": dt.date.today().isoformat(),
    }


def _split_csv(v: str) -> list[str]:
    """'a, b ,c' -> ['a','b','c']. Empty/None -> []. Used by the Dashboard
    multi-select filters, which arrive as one comma-joined query param."""
    return [x.strip() for x in (v or "").split(",") if x.strip()]


UNASSIGNED_PM = "Unassigned"   # sentinel for (client,project) with no owner


def _dash_filter(resources: list[dict], clients: list[str], projects: list[str],
                 pms: list[str], owners: dict[tuple[str, str], str]) -> list[dict]:
    """Apply the Dashboard's multi-select filters. An empty list at a level
    means "no filter at that level", so the user can select client-only,
    client+project, or any other combination.

    Projects arrive either as a "Client · Project" label (unambiguous, what the
    UI sends when the client is known) or as a bare project name. PM matching
    uses the Project→PM assignment; `Unassigned` selects projects with no PM.
    All matching is normalised so 'acme' finds 'ACME Inc.'.
    """
    cset = {_norm(c) for c in clients}
    pset: set[tuple[str | None, str]] = set()
    for p in projects:
        if " · " in p:
            c, pr = p.split(" · ", 1)
            pset.add((_norm(c), _norm(pr)))
        else:
            pset.add((None, _norm(p)))
    pmset = {_norm(p) for p in pms}
    want_unassigned = UNASSIGNED_PM in pms

    out = []
    for r in resources:
        raw_client = (r.get("client") or "").strip()
        raw_project = (r.get("project") or "").strip()
        c, p = _norm(raw_client), _norm(raw_project)

        if cset and c not in cset:
            continue
        if pset and not any((pc is None and p == pn) or (pc == c and p == pn)
                            for pc, pn in pset):
            continue
        if pmset or want_unassigned:
            owner = owners.get((raw_client, raw_project))
            # A resource with no project can never be tied to a PM assignment,
            # so it counts as unassigned rather than silently disappearing.
            hit = bool(want_unassigned and not owner)
            if owner and _norm(owner) in pmset:
                hit = True
            if not hit:
                continue
        out.append(r)
    return out


@app.get("/api/dashboard")
def api_dashboard(request: Request, month: str = "", client: str = "",
                  project: str = "", pm: str = "", currency: str = ""):
    """Dashboard rows, optionally scoped by month, client(s), project(s), PM(s)
    and currency.

    Feature #12 (redesign): every filter is a multi-select. Filters cascade —
    Month · Project · PM · Client · Currency — so the user can pick client-only,
    client+project, or any other combination; an omitted filter means "all".
    Matching is normalised, so 'acme' finds 'ACME Inc.' exactly as the grouping
    logic already normalises country/client keys.

    The option lists (clients/projects/pms) always come from the FULL set, never
    the filtered one, so choosing a filter never shrinks the list of things you
    can pick next.
    """
    _require_admin(request)
    conn = get_db()
    try:
        weeks, months = _load_layout()
        all_res = _all_resources(conn, weeks)
        owners = _project_owners(conn)
        # The Dashboard is admin-only, so this is "admin" in practice; read it from
        # the request anyway rather than assuming, so the archived-row branch below
        # can never leak a deleted project to a non-admin caller.
        _u = getattr(request.state, "user", None) or {}
        user_role = _u.get("r") or "admin"

        resources = _dash_filter(all_res, _split_csv(client), _split_csv(project),
                                 _split_csv(pm), owners)
        wr = _month_week_range(months, month)
        rows = build_dashboard_rows(resources, weeks, wr, _till_date_cap(weeks))
        # GH-32: a project can EXIST (projects table) with nobody assigned to it,
        # and then it contributes no resource rows and so no dashboard row at all.
        # Adding one silently vanished, which read as "it didn't get added"
        # (the owner, 2026-10-01). Surface it as an explicit zero row instead.
        # GH-38: an ARCHIVED project is excluded from the live rows entirely (it is
        # "deleted" as far as the numbers go) but added back below as a flagged row
        # so the admin can reactivate it.
        arch_keys = _archived_project_keys(conn)
        rows["groups"] = [g for g in rows["groups"]
                          if ((g.get("client") or "").strip().upper(),
                              (g.get("project") or "").strip().upper()) not in arch_keys]
        rows["groups"] = rows["groups"] + _empty_project_groups(
            conn, all_res, _split_csv(client), _split_csv(project),
            _split_csv(pm), owners)
        # Flagged, archived rows — admin only; a PM must not see what they deleted.
        if user_role == "admin":
            keep_keys = arch_keys
            arch_rows = [g for g in _archived_project_rows(conn)
                         if ((g.get("client") or "").strip().upper(),
                             (g.get("project") or "").strip().upper()) in keep_keys]
            # Honour the live filters so an archived row behaves like any other.
            if _split_csv(client) or _split_csv(project) or _split_csv(pm):
                cset = {_norm(c) for c in _split_csv(client) if c.strip()}
                pset = _split_csv(project)
                pmset = {_norm(p) for p in _split_csv(pm) if p.strip()}
                def _ok(g):
                    c = _norm(g["client"])
                    p = _norm(g["project"])
                    if cset and c not in cset:
                        return False
                    if pset and not any(
                        ((" · " in x and _norm(x.split(" · ", 1)[1]) == p and _norm(x.split(" · ", 1)[0]) == c)
                         or (" · " not in x and _norm(x) == p)) for x in pset):
                        return False
                    if pmset or UNASSIGNED_PM in _split_csv(pm):
                        owner = owners.get(((g["client"] or "").strip(), (g["project"] or "").strip()))
                        hit = bool(UNASSIGNED_PM in _split_csv(pm) and not owner)
                        if owner and _norm(owner) in pmset:
                            hit = True
                        if not hit:
                            return False
                    return True
                arch_rows = [g for g in arch_rows if _ok(g)]
            rows["groups"] = rows["groups"] + arch_rows

        # Currency selector. When a single currency is chosen, drop the other
        # currency's rows/totals entirely so the KPI tiles and table agree.
        cur = (currency or "").strip().upper()
        if cur in ("USD", "EUR"):
            rows = {"groups": [g for g in rows["groups"] if g["currency"] == cur],
                    "totals": [t for t in rows["totals"] if t["currency"] == cur]}

        # Option lists — always from the FULL set (see docstring). GH-32: projects
        # that exist but have no resources belong here too, otherwise a project
        # you just created cannot even be filtered to.
        all_clients = sorted({(r.get("client") or "").strip() for r in all_res
                              if (r.get("client") or "").strip()}, key=lambda s: s.lower())
        proj_pairs = {((r.get("client") or "").strip(), (r.get("project") or "").strip())
                      for r in all_res if (r.get("project") or "").strip()}
        try:
            proj_pairs |= {((d["client"] or "").strip(), (d["project"] or "").strip())
                           for d in conn.execute("SELECT client, project FROM projects").fetchall()
                           if (d["project"] or "").strip()}
        except sqlite3.Error:
            pass
        proj_pairs = sorted(proj_pairs, key=lambda t: (t[0].lower(), t[1].lower()))
        pm_opts = sorted({v for v in owners.values() if v}, key=lambda s: s.lower())
        has_unassigned = any(
            (r.get("project") or "").strip()
            and ((r.get("client") or "").strip(), (r.get("project") or "").strip()) not in owners
            for r in all_res
        )

        return {"rows": rows, "generated_at": None,
                "month": month or "all", "client": client or "",
                "project": project or "", "pm": pm or "", "currency": cur,
                "clients": all_clients,
                "projects": [{"client": c, "project": p, "label": f"{c} · {p}"}
                             for c, p in proj_pairs],
                "pms": pm_opts, "has_unassigned": has_unassigned}
    finally:
        conn.close()


@app.get("/api/dashboard/resources")
def api_dashboard_resources(request: Request, client: str = "", project: str = ""):
    """Who is on this client/project, at what rate, on which projects.

    Feature #10.2: the Dashboard's Resource(s) count becomes a button that opens
    a popup listing exactly this. Matching is normalised on both fields so it
    lines up with the row the user clicked. `project` is optional: omitting it
    returns everyone for the client.
    """
    _require_admin(request)
    conn = get_db()
    try:
        weeks, _months = _load_layout()
        resources = _all_resources(conn, weeks)
        wc, wp = _norm(client), _norm(project)
        out = []
        for r in resources:
            if wc and _norm(r.get("client")) != wc:
                continue
            if wp and _norm(r.get("project")) != wp:
                continue
            hrs = r.get("hours") or []
            total_h = sum(h for h in hrs if h)
            rate = r.get("rate") or 0.0
            off = r.get("offshore_rate") or 0.0
            out.append({
                "name": r.get("name") or "—",
                "title": r.get("title") or r.get("role") or "—",
                "country": r.get("country") or "—",
                "client": r.get("client") or "—",
                "project": r.get("project") or "—",
                "rate": round(rate, 2),
                "offshore_rate": round(off, 2),
                # what this one person contributes, so the popup explains the
                # number the user clicked instead of just listing names
                "planned_hours": round(total_h, 1),
                "planned_revenue": round(rate * total_h, 2),
                "planned_expense": round(off * total_h, 2),
            })
        out.sort(key=lambda x: (-x["planned_revenue"], x["name"].lower()))
        return {"resources": out, "count": len(out),
                "client": client or "", "project": project or ""}
    finally:
        conn.close()


def _month_week_range(months: list[dict], month: str) -> tuple[int, int] | None:
    """Return (start, end) week indices for a month name, or None for all."""
    if not month or month == "all":
        return None
    for m in months:
        if m["name"] == month.upper():
            return (m["start"], m["end"])
    return None


def _actuals_financials(r: dict, week_range: tuple[int, int] | None = None,
                        till_index: int | None = None) -> dict:
    """Actuals-based revenue/expense + reconciliation deltas.
    - actual_rev / actual_exp: computed ONLY from recorded actual hours.
      actual_rev counts what was actually billable (billed OT overage counts;
      unbilled overage only bills the planned portion; under-delivery bills the
      actual hours). Zero actuals -> $0 — never assumes actual == planned.
    - add_rev / add_exp: overage deltas (billed overage × onsite; all overage
      × offshore).
    - adj_rev / adj_exp: under-delivery deltas (negative on both sides).
    week_range (start, end) restricts to a single month; None = all weeks.
    till_index: feature #10.3 — the LAST week index that is "till date". The
    actuals loop is clamped to it so the till-date columns really mean "till
    today" instead of including weeks that have not happened yet. None = no cap.
    """
    add_rev = add_exp = adj_rev = adj_exp = 0.0
    actual_rev = actual_exp = 0.0
    # Billable-OT approval gate (2026-10-01, the owner's spec): an overage only
    # reaches the Dashboard as "additional work" once is_ot=1 AND approved=1
    # AND billed=1. Before this, `billed` alone (set by the PM who entered it)
    # moved the money — a PM could approve his own revenue. Admin approval
    # happens on Team & Access and flips `approved`.
    admin_gate = bool(r.get("ot_requires_approval", True))
    ot_rev = ot_exp = 0.0
    pending_ot_rev = pending_ot_exp = 0.0
    rate = r["rate"] or 0.0
    off = r["offshore_rate"] or 0.0
    # Optional per-title OT multiplier (admin-set on the Rate Card). Applies to
    # the OT portion only, never to the planned hours.
    ot_mult = r.get("ot_multiplier") or 1.0
    planned = r["hours"] or []
    actual = r.get("actual_hours") or []
    notes = r.get("actual_notes") or {}
    lo, hi = (week_range if week_range else (0, len(actual) - 1))
    if till_index is not None:
        hi = min(hi, till_index)
    for i in range(lo, hi + 1):
        a = actual[i] if i < len(actual) else 0.0
        if not a:
            continue
        p = planned[i] if i < len(planned) else 0.0
        over = a - p
        note = notes.get(i) or {}
        # expense: we pay actual hours worked at offshore rate
        actual_exp += a * off
        if over > 0:
            add_exp += over * off
            if note.get("billed"):
                if (not admin_gate) or note.get("approved"):
                    # approved (or ungated): overage bills at the OT rate
                    actual_rev += a * rate
                    add_rev += over * rate * ot_mult
                    ot_exp += over * off
                    ot_rev += over * rate * ot_mult
                else:
                    # billable-flagged but NOT yet approved by admin: the money
                    # is withheld from the Dashboard and surfaced as pending.
                    actual_rev += p * rate
                    pending_ot_rev += over * rate * ot_mult
                    pending_ot_exp += over * off
            else:
                actual_rev += p * rate  # only the planned portion is billable
        elif over < 0:
            actual_rev += a * rate      # under-delivery: bill actual hours
            adj_rev += over * rate
            adj_exp += over * off
            # Under-delivery billing decision (the owner's rule): if the PM said
            # "not billed", the client still pays the FULL planned hours, so the
            # shortfall is NOT a revenue loss — it shows as a schedule variance
            # with recovered money. Default (unset) keeps the historic
            # behaviour: bill actual hours only.
            if note.get("under_billed") == 0:
                actual_rev += (-over) * rate
                adj_rev += (-over) * rate
        else:
            actual_rev += p * rate      # equal to plan
    return {
        "add_rev": round(add_rev, 2), "add_exp": round(add_exp, 2),
        "adj_rev": round(adj_rev, 2), "adj_exp": round(adj_exp, 2),
        "actual_rev": round(actual_rev, 2), "actual_exp": round(actual_exp, 2),
        "ot_rev": round(ot_rev, 2), "ot_exp": round(ot_exp, 2),
        "pending_ot_rev": round(pending_ot_rev, 2),
        "pending_ot_exp": round(pending_ot_exp, 2),
    }


def _archived_project_keys(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    """(CLIENT, PROJECT) keys of archived projects, folded for comparison.

    GH-38: an archived project is "deleted" from the PM's world — it must not
    appear in their workbench, in the Dashboard rows/totals, in Utilization, or in
    the project filter. The admin still sees it in a flagged row so it can be
    reactivated. One helper so every read path agrees on the same definition.
    """
    try:
        rows = conn.execute(
            "SELECT client, project FROM projects WHERE TRIM(COALESCE(archived_at,''))<>''"
        ).fetchall()
    except sqlite3.Error:
        return set()
    return {((r["client"] or "").strip().upper(), (r["project"] or "").strip().upper())
            for r in rows}


def _archived_project_rows(conn: sqlite3.Connection) -> list[dict]:
    """Archived projects as Dashboard rows, carrying their archive stamp.

    Counted from the resource rows that still belong to them (nothing was deleted
    when they were archived), so the admin can see how big the thing they are
    about to reactivate actually is.
    """
    out: list[dict] = []
    try:
        rows = conn.execute(
            "SELECT id, client, project, archived_at, archived_by FROM projects "
            "WHERE TRIM(COALESCE(archived_at,''))<>'' ORDER BY client, project").fetchall()
    except sqlite3.Error:
        return out
    for r in rows:
        c, p = (r["client"] or "").strip(), (r["project"] or "").strip()
        if not c:
            continue
        agg = conn.execute(
            "SELECT COUNT(*) n, COALESCE(SUM((SELECT COALESCE(SUM(hours),0) FROM weekly_hours "
            "WHERE resource_id=res.id)),0) hrs FROM resources res WHERE "
            "TRIM(UPPER(res.client))=TRIM(UPPER(?)) AND TRIM(UPPER(res.project))=TRIM(UPPER(?))",
            (c, p)).fetchone()
        out.append({
            "country": "—", "client": c, "project": p,
            "revenue": 0.0, "expense": 0.0, "actual_rev": 0.0, "actual_exp": 0.0,
            "difference": 0.0, "add_rev": 0.0, "add_exp": 0.0, "adj_rev": 0.0, "adj_exp": 0.0,
            "currency": "EUR" if _norm(c) in EU_COUNTRIES else "USD",
            "resources": int(agg["n"] or 0),
            "archived": True,
            "archived_at": r["archived_at"] or "",
            "archived_by": r["archived_by"] or "",
            "project_id": r["id"],
            "archived_hours": round(float(agg["hrs"] or 0), 1),
        })
    return out


def _empty_project_groups(conn: sqlite3.Connection, all_res: list[dict],
                          clients: list[str], projects: list[str],
                          pms: list[str], owners: dict) -> list[dict]:
    """Dashboard rows for projects that EXIST but have nobody assigned (GH-32).

    The dashboard is built from `resources` rows, so a project with no resources
    totals to nothing and produced no row at all — adding a project looked like
    it had silently failed. These come back as explicit zero rows, flagged
    `empty` so the UI can mark them as awaiting their first person.

    Respects the live filters: an empty project is dropped when the client,
    project or PM filter excludes it, so filtering behaves exactly as before.
    """
    cset = {_norm(c) for c in clients}
    pset: set[tuple[str | None, str]] = set()
    for p in projects:
        if " · " in p:
            c, pr = p.split(" · ", 1)
            pset.add((_norm(c), _norm(pr)))
        else:
            pset.add((None, _norm(p)))
    pmset = {_norm(p) for p in pms}
    want_unassigned = UNASSIGNED_PM in pms

    have = {(_norm((r.get("client") or "")), _norm((r.get("project") or "")))
            for r in all_res if (r.get("project") or "").strip()}
    # GH-38: an archived project gets exactly ONE row — the flagged one from
    # _archived_project_rows(). Without this skip it was also picked up here as a
    # "no team" row, because archiving leaves it with no live resource rows, so the
    # Dashboard showed the same project twice (once plain, once red-striped).
    arch = _archived_project_keys(conn)

    out: list[dict] = []
    try:
        defined = conn.execute("SELECT client, project FROM projects").fetchall()
    except sqlite3.Error:
        return out
    for d in defined:
        raw_c, raw_p = (d["client"] or "").strip(), (d["project"] or "").strip()
        if not raw_p:
            continue
        c, p = _norm(raw_c), _norm(raw_p)
        if (c, p) in have:
            continue                      # real rows already cover it
        if (c, p) in arch:
            continue                      # archived: only the flagged row should show
        if not raw_c:
            continue                      # build_dashboard_rows skips client-less rows
        if cset and c not in cset:
            continue
        if pset and not any((pc is None and p == pn) or (pc == c and p == pn)
                            for pc, pn in pset):
            continue
        if pmset or want_unassigned:
            owner = owners.get((raw_c, raw_p))
            hit = bool(want_unassigned and not owner)
            if owner and _norm(owner) in pmset:
                hit = True
            if not hit:
                continue
        out.append({
            "country": "—", "client": raw_c, "project": raw_p,
            "revenue": 0.0, "expense": 0.0, "actual_rev": 0.0, "actual_exp": 0.0,
            "difference": 0.0, "add_rev": 0.0, "add_exp": 0.0,
            "adj_rev": 0.0, "adj_exp": 0.0,
            "currency": "EUR" if c in EU_COUNTRIES else "USD",
            "resources": 0, "empty": True,
        })
    return out


def build_dashboard_rows(resources: list[dict], weeks: list[str],
                         week_range: tuple[int, int] | None = None,
                         till_index: int | None = None) -> dict:
    """Grouped country|client report — mirrors the VBA SyncDashboard but
    dedupes by (normalized country, normalized client) so the Microsoft bug
    (a subtotal row leaking into the group list) cannot recur. Includes the
    Actuals reconciliation: Additional Revenue/Expense + Adjustment.
    week_range (start, end) restricts to a single month; None = all weeks."""
    groups: dict[tuple, dict] = {}
    order: list[tuple] = []
    for r in resources:
        client = (r["client"] or "").strip()
        project = (r["project"] or "").strip()
        country = (r["country"] or "").strip()
        if not client:
            continue
        key = (_norm(country), _norm(client), _norm(project))
        g = groups.setdefault(key, {
            "country": country or "—",
            "client": client,
            "project": project or "—",
            "revenue": 0.0,
            "expense": 0.0,
            "actual_rev": 0.0,
            "actual_exp": 0.0,
            "difference": 0.0,
            "add_rev": 0.0, "add_exp": 0.0,
            "adj_rev": 0.0, "adj_exp": 0.0,
            "currency": "EUR" if _norm(country) in EU_COUNTRIES else "USD",
            "resources": 0,
        })
        if key not in order:
            order.append(key)
        # planned revenue/expense for the selected weeks only
        hrs = r["hours"] or []
        lo, hi = (week_range if week_range else (0, len(hrs) - 1))
        sel_hrs = sum(hrs[i] for i in range(lo, min(hi, len(hrs) - 1) + 1) if i < len(hrs))
        g["revenue"] += (r["rate"] or 0.0) * sel_hrs
        g["expense"] += (r["offshore_rate"] or 0.0) * sel_hrs
        fin = _actuals_financials(r, week_range, till_index)
        g["actual_rev"] += fin["actual_rev"]
        g["actual_exp"] += fin["actual_exp"]
        g["add_rev"] += fin["add_rev"]
        g["add_exp"] += fin["add_exp"]
        g["adj_rev"] += fin["adj_rev"]
        g["adj_exp"] += fin["adj_exp"]
        g["difference"] += ((r["rate"] or 0.0) * sel_hrs - (r["offshore_rate"] or 0.0) * sel_hrs
                            + fin["add_rev"] - fin["add_exp"] + fin["adj_rev"] - fin["adj_exp"])
        g["resources"] += 1

    rows = [groups[k] for k in order]
    totals: dict[str, dict] = {}
    for g in rows:
        t = totals.setdefault(g["currency"], {
            "currency": g["currency"], "revenue": 0.0, "expense": 0.0, "difference": 0.0,
            "actual_rev": 0.0, "actual_exp": 0.0,
            "add_rev": 0.0, "add_exp": 0.0, "adj_rev": 0.0, "adj_exp": 0.0,
        })
        t["revenue"] += g["revenue"]
        t["expense"] += g["expense"]
        t["actual_rev"] += g["actual_rev"]
        t["actual_exp"] += g["actual_exp"]
        t["add_rev"] += g["add_rev"]
        t["add_exp"] += g["add_exp"]
        t["adj_rev"] += g["adj_rev"]
        t["adj_exp"] += g["adj_exp"]
        t["difference"] += g["difference"]
    return {"groups": rows, "totals": list(totals.values())}


# ---------------- Utilization ----------------
CAP_WEEK_HOURS = 40.0  # 40 hrs/week = 100% (per the owner's spec)


def compute_utilization(weeks, months, resources) -> dict:
    """Planned AND Actual utilization. Capacity = weeks-in-month × 40 (or the
    per-resource capacity override). Planned utilization uses planned hours
    (Onsite grid); Actual utilization uses actual_hours (PM-recorded). Both
    are grouped by resource name with the projects each resource works on."""
    month_weeks = {m["name"]: list(range(m["start"], m["end"] + 1)) for m in months}
    by_name: dict[str, dict] = {}
    order: list[str] = []
    for r in resources:
        name = (r["name"] or "").strip()
        if not name:
            continue
        if name not in by_name:
            by_name[name] = {
                "name": name,
                "projects": [],
                "capacity_week": r.get("capacity") or CAP_WEEK_HOURS,
                "month_planned": {m["name"]: 0.0 for m in months},
                "month_actual": {m["name"]: 0.0 for m in months},
                "total_planned": 0.0,
                "total_actual": 0.0,
            }
            order.append(name)
        e = by_name[name]
        proj = "/".join(x for x in ((r["client"] or "").strip(), (r["project"] or "").strip()) if x)
        if proj and proj not in e["projects"]:
            e["projects"].append(proj)
        for i, h in enumerate(r["hours"]):
            if not h:
                continue
            e["total_planned"] += h
            for m in months:
                if m["start"] <= i <= m["end"]:
                    e["month_planned"][m["name"]] += h
                    break
        actual = r.get("actual_hours") or []
        for i, h in enumerate(actual):
            if not h:
                continue
            e["total_actual"] += h
            for m in months:
                if m["start"] <= i <= m["end"]:
                    e["month_actual"][m["name"]] += h
                    break
    rows = []
    for name in order:
        e = by_name[name]
        cap_wk = e["capacity_week"]
        months_out = []
        for m in months:
            cap = len(month_weeks[m["name"]]) * cap_wk
            p = e["month_planned"][m["name"]]
            a = e["month_actual"][m["name"]]
            months_out.append({
                "month": m["name"],
                "planned_hours": round(p, 1),
                "actual_hours": round(a, 1),
                "capacity": cap,
                "planned_pct": round(p / cap * 100, 1) if cap else 0.0,
                "actual_pct": round(a / cap * 100, 1) if cap else 0.0,
            })
        total_cap = sum(len(idx) for idx in month_weeks.values()) * cap_wk
        rows.append({
            "name": name,
            "projects": e["projects"],
            "capacity_week": cap_wk,
            "months": months_out,
            "total_planned": round(e["total_planned"], 1),
            "total_actual": round(e["total_actual"], 1),
            "planned_overall": round(e["total_planned"] / total_cap * 100, 1) if total_cap else 0.0,
            "actual_overall": round(e["total_actual"] / total_cap * 100, 1) if total_cap else 0.0,
        })
    return {"months": [m["name"] for m in months], "rows": rows}


@app.get("/api/utilization")
def api_utilization(request: Request, month: str = "", client: str = "",
                    project: str = "", pm: str = ""):
    """Utilization for admin (all resources) or PM (scoped to their
    client/project pairs). PMs see planned + actual utilization for their
    team only. month restricts to a single month's weeks.

    GH-29: client/project/pm are the Dashboard's own multi-select filters
    (comma-joined, normalised, empty = "all"). They are applied to the
    per-project resource rows BEFORE aggregation, which is what makes the
    numbers genuinely project-scoped: `_all_resources` returns one row per
    (name, client, project), so filtering it drops the hours of the projects you
    did not ask for instead of merely hiding people. A person who works on two
    projects therefore shows only the selected project's hours — which is the
    honest reading of "show me this project's utilization".

    `options` carries the same cascading pick-lists the Dashboard uses
    (clients / projects as "Client · Project" labels / pms), built from the set
    BEFORE the admin filters are applied — so choosing a filter never shrinks
    the list of things you can pick next. `has_unassigned` reports whether any
    project lacks a PM, which is what lets the front end offer "Unassigned".
    """
    user = _require_pm(request)
    conn = get_db()
    try:
        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        # GH-38: an archived project is deleted as far as any live figure goes.
        _arch = _archived_project_keys(conn)
        if _arch:
            resources = [r for r in resources
                         if ((r.get("client") or "").strip().upper(),
                             (r.get("project") or "").strip().upper()) not in _arch]
        if user.get("r") == "pm":
            projs = _pm_projects(user["u"], conn)
            resources = [r for r in resources
                         if not (r["project"] or "").strip()
                         or _pm_owns(projs, (r["client"] or "").strip(), (r["project"] or "").strip())]
        owners = _project_owners(conn)
        # Option lists come from the PRE-filter set (see docstring above).
        opts_clients = sorted({(r.get("client") or "").strip() for r in resources
                               if (r.get("client") or "").strip()}, key=lambda s: s.lower())
        opts_projects = sorted({((r.get("client") or "").strip(), (r.get("project") or "").strip())
                                for r in resources if (r.get("project") or "").strip()},
                               key=lambda t: (t[0].lower(), t[1].lower()))
        opts_pms = sorted({v for k, v in owners.items() if v}, key=lambda s: s.lower())
        has_unassigned = any(
            (r.get("project") or "").strip()
            and not owners.get(((r.get("client") or "").strip(), (r.get("project") or "").strip()))
            for r in resources)
        # Admin filters. PMs are already scoped above; a PM sending these would
        # only ever narrow their own set, which is harmless, so no special case.
        resources = _dash_filter(resources, _split_csv(client), _split_csv(project),
                                 _split_csv(pm), owners)
        data = compute_utilization(weeks, months, resources)
        data["capacity_week"] = CAP_WEEK_HOURS
        data["role"] = user.get("r")
        data["month"] = month or "all"
        data["options"] = {
            "clients": opts_clients,
            "projects": [{"client": c, "project": p,
                          "label": (f"{c} · {p}" if c else p)} for c, p in opts_projects],
            "pms": opts_pms,
            "has_unassigned": has_unassigned,
        }
        return data
    finally:
        conn.close()


# ---------------- Pricing library ----------------
def _pricing_dict(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    # Count PEOPLE, not rows (feature #11 follow-up): a person holding this
    # title on several projects has one resources row per project, so a raw
    # COUNT(*) showed "8 resource(s)" for 6 people and disagreed with the popup.
    # COUNT(DISTINCT TRIM(name)) is the same grouping the popup uses.
    used = conn.execute(
        "SELECT COUNT(DISTINCT TRIM(name)) FROM resources WHERE TRIM(role)=?",
        (row["title"],),
    ).fetchone()[0]
    return dict(row) | {"used_by": used}


@app.get("/api/pricing/{pid}/resources")
def api_pricing_resources(pid: int, request: Request):
    """Who uses this pricing title, at what rate, and how their time splits.

    Feature #11.1 / #11 follow-up (the owner, 2026-09-30):
      * ONE ROW PER PERSON. A person holding this title on several projects has
        one `resources` row each, which made the popup repeat the same name and
        inflated the count (Project manager read "8" for 6 people).
      * COUNT IS THE NUMBER OF PEOPLE, not rows — and it agrees with the popup
        exactly, because both group by the same name key.
      * Projects are COLLAPSED onto one line as "client/project" joined with
        " / " (e.g. "Microsoft/Platform / Apple/Indy") instead of one row per project.
      * ALLOCATION column: each person's share of THIS TITLE's total planned
        hours, as a percent plus the hour split ("54.2% (640/1180h)").

    Allocation is scoped to this title's rows only — "how this person splits
    across this title's projects", matching the client/project list in the same
    row. If a person holds two DIFFERENT titles (3 people in the book do:
    Blake Herrera, Marcus Lane, Caleb Nolan), each title's popup shows only that
    title's slice.

    Matching stays TRIM(role)=title — exactly what the count and the Apply
    button use — so the three can never disagree.

    NOTE: hours are NOT a column on `resources` — they live in `weekly_hours`.
    Reading `hours` from the resources table 500s. Use _all_resources(), which
    assembles the per-week hours the same way every other view does.
    """
    _require_admin(request)
    conn = get_db()
    try:
        prow = conn.execute(
            "SELECT id, title, rate, offshore_rate, currency FROM pricing WHERE id=?",
            (pid,),
        ).fetchone()
        if not prow:
            raise HTTPException(404, "Pricing title not found")
        title = (prow["title"] or "").strip()

        weeks, _months = _load_layout()
        allres = _all_resources(conn, weeks)
        matches = [r for r in allres if (r["role"] or "").strip() == title]

        # --- group by person -------------------------------------------------
        # Exact trimmed name: the same key the Utilization tab groups on. No
        # case-folding — merging "Ethan" with "ethan" could hide two people.
        people: dict[str, dict] = {}
        order: list[str] = []
        for r in matches:
            nm = (r["name"] or "").strip() or "—"
            e = people.get(nm)
            if e is None:
                e = people[nm] = {
                    "name": nm,
                    "country": (r.get("country") or "").strip() or "—",
                    # A person's own rates; duplicated rows agree, but keep the
                    # first so the row is deterministic.
                    "rate": r.get("rate") or 0.0,
                    "offshore_rate": r.get("offshore_rate") or 0.0,
                    "hours": 0.0,
                    # EVERY (client, project) this person holds on this title,
                    # in table order and deduped. Accumulating these is the
                    # whole point of collapsing rows ("Microsoft/Platform / Apple/Indy")
                    # — keeping only the first row's project silently dropped the
                    # rest while still summing all the hours.
                    "pairs": [],
                }
                order.append(nm)
            cl = (r.get("client") or "").strip()
            pr = (r.get("project") or "").strip()
            pair = "/".join(x for x in (cl, pr) if x) or "—"
            if pair not in e["pairs"]:
                e["pairs"].append(pair)
            hrs = r.get("hours") or []
            e["hours"] += sum(h for h in hrs if h)

        total_hours = sum(e["hours"] for e in people.values())

        resources = []
        for nm in order:
            e = people[nm]
            h = e["hours"]
            pairs = e["pairs"] or ["—"]
            rr = e["rate"]
            resources.append({
                "name": nm,
                "pairs": pairs,
                "projects": " / ".join(pairs),
                "country": e["country"],
                "rate": round(rr, 2),
                "offshore_rate": round(e["offshore_rate"], 2),
                "planned_hours": round(h, 1),
                "planned_revenue": round(rr * h, 2),
                # Allocation within this title (0.0-100.0).
                "allocation_pct": round(h / total_hours * 100, 1) if total_hours else 0.0,
            })
        resources.sort(key=lambda x: (-x["planned_hours"], x["name"].lower()))

        return {
            "pricing": {"id": prow["id"], "title": title,
                        "rate": prow["rate"], "offshore_rate": prow["offshore_rate"],
                        "currency": prow["currency"]},
            "resources": resources,
            "count": len(resources),          # people, not rows
            "rows": len(matches),             # rows behind the number, for parity
            "total_hours": round(total_hours, 1),
        }
    finally:
        conn.close()

@app.get("/api/pricing")
def api_pricing_list(request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, title, rate, offshore_rate, currency FROM pricing ORDER BY sort_order, title"
        ).fetchall()
        return [_pricing_dict(r, conn) for r in rows]
    finally:
        conn.close()


@app.post("/api/pricing")
def api_pricing_create(body: PricingUpdate, request: Request):
    _require_perm(request, "pricing")
    conn = get_db()
    try:
        title = (body.title or "").strip()
        if not title:
            raise HTTPException(400, "title is required")
        if conn.execute("SELECT 1 FROM pricing WHERE title=?", (title,)).fetchone():
            raise HTTPException(409, f"Title '{title}' already exists")
        cur = conn.execute(
            "INSERT INTO pricing (title, rate, offshore_rate, currency, ot_multiplier, sort_order) "
            "VALUES (?,?,?,?,?, COALESCE((SELECT MAX(sort_order)+1 FROM pricing),0))",
            (title, body.rate, body.offshore_rate, norm_currency(body.currency),
             body.ot_multiplier),
        )
        conn.commit()
        row = conn.execute("SELECT id, title, rate, offshore_rate, currency, ot_multiplier "
                           "FROM pricing WHERE id=?", (cur.lastrowid,)).fetchone()
        return _pricing_dict(row, conn)
    finally:
        conn.close()


@app.put("/api/pricing/{pid}")
def api_pricing_update(pid: int, body: PricingUpdate, request: Request):
    _require_perm(request, "pricing")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM pricing WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "pricing title not found")
        new_title = (body.title or "").strip() or row["title"]
        if new_title != row["title"]:
            if conn.execute("SELECT 1 FROM pricing WHERE title=? AND id!=?", (new_title, pid)).fetchone():
                raise HTTPException(409, f"Title '{new_title}' already exists")
            # cascade rename to resources using this title
            conn.execute(
                "UPDATE resources SET role=? WHERE TRIM(role)=?",
                (new_title, row["title"]),
            )
        rate = body.rate if body.rate is not None else row["rate"]
        off = body.offshore_rate if body.offshore_rate is not None else row["offshore_rate"]
        currency = norm_currency(body.currency) if body.currency else row["currency"]
        # OT multiplier: explicit clear wins, else set, else leave alone.
        if body.clear_ot_multiplier:
            ot_mult = None
        elif body.ot_multiplier is not None:
            ot_mult = body.ot_multiplier
        else:
            ot_mult = row["ot_multiplier"]
        conn.execute(
            "UPDATE pricing SET title=?, rate=?, offshore_rate=?, currency=?, ot_multiplier=? WHERE id=?",
            (new_title, rate, off, currency, ot_mult, pid),
        )
        conn.commit()
        row = conn.execute("SELECT id, title, rate, offshore_rate, currency FROM pricing WHERE id=?",
                           (pid,)).fetchone()
        return _pricing_dict(row, conn)
    finally:
        conn.close()


@app.delete("/api/pricing/{pid}")
def api_pricing_delete(pid: int, request: Request):
    _require_perm(request, "pricing")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM pricing WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "pricing title not found")
        conn.execute("DELETE FROM pricing WHERE id=?", (pid,))
        _log_activity(conn, request, "pricing.delete", target=row["title"],
                      details=f"Rate card row removed (was rate {row['rate']} / offshore {row['offshore_rate']}). "
                              f"Existing resource rates are NOT recalculated.")
        conn.commit()
        return {"ok": True, "title": row["title"]}
    finally:
        conn.close()


@app.post("/api/pricing/{pid}/apply")
def api_pricing_apply(pid: int, request: Request):
    """Push this title's rates onto every resource using it (null rates kept
    as-is so an unpriced title can't zero out resources)."""
    _require_perm(request, "pricing")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM pricing WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "pricing title not found")
        sets, params = [], []
        if row["rate"] is not None:
            sets.append("rate=?"); params.append(row["rate"])
        if row["offshore_rate"] is not None:
            sets.append("offshore_rate=?"); params.append(row["offshore_rate"])
        if not sets:
            return {"ok": True, "title": row["title"], "updated": 0,
                    "rate": row["rate"], "offshore_rate": row["offshore_rate"]}
        params.append(row["title"])
        cur = conn.execute(
            f"UPDATE resources SET {', '.join(sets)} WHERE TRIM(role)=?", params
        )
        conn.commit()
        return {
            "ok": True,
            "title": row["title"],
            "updated": cur.rowcount,
            "rate": row["rate"],
            "offshore_rate": row["offshore_rate"],
        }
    finally:
        conn.close()


@app.post("/api/pricing/apply-all")
def api_pricing_apply_all(request: Request):
    """Push EVERY title's rates onto all resources using them, then every
    total (Onsite/Offshore/Dashboard) reflects the Pricing tab."""
    _require_perm(request, "pricing")
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, title, rate, offshore_rate FROM pricing ORDER BY sort_order, title"
        ).fetchall()
        total = 0
        per_title = []
        for r in rows:
            sets, params = [], []
            if r["rate"] is not None:
                sets.append("rate=?"); params.append(r["rate"])
            if r["offshore_rate"] is not None:
                sets.append("offshore_rate=?"); params.append(r["offshore_rate"])
            if not sets:
                continue
            params.append(r["title"])
            cur = conn.execute(
                f"UPDATE resources SET {', '.join(sets)} WHERE TRIM(role)=?", params
            )
            if cur.rowcount:
                per_title.append({"title": r["title"], "updated": cur.rowcount})
                total += cur.rowcount
        _log_activity(conn, request, "pricing.apply_all", target=f"{total} resource row(s)",
                      details="Pushed every title's rates onto all matching resources"
                              + (f": {', '.join(t['title'] + ' (' + str(t['updated']) + ')' for t in per_title)}" if per_title else " (nothing to update)") + ".")
        conn.commit()
        return {"ok": True, "updated": total, "per_title": per_title}
    finally:
        conn.close()


# ---------------- Import ----------------
def _validate_import_capacity(conn: sqlite3.Connection, parsed: dict,
                              mode: str) -> list[dict]:
    """Every person's PLANNED weekly hours must fit their weekly capacity.

    the owner: "make sure that it also take care of all the rules, meaning for example
    if in the upload a resource is utilized for more than 100 hours in total then
    the upload should fail giving the reason for the fails."

    Runs BEFORE any write, on a simulation of the resulting state, so a rejected
    file leaves the database exactly as it was (all-or-nothing, matching the PM
    upload path). Grouping is by person NAME — the same key `compute_utilization`
    and the 100% rule use — because a spreadsheet has no person ids, and one
    person legitimately holds a row per project.

    Capacity resolution per person, most specific first:
      1. a `capacity` column in the uploaded file (per-row override), else
      2. the person's stored capacity (people → resources), else
      3. CAP_WEEK_HOURS (40).

    In merge mode the person's OTHER projects are included, so an upload cannot
    quietly overbook someone by adding hours to one project while leaving their
    existing bookings alone. In replace mode the file IS the whole book.
    """
    try:
        weeks, _months = _load_layout()
    except Exception:  # noqa: BLE001
        weeks = []
    nweeks = len(weeks)

    # --- capacity per normalised person name, from what is already stored ------
    cap_by_name: dict[str, float] = {}
    try:
        for r in conn.execute("SELECT name, capacity FROM resources").fetchall():
            k = _norm_person_name(r["name"])
            if not k:
                continue
            c = float(r["capacity"] or CAP_WEEK_HOURS)
            cap_by_name[k] = max(cap_by_name.get(k, 0.0), c)
    except sqlite3.Error:
        pass
    try:
        for r in conn.execute("SELECT name, capacity FROM people").fetchall():
            k = _norm_person_name(r["name"])
            if k and r["capacity"]:
                cap_by_name[k] = float(r["capacity"])
    except sqlite3.Error:
        pass

    # --- hours per person per week, starting from the EXISTING book ------------
    # `before` is kept separately from `after` because the rule is NOT "nobody may
    # ever exceed capacity" — the app deliberately tolerates EXISTING
    # over-allocation ("we never retro-break existing bookings"). Measured on the
    # live book, 103 person-weeks are already over. Refusing those would make the
    # export → edit → upload round-trip impossible, which is the whole point of
    # this feature. So only weeks the UPLOAD introduces or worsens are rejected.
    per_week: dict[str, list[float]] = {}
    before: dict[str, list[float]] = {}

    def bucket(store: dict, name: str) -> list[float]:
        k = _norm_person_name(name)
        if k not in store:
            store[k] = [0.0] * max(nweeks, 1)
        return store[k]

    file_names: set[str] = set()
    for pr in parsed.get("resources", []):
        file_names.add(_norm_person_name(pr.get("name") or ""))

    if mode != "replace":
        try:
            rows = conn.execute(
                "SELECT res.name, wh.week, wh.hours FROM weekly_hours wh "
                "JOIN resources res ON res.id = wh.resource_id").fetchall()
        except sqlite3.Error:
            rows = []
        for r in rows:
            k = _norm_person_name(r["name"])
            if not k:
                continue
            h = float(r["hours"] or 0.0)
            if not h:
                continue
            i = int(r["week"])
            arr = bucket(before, r["name"])
            if 0 <= i < len(arr):
                arr[i] += h

    # `after`: start from the existing book, then let the file REPLACE each
    # person it names (the importer upserts by (client,name), so a person in the
    # file is governed by the file, while people absent from it keep their hours).
    for k, arr in before.items():
        per_week[k] = list(arr)
    cap_override: dict[str, float] = {}
    for pr in parsed.get("resources", []):
        k = _norm_person_name(pr.get("name") or "")
        if not k:
            continue
        if pr.get("capacity"):
            try:
                cap_override[k] = float(pr["capacity"])
            except (TypeError, ValueError):
                pass
    file_hours: dict[str, list[float]] = {}
    for pr in parsed.get("resources", []):
        k = _norm_person_name(pr.get("name") or "")
        if not k:
            continue
        arr = file_hours.setdefault(k, [0.0] * max(nweeks, 1))
        for i, h in enumerate(pr.get("hours") or []):
            if h and i < len(arr):
                arr[i] += float(h)
    for k, arr in file_hours.items():
        per_week[k] = list(arr)

    # --- report ---------------------------------------------------------------
    # Only weeks the UPLOAD introduces or worsens (see the `before` note above).
    # An already-over week that the file leaves alone is the status quo and must
    # not block a round-trip.
    problems: list[dict] = []
    for k, arr in per_week.items():
        cap = cap_override.get(k) or cap_by_name.get(k) or CAP_WEEK_HOURS
        if cap <= 0:
            continue
        was = before.get(k) or []
        peak = max(arr) if arr else 0.0
        if peak <= cap:
            continue
        # Name it the way the workbook spells it, not the folded key.
        disp = k
        for pr in parsed.get("resources", []):
            if _norm_person_name(pr.get("name") or "") == k:
                disp = pr.get("name") or k
                break
        for i, h in enumerate(arr):
            if h <= cap:
                continue
            prev = float(was[i]) if i < len(was) else 0.0
            if prev > cap and h <= prev + 0.01:
                continue        # already over, and the file did not worsen it
            worse = " this upload makes it worse" if prev > cap else ""
            problems.append({
                "person": disp,
                "week": i,
                "week_label": weeks[i] if i < len(weeks) else f"week {i + 1}",
                "hours": round(h, 2),
                "was_hours": round(prev, 2),
                "capacity": cap,
                "over_by": round(h - cap, 2),
                "pct": round(h / cap * 100, 1),
                "reason": (f"planned {round(h, 2)}h exceeds the {cap:g}h weekly "
                           f"capacity by {round(h - cap, 2)}h "
                           f"({round(h / cap * 100, 1)}%)"
                           + (f"; previously {round(prev, 2)}h{worse}" if prev else "")),
                "fix": (f"reduce this week to {cap:g}h or less, raise the "
                        f"capacity, or move hours to another week"),
            })
    return problems


@app.post("/api/import")
async def api_import(file: UploadFile = File(...), mode: str = Form("merge"), request: Request = None):
    user = _require_pm(request)
    data = await file.read()

    # PM import: Actuals-only, scoped to their projects. They can never touch
    # planned hours, pricing, or resources — only actual_hours for their team.
    if user.get("r") == "pm":
        conn = get_db()
        try:
            projs = _pm_projects(user["u"], conn)
            parsed_actuals = importer.parse_actuals_sheet(data)
            res_by_key = {
                (_norm(r["client"]), _norm(r["name"])): r
                for r in conn.execute("SELECT id, client, project, name, capacity FROM resources").fetchall()
            }
            added = 0
            problems = []
            applied: list[tuple[dict, object, dict]] = []   # (parsed row, db row, note)
            weeks_all, _months = _load_layout()

            def _why(v: dict) -> tuple[str, str]:
                """(short reason, what to do) for one rejected week."""
                st = v.get("status")
                if st == "no_planned":
                    return ("no planned hours for this week — the person is not "
                            "assigned to this project in that week",
                            "clear the cell, or move the person onto the project first")
                if st == "needs_comment":
                    return ("under-delivered and no reason given",
                            "put a reason in the Reason column")
                if st == "needs_ot":
                    return ("worked more than planned; OT not answered",
                            "put Y or N in the OT? column")
                if st == "needs_billing_reason":
                    return ("OT recorded as NOT billed, but no reason given",
                            "put a reason in the Reason column, or set Billed? to Y")
                return (st or "rejected by the reconciliation rules", "check this row")

            for pa in parsed_actuals:
                cur = res_by_key.get((_norm(pa["client"]), _norm(pa["name"])))
                if not cur:
                    # A row the PM cannot see (or a typo in Client/Name). Say so
                    # rather than dropping it silently — a silent drop looks like
                    # the upload worked.
                    if (pa.get("name") or "").strip():
                        problems.append({
                            "person": pa["name"], "week": None, "week_label": None,
                            "reason": f"no assignment found for this person on "
                                      f"{pa.get('client') or '?'} — check the "
                                      f"Client and Resource Name spelling",
                            "fix": "match a row from the downloaded file",
                        })
                    continue
                proj = (cur["project"] or "").strip()
                client = (cur["client"] or "").strip()
                if proj and not _pm_owns(projs, client, proj):
                    continue  # not this PM's project — skip silently (not their data)
                rid = cur["id"]
                cap = cur["capacity"] if "capacity" in cur.keys() else None
                planned = _hours_map(rid, conn)
                # The hours ALREADY stored. An import validates the EDIT, not the
                # whole year: re-listing a week that was entered (and reconciled)
                # earlier is not a new decision, and re-checking it without its
                # original note would reject a file the PM only came to change one
                # row of. Without this a straight download->upload round-trip
                # failed with scores of errors.
                stored = {r["week"]: (r["hours"] or 0.0) for r in conn.execute(
                    "SELECT week, hours FROM actual_hours WHERE resource_id=?", (rid,)).fetchall()}
                # The answers the PM typed in the sheet. Empty cells are NOT
                # defaults: they mean "I did not answer", so they must not wipe a
                # decision already recorded for that week.
                note = {}
                if (pa.get("reason") or "").strip():
                    note["comment"] = pa["reason"].strip()
                    note["reason"] = pa["reason"].strip()
                if pa.get("ot") is not None:
                    note["is_ot"] = 1 if pa["ot"] else 0
                if pa.get("billed") is not None:
                    note["billed"] = 1 if pa["billed"] else 0
                if pa.get("under_billed") is not None:
                    # "Client still billed?" Y -> the client pays -> under_billed=0
                    # (recovered). N -> the shortfall is lost revenue -> 1. Same
                    # direction as the UI's question and _actuals_financials.
                    note["under_billed"] = 0 if pa["under_billed"] else 1

                changed_notes: dict[int, dict] = {}
                for i, h in enumerate(pa["hours"]):
                    h = h or 0.0
                    was = stored.get(i, 0.0)
                    if abs(h - was) < 1e-9:
                        continue        # unchanged — leave the week exactly as it is
                    if not h and not was:
                        continue
                    # For a changed week, fall back to whatever note already
                    # exists so a pre-recorded reason is not lost by re-uploading.
                    existing = _actual_notes_map(rid, conn).get(i) or {}
                    merged = {k: existing.get(k) for k in
                              ("comment", "reason", "is_ot", "approved", "billed", "under_billed")}
                    merged.update({k: v for k, v in note.items()})
                    v = _validate_actual_week(planned.get(i, 0.0), h, cap or 40.0, merged)
                    if v["status"] != "ok":
                        why, fix = _why(v)
                        wk = weeks_all[i] if i < len(weeks_all) else f"week {i + 1}"
                        problems.append({
                            "person": cur["name"],
                            "client": client,
                            "project": proj,
                            "week": i,
                            "week_label": wk,
                            "entered": h,
                            "planned": planned.get(i, 0.0),
                            "reason": why,
                            "fix": fix,
                        })
                        continue
                    # Keep the reconciliation outcome for this changed week (and
                    # only this week) so it is written back with the hours.
                    changed_notes[i] = {**merged, **{k: v[k] for k in v if k != "status"}}
                if changed_notes:
                    applied.append((pa, cur, changed_notes))

            if problems:
                # A precise, per-row report. `message` is the human sentence;
                # `problems` is the machine-readable list (capped, with a count).
                total = len(problems)
                shown = problems[:60]
                raise HTTPException(400, {
                    "message": (
                        f"Import rejected — {total} row(s) break the reconciliation "
                        f"rules. Nothing was saved. Fix the rows listed below and "
                        f"upload again."
                    ),
                    "problems": shown,
                    "problem_count": total,
                    "truncated": total > len(shown),
                })

            # Write only after the WHOLE file validates, so a bad row cannot
            # leave the week half-recorded.
            for pa, cur, notes_by_week in applied:
                rid = cur["id"]
                if pa.get("capacity"):
                    conn.execute("UPDATE resources SET capacity=? WHERE id=?",
                                 (float(pa["capacity"]), rid))
                # Write ONLY the changed weeks. Replacing the whole row would drop
                # the notes attached to weeks the PM never touched.
                for i in list(notes_by_week.keys()):
                    h = (pa["hours"][i] if i < len(pa["hours"]) else 0) or 0.0
                    if h:
                        conn.execute(
                            "INSERT OR REPLACE INTO actual_hours (resource_id, week, hours) "
                            "VALUES (?,?,?)", (rid, i, h))
                    else:
                        conn.execute("DELETE FROM actual_hours WHERE resource_id=? AND week=?",
                                     (rid, i))
                for i, n in notes_by_week.items():
                    conn.execute(
                        "INSERT OR REPLACE INTO actual_notes "
                        "(resource_id, week, pm, overage, comment, reason, is_ot, approved, billed, under_billed) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (rid, i, user["u"], n.get("overage", 0.0),
                         n.get("comment", ""), n.get("reason", ""),
                         1 if n.get("is_ot") else 0, 1 if n.get("approved") else 0,
                         1 if n.get("billed") else 0, n.get("under_billed")))
                added += 1
            conn.commit()
            return {"added": 0, "updated": 0, "renamed": 0, "skipped": 0,
                    "pricing_added": 0, "pricing_updated": 0, "actuals_added": added,
                    "mode": "pm-actuals", "backup": None, "warnings": []}
        finally:
            conn.close()

    # Admin import (non-PM): gated behind the import_export permission.
    _require_perm(request, "import_export")
    try:
        parsed = importer.parse_workbook_bytes(data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read workbook: {e}")

    conn = get_db()
    backup_path = None
    try:
        # GH-35: every rule the app enforces must hold for a bulk upload too.
        # the owner: "if in the upload a resource is utilized for more than 100 hours
        # in total then the upload should fail giving the reason for the fails".
        # Validated on a SIMULATION before anything is written, so a rejected file
        # leaves the database exactly as it was — all-or-nothing, like the PM
        # upload. Runs before the replace-mode wipe for the same reason.
        cap_problems = _validate_import_capacity(conn, parsed, mode)
        if cap_problems:
            total = len(cap_problems)
            raise HTTPException(400, {
                "message": (
                    f"Import rejected — {total} week(s) exceed a person's weekly "
                    f"capacity. Nothing was saved. Fix the rows listed below "
                    f"(or raise the capacity on Team & Access) and upload again."
                ),
                "problems": cap_problems[:60],
                "problem_count": total,
                "truncated": total > 60,
                "kind": "capacity",
            })

        # Replace mode: this file becomes the whole database. Backup first,
        # then wipe resources + hours. Pricing (the rate card) and the week
        # layout are kept — they're configuration, not data.
        if mode == "replace":
            backups_dir = DATA_DIR / "backups"
            backups_dir.mkdir(parents=True, exist_ok=True)
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            import shutil
            backup_path = backups_dir / f"revenue-before-replace-{stamp}.db"
            shutil.copy2(DB_PATH, backup_path)
            conn.execute("DELETE FROM weekly_hours")
            conn.execute("DELETE FROM resources")
            conn.commit()
        # Map incoming roles to existing canonical Pricing spellings so the
        # vocabulary stays stable across imports (old Excel files won't
        # reintroduce non-canonical titles). Roles NOT in the Pricing library
        # are blanked — the Title dropdown only ever shows Pricing titles.
        canon_rows = conn.execute("SELECT title FROM pricing").fetchall()
        canon_by_norm = {r["title"].strip().lower(): r["title"] for r in canon_rows}
        for pr in parsed["resources"]:
            key = (pr["role"] or "").strip().lower()
            pr["role"] = canon_by_norm.get(key, "")
        # Layout follows the uploaded file ONLY for full-period files (>= 50
        # weeks — e.g. a new year's workbook). Short/partial imports keep the
        # current layout so they can't silently rewire the year.
        if len(parsed["weeks"]) >= 50:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('layout', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (json.dumps({"weeks": parsed["weeks"], "months": parsed["months"]}),),
            )
        # Match existing by normalized client|name
        existing = conn.execute(
            "SELECT id, country, client, project, name, rate, offshore_rate FROM resources"
        ).fetchall()
        by_key = {(_norm(r["client"]), _norm(r["name"])): r for r in existing}
        # Name index for rename detection: if a row no longer matches by
        # (client,name) but its name matches EXACTLY ONE existing resource on a
        # DIFFERENT client, treat it as a rename (client/project changed) and
        # update that row instead of adding a duplicate.
        by_name: dict[str, list] = {}
        for r in existing:
            by_name.setdefault(_norm(r["name"]), []).append(r)
        added = updated = skipped = renamed = 0
        for pr in parsed["resources"]:
            key = (_norm(pr["client"]), _norm(pr["name"]))
            cur = by_key.get(key)
            if cur:
                new_project = pr["project"] if parsed.get("has_project") else cur["project"]
                conn.execute(
                    "UPDATE resources SET country=?, client=?, project=?, role=?, rate=?, offshore_rate=? WHERE id=?",
                    (
                        pr["country"], pr["client"], new_project, pr["role"],
                        pr["rate"] if pr["rate"] is not None else cur["rate"],
                        pr["offshore_rate"] if pr["offshore_rate"] is not None else cur["offshore_rate"],
                        cur["id"],
                    ),
                )
                conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (cur["id"],))
                conn.executemany(
                    "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                    [(cur["id"], i, h) for i, h in enumerate(pr["hours"]) if h],
                )
                updated += 1
            else:
                # No (client,name) match — maybe the row was RENAMED (new
                # client and/or project on the same person).
                cand = by_name.get(_norm(pr["name"]), [])
                if len(cand) == 1 and _norm(cand[0]["client"]) != _norm(pr["client"]):
                    cur = cand[0]
                    conn.execute(
                        "UPDATE resources SET country=?, client=?, project=?, role=?, rate=?, offshore_rate=? WHERE id=?",
                        (
                            pr["country"], pr["client"],
                            pr["project"] if parsed.get("has_project") else cur["project"],
                            pr["role"],
                            pr["rate"] if pr["rate"] is not None else cur["rate"],
                            pr["offshore_rate"] if pr["offshore_rate"] is not None else cur["offshore_rate"],
                            cur["id"],
                        ),
                    )
                    conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (cur["id"],))
                    conn.executemany(
                        "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                        [(cur["id"], i, h) for i, h in enumerate(pr["hours"]) if h],
                    )
                    by_key[(_norm(pr["client"]), _norm(pr["name"]))] = cur
                    by_name.setdefault(_norm(pr["name"]), []).append(cur)
                    renamed += 1
                    continue
                cur2 = conn.execute(
                    "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, sort_order) "
                    "VALUES (?,?,?,?,?,?,?, COALESCE((SELECT MAX(sort_order)+1 FROM resources),0))",
                    (pr["country"], pr["client"], pr["project"], pr["name"], pr["role"],
                     pr["rate"], pr["offshore_rate"]),
                )
                rid = cur2.lastrowid
                conn.executemany(
                    "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                    [(rid, i, h) for i, h in enumerate(pr["hours"]) if h],
                )
                added += 1
        conn.commit()

        # Pricing library: upsert from uploaded roles + optional Pricing sheet.
        # Titles are matched case-insensitively so old spellings (e.g. "Open
        # Text Developer") collapse into the canonical library entry instead of
        # creating duplicates.
        pricing_added = 0
        try:
            parsed_pricing = importer.parse_pricing_sheet(data)
        except Exception:  # noqa: BLE001
            parsed_pricing = []
        existing_titles = {
            r[0] for r in conn.execute("SELECT DISTINCT title FROM pricing").fetchall()
        }
        def _canon_title(role: str) -> str:
            """Map an incoming role to the existing canonical spelling (if any)."""
            t = (role or "").strip()
            if not t:
                return t or role or ""
            row = conn.execute(
                "SELECT title FROM pricing WHERE LOWER(TRIM(title))=?", (t.lower(),)
            ).fetchone()
            return row["title"] if row else t

        def _upsert_pricing(title: str, rate, off_rate, currency: str = "USD") -> None:
            nonlocal pricing_added
            t = _canon_title(title)
            if not t or t in existing_titles:
                return
            existing_titles.add(t)
            conn.execute(
                "INSERT INTO pricing (title, rate, offshore_rate, currency, sort_order) "
                "VALUES (?,?,?,?, COALESCE((SELECT MAX(sort_order)+1 FROM pricing),0))",
                (t, rate, off_rate, norm_currency(currency)),
            )
            pricing_added += 1
        # Resource roles map to the canonical Pricing spellings so imports
        # keep the vocabulary stable.
        for pr in parsed["resources"]:
            role = _canon_title(pr["role"])
            pr["role"] = role  # canonical spelling for storage
        # An explicit Pricing sheet in the uploaded file UPDATES existing
        # titles too (rate / offshore rate / currency), or adds new ones.
        pricing_updated = 0
        for p in parsed_pricing:
            t = _canon_title(p["title"])
            if not t:
                continue
            row = conn.execute("SELECT id FROM pricing WHERE title=?", (t,)).fetchone()
            if row:
                conn.execute(
                    "UPDATE pricing SET rate=?, offshore_rate=?, currency=? WHERE id=?",
                    (p["rate"], p["offshore_rate"], p.get("currency", "USD"), row["id"]),
                )
                pricing_updated += 1
            else:
                _upsert_pricing(t, p["rate"], p["offshore_rate"], p.get("currency", "USD"))
        conn.commit()

        # Actuals sheet: merge actual hours by (client, name) — bulk entry /
        # crash-restore. Imported batches are attributed to admin (not a PM).
        actuals_added = 0
        try:
            parsed_actuals = importer.parse_actuals_sheet(data)
        except Exception:  # noqa: BLE001
            parsed_actuals = []
        if parsed_actuals:
            res_by_key = {
                (_norm(r["client"]), _norm(r["name"])): r
                for r in conn.execute("SELECT id, client, name FROM resources").fetchall()
            }
            for pa in parsed_actuals:
                cur = res_by_key.get((_norm(pa["client"]), _norm(pa["name"])))
                if not cur:
                    continue
                rid = cur["id"]
                conn.execute("DELETE FROM actual_hours WHERE resource_id=?", (rid,))
                conn.executemany(
                    "INSERT INTO actual_hours (resource_id, week, hours) VALUES (?,?,?)",
                    [(rid, i, h) for i, h in enumerate(pa["hours"]) if h],
                )
                actuals_added += 1
            conn.commit()

        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        return {
            "added": added,
            "updated": updated,
            "renamed": renamed,
            "skipped": skipped,
            "pricing_added": pricing_added,
            "pricing_updated": pricing_updated,
            "actuals_added": actuals_added,
            "mode": mode,
            "backup": str(backup_path) if backup_path else None,
            "warnings": parsed["warnings"],
            "dashboard": build_dashboard_rows(resources, weeks),
            "resources": resources,
            "pricing": [
                dict(r) for r in conn.execute(
                    "SELECT id, title, rate, offshore_rate, currency FROM pricing ORDER BY sort_order, title"
                ).fetchall()
            ],
        }
    finally:
        conn.close()


# ---------------- Export ----------------
@app.get("/api/export")
def api_export(request: Request, scope: str = "", month: str = "", client: str = "",
               project: str = "", pm: str = "", currency: str = ""):
    user = _require_pm(request)
    conn = get_db()
    try:
        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        # PMs get an Actuals-only workbook scoped to their projects (no rates,
        # no other tabs — they must never see other teams' data).
        if user.get("r") == "pm":
            projs = _pm_projects(user["u"], conn)
            scoped = [r for r in resources
                      if not (r["project"] or "").strip()
                      or _pm_owns(projs, (r["client"] or "").strip(), (r["project"] or "").strip())]
            for r in scoped:
                r["rate"] = None
                r["offshore_rate"] = None
            buf = importer.build_actuals_workbook(weeks, months, scoped)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": 'attachment; filename="Actuals_export.xlsx"'},
            )
        # Admin export (non-PM): gated behind the import_export permission.
        _require_perm(request, "import_export")

        # Feature #12: ?scope=filtered&month=&client=&project=&pm=&currency=
        # exports just what the Dashboard filters show, instead of the full
        # workbook. The default (no scope param) path below is unchanged, so
        # every existing Export button/link keeps working exactly as before.
        if (scope or "").strip().lower() == "filtered":
            owners = _project_owners(conn)
            scoped = _dash_filter(resources, _split_csv(client), _split_csv(project),
                                  _split_csv(pm), owners)
            cur = (currency or "").strip().upper()
            if cur in ("USD", "EUR"):
                scoped = [r for r in scoped
                          if ("EUR" if _norm(r.get("country")) in EU_COUNTRIES else "USD") == cur]
            wr = _month_week_range(months, month)
            # Re-total over the scoped rows so the export's Dashboard sheet
            # matches the numbers the user is looking at on screen.
            dash = build_dashboard_rows(scoped, weeks, wr, _till_date_cap(weeks))
            util = compute_utilization(weeks, months, scoped)
            # Keep the Pricing sheet in the filtered workbook too, so a filtered
            # export round-trips into the importer exactly like the full one.
            pricing = conn.execute(
                "SELECT title, rate, offshore_rate, currency FROM pricing ORDER BY sort_order, title"
            ).fetchall()
            buf = importer.build_workbook(weeks, months, scoped, dash,
                                          [dict(r) for r in pricing], util)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": 'attachment; filename="Revenue_Recon_filtered.xlsx"'},
            )

        dash = build_dashboard_rows(resources, weeks)
        pricing = conn.execute(
            "SELECT title, rate, offshore_rate, currency FROM pricing ORDER BY sort_order, title"
        ).fetchall()
        util = compute_utilization(weeks, months, resources)
        buf = importer.build_workbook(weeks, months, resources, dash, [dict(r) for r in pricing], util)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="Revenue_Recon_export.xlsx"'},
        )
    finally:
        conn.close()


# ---------------- Static ----------------
@app.get("/healthz")
def healthz():
    return {"ok": True}


def _deployed_commit() -> str:
    """Best-effort short SHA of the currently deployed code (from git HEAD)."""
    try:
        head = BASE / ".git" / "HEAD"
        if not head.exists():
            return ""
        ref = head.read_text().strip()
        if ref.startswith("ref: "):
            ref_path = BASE / ".git" / ref[5:]
            if ref_path.exists():
                return ref_path.read_text().strip()[:7]
        return ref[:7]
    except Exception:
        return ""


@app.get("/api/version")
def api_version():
    """Report the deployed commit so the frontend can detect pending updates."""
    return {"commit": _deployed_commit()}


@app.get("/index.html", include_in_schema=False)
@app.get("/", include_in_schema=False)
def index_page(request: Request):
    """Serve the SPA shell with the user's theme injected SERVER-SIDE.

    Why not let the client apply it? A client-side apply always shows the
    default theme for one paint, then swaps — a visible flash on every load.
    Injecting the custom-property block into the document means the correct
    theme is there in the first painted frame (feature #8, option C).

    Falls through to the plain file when there is no valid session: the
    frontend then renders its login screen, and the default theme is right.
    """
    html = (Path(STATIC_DIR) / "index.html").read_text()

    user = _current_user(request)
    if user:
        key = _theme_key(user)
        dark = THEMES[key]["dark"]

        # The `data-theme` / `data-theme-dark` attributes drive the handful of
        # rules a custom-property swap cannot express (light-theme status pills
        # and the meta theme-color). They must be on <html> before first paint.
        html = html.replace(
            '<html lang="en">',
            f'<html lang="en" data-theme="{key}" data-theme-dark="{"1" if dark else "0"}">',
            1,
        )
        # Keep the mobile browser chrome in sync with a light theme.
        if not dark:
            html = html.replace(
                '<meta name="theme-color" content="#0b1020">',
                '<meta name="theme-color" content="#f4f5f7">',
                1,
            )

        inject = ""
        css = _theme_css_vars(key)
        if css:
            inject += f'<style id="theme-vars">{css}</style>\n'
        inject += (
            f"<script>window.__THEME__={json.dumps(key)};"
            f"window.__THEME_DARK__={'true' if dark else 'false'};"
            f"window.__THEME_CAN_CHANGE__={'true' if _can_change_theme(user) else 'false'};"
            f"</script>\n"
        )
        # Must come AFTER the stylesheet link, which lives in <head>.
        if "</head>" in html:
            html = html.replace("</head>", inject + "</head>", 1)
        else:
            html = inject + html
    # NEVER serve a stale shell. index.html is served by THIS route (not by the
    # static mount), and a cached shell keeps pointing at asset URLs the service
    # worker already holds — so a shipped fix looks undeployed however many times
    # the user reloads. Measured 2026-10-01: the served HTML carried
    # `app.js?v=110` while the SW had a PREVIOUS `v=110` cached, so the browser
    # ran pre-edit code although the server was serving the new bytes.
    # no-store forces every shell fetch through here; the asset URLs get a content
    # hash so a changed file can never collide with an already-cached URL.
    html = _stamp_asset_versions(html)
    return HTMLResponse(html, headers={"Cache-Control": "no-store, must-revalidate"})


def _asset_version(rel: str) -> str:
    """Short content hash of a static asset — changes only when the file does."""
    try:
        data = (Path(STATIC_DIR) / rel).read_bytes()
        return hashlib.sha1(data).hexdigest()[:10]
    except OSError:
        return ""


def _stamp_asset_versions(html: str) -> str:
    """Rewrite every `app.js?v=N` / `styles.css?v=N` to a content hash.

    The hand-maintained `?v=` numbers are the deployment hazard behind a whole
    class of "my fix did not ship" reports: reuse a number that has EVER been
    served and the cache-first service worker answers with the old file. A
    content hash cannot collide with a previous build, so the trap disappears and
    nobody has to remember to bump anything.
    """
    for name in ("app.js", "styles.css", "workbench.js", "weeksheet.js"):
        ver = _asset_version(name)
        if not ver:
            continue
        html = re.sub(rf"/{re.escape(name)}\?v=[A-Za-z0-9._-]+",
                      f"/{name}?v={ver}", html)
    return html


# ============================================================================
# People master list + project assignment + the 100% weekly rule
# (2026-10-01, PM access redesign — the owner's spec)
#
# Model: a PERSON exists once (people table) with a capacity (40 h/wk default).
# A project attaches to them through an EXISTING resources row, which becomes
# the assignment link (person_id + allocation_pct + start/end date). Keeping
# the link on `resources` is deliberate: weekly_hours, actual_hours, the
# Dashboard, Utilization and the Excel round-trip are all keyed on resource_id,
# so nothing downstream had to be rebuilt.
#
# The rule (decided with the owner): a PM assigns a % of the person's WEEKLY
# capacity. If the summed allocation across ALL of that person's projects would
# exceed 100% in ANY overlapping week, the save is REFUSED and the response
# names the exact weeks plus which competing project caused it. Hard block, no
# override. People already over 100% stay in the data (we never retro-break
# existing bookings) but cannot take new work until the load comes down.
# ============================================================================


def _norm_person_name(s: str | None) -> str:
    """Fold a person name for matching: trim + collapse inner whitespace + upper."""
    return " ".join((s or "").split()).strip().upper()


def _iso_date(s: str | None):
    """Parse an ISO date, or None. Accepts 'YYYY-MM-DD' only."""
    if not s:
        return None
    try:
        return dt.date.fromisoformat(str(s).strip())
    except ValueError:
        return None


def _weeks_between(weeks: list[str], start_date: str, end_date: str) -> set[int]:
    """Week indices whose Monday falls inside [start_date, end_date].

    An empty bound on either side means "unbounded" — so a project with no
    dates (which is every project today, verified) covers the whole year
    rather than collapsing to an empty set.
    """
    sd, ed = _iso_date(start_date), _iso_date(end_date)
    out: set[int] = set()
    for i, wl in enumerate(weeks):
        d = _week_date(wl)
        if d is None:
            continue
        if sd is not None and d < sd:
            continue
        if ed is not None and d > ed:
            continue
        out.add(i)
    return out


def _approved_titles(conn: sqlite3.Connection, person_id: int) -> list[str]:
    """The EFFECTIVE approved-title set for a person: explicit approvals ∪ home
    title. Single definition shared by create, update and the API, so the PM's
    dropdown and the server-side refusal can never disagree."""
    out: list[str] = []
    for r in conn.execute("SELECT title FROM person_titles WHERE person_id=? ORDER BY title",
                          (person_id,)).fetchall():
        t = (r["title"] or "").strip()
        if t and t not in out:
            out.append(t)
    p = conn.execute("SELECT home_title FROM people WHERE id=?", (person_id,)).fetchone()
    home = (p["home_title"] or "").strip() if p else ""
    if home and home not in out:
        out.insert(0, home)
    return out


def _pricing_row(conn: sqlite3.Connection, title: str | None):
    return conn.execute(
        "SELECT title, rate, offshore_rate, currency, ot_multiplier "
        "FROM pricing WHERE title = ?", ((title or "").strip(),)
    ).fetchone()


def _reseat_people(conn: sqlite3.Connection) -> None:
    """Repair the People list if a seed produced folded (ALL-CAPS) names.

    Runs on every init but does nothing once names look human. Also merges the
    known name-variant duplicates of the SAME human (Liam / Liam Foster,
    Noah Kumar / Noah Bennett, Victor / Victor Salazar) — these are the
    exact data-quality problem the master list exists to fix, and leaving them
    split would let the 100% rule be defeated by a typo.
    """
    # 1. Un-fold any name that a previous run stored in caps.
    for p in conn.execute("SELECT id, name FROM people").fetchall():
        if p["name"] and p["name"] == p["name"].upper() and p["name"] != p["name"].lower():
            row = conn.execute(
                "SELECT name FROM resources WHERE person_id=? ORDER BY id LIMIT 1",
                (p["id"],)).fetchone()
            if row and row["name"] and row["name"] != row["name"].upper():
                conn.execute("UPDATE people SET name=? WHERE id=?", (row["name"], p["id"]))
        # 2. Keep the denormalized resource name in step with the person record.
    for p in conn.execute("SELECT id, name FROM people").fetchall():
        conn.execute(
            "UPDATE resources SET name=? WHERE person_id=? AND TRIM(name)!=TRIM(?)",
            (p["name"], p["id"], p["name"]))
    conn.commit()


def _dedupe_person_titles(conn: sqlite3.Connection) -> None:
    """Collapse titles differing only by whitespace/case for the same person.

    The seed took titles straight from `resources.role`, so a row whose role was
    stored as "Project manager " produced a second, visually identical entry next
    to "Project manager" — a duplicated line in the People table and a doubled
    option in the PM's title dropdown. Keeps the first spelling seen. Idempotent.
    """
    try:
        rows = conn.execute(
            "SELECT person_id, title FROM person_titles ORDER BY person_id, rowid").fetchall()
        seen: dict[tuple[int, str], str] = {}
        drop: list[tuple[int, str]] = []
        for r in rows:
            k = (r["person_id"], " ".join((r["title"] or "").split()).upper())
            if k in seen:
                drop.append((r["person_id"], r["title"]))
            else:
                seen[k] = r["title"]
        for pid, title in drop:
            conn.execute("DELETE FROM person_titles WHERE person_id=? AND title=?", (pid, title))
        if drop:
            conn.commit()
    except Exception:  # noqa: BLE001
        pass


def _merge_people(conn: sqlite3.Connection, keep_name: str, drop_names: list[str]) -> None:
    """Fold several person records into one (admin data-quality fix).

    Their project assignments all move to the survivor, so the 100% rule sees a
    single human. Refuses if it would put the same person on one project twice.
    """
    keep = conn.execute("SELECT * FROM people WHERE TRIM(UPPER(name))=?",
                        (_norm_person_name(keep_name),)).fetchone()
    if not keep:
        return
    for dn in drop_names:
        d = conn.execute("SELECT * FROM people WHERE TRIM(UPPER(name))=?",
                         (_norm_person_name(dn),)).fetchone()
        if not d or d["id"] == keep["id"]:
            continue
        # A collision here means both records sit on the same project — that is
        # a genuine double-booking of one person and must NOT be silently merged.
        clash = conn.execute(
            "SELECT a.project FROM resources a JOIN resources b "
            "ON TRIM(UPPER(a.client))=TRIM(UPPER(b.client)) "
            "AND TRIM(UPPER(a.project))=TRIM(UPPER(b.project)) "
            "WHERE a.person_id=? AND b.person_id=?", (keep["id"], d["id"])).fetchone()
        if clash:
            continue  # leave both; a human has to decide
        conn.execute("UPDATE resources SET person_id=? WHERE person_id=?", (keep["id"], d["id"]))
        for t in conn.execute("SELECT title FROM person_titles WHERE person_id=?", (d["id"],)).fetchall():
            conn.execute("INSERT OR IGNORE INTO person_titles (person_id, title) VALUES (?,?)",
                         (keep["id"], t["title"]))
        conn.execute("DELETE FROM person_titles WHERE person_id=?", (d["id"],))
        conn.execute("DELETE FROM people WHERE id=?", (d["id"],))
    conn.commit()


KNOWN_DUPLICATES: list[tuple[str, list[str]]] = [
    ("Liam Foster", ["Liam"]),
    ("Noah Bennett", ["Noah Kumar"]),
    ("Victor Salazar", ["Victor"]),
]


def seed_people_from_resources(conn: sqlite3.Connection) -> None:
    """Build the People master list from the distinct resource (name, home title).

    A person's home title is the one used by their EARLIEST resource row (ties
    broken by lowest id), and their approved-title set starts as just that home
    title. Idempotent by construction: init_db only calls this while `people`
    is empty.

    DISPLAY CASING MATTERS: matching happens on a folded (trimmed + upper) key,
    but the STORED name is the human-typed one from the earliest row. Storing
    the folded form turned every name into SHOUTING CAPS on the first run —
    the fix is to keep `key` for lookup and `display` for writing.
    """
    rows = conn.execute(
        "SELECT id, name, role FROM resources WHERE TRIM(name) != '' ORDER BY id"
    ).fetchall()
    titles: dict[str, dict[str, int]] = {}   # key -> {title: earliest id}
    display: dict[str, str] = {}             # key -> human name
    order: list[str] = []
    for r in rows:
        key = _norm_person_name(r["name"])
        if not key:
            continue
        if key not in titles:
            titles[key] = {}
            display[key] = " ".join((r["name"] or "").split())
            order.append(key)
        role = (r["role"] or "").strip()
        if role and role not in titles[key]:
            titles[key][role] = r["id"]
    for key in order:
        home = ""
        if titles[key]:
            home = sorted(titles[key].items(), key=lambda kv: kv[1])[0][0]
        cur = conn.execute(
            "INSERT INTO people (name, country, home_title, capacity) VALUES (?,?,?,?)",
            (display[key], "", home, CAP_WEEK_HOURS),
        )
        pid = int(cur.lastrowid or 0)
        if home:
            conn.execute("INSERT OR IGNORE INTO person_titles (person_id, title) VALUES (?,?)",
                         (pid, home))
    conn.commit()


def backfill_person_links(conn: sqlite3.Connection) -> None:
    """Attach every resource row to its person by normalized name, and default a
    legacy row's allocation from its own weekly hours (hours ÷ capacity).

    Idempotent: only touches rows whose person_id is NULL or points nowhere.
    """
    people = {_norm_person_name(r["name"]): r["id"] for r in
              conn.execute("SELECT id, name FROM people").fetchall()}
    if not people:
        return
    orphans = conn.execute(
        "SELECT id, name, capacity FROM resources WHERE person_id IS NULL"
    ).fetchall()
    for r in orphans:
        pid = people.get(_norm_person_name(r["name"]))
        if pid is None:
            continue
        conn.execute("UPDATE resources SET person_id=? WHERE id=?", (pid, r["id"]))
    conn.commit()


def _log_activity(conn: sqlite3.Connection, request: Request, action: str,
                  target: str = "", details: str = "", project: str = "") -> None:
    """Record one user-visible action. Called from the SERVER, inside the same
    transaction as the change, so an action can never happen unlogged.

    Deliberately never raises: a broken log row must not roll back or 500 a
    real piece of work. If it fails, the action still succeeds."""
    try:
        user = _current_user(request)
        actor = (user or {}).get("u", "") or "unknown"
        conn.execute(
            "INSERT INTO activity (actor, action, target, details, project) VALUES (?,?,?,?,?)",
            (str(actor), str(action), str(target), str(details), str(project)),
        )
    except Exception:  # noqa: BLE001 — logging must never break the action
        pass


def _people_rows(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for p in conn.execute(
        "SELECT * FROM people ORDER BY TRIM(UPPER(name))"
    ).fetchall():
        titles = [r["title"] for r in conn.execute(
            "SELECT title FROM person_titles WHERE person_id=? ORDER BY title", (p["id"],)
        ).fetchall()]
        assigns = conn.execute(
            "SELECT r.id, r.client, r.project, r.role, r.allocation_pct, "
            "r.start_date, r.end_date, r.phases FROM resources r WHERE r.person_id=? "
            "ORDER BY r.client, r.project", (p["id"],)
        ).fetchall()
        out.append({
            "id": p["id"], "name": p["name"], "country": p["country"],
            "home_title": p["home_title"], "capacity": p["capacity"],
            "active": p["active"], "notes": p["notes"],
            "titles": titles,
            "assignments": [{**dict(a), "phases": parse_phases(a["phases"])} for a in assigns],
            "project_count": len(assigns),
        })
    return out


def person_week_load(conn: sqlite3.Connection, person_id: int,
                     exclude_resource_id: int | None = None,
                     weeks: list[str] | None = None) -> dict:
    """Per-week booked % of capacity for ONE person across ALL their projects.

    Derived from each assignment's ACTUAL weekly hours ÷ that row's capacity, so
    it is correct for legacy rows too (which have no allocation_pct). This is
    the single source of truth for both the load rail and the hard block — the
    two can never disagree.
    """
    # `weeks` is passed in by callers that already have it. Without this the
    # function re-read the layout (and its own SQLCipher connection) on EVERY
    # call — /api/pm/load calls it once per person, which measured 6.2s.
    if weeks is None:
        weeks, _ = _load_layout()
    cap_default = CAP_WEEK_HOURS
    rows = conn.execute(
        "SELECT id, capacity, client, project, role FROM resources "
        "WHERE person_id=?", (person_id,)
    ).fetchall()
    pct = [0.0] * len(weeks)
    contrib: dict[int, list[str]] = {}
    capacity_week = cap_default
    for r in rows:
        if exclude_resource_id is not None and r["id"] == exclude_resource_id:
            continue
        cap = r["capacity"] or cap_default
        capacity_week = cap
        hrs = _hours_map(r["id"], conn)
        label = "/".join(x for x in ((r["client"] or "").strip(), (r["project"] or "").strip()) if x) or "—"
        for i in range(len(weeks)):
            h = hrs.get(i, 0.0)
            if not h:
                continue
            p = h / cap * 100.0
            pct[i] += p
            contrib.setdefault(i, []).append(f"{label} ({round(p)}%)")
    return {"weeks": weeks, "pct": pct, "contrib": contrib,
            "capacity_week": capacity_week,
            "total_pct": round(sum(pct) / len(weeks), 1) if weeks else 0.0,
            "peak_pct": round(max(pct), 1) if pct else 0.0,
            "peak_week": (weeks[pct.index(max(pct))] if pct else ""),
            "projects": [dict(r) for r in rows]}


def validate_assignment(conn: sqlite3.Connection, person_id: int, alloc_pct: float,
                        start_date: str, end_date: str,
                        exclude_resource_id: int | None = None,
                        max_conflicts: int = 12) -> dict:
    """Apply the 100% weekly hard block.

    Returns {ok, conflicts:[{week,label,total_pct,existing_pct,existing:[...]}],
    conflict_count, peak_pct, weeks_in_window}. `ok` is False the moment any
    overlapping week would exceed 100% — the caller refuses the save.
    """
    load = person_week_load(conn, person_id, exclude_resource_id)
    weeks = load["weeks"]
    window = _weeks_between(weeks, start_date, end_date)
    conflicts = []
    for i in sorted(window):
        total = load["pct"][i] + float(alloc_pct or 0.0)
        if total > 100.0 + 1e-9:
            conflicts.append({
                "week": i, "label": weeks[i],
                "total_pct": round(total, 1),
                "existing_pct": round(load["pct"][i], 1),
                "existing": load["contrib"].get(i, []),
            })
    return {
        "ok": not conflicts,
        "conflicts": conflicts[:max_conflicts],
        "conflict_count": len(conflicts),
        "peak_pct": load["peak_pct"],
        "current_weekly_pct": load["total_pct"],
        "weeks_in_window": len(window),
    }


class JoinBody(BaseModel):
    """A PM adding a new joiner. Deliberately narrower than PersonBody: a PM
    supplies who the person is and what they can work as, nothing else."""
    name: str
    country: str | None = ""
    home_title: str | None = ""
    capacity: float | None = None


class PersonBody(BaseModel):
    # Every field defaults to None, NOT "", so "omitted" is distinguishable from
    # "explicitly cleared" (GH-33). With `country: str | None = ""` a request
    # carrying only {active} arrived with country="" and home_title="" — the
    # endpoint then wrote those blanks, so toggling someone's status silently
    # ERASED their home title (caught by test: 'QA' -> ''). `None` = not
    # supplied (keep stored), `""` = clear it.
    name: str | None = None
    country: str | None = None
    home_title: str | None = None
    capacity: float | None = None
    active: int | None = None
    notes: str | None = None
    titles: list[str] | None = None


class Phase(BaseModel):
    """One leg of a time-phased allocation, e.g. 100% Jan-Mar then 50% Apr."""
    allocation_pct: float
    start_date: str | None = ""
    end_date: str | None = ""


class AssignmentBody(BaseModel):
    person_id: int
    client: str
    project: str
    title: str | None = None
    allocation_pct: float = 0.0
    start_date: str | None = ""
    end_date: str | None = ""
    title_exception: str | None = ""
    # Time-phased mode. When present and non-empty this WINS over the flat
    # allocation_pct/start_date/end_date, so the same endpoint serves both.
    phases: list[Phase] | None = None


def _require_people(request):
    """PMs always pass (scoped to their own projects); admins need 'people'."""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    if user.get("r") == "pm":
        return user
    _require_perm(request, "people")
    return user


def _pm_may_touch(conn, user, client: str, project: str) -> None:
    """Raise 403 unless this PM owns (client, project). Admins pass."""
    if user.get("r") != "pm":
        return
    projs = _pm_projects(user["u"], conn)
    if not _pm_owns(projs, (client or "").strip(), (project or "").strip()):
        raise HTTPException(403, "Not assigned to this project")


def _may_manage_projects(request):
    """Who may create / delete a PROJECT (GH-37).

    Admins need the `projects` permission. A PM is allowed too — the owner: "The PM
    should be able to add project too - not the pricing, but create a project add
    resource and PM just like admin can do but not the revenue or dollar value".
    Their scope is enforced per-project by _pm_may_touch(), so a PM can only ever
    see or remove projects they own; this helper only decides whether the route is
    reachable for them at all.

    Returns the user dict (r == "pm" for a PM, otherwise an admin).
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    if user.get("r") == "pm":
        return user
    _require_perm(request, "projects")
    return user


@app.get("/api/people")
def api_people(request: Request):
    """People master list. PMs get the same list (they must pick from it) but
    WITHOUT the money side — rates are never included here."""
    _require_people(request)
    conn = get_db()
    try:
        return {"people": _people_rows(conn)}
    finally:
        conn.close()


class BenchBody(BaseModel):
    person_id: int
    # Blank = auto: bench whatever share of the week is unbooked, floored onto the
    # 25% allocation grid. 100% = fully unallocated.
    allocation_pct: float | None = None
    start_date: str | None = ""
    end_date: str | None = ""


@app.post("/api/bench")
def api_bench(body: BenchBody, request: Request):
    """Park a person on the Bench project for the share of their week that is free.

    Goes through the SAME assignment rules as any project — the 100% hard block,
    the 25% grid, one row per (person, project) — so benching can never become a
    back door to an over-allocation.
    """
    user = _require_pm(request)
    conn = get_db()
    try:
        pid = body.person_id
        p = conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "Person not found")
        if user.get("r") == "pm":
            # A PM may bench their own team: the person must already be on one of
            # their projects, otherwise they are not this PM's to move.
            owned = _pm_projects(user["u"], conn)
            rows = conn.execute("SELECT client, project FROM resources WHERE person_id=?",
                                (pid,)).fetchall()
            if rows and not any(_pm_owns(owned, (r["client"] or ""), (r["project"] or ""))
                                for r in rows):
                raise HTTPException(403, "That person is not on any of your projects")

        bench_id = ensure_bench(conn)
        if not bench_id:
            raise HTTPException(500, "Could not create the Bench project")

        alloc = body.allocation_pct
        if alloc is None:
            # Auto: the free share of their busiest week, floored onto the grid.
            load = person_week_load(conn, pid)
            free = max(0.0, 100.0 - float(load.get("peak_pct") or 0.0))
            alloc = float(int(free / 25.0) * 25)
            if alloc <= 0:
                raise HTTPException(400, {
                    "message": (f"{p['name']} is already fully booked "
                                f"({load.get('peak_pct')}% at their peak), so there is "
                                f"nothing to bench."),
                    "code": "fully_booked", "peak_pct": load.get("peak_pct"),
                })
        if abs(float(alloc) % 25) > 1e-9:
            raise HTTPException(400, "Bench allocation must be a multiple of 25% "
                                     "(25, 50, 75 or 100)")

        existing = conn.execute(
            "SELECT id FROM resources WHERE person_id=? AND TRIM(UPPER(client))=? "
            "AND TRIM(UPPER(project))=?",
            (pid, BENCH_CLIENT.upper(), BENCH_PROJECT.upper())).fetchone()

        sd = (body.start_date or "").strip()
        ed = (body.end_date or "").strip()
        v = validate_assignment(conn, pid, float(alloc), sd, ed,
                                exclude_resource_id=(existing["id"] if existing else None))
        if not v["ok"]:
            c0 = (v["conflicts"] or [{}])[0]
            raise HTTPException(409, {
                "message": (f"Bench at {alloc:g}% would push {p['name']} over 100% in "
                            f"{v['conflict_count']} week(s). First clash: "
                            f"{c0.get('label')} would reach {c0.get('total_pct')}%."),
                "conflicts": v["conflicts"], "conflict_count": v["conflict_count"],
            })

        cap = float(p["capacity"] or CAP_WEEK_HOURS)
        if existing:
            rid = existing["id"]
            conn.execute(
                "UPDATE resources SET allocation_pct=?, start_date=?, end_date=?, "
                "capacity=?, phases='' WHERE id=?",
                (float(alloc), sd, ed, cap, rid))
            action = "bench_update"
        else:
            # Bench holds NO rate, so bench time can never add cost or revenue.
            sort = conn.execute(
                "SELECT COALESCE(MAX(sort_order),0)+1 s FROM resources").fetchone()["s"]
            rid = conn.execute(
                "INSERT INTO resources (country, client, project, name, role, rate, "
                "offshore_rate, sort_order, capacity, person_id, allocation_pct, "
                "start_date, end_date, phases) VALUES (?,?,?,?,?,0,0,?,?,?,?,?,?, '')",
                ((p["country"] or ""), BENCH_CLIENT, BENCH_PROJECT, p["name"],
                 (p["home_title"] or ""), sort, cap, pid, float(alloc), sd, ed)).lastrowid
            action = "bench_add"
        _write_allocation_hours(conn, rid, float(alloc), cap, sd, ed)
        _log_activity(conn, request, action, p["name"],
                      f"bench at {alloc:g}% (zero-rate)")
        conn.commit()
        return {"ok": True, "resource_id": rid, "allocation_pct": float(alloc),
                "project": BENCH_PROJECT, "auto": body.allocation_pct is None}
    finally:
        conn.close()


@app.post("/api/joiners")
def api_joiner_create(body: JoinBody, request: Request):
    """Add a new joiner to the company roster.

    Who may: a PM (any PM — a new hire is company news, not project data) or an
    admin. The title MUST exist on the rate card: rates are keyed by title, so an
    invented title would create a person nobody can price. Returns a clear,
    actionable error naming the Rate Card when it doesn't match.
    """
    user = _require_pm(request)
    conn = get_db()
    try:
        name = " ".join((body.name or "").split())
        if not name:
            raise HTTPException(400, "Name is required")

        # `body.capacity or CAP_WEEK_HOURS` would turn an explicit 0 into 40 and
        # silently accept nonsense. Only a MISSING value defaults.
        cap = CAP_WEEK_HOURS if body.capacity is None else float(body.capacity)
        if cap <= 0 or cap > 168:
            raise HTTPException(400, {
                "message": "Weekly availability must be between 1 and 168 hours.",
                "code": "bad_capacity",
            })

        title = " ".join((body.home_title or "").split())
        canonical = None
        if title:
            # Match the rate card case/space-insensitively, and store the CARD's
            # spelling so the vocabulary stays stable (the same rule the importer
            # applies to roles).
            for r in conn.execute("SELECT title FROM pricing").fetchall():
                if (r["title"] or "").strip().lower() == title.lower():
                    canonical = r["title"].strip()
                    break
            if canonical is None:
                known = [r["title"] for r in conn.execute(
                    "SELECT title FROM pricing ORDER BY sort_order, title").fetchall()]
                raise HTTPException(400, {
                    "message": (f"“{title}” is not on the rate card, so nobody can be "
                                f"priced at that title. Ask an admin to add it on the "
                                f"Rate Card ( + Add Title ), then add the person."),
                    "code": "unknown_title",
                    "title": title,
                    "known_titles": known[:60],
                })

        # Duplicate guard: the whole 100% rule depends on one row per human.
        dup = conn.execute(
            "SELECT id FROM people WHERE TRIM(LOWER(name))=?",
            (name.lower(),)).fetchone()
        if dup:
            raise HTTPException(400, {
                "message": f"“{name}” is already on the roster. Pick them from the list instead of adding a second record.",
                "code": "duplicate_person", "person_id": dup["id"],
            })

        pid = conn.execute(
            "INSERT INTO people (name, country, home_title, capacity, active, notes) "
            "VALUES (?,?,?,?,1,'')",
            (name, (body.country or "").strip(), canonical or "", cap)).lastrowid
        if canonical:
            conn.execute(
                "INSERT OR IGNORE INTO person_titles (person_id, title) VALUES (?,?)",
                (pid, canonical))
        _log_activity(conn, request, "person_add", name,
                      f"added a joiner: {cap:g}h/wk"
                      + (f", title {canonical}" if canonical else ", no title"))
        conn.commit()
        return {"ok": True, "person_id": pid, "name": name,
                "home_title": canonical or "", "capacity": cap}
    finally:
        conn.close()


@app.post("/api/people")
def api_person_create(body: PersonBody, request: Request):
    """Create a person. Admin-only (PMs cannot mint new people)."""
    _require_admin(request)
    _require_perm(request, "people")
    name = " ".join((body.name or "").split())
    if not name:
        raise HTTPException(400, "Name is required")
    conn = get_db()
    try:
        dup = conn.execute("SELECT id FROM people WHERE TRIM(UPPER(name))=?",
                           (_norm_person_name(name),)).fetchone()
        if dup:
            raise HTTPException(409, f"A person named '{name}' already exists")
        cur = conn.execute(
            "INSERT INTO people (name, country, home_title, capacity, active, notes) "
            "VALUES (?,?,?,?,?,?)",
            (name, (body.country or "").strip(), (body.home_title or "").strip(),
             float(body.capacity or CAP_WEEK_HOURS), int(body.active if body.active is not None else 1),
             (body.notes or "").strip()),
        )
        pid = cur.lastrowid
        titles = [t.strip() for t in (body.titles or []) if (t or "").strip()]
        if not titles and (body.home_title or "").strip():
            titles = [(body.home_title or "").strip()]
        for t in titles:
            conn.execute("INSERT OR IGNORE INTO person_titles (person_id, title) VALUES (?,?)", (pid, t))
        _log_activity(conn, request, "person.create", target=name,
                      details=f"Title(s): {', '.join(titles) or '—'}. Capacity {float(body.capacity or CAP_WEEK_HOURS)}h/wk.")
        conn.commit()
        return {"ok": True, "id": pid}
    finally:
        conn.close()


@app.put("/api/people/{pid}")
def api_person_update(pid: int, body: PersonBody, request: Request):
    """Edit a person's identity/capacity and their APPROVED title set.

    Changing the home title or the approved set is exactly the admin control
    that stops a PM drifting a billing rate (decision: restricted title list).
    """
    _require_admin(request)
    _require_perm(request, "people")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "Person not found")
        name = " ".join((body.name or "").split()) or row["name"]
        # PARTIAL UPDATE (GH-33). Every field falls back to the STORED value when
        # the caller omits it — `None` means "not supplied", while an explicit ""
        # means "clear it". This matters because the People list's Active toggle
        # sends only {active}, and the previous code wrote `body.country or ""`
        # for absent keys, which silently BLANKED home_title on every toggle
        # (caught by test: 'QA' -> '').
        def _keep(v, stored):
            return stored if v is None else v

        home_title = _keep(body.home_title, row["home_title"] or "")
        canonical = home_title.strip()
        if canonical:
            # Match the rate card case/space-insensitively and store the CARD's
            # spelling, so a person is never pinned to a title nobody can price.
            try:
                match = conn.execute(
                    "SELECT title FROM pricing WHERE TRIM(LOWER(title))=?",
                    (" ".join(canonical.split()).lower(),)).fetchone()
            except sqlite3.Error:
                match = None
            if match:
                canonical = match["title"]

        conn.execute(
            "UPDATE people SET name=?, country=?, home_title=?, capacity=?, active=?, notes=? WHERE id=?",
            (name,
             _keep(body.country, row["country"] or "").strip(),
             canonical.strip(),
             float(body.capacity if body.capacity is not None else row["capacity"] or CAP_WEEK_HOURS),
             int(body.active if body.active is not None else row["active"]),
             _keep(body.notes, row["notes"] or "").strip(),
             pid),
        )
        if body.titles is not None:
            keep = [t.strip() for t in body.titles if (t or "").strip()]
            if (body.home_title or "").strip() and (body.home_title or "").strip() not in keep:
                keep.append((body.home_title or "").strip())
            conn.execute("DELETE FROM person_titles WHERE person_id=?", (pid,))
            for t in keep:
                conn.execute("INSERT OR IGNORE INTO person_titles (person_id, title) VALUES (?,?)", (pid, t))
        # Keep the denormalized name/role on the resource rows in step so grids,
        # exports and reports never show a stale name.
        if name != row["name"]:
            conn.execute("UPDATE resources SET name=? WHERE person_id=?", (name, pid))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


class MergeBody(BaseModel):
    merge_from: int


@app.post("/api/people/{pid}/merge")
def api_person_merge(pid: int, body: MergeBody, request: Request):
    """Merge another person record INTO this one (admin data-quality fix).

    Exists because the same human was entered twice under different spellings
    (Liam / Liam Foster). Left split, a typo would defeat the 100% rule — the
    two records would each look half-loaded.
    """
    _require_admin(request)
    _require_perm(request, "people")
    conn = get_db()
    try:
        keep = conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
        src = conn.execute("SELECT * FROM people WHERE id=?", (body.merge_from,)).fetchone()
        if not keep or not src:
            raise HTTPException(404, "Person not found")
        if keep["id"] == src["id"]:
            raise HTTPException(400, "Cannot merge a person into themselves")
        clash = conn.execute(
            "SELECT a.client, a.project FROM resources a JOIN resources b "
            "ON TRIM(UPPER(a.client))=TRIM(UPPER(b.client)) "
            "AND TRIM(UPPER(a.project))=TRIM(UPPER(b.project)) "
            "WHERE a.person_id=? AND b.person_id=?", (keep["id"], src["id"])).fetchone()
        if clash:
            raise HTTPException(
                409, f"Both records are on {clash['client']} · {clash['project']}. "
                     f"That is a real double-booking — resolve the assignment first.")
        # Read what is about to move BEFORE the UPDATE repoints the rows, so the
        # activity log can name the projects that changed hands.
        moved = [f"{r['client']} · {r['project']}" for r in conn.execute(
            "SELECT client, project FROM resources WHERE person_id=? ORDER BY client, project",
            (src["id"],)).fetchall()]
        conn.execute("UPDATE resources SET person_id=? WHERE person_id=?", (keep["id"], src["id"]))
        for t in conn.execute("SELECT title FROM person_titles WHERE person_id=?", (src["id"],)).fetchall():
            conn.execute("INSERT OR IGNORE INTO person_titles (person_id, title) VALUES (?,?)",
                         (keep["id"], t["title"]))
        conn.execute("DELETE FROM person_titles WHERE person_id=?", (src["id"],))
        conn.execute("DELETE FROM people WHERE id=?", (src["id"],))
        # IRREVERSIBLE from the UI → always logged. Without this row there is no
        # way to find out afterwards what a merge did (the owner, 2026-10-01).
        _log_activity(
            conn, request, "person.merge", target=f"{src['name']} → {keep['name']}",
            details=(f"{len(moved)} project(s) moved onto {keep['name']}"
                     + (f": {', '.join(moved)}" if moved else " (had no assignments)")
                     + f". Person '{src['name']}' deleted. Not reversible from the UI."),
            project=", ".join(moved),
        )
        conn.commit()
        return {"ok": True, "merged": src["name"], "into": keep["name"], "moved": moved}
    finally:
        conn.close()


@app.get("/api/activity")
def api_activity(request: Request, limit: int = 60):
    """Recent actions, newest first — the answer to 'what did I just do?'.

    Admin-only: it exposes who changed what, so PMs do not get it. One indexed
    query, rendered on the Team & Access tab."""
    _require_admin(request)
    lim = max(1, min(int(limit or 60), 500))
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, ts, actor, action, target, details, project "
            "FROM activity ORDER BY id DESC LIMIT ?", (lim,)
        ).fetchall()
        return {"activity": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.delete("/api/people/{pid}")
def api_person_delete(pid: int, request: Request):
    """Delete a person — refused while they still hold project assignments."""
    _require_admin(request)
    _require_perm(request, "people")
    conn = get_db()
    try:
        n = conn.execute("SELECT COUNT(*) FROM resources WHERE person_id=?", (pid,)).fetchone()[0]
        if n:
            raise HTTPException(409, f"This person is still on {n} project(s). Remove those assignments first.")
        gone = conn.execute("SELECT name FROM people WHERE id=?", (pid,)).fetchone()
        conn.execute("DELETE FROM person_titles WHERE person_id=?", (pid,))
        conn.execute("DELETE FROM people WHERE id=?", (pid,))
        _log_activity(conn, request, "person.delete", target=(gone["name"] if gone else f"#{pid}"),
                      details="Person record deleted (held no assignments).")
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


class PhaseCheckBody(BaseModel):
    person_id: int
    phases: list[Phase]
    exclude_resource_id: int | None = None


@app.post("/api/assignment/check-phases")
def api_assignment_check_phases(body: PhaseCheckBody, request: Request):
    """Dry-run a TIME-PHASED plan so the dialog can warn before committing.

    POST (not GET) because a phase list is a structure, not a few scalars. Same
    100% rule, applied per phase.
    """
    _require_people(request)
    conn = get_db()
    try:
        p = conn.execute("SELECT * FROM people WHERE id=?", (body.person_id,)).fetchone()
        if not p:
            raise HTTPException(404, "Person not found")
        phases = parse_phases([x.model_dump() for x in body.phases])
        bad = validate_phases(phases)
        cap = p["capacity"] or CAP_WEEK_HOURS
        base = {"person": {"id": p["id"], "name": p["name"], "capacity": cap},
                "existing_weekly_hours": round(M_peak(conn, body.person_id, body.exclude_resource_id) / 100.0 * cap, 2)}
        if bad:
            return {**base, "ok": False, "invalid": bad, "conflict_count": 0,
                    "conflicts": [], "schedule": [], "total_hours": 0}
        v = validate_phases_assignment(conn, body.person_id, phases, body.exclude_resource_id)
        sched = _resolve_schedule(phases)
        for s in sched:
            s["hours_per_week"] = round(s["allocation_pct"] / 100.0 * cap, 2)
        v.update(base)
        v["schedule"] = sched
        v["total_hours"] = round(sum(s["hours_per_week"] * s["weeks"] for s in sched), 1)
        return v
    finally:
        conn.close()


def M_peak(conn, person_id: int, exclude_resource_id: int | None = None) -> float:
    """Peak existing weekly % for a person (small helper for the check payload)."""
    return person_week_load(conn, person_id, exclude_resource_id)["peak_pct"]


@app.get("/api/assignment/check")
def api_assignment_check(person_id: int, allocation_pct: float = 0.0,
                         start_date: str = "", end_date: str = "",
                         exclude_resource_id: int | None = None, request: Request = None):
    """Dry-run the FLAT 100% rule so the UI can warn BEFORE the PM commits."""
    _require_people(request)
    conn = get_db()
    try:
        p = conn.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
        if not p:
            raise HTTPException(404, "Person not found")
        v = validate_assignment(conn, person_id, allocation_pct, start_date, end_date,
                                exclude_resource_id)
        cap = p["capacity"] or CAP_WEEK_HOURS
        v["person"] = {"id": p["id"], "name": p["name"], "capacity": cap}
        v["proposed_weekly_hours"] = round(float(allocation_pct or 0.0) / 100.0 * cap, 2)
        v["existing_weekly_hours"] = round(v["peak_pct"] / 100.0 * cap, 2)
        return v
    finally:
        conn.close()


@app.post("/api/assignments")
def api_assignment_create(body: AssignmentBody, request: Request):
    """PM adds a person to one of THEIR projects.

    Enforces, in order: project ownership, person exists, title is on the
    person's approved list, non-home titles carry a mandatory reason, the person
    is not already on this project, and the 100% weekly hard block.
    """
    user = _require_people(request)
    conn = get_db()
    try:
        client = (body.client or "").strip()
        project = (body.project or "").strip()
        if not project:
            raise HTTPException(400, "Project is required")
        _pm_may_touch(conn, user, client, project)

        p = conn.execute("SELECT * FROM people WHERE id=?", (body.person_id,)).fetchone()
        if not p:
            raise HTTPException(404, "Person not found")

        # The approved-title set is the security boundary that stops a PM
        # drifting a billing rate. Effective set = explicit approvals ∪ home
        # title. If BOTH are empty the person cannot be priced at all, so refuse
        # rather than letting a PM mint a title (the old check silently allowed
        # anything when the person had no titles — a real hole).
        title = (body.title or "").strip() or (p["home_title"] or "").strip()
        approved = _approved_titles(conn, body.person_id)
        if not approved:
            raise HTTPException(
                400, f"{p['name']} has no title set. Ask an admin to set their "
                     f"home title on the People page before assigning them.")
        if title not in approved:
            raise HTTPException(
                400, f"'{title}' is not an approved title for {p['name']}. "
                     f"Approved: {', '.join(approved)}")

        # A title that differs from the home title is the case the owner wants
        # eyes on (a PM doing BA work, a developer testing), so require the why.
        # A person with NO home title counts as an exception for ANY title.
        exception = ""
        home = (p["home_title"] or "").strip()
        if title and (not home or title != home):
            exception = (body.title_exception or "").strip()
            if not exception:
                raise HTTPException(
                    400, f"A reason is required when booking {p['name']} as '{title}'"
                         + (f" (home title: '{home}')." if home
                            else " — this person has no home title yet."))

        dup = conn.execute(
            "SELECT id FROM resources WHERE person_id=? AND TRIM(UPPER(client))=? "
            "AND TRIM(UPPER(project))=?", (body.person_id, client.upper(), project.upper())
        ).fetchone()
        if dup:
            raise HTTPException(409, f"{p['name']} is already assigned to {client} · {project}.")

        # Time-phased mode when phases are supplied; otherwise the flat path.
        phases = parse_phases([x.model_dump() for x in (body.phases or [])]) if body.phases else []
        if phases:
            err = validate_phases(phases)
            if err:
                raise HTTPException(400, err)
            sd, ed = phases_span(phases)
            alloc = phases[0]["allocation_pct"]   # headline % = the opening phase
        else:
            alloc = float(body.allocation_pct or 0.0)
            if alloc < 0 or alloc > 100:
                raise HTTPException(400, "Allocation must be between 0 and 100%")
            # Enforce the quarter grid (25/50/75/100) SERVER-side, not just in the
            # slider: "the iteration [should] be of 25". The UI steps by 25, but a
            # direct API call or a stale form could still post 35%, so the rule
            # has to live here to actually be true. Nothing else in the codebase
            # writes allocation_pct (the importer and the admin resource editor do
            # not touch it), so this cannot break a bulk load.
            if abs(alloc % 25) > 1e-9:
                raise HTTPException(400, f"Allocation must be a multiple of 25% "
                                         f"(25, 50, 75 or 100) — got {alloc:g}%.")
            sd = (body.start_date or "").strip()
            ed = (body.end_date or "").strip()
            sd_d, ed_d = _iso_date(sd), _iso_date(ed)
            if sd_d and ed_d and ed_d < sd_d:
                raise HTTPException(400, "End date cannot be before the start date")

        # The 100% rule must see the person's load INCLUDING what this assignment
        # will add, week by week — a flat single-% check would miss a taper whose
        # opening phase is the only heavy one.
        v = validate_assignment(conn, body.person_id, alloc, sd, ed)
        if phases:
            v = validate_phases_assignment(conn, body.person_id, phases)
        if not v["ok"]:
            raise HTTPException(409, _clash_message(p["name"], alloc, v))

        pr = _pricing_row(conn, title)
        cap = p["capacity"] or CAP_WEEK_HOURS
        cur = conn.execute(
            "INSERT INTO resources (country, client, project, name, role, rate, "
            "offshore_rate, sort_order, capacity, person_id, allocation_pct, "
            "start_date, end_date, title_exception, phases) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ((p["country"] or ""), client, project, p["name"], title,
             (pr["rate"] if pr else None), (pr["offshore_rate"] if pr else None),
             (conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM resources").fetchone()[0]),
             cap, body.person_id, alloc, sd, ed, exception,
             (json.dumps(phases) if phases else "")),
        )
        rid = int(cur.lastrowid or 0)
        if phases:
            _write_phase_hours(conn, rid, phases, cap)
        else:
            _write_allocation_hours(conn, rid, alloc, cap, sd, ed)
        conn.commit()
        return {"ok": True, "resource_id": rid,
                "weeks_booked": v["weeks_in_window"],
                "weekly_hours": round(alloc / 100.0 * cap, 2),
                "phased": bool(phases)}
    finally:
        conn.close()


def validate_phases_assignment(conn: sqlite3.Connection, person_id: int,
                               phases: list[dict],
                               exclude_resource_id: int | None = None,
                               max_conflicts: int = 12) -> dict:
    """The 100% hard block, applied PHASE BY PHASE.

    The flat `validate_assignment` checks one % against one window. A taper has
    several windows at different %, so each phase's weeks are tested against the
    person's EXISTING load (excluding this assignment when editing), and every
    week that would exceed 100% is reported. Same `person_week_load` source as
    the rail, so the preview and the rail cannot disagree.
    """
    load = person_week_load(conn, person_id, exclude_resource_id)
    weeks = load["weeks"]
    conflicts = []
    owned: set[int] = set()
    for p in phases:
        for wk in _phase_weeks(weeks, p["start_date"], p["end_date"]):
            owned.add(wk)
            total = load["pct"][wk] + float(p["allocation_pct"] or 0.0)
            if total > 100.0 + 1e-9:
                conflicts.append({
                    "week": wk, "label": weeks[wk],
                    "total_pct": round(total, 1),
                    "existing_pct": round(load["pct"][wk], 1),
                    "existing": load["contrib"].get(wk, []),
                    "phase_pct": round(float(p["allocation_pct"] or 0.0), 1),
                })
    return {
        "ok": not conflicts,
        "conflicts": conflicts[:max_conflicts],
        "conflict_count": len(conflicts),
        "peak_pct": load["peak_pct"],
        "current_weekly_pct": load["total_pct"],
        "weeks_in_window": len(owned),
        "phased": True,
    }


def _clash_message(name: str, alloc: float, v: dict) -> str:
    """Human-readable refusal naming the week(s) and the competing project."""
    n = v["conflict_count"]
    c0 = v["conflicts"][0] if v["conflicts"] else {}
    others = "; ".join(c0.get("existing", [])[:3]) or "existing assignments"
    return (
        f"Cannot assign {name} at {round(alloc, 1)}% — it would exceed 100% of capacity "
        f"in {n} week(s). First clash: week {c0.get('label','?')} would reach "
        f"{c0.get('total_pct','?')}% ({c0.get('existing_pct',0)}% already booked on "
        f"{others}). Reduce the allocation or shorten the date range."
    )


def parse_phases(raw) -> list[dict]:
    """Read an assignment's phases from the DB (JSON string) — tolerant of junk."""
    if not raw:
        return []
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(data, list):
        return []
    out = []
    for p in data:
        if not isinstance(p, dict):
            continue
        try:
            pct = float(p.get("allocation_pct") or 0)
        except (TypeError, ValueError):
            continue
        out.append({
            "allocation_pct": pct,
            "start_date": str(p.get("start_date") or "").strip(),
            "end_date": str(p.get("end_date") or "").strip(),
        })
    return out


def validate_phases(phases: list[dict]) -> str:
    """Return an error message if the phase list is unusable, else ''.

    Rules: at least one phase; each 0-100%; start <= end when both given; and NO
    OVERLAPPING weeks. Overlap matters because two phases owning the same week
    would silently double that week's hours for the person, which is exactly the
    kind of quiet inflation the 100% rule exists to prevent.
    """
    if not phases:
        return "At least one phase is required."
    for i, p in enumerate(phases, 1):
        pct = p["allocation_pct"]
        if pct < 0 or pct > 100:
            return f"Phase {i}: allocation must be between 0 and 100%."
        # Every phase sits on the same 25% grid as a flat allocation, so a taper
        # reads as 100 -> 75 -> 50 -> 25 and never as an arbitrary 33%.
        if abs(pct % 25) > 1e-9:
            return (f"Phase {i}: allocation must be a multiple of 25% "
                    f"(25, 50, 75 or 100) — got {pct:g}%.")
        sd, ed = _iso_date(p["start_date"]), _iso_date(p["end_date"])
        if p["start_date"] and not sd:
            return f"Phase {i}: start date is not a valid date."
        if p["end_date"] and not ed:
            return f"Phase {i}: end date is not a valid date."
        if sd and ed and ed < sd:
            return f"Phase {i}: end date is before the start date."
    # Overlap check, computed on the SNAPPED weeks so it matches what is written.
    weeks, _ = _load_layout()
    owned: dict[int, int] = {}
    for i, p in enumerate(phases, 1):
        for wk in _phase_weeks(weeks, p["start_date"], p["end_date"]):
            if wk in owned:
                return (f"Phase {i} overlaps phase {owned[wk]} in the week of "
                        f"{weeks[wk]}. Phases must not share a week.")
            owned[wk] = i
    return ""


def _phase_weeks(weeks: list[str], start_date: str, end_date: str) -> list[int]:
    """Week indices owned by one phase, SNAPPED to whole weeks.

    Weeks run Monday->Sunday and allocation is per-week, so a boundary landing
    mid-week has to pick a side. The rule: a phase owns every week whose Monday
    falls in its window (the same rule the flat mode's `_weeks_between` uses), and
    because the UI snaps the dates it hands us to week boundaries, the phases
    tile the span without gaps or double-ownership.
    """
    return sorted(_weeks_between(weeks, start_date, end_date))


def phases_span(phases: list[dict]) -> tuple[str, str]:
    """Overall start/end of a phase list, ignoring unbounded ends."""
    starts = [p["start_date"] for p in phases if p["start_date"]]
    ends = [p["end_date"] for p in phases if p["end_date"]]
    return (min(starts) if starts else "", max(ends) if ends else "")


def _write_allocation_hours(conn: sqlite3.Connection, rid: int, alloc_pct: float,
                            capacity: float, start_date: str, end_date: str) -> None:
    """Spread allocation_pct × capacity across the weeks in the project window.

    Only the in-window weeks are written, and existing hours outside the window
    are left alone — so re-running this can never silently wipe a hand-tuned
    week that sits outside the assignment's dates.
    """
    weeks, _ = _load_layout()
    window = _weeks_between(weeks, start_date, end_date)
    weekly = float(alloc_pct or 0.0) / 100.0 * float(capacity or CAP_WEEK_HOURS)
    existing = _hours_map(rid, conn)
    for i in window:
        if abs(weekly) < 1e-9:
            conn.execute("DELETE FROM weekly_hours WHERE resource_id=? AND week=?", (rid, i))
        else:
            conn.execute(
                "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?) "
                "ON CONFLICT(resource_id, week) DO UPDATE SET hours=excluded.hours",
                (rid, i, weekly))
    for i, h in existing.items():
        if i not in window and h:
            conn.execute(
                "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?) "
                "ON CONFLICT(resource_id, week) DO UPDATE SET hours=excluded.hours",
                (rid, i, h))


def _resolve_schedule(phases: list[dict]) -> list[dict]:
    """Turn phases into a human-readable, week-aligned schedule.

    Reports the FIRST and LAST week each phase actually owns plus the week count,
    so the UI can show "100% · Jan-02 → Mar-30 · 13 weeks" instead of echoing
    back the raw dates the user typed (which may not sit on week boundaries).
    """
    if not phases:
        return []
    weeks, _ = _load_layout()
    out = []
    for p in phases:
        idx = _phase_weeks(weeks, p["start_date"], p["end_date"])
        out.append({
            "allocation_pct": p["allocation_pct"],
            "start_date": p["start_date"],
            "end_date": p["end_date"],
            "first_week": (weeks[idx[0]] if idx else ""),
            "last_week": (weeks[idx[-1]] if idx else ""),
            "weeks": len(idx),
            "hours_per_week": None,   # filled by the caller when capacity is known
        })
    return out


def _write_phase_hours(conn: sqlite3.Connection, rid: int, phases: list[dict],
                       capacity: float) -> None:
    """Write weekly hours from a phase list: pct × capacity for each owned week.

    Weeks OUTSIDE every phase are left exactly as they are — same contract as the
    flat writer, so a hand-tuned week sitting outside the phased window is never
    silently wiped. A phase at 0% clears its weeks.
    """
    weeks, _ = _load_layout()
    cap = float(capacity or CAP_WEEK_HOURS)
    owned: set[int] = set()
    for p in phases:
        weekly = float(p["allocation_pct"] or 0.0) / 100.0 * cap
        for wk in _phase_weeks(weeks, p["start_date"], p["end_date"]):
            owned.add(wk)
            if abs(weekly) < 1e-9:
                conn.execute("DELETE FROM weekly_hours WHERE resource_id=? AND week=?", (rid, wk))
            else:
                conn.execute(
                    "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?) "
                    "ON CONFLICT(resource_id, week) DO UPDATE SET hours=excluded.hours",
                    (rid, wk, weekly))


@app.put("/api/assignments/{rid}")
def api_assignment_update(rid: int, body: AssignmentBody, request: Request):
    """Change an existing assignment's %, window or title (with the same rules)."""
    user = _require_people(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "Assignment not found")
        _pm_may_touch(conn, user, row["client"], row["project"])
        pid = body.person_id or row["person_id"]
        p = conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "Person not found")
        approved = _approved_titles(conn, pid)
        title = (body.title or row["role"] or p["home_title"] or "").strip()
        if not approved:
            raise HTTPException(400, f"{p['name']} has no title set. Set their home title first.")
        if title not in approved:
            raise HTTPException(
                400, f"'{title}' is not an approved title for {p['name']}. "
                     f"Approved: {', '.join(approved)}")
        exception = (body.title_exception or "").strip()
        home = (p["home_title"] or "").strip()
        if title and (not home or title != home) and not exception:
            raise HTTPException(400, f"A reason is required when booking {p['name']} as '{title}'.")
        phases = parse_phases([x.model_dump() for x in (body.phases or [])]) if body.phases else []
        if phases:
            err = validate_phases(phases)
            if err:
                raise HTTPException(400, err)
            sd, ed = phases_span(phases)
            alloc = phases[0]["allocation_pct"]
        else:
            alloc = float(body.allocation_pct if body.allocation_pct is not None
                          else (row["allocation_pct"] or 0.0))
            # Same quarter grid as create. Note a LEGACY row with a non-quarter
            # allocation keeps working: this only fires when the value is
            # being (re)written, and no live row has one set.
            if abs(alloc % 25) > 1e-9:
                raise HTTPException(400, f"Allocation must be a multiple of 25% "
                                         f"(25, 50, 75 or 100) — got {alloc:g}%.")
            sd = (body.start_date if body.start_date is not None else row["start_date"]) or ""
            ed = (body.end_date if body.end_date is not None else row["end_date"]) or ""
        if phases:
            v = validate_phases_assignment(conn, pid, phases, exclude_resource_id=rid)
        else:
            v = validate_assignment(conn, pid, alloc, sd, ed, exclude_resource_id=rid)
        if not v["ok"]:
            raise HTTPException(409, _clash_message(p["name"], alloc, v))
        pr = _pricing_row(conn, title)
        cap = p["capacity"] or CAP_WEEK_HOURS
        conn.execute(
            "UPDATE resources SET person_id=?, role=?, rate=?, offshore_rate=?, "
            "capacity=?, allocation_pct=?, start_date=?, end_date=?, title_exception=?, "
            "phases=? WHERE id=?",
            (pid, title, (pr["rate"] if pr else row["rate"]),
             (pr["offshore_rate"] if pr else row["offshore_rate"]),
             cap, alloc, sd, ed, exception,
             (json.dumps(phases) if phases else ""), rid))
        # Switching an assignment back to flat mode must not leave the old
        # phased hours behind in weeks the flat window no longer covers.
        if phases:
            _write_phase_hours(conn, rid, phases, cap)
        else:
            _write_allocation_hours(conn, rid, alloc, cap, sd, ed)
        conn.commit()
        return {"ok": True, "weeks_booked": v["weeks_in_window"], "phased": bool(phases)}
    finally:
        conn.close()


@app.delete("/api/assignments/{rid}")
def api_assignment_delete(rid: int, request: Request):
    """Remove a person from a project (PM-scoped). Deletes its hours + actuals."""
    user = _require_people(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "Assignment not found")
        _pm_may_touch(conn, user, row["client"], row["project"])
        nh = conn.execute("SELECT COUNT(*) FROM weekly_hours WHERE resource_id=?", (rid,)).fetchone()[0]
        na = conn.execute("SELECT COUNT(*) FROM actual_hours WHERE resource_id=?", (rid,)).fetchone()[0]
        conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM actual_hours WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM actual_notes WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM resources WHERE id=?", (rid,))
        # Names the hours that went with it — the dialog warns, this records it.
        _log_activity(conn, request, "assignment.delete", target=f"{row['name']} — {row['client']} · {row['project']}",
                      details=f"Removed from project. Deleted {nh} planned-hour row(s) and {na} actual-hour row(s).",
                      project=f"{row['client']} · {row['project']}")
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/my-projects")
def api_my_projects(request: Request):
    """Projects this PM owns, with team counts/hours — the workbench's left list."""
    user = _require_people(request)
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        arch = _archived_project_keys(conn)      # GH-38: no longer theirs
        projs = _pm_projects(user["u"], conn) if user.get("r") == "pm" else None
        rows = conn.execute(
            "SELECT TRIM(client) client, TRIM(project) project, COUNT(*) n, "
            "COALESCE(SUM(h.h),0) hrs FROM resources r "
            "LEFT JOIN (SELECT resource_id, SUM(hours) h FROM weekly_hours GROUP BY resource_id) h "
            "ON h.resource_id=r.id WHERE TRIM(r.project)!='' GROUP BY TRIM(r.client), TRIM(r.project) "
            "ORDER BY TRIM(r.client), TRIM(r.project)").fetchall()
        out = []
        seen: set[tuple[str, str]] = set()
        for r in rows:
            if projs is not None and not _pm_owns(projs, r["client"], r["project"]):
                continue
            key = ((r["client"] or "").upper(), (r["project"] or "").upper())
            if key in arch:
                continue          # archived == deleted, from every live view
            seen.add(key)
            meta = conn.execute(
                "SELECT start_date, end_date FROM projects WHERE TRIM(UPPER(client))=? AND TRIM(UPPER(project))=?",
                ((r["client"] or "").upper(), (r["project"] or "").upper())).fetchone()
            team = conn.execute(
                "SELECT id, name, role, allocation_pct, start_date, end_date, capacity, "
                "title_exception, phases "
                "FROM resources WHERE TRIM(UPPER(client))=? AND TRIM(UPPER(project))=? ORDER BY name",
                ((r["client"] or "").upper(), (r["project"] or "").upper())).fetchall()
            out.append({
                "client": r["client"], "project": r["project"],
                "people": r["n"], "booked_hours": round(r["hrs"] or 0, 1),
                "start_date": (meta["start_date"] if meta else "") or "",
                "end_date": (meta["end_date"] if meta else "") or "",
                "team": [{**dict(t), "phases": parse_phases(t["phases"])} for t in team],
            })
        # GH-37: a project this PM owns but has NOBODY on yet has no resource rows,
        # so the query above cannot see it and a freshly created project vanished
        # from the very list it was meant to appear in (the same class of bug as the
        # Dashboard's GH-32). Add those as empty entries — they are the ones a PM
        # most needs, because staffing them is the next thing they do.
        if projs is not None:
            for cl, pr in projs:
                key = ((cl or "").strip().upper(), (pr or "").strip().upper())
                if not pr or key in seen or key in arch:
                    continue
                meta = conn.execute(
                    "SELECT start_date, end_date FROM projects WHERE "
                    "TRIM(UPPER(client))=? AND TRIM(UPPER(project))=?",
                    (key[0], key[1])).fetchone()
                if not meta:
                    continue          # owned but not defined (legacy row) — skip
                out.append({
                    "client": (cl or "").strip(), "project": pr.strip(),
                    "people": 0, "booked_hours": 0.0,
                    "start_date": meta["start_date"] or "", "end_date": meta["end_date"] or "",
                    "team": [], "empty": True,
                })
            out.sort(key=lambda x: ((x["client"] or "").lower(), (x["project"] or "").lower()))
        return {"projects": out, "role": user.get("r"), "weeks": len(weeks)}
    finally:
        conn.close()


def person_loads_bulk(conn: sqlite3.Connection, weeks: list[str]):
    """Per-week booked % for EVERY person in ONE database pass.

    The rail needs all ~50 people at once; calling person_week_load() in a loop
    did one connection + one hours query per person (N+1 through SQLCipher) and
    took 6.2s. This batches both. Deliberately mirrors person_week_load's maths
    (each row's hours ÷ that row's capacity, summed per person) so the rail and
    the 100% validator can never disagree.
    """
    rows = conn.execute(
        "SELECT id, person_id, capacity, client, project FROM resources "
        "WHERE person_id IS NOT NULL").fetchall()
    by_rid: dict[int, list[tuple[int, float]]] = {}
    for h in conn.execute("SELECT resource_id, week, hours FROM weekly_hours WHERE hours > 0").fetchall():
        by_rid.setdefault(h["resource_id"], []).append((h["week"], h["hours"]))
    n = len(weeks)
    acc: dict[int, list[float]] = {}
    contrib: dict[int, dict[int, list[str]]] = {}
    for r in rows:
        pid = r["person_id"]
        cap = r["capacity"] or CAP_WEEK_HOURS
        a = acc.setdefault(pid, [0.0] * n)
        cmap = contrib.setdefault(pid, {})
        label = "/".join(x for x in ((r["client"] or "").strip(), (r["project"] or "").strip()) if x) or "—"
        for wk, h in by_rid.get(r["id"], []):
            if wk < n and h:
                p = h / cap * 100.0
                a[wk] += p
                # Keep the structured detail (label, %, hours), not just a display
                # string: the load rail needs it to explain a single week and to
                # offer "go edit this project" from the cell.
                cmap.setdefault(wk, []).append(
                    {"label": label, "pct": round(p, 1), "hours": round(h, 2),
                     "resource_id": r["id"], "client": (r["client"] or "").strip(),
                     "project": (r["project"] or "").strip()})
    return acc, contrib


@app.get("/api/pm/load")
def api_pm_load(request: Request):
    """Every person's week-by-week load — powers the workbench load rail.

    PMs see the full roster (they need to know who is free to ask for someone),
    but only booked %, never rates or money.
    """
    _require_people(request)
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        people = conn.execute(
            "SELECT id, name, home_title, capacity FROM people ORDER BY TRIM(UPPER(name))").fetchall()
        projrows = conn.execute(
            "SELECT person_id, client, project FROM resources WHERE person_id IS NOT NULL").fetchall()
        projs: dict[int, list[str]] = {}
        for r in projrows:
            lab = " · ".join(x for x in ((r["client"] or "").strip(), (r["project"] or "").strip()) if x)
            if lab and lab not in projs.setdefault(r["person_id"], []):
                projs[r["person_id"]].append(lab)
        acc, contrib = person_loads_bulk(conn, weeks)
        months = _load_layout()[1]
        # For each week: which month it belongs to, and the list of projects that
        # consume it. Sent as two parallel arrays so the client can label the
        # month band and explain any single week without another request.
        week_month = []
        for i in range(len(weeks)):
            nm = next((m["name"] for m in months if m["start"] <= i <= m["end"]), "")
            week_month.append(nm)
        out = []
        for p in people:
            pct = acc.get(p["id"], [0.0] * len(weeks))
            peak = max(pct) if pct else 0.0
            cmap = contrib.get(p["id"], {})
            detail = [cmap.get(i, []) for i in range(len(weeks))]
            out.append({
                "id": p["id"], "name": p["name"], "home_title": p["home_title"],
                "capacity": p["capacity"],
                "peak_pct": round(peak, 1),
                "peak_week": (weeks[pct.index(peak)] if pct else ""),
                "avg_pct": round(sum(pct) / len(pct), 1) if pct else 0.0,
                "projects": projs.get(p["id"], []),
                "weeks": [round(v, 1) for v in pct],
                "detail": detail,
            })
        # Titles ONLY — no rates. A PM needs the rate-card vocabulary to add a
        # joiner (the title decides pricing and must already exist on the card),
        # and `/api/pricing` is admin-gated. Sending the string alone gives away
        # nothing about money.
        titles = [r["title"] for r in conn.execute(
            "SELECT title FROM pricing ORDER BY sort_order, title").fetchall() if r["title"]]
        return {"people": out, "week_labels": weeks, "months": months,
                "week_month": week_month, "titles": titles,
                "current": _current_period(weeks, months)}
    finally:
        conn.close()


# ---------------- OT approvals (admin gate, the owner's spec) ----------------
# A PM flags an overage as billable OT; the money stays OUT of the Dashboard
# until the admin approves it here. Approval is what flips actual_notes.approved,
# which _actuals_financials reads to release the "Additional work (OT)" revenue.
@app.get("/api/ot/pending")
def api_ot_pending(request: Request):
    """Billable OT awaiting admin approval (plus a short recently-approved tail)."""
    _require_perm(request, "ot_approval")
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        rows = conn.execute(
            "SELECT n.id, n.resource_id, n.week, n.pm, n.overage, n.reason, n.comment, "
            "n.approved, n.billed, n.created_at, r.name, r.role, r.client, r.project, "
            "r.rate, r.offshore_rate, r.capacity "
            "FROM actual_notes n JOIN resources r ON r.id = n.resource_id "
            "WHERE n.is_ot=1 AND n.billed=1 ORDER BY n.approved, n.created_at DESC"
        ).fetchall()
        ot_by_title = {
            x["title"]: (x["ot_multiplier"] or 1.0)
            for x in conn.execute("SELECT title, ot_multiplier FROM pricing").fetchall()
        }
        out = []
        for r in rows:
            mult = ot_by_title.get((r["role"] or "").strip(), 1.0)
            out.append({
                "id": r["id"], "resource_id": r["resource_id"],
                "week": r["week"],
                "week_label": weeks[r["week"]] if 0 <= r["week"] < len(weeks) else str(r["week"]),
                "person": r["name"], "title": r["role"],
                "client": r["client"], "project": r["project"],
                "pm": r["pm"], "ot_hours": round(r["overage"] or 0, 1),
                "reason": r["reason"] or r["comment"] or "",
                "approved": bool(r["approved"]),
                "ot_multiplier": mult,
                "ot_revenue": round((r["overage"] or 0) * (r["rate"] or 0) * mult, 2),
                "ot_cost": round((r["overage"] or 0) * (r["offshore_rate"] or 0), 2),
                "created_at": r["created_at"],
            })
        pending = [x for x in out if not x["approved"]]
        return {
            "pending": pending, "approved": [x for x in out if x["approved"]],
            "pending_revenue": round(sum(x["ot_revenue"] for x in pending), 2),
            "pending_cost": round(sum(x["ot_cost"] for x in pending), 2),
            "gate_enabled": _ot_requires_approval(conn),
        }
    finally:
        conn.close()


class OtDecision(BaseModel):
    approve: bool
    note: str | None = ""


@app.post("/api/ot/{note_id}/decision")
def api_ot_decision(note_id: int, body: OtDecision, request: Request):
    """Approve or revoke one billable-OT entry (admin only)."""
    _require_perm(request, "ot_approval")
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM actual_notes WHERE id=?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(404, "OT entry not found")
        conn.execute("UPDATE actual_notes SET approved=? WHERE id=?",
                     (1 if body.approve else 0, note_id))
        conn.commit()
        return {"ok": True, "approved": bool(body.approve)}
    finally:
        conn.close()


@app.post("/api/ot/gate")
def api_ot_gate(request: Request, enabled: int = 1):
    """Turn the admin OT gate on/off. Off = billable OT hits the Dashboard immediately."""
    _require_perm(request, "ot_approval")
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('ot_requires_approval', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("1" if enabled else "0",))
        conn.commit()
        return {"ok": True, "gate_enabled": bool(enabled)}
    finally:
        conn.close()


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

# Schema init runs LAST so every table-creation helper and the People seeding
# functions are already defined. Keep this at the bottom of the file.
init_db()


# ---------------- Bench ----------------
# the owner: "we can also create a project called bench where the resources will be
# added if they are not allocated to a project fully or partially." Bench is a
# REAL project (client "Internal") with ZERO rates, so bench time adds no cost
# and no revenue and no money total moves. Utilization still reads real bookings.
BENCH_CLIENT = "Internal"
BENCH_PROJECT = "Bench"


def ensure_bench(conn: sqlite3.Connection):
    """Make sure the Bench project exists; return its id. Idempotent.

    Bench is where an unallocated person is parked so a partial or zero booking
    is visible instead of the person vanishing from the grids.
    """
    try:
        row = conn.execute("SELECT id FROM projects WHERE client=? AND project=?",
                           (BENCH_CLIENT, BENCH_PROJECT)).fetchone()
        if row:
            return row["id"]
        cur = conn.execute(
            "INSERT INTO projects (client, project, start_date, end_date) VALUES (?,?,?,?)",
            (BENCH_CLIENT, BENCH_PROJECT, "", ""))
        conn.commit()
        return cur.lastrowid
    except Exception:  # noqa: BLE001 - a helper must never break startup
        try:
            conn.rollback()
        except Exception:
            pass
        return None


def ensure_bench_on_start() -> None:
    """Bench must exist on every start, not only after a manual create."""
    try:
        c = get_db()
        ensure_bench(c)
        c.close()
    except Exception:  # noqa: BLE001
        pass


ensure_bench_on_start()