"""Reallocation requests (GH-53): propose → releasing-PM approves → rows move.

the owner's spec, 2026-10-02:
  "lets say I want to move Nathan who is allocated 100% to Google and I want to take
   his 50% from google to a new project ... the allocation happen once Google PM
   approved ... there should be a notification bell ... I can approve or reject
   and all these get tracked and noted. and the same option the admin should have
   too and in case of admin he can do it for any client and project and resource
   including PM"

Asserted here:
  A. a PM's request lands PENDING and moves NOTHING
  B. the releasing PM can decide it; an unrelated PM cannot
  C. approval writes BOTH rows: source reduced, target created, hours shifted
  D. the PAST is immutable — weeks before the effective week keep their booking
  E. you cannot release more than the source project actually holds
  F. rejection leaves the source completely untouched
  G. an admin's move applies immediately and is still recorded
  H. a loan warns 7 days out and returns the share automatically
  I. the trail records every step ("all these get tracked and noted")
  J. no money crosses the PM payloads (CHARTER #1)

Run:  /usr/bin/python3 tests/test_allocation_requests.py
"""
import os, sys, json, tempfile, datetime as dt
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.main as m

tmp = tempfile.mkdtemp(prefix="rt-alloc-test-")
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

PASS, FAIL = [], []


def check(ok, msg):
    (PASS if ok else FAIL).append(msg)
    print(("  PASS - " if ok else "  FAIL - ") + msg)


def login(user, pw="super-secret"):
    r = client.post("/api/login", json={"username": user, "password": pw})
    assert r.status_code == 200, f"login {user} failed: {r.status_code} {r.text[:200]}"
    return r


# One long-lived connection for fixtures; `snap()` opens a fresh read handle so a
# commit inside a route is always visible here.
conn = m.get_db()


def snap():
    return m.get_db()


def q1(sql, args=()):
    c = snap()
    try:
        return c.execute(sql, args).fetchone()
    finally:
        c.close()


def qc(sql, args=()):
    c = snap()
    try:
        return c.execute(sql, args).fetchone()[0]
    finally:
        c.close()


weeks, months = m._load_layout()
CUR = m._current_period(weeks, months)["week_index"]
# NOTE: resources.start_date/end_date hold ISO dates in real data; the week
# LABELS ("Sep-28") are display only. A fixture that stores a label makes
# _iso_date() return None and silently skips the phase split — which is exactly
# how the first run of this suite fooled itself.
START_IDX = max(0, CUR - 4)


def wk_iso(i):
    d = m._week_date(weeks[i])
    assert d is not None, f"unparseable week label: {weeks[i]!r}"
    return d.isoformat()


SRC_START = wk_iso(START_IDX)
SRC_END = wk_iso(len(weeks) - 1)


def mk_project(cn, pn):
    conn.execute("INSERT OR IGNORE INTO projects (client, project) VALUES (?,?)", (cn, pn))


def mk_pm(username, projects):
    row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        conn.execute("INSERT INTO users (username, password_hash, role, permissions) VALUES (?,?,?,?)",
                     (username, m._hash_password("pw-" + username), "pm", "[]"))
        row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    for c, p in projects:
        conn.execute("INSERT OR IGNORE INTO user_projects (user_id, client, project) VALUES (?,?,?)",
                     (row["id"], c, p))


def mk_booked_person(name, cn, pn, pct, start=None, capacity=40.0):
    start = start or wk_iso(CUR)
    conn.execute("INSERT INTO people (name, country, home_title, capacity, active) VALUES (?,?,?,?,1)",
                 (name, "", "Platform Developer", capacity))
    pid = conn.execute("SELECT id FROM people WHERE name=?", (name,)).fetchone()["id"]
    conn.execute("INSERT OR IGNORE INTO pricing (title, rate, offshore_rate, currency) "
                 "VALUES ('Platform Developer', 40, 15, 'USD')")
    conn.execute(
        "INSERT INTO resources (country, client, project, name, role, rate, offshore_rate, sort_order, "
        "capacity, person_id, allocation_pct, start_date, end_date, phases) "
        "VALUES ('',?,?,?,?,40,15,1,?,?,?,?,?,'')",
        (cn, pn, name, "Platform Developer", capacity, pid, pct, start, SRC_END))
    rid = conn.execute("SELECT id FROM resources WHERE person_id=?", (pid,)).fetchone()["id"]
    weekly = pct / 100.0 * capacity
    for i in range(START_IDX if start != wk_iso(CUR) else CUR, len(weeks)):
        conn.execute("INSERT OR REPLACE INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                     (rid, i, weekly))
    conn.commit()
    return pid, rid


mk_project("APPLE", "Regular")
mk_project("Google", "Support")
mk_project("Meta", "Platform")
mk_pm("pm_fop", [("Google", "Support")])            # owns the SOURCE
mk_pm("pm_doxim", [("APPLE", "Regular")])
mk_pm("pm_print", [("Meta", "Platform")])   # owns the TARGET

nathan, deepak_rid = mk_booked_person("Test Nathan", "Google", "Support", 100.0, start=SRC_START)
other, other_rid = mk_booked_person("Test Other", "APPLE", "Regular", 100.0, start=SRC_START)

print("\n=== A. a PM's request lands PENDING and moves NOTHING ===")
client.cookies.clear(); login("pm_print", "pw-pm_print")
r = client.post("/api/allocation-requests", json={
    "person_id": nathan, "from_client": "Google", "from_project": "Support", "from_pct": 50,
    "to_client": "Meta", "to_project": "Platform", "to_pct": 50,
    "reason": "cover the Platform migration"})
check(r.status_code == 200, f"PM can raise a request (HTTP {r.status_code})")
REQ = r.json()["id"]
check(r.json()["status"] == "pending", f"status is 'pending' (got {r.json()['status']})")
check(abs(float(q1("SELECT allocation_pct FROM resources WHERE id=?", (deepak_rid,))[0]) - 100.0) < 1e-9,
      "the source booking is UNCHANGED while pending")
check(abs(qc("SELECT hours FROM weekly_hours WHERE resource_id=? AND week=?", (deepak_rid, CUR)) - 40.0) < 1e-9,
      "the source weekly hours are UNCHANGED while pending")
check(qc("SELECT COUNT(*) FROM resources WHERE person_id=? AND client='Meta'", (nathan,)) == 0,
      "no target row was created while pending")

print("\n=== B. only the RELEASING PM (or an admin) may decide ===")
client.cookies.clear(); login("pm_doxim", "pw-pm_doxim")
check(client.post(f"/api/allocation-requests/{REQ}/approve", json={}).status_code == 403,
      "an unrelated PM is refused approval")
check(client.post(f"/api/allocation-requests/{REQ}/reject", json={"note": "nope"}).status_code == 403,
      "and cannot reject either")
client.cookies.clear(); login("pm_fop", "pw-pm_fop")
nb = client.get("/api/notifications").json()
check(any(x["id"] == REQ for x in nb["needs_deciding"]), "the releasing PM sees it in their bell")
check(nb["unread"] >= 1, f"the badge counts it (unread={nb['unread']})")

print("\n=== C. approval writes BOTH rows and shifts the hours ===")
check(client.post(f"/api/allocation-requests/{REQ}/approve", json={"note": "ok by me"}).status_code == 200,
      "the releasing PM can approve")
tgt = q1("SELECT * FROM resources WHERE person_id=? AND client='Meta' AND project='Platform'", (nathan,))
check(tgt is not None, "a row was created on the RECEIVING project")
check(tgt and abs(float(tgt["allocation_pct"]) - 50.0) < 1e-9,
      f"the receiving row holds 50% (got {tgt['allocation_pct'] if tgt else None})")
check(abs(qc("SELECT hours FROM weekly_hours WHERE resource_id=? AND week=?", (tgt["id"], CUR)) - 20.0) < 1e-9,
      "the receiving row books 20h/wk (50% of 40h)")
check(abs(qc("SELECT hours FROM weekly_hours WHERE resource_id=? AND week=?", (deepak_rid, CUR + 1)) - 20.0) < 1e-9,
      "the source drops to 20h/wk from the effective week")
check(bool(q1("SELECT phases FROM resources WHERE id=?", (deepak_rid,))[0]),
      "the source carries a phase split (the reduction is dated, not whole-row)")

print("\n=== D. the PAST is immutable (CHARTER #2) ===")
# The source booking started 4 weeks ago; those weeks must survive the split.
src_phases = m.parse_phases(q1("SELECT phases FROM resources WHERE id=?", (deepak_rid,))[0])
first = src_phases[0] if src_phases else {}
check(first.get("allocation_pct") == 100.0,
      f"the pre-existing phase keeps the ORIGINAL 100% (got {first.get('allocation_pct')})")
check((first.get("end_date") or "") < weeks[CUR],
      f"and it ends BEFORE the effective week (ends {first.get('end_date')}, effective {weeks[CUR]})")
check(abs(qc("SELECT hours FROM weekly_hours WHERE resource_id=? AND week=?", (deepak_rid, CUR - 1)) - 40.0) < 1e-9,
      "the week before the move still holds the full 40h")
client.cookies.clear(); login("pm_print", "pw-pm_print")
r = client.post("/api/allocation-requests", json={
    "person_id": other, "from_client": "APPLE", "from_project": "Regular", "from_pct": 50,
    "to_client": "Meta", "to_project": "Platform", "to_pct": 50,
    "effective_from_week": 2, "reason": "please move from week 2"})
check(r.status_code == 200, f"a past-effective request is accepted (HTTP {r.status_code})")
eff = r.json()["request"]["effective_from_week"]
check(eff == CUR, f"effective week clamped from 2 to the CURRENT week {CUR} (got {eff})")

print("\n=== E. you cannot release more than the source holds ===")
client.cookies.clear(); login("pm_doxim", "pw-pm_doxim")
r = client.post("/api/allocation-requests", json={
    "person_id": other, "from_client": "APPLE", "from_project": "Regular", "from_pct": 100,
    "to_client": "Meta", "to_project": "Platform", "to_pct": 100, "reason": "all of it"})
# 'other' IS at 100% on APPLE/Regular, so this is allowed; shrink the source first
# to prove the guard bites.
c2 = snap()
c2.execute("UPDATE resources SET allocation_pct=25 WHERE id=?", (other_rid,))
c2.commit(); c2.close()
r = client.post("/api/allocation-requests", json={
    "person_id": other, "from_client": "APPLE", "from_project": "Regular", "from_pct": 100,
    "to_client": "Meta", "to_project": "Platform", "to_pct": 100, "reason": "over-release"})
check(r.status_code == 400, f"releasing 100% off a 25% booking is refused (HTTP {r.status_code})")
check("cannot release" in r.text, f"the message explains why: {r.text[:110]}")
# restore for the reject case
c2 = snap(); c2.execute("UPDATE resources SET allocation_pct=100 WHERE id=?", (other_rid,)); c2.commit(); c2.close()

print("\n=== F. rejection leaves the source completely untouched ===")
REQ2 = [x for x in client.get("/api/allocation-requests").json()["requests"]
        if x["person_id"] == other and x["status"] == "pending"][0]["id"]
client.cookies.clear(); login("pm_doxim", "pw-pm_doxim")
check(client.post(f"/api/allocation-requests/{REQ2}/reject", json={"note": "we need them"}).status_code == 200,
      "the releasing PM can reject")
check(abs(float(q1("SELECT allocation_pct FROM resources WHERE id=?", (other_rid,))[0]) - 100.0) < 1e-9,
      "the source % is untouched after a rejection")
check(abs(qc("SELECT hours FROM weekly_hours WHERE resource_id=? AND week=?", (other_rid, CUR)) - 40.0) < 1e-9,
      "the source hours are untouched after a rejection")
check(qc("SELECT COUNT(*) FROM resources WHERE person_id=? AND client='Meta'", (other,)) == 0,
      "no target row exists after a rejection")
check(client.post(f"/api/allocation-requests/{REQ2}/reject", json={"note": "again"}).status_code == 409,
      "re-deciding a settled request is refused")
check(client.post(f"/api/allocation-requests/{REQ2}/reject", json={}).status_code == 409,
      "and cannot be rejected with no reason at all once settled")

print("\n=== G. an ADMIN's move applies immediately and is still recorded ===")
admin_person, admin_rid = mk_booked_person("Test AdminMove", "APPLE", "Regular", 100.0)
client.cookies.clear(); login(os.environ["REVENUE_AUTH_USER"])
r = client.post("/api/allocation-requests", json={
    "person_id": admin_person, "from_client": "APPLE", "from_project": "Regular", "from_pct": 50,
    "to_client": "Meta", "to_project": "Platform", "to_pct": 50, "reason": "admin rebalance"})
check(r.status_code == 200, f"admin can move (HTTP {r.status_code})")
aj = r.json()
check(aj["status"] == "applied", f"it APPLIES immediately (status={aj['status']})")
check(q1("SELECT * FROM resources WHERE person_id=? AND client='Meta'", (admin_person,)) is not None,
      "the admin's move created the receiving row")
acts = [e["action"] for e in client.get(f"/api/allocation-requests/{aj['id']}/trail").json()["events"]]
check("requested" in acts and "applied" in acts, f"and is fully recorded ({acts})")

print("\n=== H. a LOAN warns 7 days out and returns the share automatically ===")
loan_person, loan_rid = mk_booked_person("Test Loan", "APPLE", "Regular", 100.0)
soon = (dt.date.today() + dt.timedelta(days=7)).isoformat()
client.cookies.clear(); login("pm_doxim", "pw-pm_doxim")
r = client.post("/api/allocation-requests", json={
    "person_id": loan_person, "from_client": "APPLE", "from_project": "Regular", "from_pct": 50,
    "to_client": "Meta", "to_project": "Platform", "to_pct": 50,
    "until_date": soon, "reason": "temporary cover"})
check(r.status_code == 200, f"a loan request is accepted (HTTP {r.status_code})")
LOAN = r.json()["id"]
client.cookies.clear(); login("pm_doxim", "pw-pm_doxim")
check(client.post(f"/api/allocation-requests/{LOAN}/approve", json={}).status_code == 200, "the loan is approved")
client.cookies.clear(); login(os.environ["REVENUE_AUTH_USER"])
sweep = client.post("/api/allocation-requests/sweep").json()
check(LOAN in sweep["warned"], f"the 7-day warning fired ({sweep['warned']})")
check(LOAN not in client.post("/api/allocation-requests/sweep").json()["warned"],
      "the warning is NOT repeated (idempotent)")

c2 = snap(); c2.execute("UPDATE allocation_requests SET until_date=? WHERE id=?",
                        ((dt.date.today() - dt.timedelta(days=1)).isoformat(), LOAN)); c2.commit(); c2.close()
ended = client.post("/api/allocation-requests/sweep").json()
check(LOAN in ended["ended"], f"the loan ended automatically ({ended['ended']})")
check(abs(float(q1("SELECT allocation_pct FROM resources WHERE id=?", (loan_rid,))[0]) - 100.0) < 1e-9,
      "the source got its share BACK")

print("\n=== I. the trail records every step ===")
tr = client.get(f"/api/allocation-requests/{REQ}/trail").json()
acts = [e["action"] for e in tr["events"]]
check(acts and acts[0] == "requested", f"first event is 'requested' ({acts})")
check("approved" in acts, "approval is recorded")
check(tr["decided_by"], f"decided_by is stamped ({tr['decided_by']})")
check(tr["summary"].startswith("Move"), f"a plain-language summary exists: {tr['summary'][:60]}…")

print("\n=== J. no money crosses the PM payloads (CHARTER #1) ===")
client.cookies.clear(); login("pm_fop", "pw-pm_fop")
blob = (json.dumps(client.get("/api/notifications").json())
        + json.dumps(client.get("/api/allocation-requests").json())).lower()
leaks = [w for w in ("rate", "offshore", "revenue", "expense", "margin", "cost", "price") if w in blob]
check(not leaks, f"no rate/money field in the PM payload (found: {leaks})")

print(f"\n{'='*60}\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    for f in FAIL:
        print("  FAILED: " + f)
    sys.exit(1)
print("ALL ALLOCATION-REQUEST CHECKS PASS")
