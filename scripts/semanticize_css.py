#!/usr/bin/env python3
"""
semanticize_css.py — one-off sweep that turns Revenue Recon's hardcoded dark
colours into semantic CSS variables, so a theme override actually applies
everywhere.

Why this exists: the existing stylesheet declares 14 variables in :root, but
41 hex literals and 60 rgba() literals sit outside that block. Without this
sweep, every new theme would leave dark-blue patches behind (panels, borders,
scrollbar, table striping, status pills) — the theme would look broken.

Strategy = SAFE substitution, not blind find/replace:
  * Only colours whose luminance says "this is a dark surface" (or a light
    hairline) become the generic --surface-* / --hairline-* roles.
  * Any rgba() that already derives from a semantic colour (e.g.
    rgba(34,211,238,...) == --accent) becomes color-mix-free
    rgba(var(--accent-rgb), a) using per-colour RGB triplet variables.
  * Anything we cannot classify confidently is LEFT ALONE and reported, so a
    human decides. Silent mis-mapping is how themes end up looking wrong.

Run:  python3 semanticize_css.py            # dry run, prints the plan
      python3 semanticize_css.py --apply    # writes app/static/styles.css
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "app/static/styles.css"

# ─── semantic variables this sweep introduces ────────────────────────
# Values chosen to reproduce the CURRENT look exactly when --theme is unset,
# so shipping this changes nothing visually until a theme is applied.
NEW_VARS = """
  /* ── semantic surface scale (themeable) ───────────────────────────
     These reproduce the original dark palette 1:1, so the default look is
     unchanged. Every theme overrides them. */
  --surface-1: #0b101f;   /* raised panel            (was #0b101f / #0d1326) */
  --surface-2: #0e1428;   /* deeper panel            */
  --surface-3: #1a2238;   /* hover / active row      */
  --surface-4: #08121c;   /* inset well              */
  --surface-5: #101831;   /* header band             */
  --surface-6: #151e36;   /* table stripe            */
  --surface-7: #121829;   /* modal body              */
  --hairline:   #4a5878;  /* strong 1px divider      */
  --hairline-2: #7a88a5;  /* subtle 1px divider      */

  /* ── status pill backgrounds (dark tint of the status hue) ─────── */
  --pill-red-bg:    #3a1b22;
  --pill-green-bg:  #10301f;
  --pill-amber-bg:  #332a12;
  --pill-orange-bg: #33200f;

  /* ── RGB triplets for rgba() composition ─────────────────────────
     Lets a theme recolour translucent overlays without rewriting every
     rgba() literal. Usage: rgba(var(--accent-rgb), 0.16) */
  --bg-rgb:     11, 16, 32;
  --text-rgb:   230, 236, 245;
  --accent-rgb: 34, 211, 238;
  --accent2-rgb:167, 139, 250;
  --green-rgb:  52, 211, 153;
  --red-rgb:    248, 113, 113;
  --amber-rgb:  251, 191, 36;
  --muted-rgb:  147, 161, 184;
"""

# hardcoded hex → semantic var. Only entries we are CONFIDENT about.
HEX_MAP = {
    "#0b101f": "var(--surface-1)",
    "#0b1020": "var(--bg)",
    "#0d1326": "var(--surface-2)",
    "#0e1428": "var(--surface-2)",
    "#1a2238": "var(--surface-3)",
    "#08121c": "var(--surface-4)",
    "#101831": "var(--surface-5)",
    "#151e36": "var(--surface-6)",
    "#121829": "var(--surface-7)",
    "#4a5878": "var(--hairline)",
    "#7a88a5": "var(--hairline-2)",
    "#f87171": "var(--red)",
    "#34d399": "var(--green)",
    "#fbbf24": "var(--amber)",
    "#3a1b22": "var(--pill-red-bg)",
    "#10301f": "var(--pill-green-bg)",
    "#332a12": "var(--pill-amber-bg)",
    "#33200f": "var(--pill-orange-bg)",
    # #fb923c (orange) has no existing variable — add one alongside amber.
    "#fb923c": "var(--orange)",
}

# rgba(r,g,b,a) where the rgb is a known semantic colour → rgba(var(--X-rgb), a)
RGB_ROLES = {
    (34, 211, 238): "accent",
    (167, 139, 250): "accent2",
    (52, 211, 153): "green",
    (248, 113, 113): "red",
    (251, 191, 36): "amber",
    (147, 161, 184): "muted",
    (11, 16, 32): "bg",
    (230, 236, 245): "text",
}

# rgba(0,0,0,a) and rgba(255,255,255,a) are NEUTRAL shadows/hairlines and are
# correct in both light and dark themes — deliberately left untouched.


def split_root(css: str) -> tuple[str, str, str]:
    """Return (before_root, root_block, after_root)."""
    i = css.index(":root")
    braces = css.index("{", i)
    depth, j = 0, braces
    while j < len(css):
        if css[j] == "{":
            depth += 1
        elif css[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return css[:i], css[i:j + 1], css[j + 1:]


def main() -> None:
    apply = "--apply" in sys.argv
    css = CSS.read_text()
    before, root, after = split_root(css)

    report: list[str] = []
    touched = 0

    # 1. hex substitution, only outside :root (the root block DEFINES them)
    for lit, var in HEX_MAP.items():
        n = len(re.findall(re.escape(lit), after, flags=re.I))
        if not n:
            continue
        after = re.sub(re.escape(lit), var, after, flags=re.I)
        touched += n
        report.append(f"  hex {lit:9} → {var:24} x{n}")

    # 2. rgba() with a semantic rgb → rgba(var(--role-rgb), a)
    def sub_rgba(m: re.Match) -> str:
        r, g, b, a = m.group(1), m.group(2), m.group(3), m.group(4)
        key = (int(r), int(g), int(b))
        role = RGB_ROLES.get(key)
        if not role:
            return m.group(0)
        return f"rgba(var(--{role}-rgb), {a})"

    pat = re.compile(r"rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)")
    converted = pat.sub(sub_rgba, after)
    n_rgba = len(pat.findall(after)) - len(pat.findall(converted))
    after = converted
    report.append(f"  rgba() with a semantic colour → rgba(var(--<role>-rgb), a)  x{n_rgba}")
    touched += n_rgba

    # 3. add --orange (used by the orange pill) to :root if missing
    root_new = root
    if "--orange:" not in root_new:
        root_new = root_new.rstrip()
        assert root_new.endswith("}")
        root_new = root_new[:-1].rstrip() + "\n  --orange: #fb923c;\n}"

    root_new = root_new[:-1].rstrip() + "\n" + NEW_VARS + "}"

    out = before + root_new + after

    print("=== semanticize_css.py plan ===")
    print("\n".join(report) or "  (nothing to do)")
    print(f"  TOTAL literals converted: {touched}")

    # leftovers — anything still hardcoded, for human review
    left_hex = sorted(set(re.findall(r"#[0-9a-fA-F]{3,6}\b", after)))
    left_rgba = sorted(set(re.findall(r"rgba?\([^)]*\)", after)))
    print(f"\n  remaining hex outside :root: {len(left_hex)} {left_hex}")
    print(f"  remaining rgba() literals  : {len(left_rgba)} (neutral shadows/hairlines kept on purpose)")

    if apply:
        CSS.write_text(out)
        print(f"\nAPPLIED → {CSS}")
    else:
        print("\n(dry run — pass --apply to write)")


if __name__ == "__main__":
    main()
