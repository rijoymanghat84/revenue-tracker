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

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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


# ---------------- Auth gate (basic auth, one shared password) ----------------
def _auth_creds() -> tuple[str, str]:
    user = os.environ.get("REVENUE_AUTH_USER", "rijoy")
    pw = os.environ.get("REVENUE_AUTH_PASSWORD", "")
    if not pw:
        pw_file = BASE / ".password"
        if pw_file.exists():
            pw = pw_file.read_text().strip()
    return user, pw


class BasicAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.url.path == "/healthz":
            return await call_next(request)  # liveness stays open for the watchdog
        user, pw = _auth_creds()
        auth = request.headers.get("Authorization", "")
        ok = False
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8")
                u, _, p = decoded.partition(":")
                ok = bool(pw) and hmac.compare_digest(u, user) and hmac.compare_digest(p, pw)
            except Exception:  # noqa: BLE001
                ok = False
        if not ok:
            resp = JSONResponse({"detail": "Unauthorized"}, status_code=401)
            resp.headers["WWW-Authenticate"] = 'Basic realm="Revenue Tracker"'
            return resp
        return await call_next(request)


app.add_middleware(BasicAuthMiddleware)


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
        """
    )
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


def _resource_dict(row: sqlite3.Row, hours: dict[int, float], weeks: list[str]) -> dict:
    hrs = [hours.get(i, 0.0) for i in range(len(weeks))]
    total_hrs = sum(hrs)
    rate = row["rate"] or 0.0
    off_rate = row["offshore_rate"] or 0.0
    cost = rate * total_hrs
    expense = off_rate * total_hrs
    return {
        "id": row["id"],
        "country": row["country"],
        "client": row["client"],
        "project": row["project"],
        "name": row["name"],
        "role": row["role"],
        "rate": row["rate"],
        "offshore_rate": row["offshore_rate"],
        "hours": hrs,
        "total_hrs": total_hrs,
        "total_cost": cost,
        "expense": expense,
        "difference": cost - expense,
    }


def _all_resources(conn: sqlite3.Connection, weeks: list[str]) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM resources ORDER BY sort_order, id"
    ).fetchall()
    return [_resource_dict(r, _hours_map(r["id"], conn), weeks) for r in rows]


# ---------------- Pydantic models ----------------
class ResourceUpdate(BaseModel):
    country: str | None = None
    client: str | None = None
    project: str | None = None
    name: str | None = None
    role: str | None = None
    rate: float | None = None
    offshore_rate: float | None = None


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
def api_state():
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
def api_create_resource(body: ResourceUpdate | None = None):
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
def api_update_resource(rid: int, body: ResourceUpdate):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
        new_vals = {
            k: (getattr(body, k) if getattr(body, k) is not None else row[k])
            for k in ("country", "client", "project", "name", "role", "rate", "offshore_rate")
        }
        conn.execute(
            "UPDATE resources SET country=?, client=?, project=?, name=?, role=?, rate=?, offshore_rate=? WHERE id=?",
            (new_vals["country"], new_vals["client"], new_vals["project"],
             new_vals["name"], new_vals["role"], new_vals["rate"], new_vals["offshore_rate"], rid),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        weeks, _ = _load_layout()
        return _resource_dict(row, _hours_map(rid, conn), weeks)
    finally:
        conn.close()


@app.put("/api/resources/{rid}/hours")
def api_update_hours(rid: int, body: HoursUpdate):
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
def api_delete_resource(rid: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (rid,))
        conn.execute("DELETE FROM resources WHERE id=?", (rid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/dashboard")
def api_dashboard():
    conn = get_db()
    try:
        weeks, _ = _load_layout()
        resources = _all_resources(conn, weeks)
        return {"rows": build_dashboard_rows(resources, weeks), "generated_at": None}
    finally:
        conn.close()


def build_dashboard_rows(resources: list[dict], weeks: list[str]) -> dict:
    """Grouped country|client report — mirrors the VBA SyncDashboard but
    dedupes by (normalized country, normalized client) so the IMS bug
    (a subtotal row leaking into the group list) cannot recur."""
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
            "difference": 0.0,
            "currency": "EUR" if _norm(country) in EU_COUNTRIES else "USD",
            "resources": 0,
        })
        if key not in order:
            order.append(key)
        g["revenue"] += r["total_cost"]
        g["expense"] += r["expense"]
        g["difference"] += r["difference"]
        g["resources"] += 1

    rows = [groups[k] for k in order]
    totals: dict[str, dict] = {}
    for g in rows:
        t = totals.setdefault(g["currency"], {"currency": g["currency"], "revenue": 0.0, "expense": 0.0, "difference": 0.0})
        t["revenue"] += g["revenue"]
        t["expense"] += g["expense"]
        t["difference"] += g["difference"]
    return {"groups": rows, "totals": list(totals.values())}


# ---------------- Pricing library ----------------
def _pricing_dict(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    used = conn.execute(
        "SELECT COUNT(*) FROM resources WHERE TRIM(role)=?", (row["title"],)
    ).fetchone()[0]
    return dict(row) | {"used_by": used}


@app.get("/api/pricing")
def api_pricing_list():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, title, rate, offshore_rate, currency FROM pricing ORDER BY sort_order, title"
        ).fetchall()
        return [_pricing_dict(r, conn) for r in rows]
    finally:
        conn.close()


@app.post("/api/pricing")
def api_pricing_create(body: PricingUpdate):
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
def api_pricing_update(pid: int, body: PricingUpdate):
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
def api_pricing_delete(pid: int):
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
def api_pricing_apply(pid: int):
    """Push this title's rates onto every resource using it."""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM pricing WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "pricing title not found")
        cur = conn.execute(
            "UPDATE resources SET rate=?, offshore_rate=? WHERE TRIM(role)=?",
            (row["rate"], row["offshore_rate"], row["title"]),
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


# ---------------- Import ----------------
@app.post("/api/import")
async def api_import(file: UploadFile = File(...), mode: str = Form("merge")):
    data = await file.read()
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
        # reintroduce non-canonical titles).
        canon_rows = conn.execute("SELECT title FROM pricing").fetchall()
        canon_by_norm = {r["title"].strip().lower(): r["title"] for r in canon_rows}
        for pr in parsed["resources"]:
            key = (pr["role"] or "").strip().lower()
            if key in canon_by_norm:
                pr["role"] = canon_by_norm[key]
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
        # Resource roles do NOT auto-add to the Pricing library — the library
        # is the canonical list + manual '+ Add Title' entries. Only an
        # explicit Pricing sheet in the uploaded file adds titles.
        for pr in parsed["resources"]:
            role = _canon_title(pr["role"])
            pr["role"] = role  # canonical spelling for storage
        for p in parsed_pricing:
            _upsert_pricing(p["title"], p["rate"], p["offshore_rate"], p.get("currency", "USD"))
        conn.commit()

        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        return {
            "added": added,
            "updated": updated,
            "renamed": renamed,
            "skipped": skipped,
            "pricing_added": pricing_added,
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
def api_export():
    conn = get_db()
    try:
        weeks, months = _load_layout()
        resources = _all_resources(conn, weeks)
        dash = build_dashboard_rows(resources, weeks)
        pricing = conn.execute(
            "SELECT title, rate, offshore_rate, currency FROM pricing ORDER BY sort_order, title"
        ).fetchall()
        buf = importer.build_workbook(weeks, months, resources, dash, [dict(r) for r in pricing])
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