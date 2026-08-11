#!/usr/bin/env python3
"""Set the Pricing library to Rijoy's canonical role list.

- Replaces all pricing rows with the 14 canonical titles (in his order),
  carrying forward existing rates where old spellings match (case-insensitive,
  trimmed).
- Remaps resources whose role matches a canonical title to the canonical
  spelling (e.g. 'Project Manager' -> 'Project manager').
- Resources with non-canonical roles keep their roles + stored rates — they
  simply don't have a Pricing entry (custom titles stay selectable).

Usage: /usr/bin/python3 scripts/set_canonical_pricing.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import get_db  # noqa: E402

CANONICAL = [
    "Project manager",
    "Solution Architect",
    "Principal Architect",
    "Quadient Developer",
    "Sr. Quadient Developer",
    "Java Developer",
    "Sr. Java Developer",
    "Open text developer",
    "Sr. Open text developer",
    "PhP Developer",
    "Sr. PHP Developer",
    "BCC",
    "QA",
    "QA Lead",
]


def norm(s) -> str:
    return (s or "").strip().lower()


def main() -> None:
    conn = get_db()
    try:
        old = {
            norm(r["title"]): (r["rate"], r["offshore_rate"])
            for r in conn.execute("SELECT title, rate, offshore_rate FROM pricing").fetchall()
        }
        conn.execute("DELETE FROM pricing")
        carried = 0
        for i, title in enumerate(CANONICAL):
            rate, off = old.get(norm(title), (None, None))
            if rate is not None or off is not None:
                carried += 1
            conn.execute(
                "INSERT INTO pricing (title, rate, offshore_rate, sort_order) VALUES (?,?,?,?)",
                (title, rate, off, i),
            )

        canon_by_norm = {norm(t): t for t in CANONICAL}
        resources = conn.execute("SELECT id, role FROM resources").fetchall()
        remapped = 0
        for r in resources:
            target = canon_by_norm.get(norm(r["role"]))
            if target and target != r["role"]:
                conn.execute("UPDATE resources SET role=? WHERE id=?", (target, r["id"]))
                remapped += 1
        conn.commit()

        rows = conn.execute(
            "SELECT p.title, p.rate, p.offshore_rate, "
            "(SELECT COUNT(*) FROM resources r WHERE TRIM(r.role)=p.title) AS used "
            "FROM pricing p ORDER BY p.sort_order"
        ).fetchall()
        print(f"canonical pricing set ({carried} with carried rates), remapped {remapped} resource(s):")
        for r in rows:
            print(f"  {r['title']:26} {r['rate'] or '-':>8} / {r['offshore_rate'] or '-':>8}  used_by={r['used']}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()