"""GH-54: allocation derived from the plan, Edit preserves the plan, Remove asks
resigned vs back-to-Bench.

Rijoy's three asks on My Projects -> click a project -> the resource panel:
  1. planned/allocation must be filled for every project, not come up empty
  2. Edit must open pre-filled with THAT resource (no re-picking from a list)
  3. Remove must ask "did they resign?" — no -> back to Bench, yes -> inactive

Everything here runs against a TEMP database (DB_PATH/DATA_DIR are monkeypatched
below), so it can never touch the live book. Run:

    /usr/bin/python3 tests/test_gh54_panel.py
    (or: bash scripts/run-tests.sh)
"""
import os, sys, json, tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app.main as m

tmp = tempfile.mkdtemp(prefix="rt-gh54-")
os.environ["REVENUE_AUTH_USER"] = "rijoy"
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


r = client.post("/api/login", json={"username": "rijoy", "password": "super-secret"})
check("login", r.status_code == 200 and r.json().get("super_admin"), str(r.status_code))
cookie = {"rt_session": r.cookies["rt_session"]}
weeks, _ = m._load_layout()
N = len(weeks)


def add_person(name, home="QA", capacity=40.0):
    conn = m.get_db()
    conn.execute("INSERT INTO people (name, country, home_title, capacity, active) "
                 "VALUES (?,?,?,?,1)", (name, "CA", home, capacity))
    pid = conn.execute("SELECT id FROM people ORDER BY id DESC LIMIT 1").fetchone()["id"]
    conn.commit(); conn.close()
    return pid


def add_project(client_, project):
    conn = m.get_db()
    conn.execute("INSERT INTO projects (client, project) VALUES (?,?)", (client_, project))
    conn.commit(); conn.close()


def add_legacy_resource(name, client_, project, pid=None, hours=40.0, weeks_=None, role="QA",
                        capacity=40.0):
    """A resource shaped like the real Excel import: hours present, allocation NULL."""
    conn = m.get_db()
    conn.execute(
        "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, "
        "capacity, person_id, allocation_pct, start_date, end_date, phases) "
        "VALUES ('CA',?,?,?,?,100.0,50.0,?,?,NULL,'','','')",
        (client_, project, name, role, capacity, pid))
    rid = conn.execute("SELECT id FROM resources ORDER BY id DESC LIMIT 1").fetchone()["id"]
    for i in (weeks_ if weeks_ is not None else range(N)):
        conn.execute("INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                     (rid, i, hours))
    conn.commit(); conn.close()
    return rid


def hours_of(rid):
    conn = m.get_db()
    rows = {r["week"]: r["hours"] for r in conn.execute(
        "SELECT week, hours FROM weekly_hours WHERE resource_id=?", (rid,))}
    conn.close()
    return rows


def team_of(client_, project):
    r = client.get("/api/my-projects", cookies=cookie)
    for p in r.json()["projects"]:
        if p["client"] == client_ and p["project"] == project:
            return p
    return None


def _bench_rate(pid):
    """(rate, offshore_rate) of a person's Bench row — must be zero."""
    conn = m.get_db()
    row = conn.execute(
        "SELECT rate, offshore_rate FROM resources WHERE person_id=? AND UPPER(project)='BENCH'",
        (pid,)).fetchone()
    conn.close()
    return (row["rate"], row["offshore_rate"]) if row else (None, None)


# ---------------------------------------------------------------- 1. derivation
print("\n--- 1. allocation is derived from the plan, not left empty ---")
pid = add_person("Ada Quarter", home="QA")
add_project("TestCo", "Alpha")
rid_full = add_legacy_resource("Ada Quarter", "TestCo", "Alpha", pid, hours=40.0)
pt = team_of("TestCo", "Alpha")
mem = next(t for t in pt["team"] if t["id"] == rid_full)
check("legacy row (40h, allocation NULL) shows 100%", mem["allocation_pct"] == 100.0,
      f"got {mem['allocation_pct']}")
check("...flagged as derived", mem["allocation_derived"] is True)
check("...weekly hrs filled", mem["weekly_hours"] == 40.0, f"got {mem['weekly_hours']}")
check("...window derived from the plan weeks",
      bool(mem["start_date"]) and bool(mem["end_date"]),
      f"{mem['start_date']}..{mem['end_date']}")

# 20h/wk -> 50%; 8h -> 25%
pid2 = add_person("Bob Half", home="QA")
rid_half = add_legacy_resource("Bob Half", "TestCo", "Alpha", pid2, hours=20.0)
# a variable plan: 40h for most weeks, 8h in the tail -> peak 100%
pid3 = add_person("Cleo Varied", home="QA")
var_weeks = list(range(0, 30)) + list(range(30, N))
rid_var = add_legacy_resource("Cleo Varied", "TestCo", "Alpha", pid3, hours=40.0,
                              weeks_=range(0, 30))
conn = m.get_db()
for i in range(30, N):
    conn.execute("INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)", (rid_var, i, 8.0))
conn.commit(); conn.close()

pt = team_of("TestCo", "Alpha")
by_id = {t["id"]: t for t in pt["team"]}
check("20h/wk derives 50%", by_id[rid_half]["allocation_pct"] == 50.0,
      f"got {by_id[rid_half]['allocation_pct']}")
check("varied plan uses the PEAK week (100%), not the average",
      by_id[rid_var]["allocation_pct"] == 100.0, f"got {by_id[rid_var]['allocation_pct']}")

# derivation must not move the money
before = sum(hours_of(rid_var).values())
check("derivation writes nothing (plan unchanged)", before == 30 * 40.0 + (N - 30) * 8.0,
      f"sum={before}")

# ------------------------------------------------- 2. Edit preserves the plan
print("\n--- 2. Edit only rewrites the plan when the allocation changes ---")
# Cleo: varied plan. Put a stored allocation so the dialog has one, then edit
# ONLY the title -> her weeks must survive untouched.
conn = m.get_db()
conn.execute("UPDATE resources SET allocation_pct=100.0 WHERE id=?", (rid_var,))
conn.commit(); conn.close()
plan_before = hours_of(rid_var)

body = {"person_id": pid3, "client": "TestCo", "project": "Alpha", "title": "QA",
        "allocation_pct": 100.0, "start_date": "", "end_date": "", "title_exception": ""}
r = client.put(f"/api/assignments/{rid_var}", json=body, cookies=cookie)
check("no-op save accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...reports the plan was NOT rewritten", r.json().get("plan_rewritten") is False,
      str(r.json()))
check("...every week is byte-identical after a no-op save", hours_of(rid_var) == plan_before,
      "week values changed")

# Changing the allocation DOES re-spread
body["allocation_pct"] = 25.0
r = client.put(f"/api/assignments/{rid_var}", json=body, cookies=cookie)
check("allocation change accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...reports the plan WAS rewritten", r.json().get("plan_rewritten") is True,
      str(r.json()))
h = hours_of(rid_var)
check("...weeks now hold 25% x 40h = 10h", all(abs(v - 10.0) < 1e-6 for v in h.values()),
      f"distinct={sorted(set(round(v,2) for v in h.values()))}")

# A derived (no stored %), no-op save must also preserve the varied plan.
pid4 = add_person("Dana Legacy", home="QA")
rid_l4 = add_legacy_resource("Dana Legacy", "TestCo", "Alpha", pid4, hours=40.0, weeks_=range(0, 20))
conn = m.get_db()
for i in range(20, N):
    conn.execute("INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)", (rid_l4, i, 12.0))
conn.commit(); conn.close()
plan_l4 = hours_of(rid_l4)
# The dialog opens on the DERIVED 100% and the DERIVED window and posts them back.
pt = team_of("TestCo", "Alpha")
d = next(t for t in pt["team"] if t["id"] == rid_l4)
body = {"person_id": pid4, "client": "TestCo", "project": "Alpha", "title": "QA",
        "allocation_pct": d["allocation_pct"], "start_date": d["start_date"],
        "end_date": d["end_date"], "title_exception": ""}
r = client.put(f"/api/assignments/{rid_l4}", json=body, cookies=cookie)
check("derived-value save accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...derived no-op does NOT flatten the varied plan",
      hours_of(rid_l4) == plan_l4, "plan was flattened")
check("...the derived % is now stored", team_of("TestCo", "Alpha")["team"] and
      next(t for t in team_of("TestCo", "Alpha")["team"] if t["id"] == rid_l4)["allocation_derived"] is False)

# A legacy non-home booking with NO reason must still be saveable (8 live rows).
print("\n--- 2b. a legacy non-home booking is not blocked for a missing reason ---")
pid5 = add_person("Eve Booked", home="Project manager")
rid_e = add_legacy_resource("Eve Booked", "TestCo", "Alpha", pid5, hours=40.0,
                            role="Solution Architect")
body = {"person_id": pid5, "client": "TestCo", "project": "Alpha",
        "title": "Solution Architect", "allocation_pct": 100.0,
        "start_date": "", "end_date": "", "title_exception": ""}
r = client.put(f"/api/assignments/{rid_e}", json=body, cookies=cookie)
check("unchanged non-home booking is accepted without a reason", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")
# But a real CHANGE to a different non-home title still needs one.
body["title"] = "QA"          # neither the current booking nor the home title
r = client.put(f"/api/assignments/{rid_e}", json=body, cookies=cookie)
check("re-titling to a different non-home title still needs a reason", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")

# ------------------------------------------------- 3. Remove: resigned vs bench
print("\n--- 3. Remove asks resigned vs back to Bench ---")
# (a) NOT resigned, sole project -> benched for their full availability
pid6 = add_person("Frank Free", home="QA")
add_project("TestCo", "Beta")
rid_f = add_legacy_resource("Frank Free", "TestCo", "Beta", pid6, hours=40.0)
r = client.post(f"/api/assignments/{rid_f}/remove", json={"resigned": False}, cookies=cookie)
check("not-resigned removal accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
j = r.json()
check("...reports benched", j.get("benched") is True, str(j))
check("...benched at 100% (fully free)", j.get("bench_pct") == 100.0, str(j))
conn = m.get_db()
bench_row = conn.execute(
    "SELECT id, allocation_pct FROM resources WHERE person_id=? AND UPPER(project)='BENCH'",
    (pid6,)).fetchone()
act = conn.execute("SELECT active FROM people WHERE id=?", (pid6,)).fetchone()["active"]
conn.close()
check("...a Bench assignment was created", bench_row is not None)
check("...bench row carries the freed %", bench_row and bench_row["allocation_pct"] == 100.0,
      str(bench_row and bench_row["allocation_pct"]))
check("...person remains active", act == 1, f"active={act}")
check("...bench hours are zero-rate (no money)", _bench_rate(pid6) == (0, 0),
      str(_bench_rate(pid6)))

# (b) NOT resigned, HALF booked elsewhere -> benched for the FREED half only
pid7 = add_person("Gina Half", home="QA")
add_project("TestCo", "Gamma")
rid_g1 = add_legacy_resource("Gina Half", "TestCo", "Beta", pid7, hours=20.0)   # 50%
rid_g2 = add_legacy_resource("Gina Half", "TestCo", "Gamma", pid7, hours=20.0)  # 50%
r = client.post(f"/api/assignments/{rid_g1}/remove", json={"resigned": False}, cookies=cookie)
check("half-booked not-resigned removal accepted", r.status_code == 200, f"{r.status_code}")
check("...benched for the freed 50%, not 100%", r.json().get("bench_pct") == 50.0, str(r.json()))

# (c) RESIGNED, sole project -> inactive, no bench
pid8 = add_person("Hana Gone", home="QA")
add_project("TestCo", "Delta")
rid_h = add_legacy_resource("Hana Gone", "TestCo", "Delta", pid8, hours=40.0)
r = client.post(f"/api/assignments/{rid_h}/remove", json={"resigned": True}, cookies=cookie)
check("resigned removal accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...reports resigned", r.json().get("resigned") is True, str(r.json()))
conn = m.get_db()
act = conn.execute("SELECT active FROM people WHERE id=?", (pid8,)).fetchone()["active"]
nbench = conn.execute("SELECT COUNT(*) FROM resources WHERE person_id=? AND UPPER(project)='BENCH'",
                      (pid8,)).fetchone()[0]
conn.close()
check("...person marked INACTIVE", act == 0, f"active={act}")
check("...nothing benched for a resigned person", nbench == 0, f"bench rows={nbench}")

# (d) RESIGNED while still on another project -> 409, then force
pid9 = add_person("Ivan Two", home="QA")
add_project("TestCo", "Epsilon")
rid_i1 = add_legacy_resource("Ivan Two", "TestCo", "Delta", pid9, hours=40.0)
rid_i2 = add_legacy_resource("Ivan Two", "TestCo", "Epsilon", pid9, hours=40.0)
r = client.post(f"/api/assignments/{rid_i1}/remove", json={"resigned": True}, cookies=cookie)
check("resigned-with-others is refused first (409)", r.status_code == 409, f"{r.status_code}")
check("...names the other project", "Epsilon" in json.dumps(r.json()), r.text[:200])
conn = m.get_db()
still = conn.execute("SELECT COUNT(*) FROM resources WHERE id=?", (rid_i1,)).fetchone()[0]
conn.close()
check("...and nothing was deleted by the refusal", still == 1)
r = client.post(f"/api/assignments/{rid_i1}/remove", json={"resigned": True, "force": True},
                cookies=cookie)
check("forced resign accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
conn = m.get_db()
act = conn.execute("SELECT active FROM people WHERE id=?", (pid9,)).fetchone()["active"]
other = conn.execute("SELECT COUNT(*) FROM resources WHERE id=?", (rid_i2,)).fetchone()[0]
conn.close()
check("...person inactive", act == 0, f"active={act}")
check("...their OTHER assignment is left in place (not silently cleared)", other == 1)

# (e) the plain DELETE still works (backwards compatibility)
pid10 = add_person("Jill Old", home="QA")
add_project("TestCo", "Zeta")
rid_j = add_legacy_resource("Jill Old", "TestCo", "Zeta", pid10, hours=40.0)
r = client.delete(f"/api/assignments/{rid_j}", cookies=cookie)
check("legacy DELETE still works", r.status_code == 200 and r.json().get("ok") is True,
      f"{r.status_code} {r.text[:120]}")

# (f) removing the person's BENCH row must NOT re-bench (circular)
print("\n--- 3b. removing the Bench row itself, and unlinked resources ---")
conn = m.get_db()
conn.execute("INSERT OR IGNORE INTO projects (client, project) VALUES ('Internal','Bench')")
conn.commit(); conn.close()
pid11 = add_person("Kim Benched", home="QA")
conn = m.get_db()
conn.execute("INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, "
             "capacity, person_id, allocation_pct, start_date, end_date, phases) "
             "VALUES ('CA','Internal','Bench',?, 'QA',0,0,40.0,?,50.0,'','','')", ("Kim Benched", pid11))
rid_k = conn.execute("SELECT id FROM resources ORDER BY id DESC LIMIT 1").fetchone()["id"]
for i in range(N):
    conn.execute("INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)", (rid_k, i, 20.0))
conn.commit(); conn.close()
r = client.post(f"/api/assignments/{rid_k}/remove", json={"resigned": False}, cookies=cookie)
check("removing a Bench row is accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...it does NOT re-bench (circular)", r.json().get("benched") is False, str(r.json()))
check("...and says so plainly", "Bench" in (r.json().get("outcome") or ""), str(r.json().get("outcome")))
conn = m.get_db()
recreated = conn.execute("SELECT COUNT(*) FROM resources WHERE person_id=? AND UPPER(project)='BENCH'",
                         (pid11,)).fetchone()[0]
act11 = conn.execute("SELECT active FROM people WHERE id=?", (pid11,)).fetchone()["active"]
conn.close()
check("...no Bench row is recreated", recreated == 0, f"rows={recreated}")
check("...person stays active", act11 == 1, f"active={act11}")

# (g) a resource with NO person record: removed, but nothing to bench/deactivate
add_project("TestCo", "Eta")
conn = m.get_db()
conn.execute("INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, "
             "capacity, person_id, allocation_pct, start_date, end_date, phases) "
             "VALUES ('CA','TestCo','Eta','Orphan Row','QA',100.0,50.0,40.0,NULL,NULL,'','','')")
rid_o = conn.execute("SELECT id FROM resources ORDER BY id DESC LIMIT 1").fetchone()["id"]
conn.commit(); conn.close()
r = client.post(f"/api/assignments/{rid_o}/remove", json={"resigned": False}, cookies=cookie)
check("unlinked resource removal accepted", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...reports no person record to bench",
      "person record" in (r.json().get("outcome") or ""), str(r.json().get("outcome")))
check("...and is not reported as benched", r.json().get("benched") is False)

print("\n" + ("ALL PASS" if not failures else f"{len(failures)} FAILURE(S): {failures}"))
sys.exit(1 if failures else 0)
