"""Weekly entry: only the week the PM actually edited is questioned.

the owner (2026-10-02): "when I try to add the hours under weekly entry and try to
save the week it asks why there is a short fall. This is been asked even if the
hours are not less."

Cause: a save carries the FULL 53-week array (the backend requires it), and the
server validated EVERY week in it. Any unrelated week sitting below plan without
a recorded reason therefore blocked the save and fired the under-delivery
prompt for a week the PM never opened. Fixed by having the client declare
`edited: [weeks]` and the server judging only those; every other week keeps its
STORED value (the payload's stale slots are ignored, not written).

Asserted below:
  A. the entered week is written; an unresolved OTHER week no longer blocks it
  B. a stale value in an unrendered slot is NOT written as an actual (integrity)
  C. the under-delivery question IS still asked for the week the PM edits
  D. the overage / OT question IS still asked for the week the PM edits
  E. backward compatibility: with no `edited`, the diff rule still applies
  F. the money rules the owner spelled out (under/over × billed/not billed)

Run:  /usr/bin/python3 tests/test_week_save_stale_notes.py
"""
import os, sys, json, tempfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.main as m

tmp = tempfile.mkdtemp(prefix="rt-weeksave-test-")
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


r = client.post("/api/login", json={"username": "admin", "password": "super-secret"})
cookie = {"rt_session": r.cookies["rt_session"]}
weeks, months = m._load_layout()
N = len(weeks)
ENTERED, OLD = 10, 7


def make_resource(name, client_, project, rate=100.0, off=50.0):
    conn = m.get_db()
    conn.execute(
        "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, capacity) "
        "VALUES ('CA',?,?,?,'Developer',?,?,40.0)", (client_, project, name, rate, off))
    rid = conn.execute("SELECT id FROM resources ORDER BY id DESC LIMIT 1").fetchone()["id"]
    conn.executemany("INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                     [(rid, i, 40.0) for i in range(N)])
    conn.commit()
    conn.close()
    return rid


def put(rid, hours, notes=None, edited=None, **kw):
    body = {"hours": hours, "notes": notes or {}}
    if edited is not None:
        body["edited"] = edited
    body.update(kw)
    return client.put(f"/api/resources/{rid}/actuals", cookies=cookie, json=body).json()


def stored(rid):
    conn = m.get_db()
    try:
        return {x["week"]: x["hours"] for x in conn.execute(
            "SELECT week, hours FROM actual_hours WHERE resource_id=?", (rid,)).fetchall()}
    finally:
        conn.close()


# ---------------------------------------------------------------- A + B
rid = make_resource("Test Person", "Acme", "Widget")
conn = m.get_db()
# an earlier week below plan, with NO reason recorded (what a bulk upload leaves)
conn.execute("INSERT INTO actual_hours (resource_id, week, hours) VALUES (?,?,?)", (rid, OLD, 30.0))
conn.commit()
conn.close()

# Exactly what saveWeekSheet sends: stored actuals for the year, with an
# UNRENDERED slot still holding the stale PLANNED value (40h at week 11).
full = [0.0] * N
for w, h in stored(rid).items():
    full[w] = h
full[ENTERED] = 40.0      # the PM's entry — EQUAL to plan, no shortfall
full[11] = 40.0           # stale unrendered slot (planned, not entered)

res = put(rid, full, {}, edited=[ENTERED])
print("  A/B response:", json.dumps(res))
check("A1 the entered week saves (no spurious shortfall prompt)",
      res.get("status") == "ok", f"status={res.get('status')} weeks={res.get('weeks')}")
check("A2 the entered week is written",
      stored(rid).get(ENTERED) == 40.0, f"stored={stored(rid)}")
check("A3 the unrelated unresolved week does not block the save",
      not any(w.get("week") == OLD for w in res.get("weeks", [])), f"weeks={res.get('weeks')}")
check("A4 the earlier week's own value survives untouched",
      stored(rid).get(OLD) == 30.0, f"stored={stored(rid)}")
check("B  the stale unrendered slot is NOT written as an actual",
      11 not in stored(rid), f"stored={stored(rid)} (week 11 must stay unentered)")

# ---------------------------------------------------------------- C
rid_c = make_resource("Under Person", "Acme", "Widget")
full_c = [0.0] * N
full_c[ENTERED] = 30.0        # 10h under plan -> must still ask
res_c = put(rid_c, full_c, {}, edited=[ENTERED])
print("  C response:", json.dumps(res_c))
check("C  under-delivery still asks for the reason",
      (ENTERED, "needs_comment") in [(w["week"], w["status"]) for w in res_c.get("weeks", [])],
      f"weeks={res_c.get('weeks')}")

# ---------------------------------------------------------------- D
rid_d = make_resource("Over Person", "Acme", "Widget")
full_d = [0.0] * N
full_d[ENTERED] = 50.0        # 10h over plan -> must still ask about OT
res_d = put(rid_d, full_d, {}, edited=[ENTERED])
print("  D response:", json.dumps(res_d))
check("D  overage still asks the OT question",
      (ENTERED, "needs_ot") in [(w["week"], w["status"]) for w in res_d.get("weeks", [])],
      f"weeks={res_d.get('weeks')}")

# ---------------------------------------------------------------- E
rid_e = make_resource("Compat Person", "Acme", "Widget")
full_e = [0.0] * N
full_e[ENTERED] = 30.0
res_e = put(rid_e, full_e)          # NO `edited` field at all
print("  E response:", json.dumps(res_e))
check("E  a client that omits `edited` still gets the real week questioned",
      (ENTERED, "needs_comment") in [(w["week"], w["status"]) for w in res_e.get("weeks", [])],
      f"weeks={res_e.get('weeks')}")

# ---------------------------------------------------------------- F (money)
# the owner's rules. planned 40h @100 revenue / @50 cost.
#   under + billed in full -> revenue = planned; cost = actual (recovered)
#   under + not billed     -> revenue = actual (lost); cost = actual
#   over  + billed to client -> revenue = actual, but the OT slice WAITS for
#                               admin approval (pending_ot_rev until approved)
#   over  + not billed     -> revenue = planned portion only; cost = actual
#   over  + not OT         -> same as not billed (expense only, incremental)
money = [
    ("under · billed in full", 30.0, {"comment": "reduced scope", "under_billed": 0}, 4000.0, 1500.0, 0.0),
    ("under · not billed", 30.0, {"comment": "reduced scope", "under_billed": 1}, 3000.0, 1500.0, 0.0),
    ("over · OT billed (awaiting approval)", 50.0,
     {"comment": "approved by PM", "is_ot": 1, "approved": 1, "billed": 1}, 4000.0, 2500.0, 1000.0),
    ("over · OT not billed", 50.0,
     {"comment": "not billable", "is_ot": 1, "approved": 1, "billed": 0}, 4000.0, 2500.0, 0.0),
    ("over · not OT", 50.0, {"comment": "recorded overage", "is_ot": 0}, 4000.0, 2500.0, 0.0),
]
rid_ot_billed = None
for label, hrs, note, want_rev, want_exp, want_pending in money:
    rid_f = make_resource(f"Money {label}", "Acme", "Widget")
    if label.startswith("over · OT billed"):
        rid_ot_billed = rid_f
    full_f = [0.0] * N
    full_f[ENTERED] = hrs
    res_f = put(rid_f, full_f, {ENTERED: note}, edited=[ENTERED])
    assert res_f.get("status") == "ok", f"{label}: {res_f}"
    conn = m.get_db()
    row = dict(conn.execute("SELECT * FROM resources WHERE id=?", (rid_f,)).fetchone())
    row["hours"] = [x["hours"] for x in conn.execute(
        "SELECT week, hours FROM weekly_hours WHERE resource_id=? ORDER BY week", (rid_f,)).fetchall()]
    row["actual_hours"] = [stored(rid_f).get(i, 0.0) for i in range(N)]
    row["actual_notes"] = m._actual_notes_map(rid_f, conn)
    fin = m._actuals_financials(row)
    conn.close()
    check(f"F  money · {label}: revenue {want_rev:.0f} / expense {want_exp:.0f} / pending {want_pending:.0f}",
          abs(fin["actual_rev"] - want_rev) < 0.01
          and abs(fin["actual_exp"] - want_exp) < 0.01
          and abs(fin["pending_ot_rev"] - want_pending) < 0.01,
          f"got rev={fin['actual_rev']} exp={fin['actual_exp']} pending={fin['pending_ot_rev']}")

# The approval gate: once the admin approves, the withheld OT revenue lands.
rid_f = rid_ot_billed
conn = m.get_db()
conn.execute("UPDATE actual_notes SET approved=1 WHERE resource_id=? AND week=?", (rid_f, ENTERED))
conn.commit()
row = dict(conn.execute("SELECT * FROM resources WHERE id=?", (rid_f,)).fetchone())
row["hours"] = [x["hours"] for x in conn.execute(
    "SELECT week, hours FROM weekly_hours WHERE resource_id=? ORDER BY week", (rid_f,)).fetchall()]
row["actual_hours"] = [stored(rid_f).get(i, 0.0) for i in range(N)]
row["actual_notes"] = m._actual_notes_map(rid_f, conn)
fin2 = m._actuals_financials(row)
conn.close()
check("F  money · approved OT releases the withheld revenue",
      abs(fin2["actual_rev"] - 5000.0) < 0.01 and abs(fin2["pending_ot_rev"]) < 0.01,
      f"got rev={fin2['actual_rev']} pending={fin2['pending_ot_rev']}")

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("ALL CHECKS PASS")
