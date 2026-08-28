"""Verify admin-management feature against an isolated temp DB.

Monkeypatches app.main.DB_PATH / DATA_DIR to a temp dir, seeds via init_db(),
then drives the TestClient: login as super-admin, create an admin with
permissions, verify permission gating, verify the last-admin safeguard.
"""
import os, sys, json, tempfile, shutil
sys.path.insert(0, "/opt/data/revenue-tracker")

import app.main as m

# --- isolate DB ---
tmp = tempfile.mkdtemp(prefix="rt-admin-test-")
print("TMP:", tmp)
os.environ["REVENUE_AUTH_USER"] = "rijoy"
os.environ["REVENUE_AUTH_PASSWORD"] = "super-secret"
os.environ["REVENUE_DB_PASSWORD"] = ""          # plain DB for test
m.DATA_DIR = tmp
m.DB_PATH = os.path.join(tmp, "revenue.db")
m.DB_KEY_FILE = os.path.join(tmp, ".dbkey")

# ensure _HAS_CIPHER doesn't interfere: force plain sqlite3 for the test
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

# 1. super-admin login
r = login("rijoy", "super-secret")
check("super-admin login 200", r.status_code == 200, f"got {r.status_code}")
sa = cookie(r)
me = client.get("/api/me", cookies=sa).json()
check("super-admin has all perms", set(me["permissions"]) == set(m.ADMIN_PERMISSIONS),
      f"perms={me['permissions']}")

# 2. create an admin with a subset of permissions
r = client.post("/api/users", cookies=sa, json={
    "username": "bob", "password": "bobpw", "role": "admin",
    "permissions": ["pricing", "dashboard"], "projects": []})
check("create admin 200", r.status_code == 200, f"got {r.status_code} body={r.text}")
bob_id = r.json()["id"]

# 3. bob can login with role admin and only his perms
r = login("bob", "bobpw")
check("bob login 200", r.status_code == 200, f"got {r.status_code}")
bob = cookie(r)
me = client.get("/api/me", cookies=bob).json()
check("bob role admin", me["role"] == "admin", f"role={me['role']}")
check("bob perms subset", set(me["permissions"]) == {"pricing", "dashboard"},
      f"perms={me['permissions']}")

# 4. permission gating: bob CAN read pricing but CANNOT write db-security.
#    Reads stay admin-only (any admin may view); writes are perm-gated.
r = client.get("/api/pricing", cookies=bob)
check("bob can read pricing", r.status_code == 200, f"got {r.status_code}")
r = client.get("/api/db-security", cookies=bob)
check("bob can view db-security (read-only view)", r.status_code == 200, f"got {r.status_code}")
r = client.post("/api/db-password", cookies=bob, json={"password": "abcdef1"})
check("bob blocked from db-password write (no perm)", r.status_code == 403, f"got {r.status_code}")

# bob CANNOT create a resource (no 'resources' perm)
r = client.post("/api/resources", cookies=bob, json={"name": "X"})
check("bob blocked from create resource", r.status_code == 403, f"got {r.status_code}")

# bob CAN create a pricing title (has 'pricing')
r = client.post("/api/pricing", cookies=bob, json={"title": "Test Role", "rate": 10, "offshore_rate": 5})
check("bob can create pricing", r.status_code == 200, f"got {r.status_code} body={r.text}")

# 5. bob CANNOT manage users (no 'users' perm)
r = client.post("/api/users", cookies=bob, json={"username": "carol", "password": "x", "role": "pm"})
check("bob blocked from create user", r.status_code == 403, f"got {r.status_code}")

# 6. super-admin creates a PM (still works)
r = client.post("/api/users", cookies=sa, json={"username": "pm1", "password": "pmpw", "role": "pm", "projects": []})
check("super-admin create PM 200", r.status_code == 200, f"got {r.status_code}")
pm_id = r.json()["id"]
r = login("pm1", "pmpw")
check("PM login 200", r.status_code == 200, f"got {r.status_code}")
pm = cookie(r)
me = client.get("/api/me", cookies=pm).json()
check("PM role pm", me["role"] == "pm", f"role={me['role']}")
# PM denied admin endpoints
r = client.get("/api/pricing", cookies=pm)
check("PM blocked from pricing", r.status_code == 403, f"got {r.status_code}")

# 7. last-admin safeguard: cannot delete the last admin (bob is only admin besides super)
r = client.delete(f"/api/users/{bob_id}", cookies=sa)
check("cannot delete last admin", r.status_code == 400, f"got {r.status_code} body={r.text}")

# create a 2nd admin then delete bob
r = client.post("/api/users", cookies=sa, json={
    "username": "alice", "password": "alicepw", "role": "admin", "permissions": ["users"]})
alice_id = r.json()["id"]
r = client.delete(f"/api/users/{bob_id}", cookies=sa)
check("delete bob (2 admins now) 200", r.status_code == 200, f"got {r.status_code}")

# 8. cannot delete yourself (create a 3rd admin so alice isn't the last admin,
#    then have alice try to delete her own account)
r = client.post("/api/users", cookies=sa, json={
    "username": "dave", "password": "davepw", "role": "admin", "permissions": []})
r = login("alice", "alicepw")
alice = cookie(r)
r = client.delete(f"/api/users/{alice_id}", cookies=alice)
check("cannot delete own account", r.status_code == 400 and "own" in r.text,
      f"got {r.status_code} body={r.text}")

# 9. admin with only 'users' perm cannot access pricing write
r = client.post("/api/pricing", cookies=alice, json={"title": "Nope", "rate": 1})
check("alice blocked from pricing create (no perm)", r.status_code == 403, f"got {r.status_code}")

# cleanup temp
shutil.rmtree(tmp, ignore_errors=True)

print("\n==== RESULT ====")
if failures:
    print("FAILURES:", failures)
    sys.exit(1)
print("ALL PASSED")
