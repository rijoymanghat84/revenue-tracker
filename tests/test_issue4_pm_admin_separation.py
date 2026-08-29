"""Verify Issue #4 fix: admins no longer leak into the PM section, and only
Rijoy (super-admin) can manage admin accounts.

Covers:
  * /api/users returns PMs and admins in one list (as before), but the
    frontend now splits them; here we verify the role/super_admin flags drive
    that split.
  * super_admin flag: True for rijoy, False for a regular admin.
  * A regular admin WITH the 'users' permission CAN create/edit/delete PMs.
  * A regular admin (even with 'users' perm) CANNOT create/edit/delete ADMINS
    (403) — only Rijoy can.
  * Rijoy creating an admin no longer produces a duplicate-visible "PM" entry:
    creating the same username as admin then as PM (or vice versa) is a 409.
"""
import os, sys, json, tempfile, shutil
sys.path.insert(0, "/opt/data/revenue-tracker")

import app.main as m

tmp = tempfile.mkdtemp(prefix="rt-issue4-test-")
print("TMP:", tmp)
os.environ["REVENUE_AUTH_USER"] = "rijoy"
os.environ["REVENUE_AUTH_PASSWORD"] = "super-secret"
os.environ["REVENUE_DB_PASSWORD"] = ""
m.DATA_DIR = tmp
m.DB_PATH = os.path.join(tmp, "revenue.db")
m.DB_KEY_FILE = os.path.join(tmp, ".dbkey")

import sqlite3 as _plain
m._cipher = _plain
m._HAS_CIPHER = False

from fastapi.testclient import TestClient
m.init_db()
client = TestClient(m.app)

def login(u, p):
    return client.post("/api/login", json={"username": u, "password": p})

def cookie(resp):
    return {"rt_session": resp.cookies["rt_session"]}

failures = []

def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), "-", name, extra)
    if not cond:
        failures.append(name)

# --- setup: rijoy (super) + a regular admin (alice, with users perm) ---
r = login("rijoy", "super-secret")
check("rijoy login 200", r.status_code == 200, f"got {r.status_code}")
sa = cookie(r)
me = client.get("/api/me", cookies=sa).json()
check("rijoy is super_admin", me.get("super_admin") is True, f"super_admin={me.get('super_admin')}")

r = client.post("/api/users", cookies=sa, json={
    "username": "alice", "password": "alicepw", "role": "admin",
    "permissions": ["users"], "projects": []})
check("rijoy creates admin alice 200", r.status_code == 200, f"got {r.status_code} body={r.text}")
alice_id = r.json()["id"]

r = login("alice", "alicepw")
check("alice login 200", r.status_code == 200, f"got {r.status_code}")
alice = cookie(r)
me = client.get("/api/me", cookies=alice).json()
check("alice is NOT super_admin", me.get("super_admin") is False, f"super_admin={me.get('super_admin')}")
check("alice role admin", me["role"] == "admin", f"role={me['role']}")

# --- a regular PM exists so alice has a target to manage ---
r = client.post("/api/users", cookies=sa, json={
    "username": "pm1", "password": "pmpw", "role": "pm", "projects": []})
pm_id = r.json()["id"]

# --- 1. alice (regular admin WITH users perm) CAN manage PMs ---
r = client.post("/api/users", cookies=alice, json={
    "username": "pm2", "password": "pm2pw", "role": "pm", "projects": []})
check("alice can create a PM (has users perm)", r.status_code == 200, f"got {r.status_code} body={r.text}")
pm2_id = r.json()["id"]
r = client.put(f"/api/users/{pm2_id}", cookies=alice, json={"projects": []})
check("alice can edit a PM", r.status_code == 200, f"got {r.status_code}")
r = client.delete(f"/api/users/{pm2_id}", cookies=alice)
check("alice can delete a PM", r.status_code == 200, f"got {r.status_code}")

# --- 2. alice CANNOT create an ADMIN (403) even with users perm ---
r = client.post("/api/users", cookies=alice, json={
    "username": "mallory", "password": "x", "role": "admin", "permissions": []})
check("alice blocked from creating an admin (super-admin only)", r.status_code == 403, f"got {r.status_code} body={r.text}")
# and no row was created
r = client.get("/api/users", cookies=sa).json()
check("no 'mallory' row created", all(u["username"] != "mallory" for u in r), f"users={[u['username'] for u in r]}")

# --- 3. alice CANNOT edit an admin (403) ---
r = client.put(f"/api/users/{alice_id}", cookies=alice, json={"password": "newpw1"})
check("alice blocked from editing an admin, even herself", r.status_code == 403, f"got {r.status_code}")

# --- 4. alice CANNOT promote a PM to admin (403) ---
r = client.put(f"/api/users/{pm_id}", cookies=alice, json={"role": "admin"})
check("alice blocked from promoting a PM to admin", r.status_code == 403, f"got {r.status_code} body={r.text}")

# --- 5. alice CANNOT delete an admin (403) ---
# create a second admin first (by rijoy) so alice isn't the last admin
r = client.post("/api/users", cookies=sa, json={
    "username": "bob", "password": "bobpw", "role": "admin", "permissions": []})
bob_id = r.json()["id"]
r = client.delete(f"/api/users/{bob_id}", cookies=alice)
check("alice blocked from deleting an admin", r.status_code == 403, f"got {r.status_code}")
# bob still exists
r = client.get("/api/users", cookies=sa).json()
check("bob still exists after alice's blocked delete", any(u["id"] == bob_id for u in r))

# --- 6. same username cannot be both admin and PM (409) ---
r = client.post("/api/users", cookies=sa, json={
    "username": "dual", "password": "pw", "role": "pm", "projects": []})
check("create 'dual' as PM 200", r.status_code == 200, f"got {r.status_code}")
r = client.post("/api/users", cookies=sa, json={
    "username": "dual", "password": "pw", "role": "admin", "permissions": []})
check("'dual' as admin rejected 409 (one role per user)", r.status_code == 409, f"got {r.status_code} body={r.text}")

# --- 7. rijoy (super-admin) CAN still do it all ---
r = client.post("/api/users", cookies=sa, json={
    "username": "dave", "password": "davepw", "role": "admin", "permissions": []})
check("rijoy creates admin dave 200", r.status_code == 200, f"got {r.status_code}")
dave_id = r.json()["id"]
r = client.put(f"/api/users/{dave_id}", cookies=sa, json={"permissions": ["dashboard"]})
check("rijoy edits admin 200", r.status_code == 200, f"got {r.status_code}")
r = client.delete(f"/api/users/{dave_id}", cookies=sa)
check("rijoy deletes admin 200", r.status_code == 200, f"got {r.status_code}")

# --- user list splits correctly: roles present ---
r = client.get("/api/users", cookies=sa).json()
roles = {u["username"]: u["role"] for u in r}
check("alice listed as admin", roles.get("alice") == "admin", f"roles={roles}")
check("pm1 listed as pm", roles.get("pm1") == "pm", f"roles={roles}")

shutil.rmtree(tmp, ignore_errors=True)
print("\n==== RESULT ====")
if failures:
    print("FAILURES:", failures)
    sys.exit(1)
print("ALL PASSED")
