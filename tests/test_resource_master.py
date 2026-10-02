"""GH-56: the Resource master list.

the owner, 2026-10-02:
  "I want you to split the Teams and Access section for admin to team and
   Resource, move the resource ... to resource tab but with the look and
   functionality of the resource from PM section ... option to Add new resource
   and by default it gets added to bench and then make a resource active or
   inactive, their home title, Approved titles, capacity, project they are in.
   Option to assign them to project from back.
   This will be the master table for resource any change to this will reflect
   everywhere and any change to resource by PM or any body should replce here too"

Covers the data contract behind that screen:
  1. Add resource -> ACTIVE + parked on Internal · Bench (zero-rate, no hours)
  2. First real assignment releases a LONE bench row
  3. Edit propagates: name / home title / capacity rewrite the project rows
  4. An exception title is NOT rewritten (only the old home title is)
  5. The money never moves from any of the above

Runs against a TEMP database — it can never touch the live book.
    /usr/bin/python3 tests/test_resource_master.py
"""
import os, sys, tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app.main as m

tmp = tempfile.mkdtemp(prefix="rt-rm-")
os.environ["REVENUE_AUTH_USER"] = "admin"
os.environ["REVENUE_AUTH_PASSWORD"] = "super-secret"
os.environ["REVENUE_DB_PASSWORD"] = ""
m.DATA_DIR = Path(tmp)
m.DB_PATH = Path(tmp) / "revenue.db"
m.DB_KEY_FILE = Path(tmp) / ".dbkey"
m.LEGACY_KEY_FILE = Path(tmp) / ".dbkey.legacy"

import sqlite3 as _plain
m._cipher = _plain
m._HAS_CIPHER = False

from fastapi.testclient import TestClient
m.init_db()
client = TestClient(m.app)

failures = []


def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), "-", name, extra)
    if not cond:
        failures.append(name)


def q(sql, args=()):
    c = m.get_db()
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def one(sql, args=()):
    r = q(sql, args)
    return r[0] if r else None


def money():
    """(rev, exp, hrs) — coalesced to 0 so an empty book is comparable."""
    r = one("SELECT ROUND(COALESCE(SUM(h.hours*COALESCE(r.rate,0)),0),4) rev, "
            "ROUND(COALESCE(SUM(h.hours*COALESCE(r.offshore_rate,0)),0),4) exp, "
            "ROUND(COALESCE(SUM(h.hours),0),2) hrs FROM resources r "
            "JOIN weekly_hours h ON h.resource_id=r.id")
    return (float(r["rev"]), float(r["exp"]), float(r["hrs"])) if r else (0.0, 0.0, 0.0)


r = client.post("/api/login", json={"username": "admin", "password": "super-secret"})
check("login as super-admin", r.status_code == 200 and r.json().get("super_admin"))
W = {"rt_session": r.cookies["rt_session"]}

# A project to assign into, with a priced title so money is observable.
conn = m.get_db()
conn.execute("INSERT INTO projects (client, project, start_date, end_date) VALUES (?,?,?,?)",
             ("Acme", "Atlas", "", ""))
conn.execute("INSERT INTO pricing (title, rate, offshore_rate, currency) VALUES (?,?,?,?)",
             ("QA", 100.0, 40.0, "USD"))
conn.commit(); conn.close()
m.ensure_bench(m.get_db())

before = money()
print("money before:", before)

# ---- 1. Add a resource: ACTIVE + on the Bench, zero rates, no hours ---------
r = client.post("/api/people", json={"name": "Zz Newbie", "country": "CA",
                                     "home_title": "QA", "capacity": 40},
                cookies=W)
check("add resource returns 200", r.status_code == 200, str(r.status_code)[:200])
pid = r.json().get("id")
bench_rid = r.json().get("bench_resource_id")
check("response carries a bench resource id", bool(bench_rid), str(r.json())[:200])

prow = one("SELECT * FROM people WHERE id=?", (pid,))
check("person is ACTIVE by default", int(prow["active"]) == 1, f"active={prow['active']}")

brow = one("SELECT * FROM resources WHERE id=?", (bench_rid,))
check("parked on Internal · Bench", brow and brow["client"] == "Internal" and brow["project"] == "Bench",
      f"{brow['client']} · {brow['project']}" if brow else "no row")
check("bench row holds ZERO rates (financially inert)",
      brow and float(brow["rate"] or 0) == 0 and float(brow["offshore_rate"] or 0) == 0,
      f"rate={brow['rate']} offshore={brow['offshore_rate']}" if brow else "")
bhrs = one("SELECT COUNT(*) n, COALESCE(SUM(hours),0) h FROM weekly_hours WHERE resource_id=?",
           (bench_rid,))
check("bench row writes NO hours (so they read as FREE, not 100% booked)",
      bhrs["n"] == 0 and float(bhrs["h"]) == 0, f"rows={bhrs['n']} hours={bhrs['h']}")

# The load rail must show them as available, not booked.
load = client.get("/api/pm/load", cookies=W).json()
mine = [x for x in load["people"] if x["id"] == pid][0]
check("rail shows the new resource as 100% free", mine["peak_pct"] == 0,
      f"peak={mine['peak_pct']}")
check("...and lists them on the Bench project",
      any("Bench" in s for s in mine["projects"]), str(mine["projects"]))
check("money unchanged by the add", money() == before, f"{money()} vs {before}")

# ---- 2. First real assignment releases the lone Bench row -------------------
r = client.post("/api/assignments", cookies=W, json={
    "client": "Acme", "project": "Atlas", "person_id": pid, "title": "QA",
    "allocation_pct": 50, "start_date": "", "end_date": "",
})
check("assign 50% to Acme · Atlas is accepted", r.status_code == 200, str(r.status_code)[:300])
still_bench = one("SELECT * FROM resources WHERE person_id=? AND project='Bench'", (pid,))
check("the lone Bench placeholder was released", still_bench is None,
      "still on Bench" if still_bench else "")
rows = q("SELECT client, project FROM resources WHERE person_id=?", (pid,))
check("exactly ONE row left, on the real project", len(rows) == 1,
      str([dict(x) for x in rows]))
# The assignment itself DOES write hours — that is its job (50% × 40h × 53 weeks
# with a blank window = 1060h). What must not move is anything the master-list
# edit does later, so pin the figure here and compare propagation against it.
after_assign = money()
check("the assignment wrote the planned hours it promises", after_assign[2] == 1060.0,
      str(after_assign))

# ---- 3. Edit propagates: name, home title, capacity -------------------------
# Book an EXCEPTION title on a second project so we can prove it is preserved.
conn = m.get_db()
conn.execute("INSERT INTO projects (client, project) VALUES (?,?)", ("Beta", "Borealis"))
aid = conn.execute("INSERT INTO resources (client, project, name, role, rate, offshore_rate, "
                   "capacity, person_id, allocation_pct) VALUES (?,?,?,?,?,?,?,?,?)",
                   ("Beta", "Borealis", "Zz Newbie", "Developer", 100.0, 40.0, 40.0, pid, 25.0)
                   ).lastrowid
conn.commit(); conn.close()
# Both project rows must be at the SAME capacity for the propagation assertion to
# be a real test (a stale differing value would pass for the wrong reason).
conn = m.get_db()
conn.execute("UPDATE resources SET capacity=40.0 WHERE person_id=?", (pid,))
conn.commit(); conn.close()

r = client.put(f"/api/people/{pid}", cookies=W, json={
    "name": "Zz Renamed", "home_title": "QA Lead", "capacity": 30})
check("edit returns 200", r.status_code == 200, str(r.status_code)[:200])
check("PROPAGATION MOVES NO MONEY", money() == after_assign,
      f"{money()} vs {after_assign}")
mir = r.json().get("mirror") or {}
check("mirror reports the renames", mir.get("name_rows", 0) >= 2, str(mir))
check("mirror reports the capacity rows", mir.get("cap_rows", 0) >= 2, str(mir))

nm = q("SELECT DISTINCT name FROM resources WHERE person_id=?", (pid,))
check("name propagated to EVERY project row", [x["name"] for x in nm] == ["Zz Renamed"],
      str([dict(x) for x in nm]))
caps = q("SELECT DISTINCT capacity FROM resources WHERE person_id=?", (pid,))
check("capacity propagated to every project row", [float(x["capacity"]) for x in caps] == [30.0],
      str([dict(x) for x in caps]))
roles = {x["project"]: x["role"] for x in q(
    "SELECT project, role FROM resources WHERE person_id=?", (pid,))}
check("row booked on the OLD home title was re-titled", roles.get("Atlas") == "QA Lead",
      str(roles))
check("row on an EXCEPTION title was LEFT ALONE", roles.get("Borealis") == "Developer",
      str(roles))

# ---- 4. The person payload the card reads -----------------------------------
peo = client.get("/api/people", cookies=W).json()["people"]
me = [x for x in peo if x["id"] == pid][0]
check("payload carries home_title", me["home_title"] == "QA Lead", me["home_title"])
check("payload carries approved titles", "QA Lead" in (me["titles"] or []), str(me["titles"]))
check("payload carries capacity", float(me["capacity"]) == 30.0, str(me["capacity"]))
check("payload carries the assignments (projects they are in)",
      len(me["assignments"]) == 2, str([a["project"] for a in me["assignments"]]))

# ---- 5. A bench row alongside a real project is NOT released ----------------
# 25% on Atlas already; 25% on Borealis is booked (no hours though, so the load
# validator sees only Atlas' 50%). Bench auto = the free 50%, which fits.
r = client.post("/api/bench", cookies=W, json={"person_id": pid})
check("can still bench alongside a real project", r.status_code == 200, str(r.status_code)[:250])
b = one("SELECT COUNT(*) n FROM resources WHERE person_id=? AND project='Bench'", (pid,))
check("Bench row now exists alongside the real projects", b["n"] == 1, f"n={b['n']}")
r = client.post("/api/assignments", cookies=W, json={
    "client": "Acme", "project": "Atlas", "person_id": pid, "title": "QA Lead",
    "allocation_pct": 25})
check("a duplicate assignment is refused", r.status_code == 409, str(r.status_code))
n_proj = one("SELECT COUNT(*) n FROM resources WHERE person_id=? AND project!='Bench'", (pid,))
check("...and the two real project rows are untouched", n_proj["n"] == 2, f"n={n_proj['n']}")

print("\n==== RESULT ====")
if failures:
    print(f"{len(failures)} FAILED:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("ALL PASSED")
