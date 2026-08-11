#!/usr/bin/env python3
"""Seed the revenue DB from a Revenue_2026-style workbook (default: original file).
Usage: /usr/bin/python3 scripts/seed.py [path_to_workbook]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import (  # noqa: E402  (imports trigger init_db)
    DB_PATH, _load_layout, _all_resources, build_dashboard_rows, get_db,
)
from app import importer  # noqa: E402


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else \
        "/opt/data/webui/attachments/dd2fb6b2f3c1/Revenue_2026.xlsm"
    data = Path(src).read_bytes()
    parsed = importer.parse_workbook_bytes(data)

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('layout', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps({"weeks": parsed["weeks"], "months": parsed["months"]}),),
        )
        existing_keys = {
            (r["client"].strip().upper(), r["name"].strip().upper())
            for r in conn.execute("SELECT client, name FROM resources").fetchall()
        }
        added = updated = 0
        for pr in parsed["resources"]:
            key = (pr["client"].strip().upper(), pr["name"].strip().upper())
            if key in existing_keys:
                cur = conn.execute(
                    "SELECT id FROM resources WHERE UPPER(TRIM(client))=? AND UPPER(TRIM(name))=?",
                    key,
                ).fetchone()
                conn.execute(
                    "UPDATE resources SET country=?, role=?, rate=?, offshore_rate=? WHERE id=?",
                    (pr["country"], pr["role"], pr["rate"], pr["offshore_rate"], cur["id"]),
                )
                conn.execute("DELETE FROM weekly_hours WHERE resource_id=?", (cur["id"],))
                conn.executemany(
                    "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                    [(cur["id"], i, h) for i, h in enumerate(pr["hours"]) if h],
                )
                updated += 1
            else:
                c2 = conn.execute(
                    "INSERT INTO resources (country, client, name, role, rate, offshore_rate, sort_order) "
                    "VALUES (?,?,?,?,?,?, COALESCE((SELECT MAX(sort_order)+1 FROM resources),0))",
                    (pr["country"], pr["client"], pr["name"], pr["role"], pr["rate"], pr["offshore_rate"]),
                )
                rid = c2.lastrowid
                conn.executemany(
                    "INSERT INTO weekly_hours (resource_id, week, hours) VALUES (?,?,?)",
                    [(rid, i, h) for i, h in enumerate(pr["hours"]) if h],
                )
                existing_keys.add(key)
                added += 1
        conn.commit()

        weeks, _ = _load_layout()
        resources = _all_resources(conn, weeks)
        dash = build_dashboard_rows(resources, weeks)
        print(f"seeded {src}: {added} added, {updated} updated → "
              f"{len(resources)} resources total")
        for t in dash["totals"]:
            print(f"  TOTAL {t['currency']}: rev={t['revenue']:,.2f} exp={t['expense']:,.2f} diff={t['difference']:,.2f}")
        total_rev = sum(t["revenue"] for t in dash["totals"])
        total_exp = sum(t["expense"] for t in dash["totals"])
        print(f"  GRAND TOTAL: rev={total_rev:,.2f} exp={total_exp:,.2f} profit={total_rev-total_exp:,.2f}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()