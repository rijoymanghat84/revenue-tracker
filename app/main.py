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
import os
import sqlite3
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from . import importer

BASE = Path(__file__).resolve().parent.parent
DATA_DIR = BASE / "data"
DB_PATH = DATA_DIR / "revenue.db"
STATIC_DIR = Path(__file__).resolve().parent / "static"

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

app = FastAPI(title="Revenue Tracker")


# ---------------- Auth (login + role-based sessions) ----------------
def _admin_creds() -> tuple[str, str]:
    user = os.environ.get("REVENUE_AUTH_USER", "rijoy")
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


def _pm_projects(username: str, conn: sqlite3.Connection) -> list[str]:
    row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        return []
    return [r["project"] for r in conn.execute(
        "SELECT project FROM user_projects WHERE user_id=? ORDER BY project", (row["id"],)
    ).fetchall()]


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


def _require_pm(request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    return user


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
            resp = JSONResponse({"role": "admin", "username": uname, "projects": []})
            resp.set_cookie("rt_session", _make_token(uname, "admin"), httponly=True, samesite="lax", max_age=7 * 86400)
            return resp
        # PM: users table
        row = conn.execute("SELECT username, password_hash FROM users WHERE username=?", (uname,)).fetchone()
        if row and _verify_password(body.password or "", row["password_hash"]):
            projects = _pm_projects(uname, conn)
            resp = JSONResponse({"role": "pm", "username": uname, "projects": projects})
            resp.set_cookie("rt_session", _make_token(uname, "pm"), httponly=True, samesite="lax", max_age=7 * 86400)
            return resp
        raise HTTPException(401, "Invalid username or password")
    finally:
        conn.close()


@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("rt_session")
    return resp


@app.get("/api/me")
def api_me(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Unauthorized")
    conn = get_db()
    try:
        projects = _pm_projects(user["u"], conn) if user.get("r") == "pm" else []
        return {"role": user["r"], "username": user["u"], "projects": projects}
    finally:
        conn.close()


# ---------------- DB ----------------
def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
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
            project TEXT NOT NULL,
            PRIMARY KEY (user_id, project)
        );
        """
    )
    # Migration: add capacity column if the resources table predates it
    rcols = {r[1] for r in conn.execute("PRAGMA table_info(resources)").fetchall()}
    if "capacity" not in rcols:
        conn.execute("ALTER TABLE resources ADD COLUMN capacity REAL NOT NULL DEFAULT 40")
    # Migration: add project column if the table predates it
    cols = {r[1] for r in conn.execute("PRAGMA table_info(resources)").fetchall()}
    if "project" not in cols:
        conn.execute("ALTER TABLE resources ADD COLUMN project TEXT NOT NULL DEFAULT ''")
    # Migration: add currency column if the pricing table predates it
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(pricing)").fetchall()}
    if "currency" not in pcols:
        conn.execute("ALTER TABLE pricing ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'")
    # Seed the pricing library once from distinct resource roles
    if conn.execute("SELECT COUNT(*) FROM pricing").fetchone()[0] == 0:
        seed_pricing_from_roles(conn)
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


init_db()


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
        "SELECT week, pm, overage, comment, is_ot, approved, billed FROM actual_notes "
        "WHERE resource_id=? ORDER BY week",
        (resource_id,),
    ).fetchall()
    return {r["week"]: dict(r) for r in rows}


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


def _all_resources(conn: sqlite3.Connection, weeks: list[str]) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM resources ORDER BY sort_order, id"
    ).fetchall()
    return [
        _resource_dict(r, _hours_map(r["id"], conn), weeks,
                       _actual_hours_map(r["id"], conn), _actual_notes_map(r["id"], conn))
        for r in rows
    ]


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
            "(SELECT COUNT(*) FROM resources r WHERE TRIM(r.role)=p.title) AS used_by "
            "FROM pricing p ORDER BY p.sort_order, p.title"
        ).fetchall()
        return {
            "year": 2026,
            "weeks": weeks,
            "months": months,
            "resources": resources,
            "pricing": [dict(r) for r in pricing],
        }
    finally:
        conn.close()


@app.post("/api/resources")
def api_create_resource(body: ResourceUpdate | None = None, request: Request = None):
    _require_admin(request)
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, sort_order) "
            "VALUES (?,?,?,?,?,?,?, "
            "COALESCE((SELECT MAX(sort_order)+1 FROM resources), 0))",
            (
                (body.country or "") if body else "",
                (body.client or "") if body else "",
                (body.project or "") if body else "",
                (body.name or "New Resource") if body else "New Resource",
                (body.role or "") if body else "",
                body.rate if body else None,
                body.offshore_rate if body else None,
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
    _require_admin(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
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
    _require_admin(request)
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
    _require_admin(request)
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
        return {"status": "ok", "overage": 0.0}
    if overage < 0:
        # under-delivery: mandatory comment
        if not (note.get("comment") or "").strip():
            return {"status": "needs_comment", "overage": overage}
        return {"status": "ok", "overage": overage}
    # overage -> OT flow (any overage)
    is_ot = note.get("is_ot")
    if is_ot is None:
        # OT question not answered yet — must ask before saving
        return {"status": "needs_ot", "overage": overage}
    if not is_ot:
        # explicitly declined OT: record overage, no approval/billing questions
        return {"status": "ok", "overage": overage, "is_ot": False}
    approved = bool(note.get("approved"))
    if not approved:
        return {"status": "needs_approval", "overage": overage, "is_ot": True}
    billed = bool(note.get("billed"))
    if not billed:
        if not (note.get("reason") or "").strip():
            return {"status": "needs_billing_reason", "overage": overage, "is_ot": True, "approved": True}
        return {"status": "ok", "overage": overage, "is_ot": True, "approved": True, "billed": False}
    return {"status": "ok", "overage": overage, "is_ot": True, "approved": True, "billed": True}


@app.put("/api/resources/{rid}/actuals")
def api_update_actuals(rid: int, body: ActualsUpdate, request: Request):
    user = _require_pm(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
        # PM scoping: only their projects
        if user.get("r") == "pm":
            projs = _pm_projects(user["u"], conn)
            proj = (row["project"] or "").strip()
            if proj and proj not in projs:
                raise HTTPException(403, "Not assigned to this project")
        weeks, _ = _load_layout()
        n = len(weeks)
        if body.hours is None:
            raise HTTPException(400, "provide 'hours'")
        hours = [float(h) if h is not None else 0.0 for h in body.hours]
        if len(hours) != n:
            raise HTTPException(400, f"expected {n} hours, got {len(hours)}")
        planned = _hours_map(rid, conn)
        capacity = row["capacity"] or 40.0
        notes = body.notes or {}
        # Validate every week; collect anything that still needs input
        needs = []
        for i, h in enumerate(hours):
            if not h:
                continue
            v = _validate_actual_week(planned.get(i, 0.0), h, capacity, notes.get(i))
            if v["status"] != "ok":
                needs.append({"week": i, **v})
        if needs:
            return JSONResponse({"status": "needs_input", "weeks": needs}, status_code=200)
        # All good: persist hours + notes
        conn.execute("DELETE FROM actual_hours WHERE resource_id=?", (rid,))
        conn.executemany(
            "INSERT INTO actual_hours (resource_id, week, hours) VALUES (?,?,?)",
            [(rid, i, h) for i, h in enumerate(hours) if h],
        )
        for i, h in enumerate(hours):
            if not h:
                continue
            v = _validate_actual_week(planned.get(i, 0.0), h, capacity, notes.get(i))
            note = notes.get(i) or {}
            conn.execute(
                "INSERT INTO actual_notes (resource_id, week, pm, overage, comment, is_ot, approved, billed) "
                "VALUES (?,?,?,?,?,?,?,?) "
                "ON CONFLICT(resource_id, week) DO UPDATE SET "
                "pm=excluded.pm, overage=excluded.overage, comment=excluded.comment, "
                "is_ot=excluded.is_ot, approved=excluded.approved, billed=excluded.billed",
                (rid, i, user["u"], v["overage"], (note.get("comment") or "").strip(),
                 int(v.get("is_ot", False)), int(v.get("approved", False)), int(v.get("billed", False))),
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
            projs = set(_pm_projects(user["u"], conn))
            resources = [r for r in resources if not (r["project"] or "").strip() or (r["project"] or "").strip() in projs]
        # Strip rates for PMs
        if user.get("r") == "pm":
            for r in resources:
                r["rate"] = None
                r["offshore_rate"] = None
        return {"weeks": weeks, "months": _load_layout()[1], "resources": resources,
                "role": user["r"], "username": user["u"], "year": 2026}
    finally:
        conn.close()


# ---------------- User management (admin) ----------------
class UserCreate(BaseModel):
    username: str
    password: str
    projects: list[str] = []


class UserUpdate(BaseModel):
    password: str | None = None
    projects: list[str] | None = None


def _project_owners(conn: sqlite3.Connection) -> dict[str, str]:
    """Map project -> owning PM username. A project has AT MOST one PM (the
    UI enforces this too, but the DB layer must guarantee it)."""
    rows = conn.execute(
        "SELECT up.project, u.username FROM user_projects up "
        "JOIN users u ON u.id = up.user_id ORDER BY up.project"
    ).fetchall()
    return {r["project"]: r["username"] for r in rows}


def _validate_project_ownership(conn, projects: list[str], self_username: str | None) -> None:
    """Reject assigning a project that's already owned by a DIFFERENT PM.
    self_username is the PM being edited (its own projects are fine)."""
    owners = _project_owners(conn)
    for p in projects:
        owner = owners.get(p)
        if owner and owner != self_username:
            raise HTTPException(409, f"Project '{p}' is already assigned to PM '{owner}'")


@app.get("/api/users")
def api_users(request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        rows = conn.execute("SELECT id, username, role FROM users ORDER BY username").fetchall()
        out = []
        for r in rows:
            projs = [p["project"] for p in conn.execute(
                "SELECT project FROM user_projects WHERE user_id=? ORDER BY project", (r["id"],)
            ).fetchall()]
            out.append({"id": r["id"], "username": r["username"], "role": r["role"], "projects": projs})
        return out
    finally:
        conn.close()


@app.get("/api/project-owners")
def api_project_owners(request: Request):
    """Which PM owns each project (so the UI can grey out projects already
    taken). Only admin."""
    _require_admin(request)
    conn = get_db()
    try:
        return _project_owners(conn)
    finally:
        conn.close()


@app.post("/api/users")
def api_user_create(body: UserCreate, request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        uname = (body.username or "").strip()
        if not uname or not body.password:
            raise HTTPException(400, "username and password required")
        if conn.execute("SELECT 1 FROM users WHERE username=?", (uname,)).fetchone():
            raise HTTPException(409, f"User '{uname}' already exists")
        projs = sorted({x.strip() for x in body.projects if x.strip()})
        _validate_project_ownership(conn, projs, self_username=None)
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?,?, 'pm')",
            (uname, _hash_password(body.password)),
        )
        uid = cur.lastrowid
        for p in projs:
            conn.execute("INSERT INTO user_projects (user_id, project) VALUES (?,?)", (uid, p))
        conn.commit()
        return {"ok": True, "id": uid, "username": uname}
    finally:
        conn.close()


@app.put("/api/users/{uid}")
def api_user_update(uid: int, body: UserUpdate, request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "user not found")
        if body.password:
            conn.execute("UPDATE users SET password_hash=? WHERE id=?", (_hash_password(body.password), uid))
        if body.projects is not None:
            projs = sorted({x.strip() for x in body.projects if x.strip()})
            _validate_project_ownership(conn, projs, self_username=row["username"])
            conn.execute("DELETE FROM user_projects WHERE user_id=?", (uid,))
            for p in projs:
                conn.execute("INSERT INTO user_projects (user_id, project) VALUES (?,?)", (uid, p))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/users/{uid}")
def api_user_delete(uid: int, request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        conn.execute("DELETE FROM user_projects WHERE user_id=?", (uid,))
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/projects")
def api_projects(request: Request):
    """Distinct project names (for PM assignment)."""
    _require_admin(request)
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT TRIM(project) AS p FROM resources WHERE TRIM(project) != '' ORDER BY p"
        ).fetchall()
        return [r["p"] for r in rows]
    finally:
        conn.close()


@app.get("/api/dashboard")
def api_dashboard(request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        resources = _all_resources(conn, weeks)
        return {"rows": build_dashboard_rows(resources, weeks), "generated_at": None}
    finally:
        conn.close()


def _actuals_financials(r: dict) -> dict:
    """Actuals-based revenue/expense + reconciliation deltas.
    - actual_rev / actual_exp: computed ONLY from recorded actual hours.
      actual_rev counts what was actually billable (billed OT overage counts;
      unbilled overage only bills the planned portion; under-delivery bills the
      actual hours). Zero actuals -> $0 — never assumes actual == planned.
    - add_rev / add_exp: overage deltas (billed overage × onsite; all overage
      × offshore).
    - adj_rev / adj_exp: under-delivery deltas (negative on both sides)."""
    add_rev = add_exp = adj_rev = adj_exp = 0.0
    actual_rev = actual_exp = 0.0
    rate = r["rate"] or 0.0
    off = r["offshore_rate"] or 0.0
    planned = r["hours"] or []
    actual = r.get("actual_hours") or []
    notes = r.get("actual_notes") or {}
    for i, a in enumerate(actual):
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
                actual_rev += a * rate
                add_rev += over * rate
            else:
                actual_rev += p * rate  # only the planned portion is billable
        elif over < 0:
            actual_rev += a * rate      # under-delivery: bill actual hours
            adj_rev += over * rate
            adj_exp += over * off
        else:
            actual_rev += p * rate      # equal to plan
    return {
        "add_rev": round(add_rev, 2), "add_exp": round(add_exp, 2),
        "adj_rev": round(adj_rev, 2), "adj_exp": round(adj_exp, 2),
        "actual_rev": round(actual_rev, 2), "actual_exp": round(actual_exp, 2),
    }


def build_dashboard_rows(resources: list[dict], weeks: list[str]) -> dict:
    """Grouped country|client report — mirrors the VBA SyncDashboard but
    dedupes by (normalized country, normalized client) so the IMS bug
    (a subtotal row leaking into the group list) cannot recur. Includes the
    Actuals reconciliation: Additional Revenue/Expense + Adjustment."""
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
        fin = _actuals_financials(r)
        g["revenue"] += r["total_cost"]
        g["expense"] += r["expense"]
        g["actual_rev"] += fin["actual_rev"]
        g["actual_exp"] += fin["actual_exp"]
        g["add_rev"] += fin["add_rev"]
        g["add_exp"] += fin["add_exp"]
        g["adj_rev"] += fin["adj_rev"]
        g["adj_exp"] += fin["adj_exp"]
        g["difference"] += r["difference"] + fin["add_rev"] - fin["add_exp"] + fin["adj_rev"] - fin["adj_exp"]
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
CAP_WEEK_HOURS = 40.0  # 40 hrs/week = 100% (per Rijoy's spec)


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
def api_utilization(request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        data = compute_utilization(weeks, months, resources)
        data["capacity_week"] = CAP_WEEK_HOURS
        return data
    finally:
        conn.close()


# ---------------- Pricing library ----------------
def _pricing_dict(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    used = conn.execute(
        "SELECT COUNT(*) FROM resources WHERE TRIM(role)=?", (row["title"],)
    ).fetchone()[0]
    return dict(row) | {"used_by": used}


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
    _require_admin(request)
    conn = get_db()
    try:
        title = (body.title or "").strip()
        if not title:
            raise HTTPException(400, "title is required")
        if conn.execute("SELECT 1 FROM pricing WHERE title=?", (title,)).fetchone():
            raise HTTPException(409, f"Title '{title}' already exists")
        cur = conn.execute(
            "INSERT INTO pricing (title, rate, offshore_rate, currency, sort_order) VALUES (?,?,?,?,"
            " COALESCE((SELECT MAX(sort_order)+1 FROM pricing),0))",
            (title, body.rate, body.offshore_rate, norm_currency(body.currency)),
        )
        conn.commit()
        row = conn.execute("SELECT id, title, rate, offshore_rate, currency FROM pricing WHERE id=?",
                           (cur.lastrowid,)).fetchone()
        return _pricing_dict(row, conn)
    finally:
        conn.close()


@app.put("/api/pricing/{pid}")
def api_pricing_update(pid: int, body: PricingUpdate, request: Request):
    _require_admin(request)
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
        conn.execute(
            "UPDATE pricing SET title=?, rate=?, offshore_rate=?, currency=? WHERE id=?",
            (new_title, rate, off, currency, pid),
        )
        conn.commit()
        row = conn.execute("SELECT id, title, rate, offshore_rate, currency FROM pricing WHERE id=?",
                           (pid,)).fetchone()
        return _pricing_dict(row, conn)
    finally:
        conn.close()


@app.delete("/api/pricing/{pid}")
def api_pricing_delete(pid: int, request: Request):
    _require_admin(request)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM pricing WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "pricing title not found")
        conn.execute("DELETE FROM pricing WHERE id=?", (pid,))
        conn.commit()
        return {"ok": True, "title": row["title"]}
    finally:
        conn.close()


@app.post("/api/pricing/{pid}/apply")
def api_pricing_apply(pid: int, request: Request):
    """Push this title's rates onto every resource using it (null rates kept
    as-is so an unpriced title can't zero out resources)."""
    _require_admin(request)
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
    _require_admin(request)
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
        conn.commit()
        return {"ok": True, "updated": total, "per_title": per_title}
    finally:
        conn.close()


# ---------------- Import ----------------
@app.post("/api/import")
async def api_import(file: UploadFile = File(...), mode: str = Form("merge"), request: Request = None):
    user = _require_pm(request)
    data = await file.read()

    # PM import: Actuals-only, scoped to their projects. They can never touch
    # planned hours, pricing, or resources — only actual_hours for their team.
    if user.get("r") == "pm":
        conn = get_db()
        try:
            projs = set(_pm_projects(user["u"], conn))
            parsed_actuals = importer.parse_actuals_sheet(data)
            res_by_key = {
                (_norm(r["client"]), _norm(r["name"])): r
                for r in conn.execute("SELECT id, client, project, name FROM resources").fetchall()
            }
            added = 0
            for pa in parsed_actuals:
                cur = res_by_key.get((_norm(pa["client"]), _norm(pa["name"])))
                if not cur:
                    continue
                proj = (cur["project"] or "").strip()
                if proj and proj not in projs:
                    continue  # not this PM's project — skip
                rid = cur["id"]
                conn.execute("DELETE FROM actual_hours WHERE resource_id=?", (rid,))
                conn.executemany(
                    "INSERT INTO actual_hours (resource_id, week, hours) VALUES (?,?,?)",
                    [(rid, i, h) for i, h in enumerate(pa["hours"]) if h],
                )
                added += 1
            conn.commit()
            return {"added": 0, "updated": 0, "renamed": 0, "skipped": 0,
                    "pricing_added": 0, "pricing_updated": 0, "actuals_added": added,
                    "mode": "pm-actuals", "backup": None, "warnings": []}
        finally:
            conn.close()

    try:
        parsed = importer.parse_workbook_bytes(data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read workbook: {e}")

    conn = get_db()
    backup_path = None
    try:
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
def api_export(request: Request):
    user = _require_pm(request)
    conn = get_db()
    try:
        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        # PMs get an Actuals-only workbook scoped to their projects (no rates,
        # no other tabs — they must never see other teams' data).
        if user.get("r") == "pm":
            projs = set(_pm_projects(user["u"], conn))
            scoped = [r for r in resources
                      if not (r["project"] or "").strip() or (r["project"] or "").strip() in projs]
            for r in scoped:
                r["rate"] = None
                r["offshore_rate"] = None
            buf = importer.build_actuals_workbook(weeks, months, scoped)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": 'attachment; filename="Actuals_2026_export.xlsx"'},
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
            headers={"Content-Disposition": 'attachment; filename="Revenue_2026_export.xlsx"'},
        )
    finally:
        conn.close()


# ---------------- Static ----------------
@app.get("/healthz")
def healthz():
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")