/* ============================================================================
   TABLE SORTING — click any column header to sort ascending / descending.
   ----------------------------------------------------------------------------
   Rijoy: "one change that I want across all the logs where there is a table, that
   is the ability to filter the column based on ascending or descending. This goes
   to all the tables there in the app across all logins."

   One generic implementation instead of 15 bespoke ones, so every table behaves
   identically and a NEW table gets sorting for free.

   Design notes (these are the things that make it safe on THIS app):

   1. DELEGATED + OBSERVED, never wired per table. Every table here is re-rendered
      wholesale (tbody.innerHTML = ...) on load, on filter, on save. A sorter that
      attached handlers at render time would be lost on the next render. So we:
        - listen on the document for clicks on any <th>,
        - remember the sort per table id + column,
        - RE-APPLY it after a re-render via a MutationObserver on each tbody.
      That is why sorting survives a filter or a data refresh.

   2. GROUPED TABLES (Planned grid, Actuals grid) must not be scrambled. Those
      tbodies interleave `tr.group-row` headers with their member rows, and the
      collapse logic maps a group header to the rows that follow it. A naive sort
      of all rows would detach members from their header. So we sort only the runs
      of data rows BETWEEN group headers and leave each group header pinned.

   3. IDEMPOTENCE, or the observer loops forever. Re-applying a sort appends nodes,
      which is itself a mutation, which re-fires the observer. We therefore compare
      the computed order with the current DOM order and return without touching the
      DOM when they already match. That makes it converge instead of spinning.

   4. NUMBERS SORT AS NUMBERS. A column is numeric only if EVERY data cell in it
      parses as a number, so a column containing "—" or "n/a" sorts as text rather
      than throwing the blanks to the top. "$1,234.50", "45%" and "120h" all parse.
      Input cells (editable hour boxes) contribute their VALUE, not their markup.

   5. PLACEHOLDER ROWS ("No data for this scope", colspan=8) are pinned in place,
      not sorted, so they cannot float into the middle of the results.
   ========================================================================== */

const TS = {
  sorts: {},      // tableId -> { idx, dir }  (dir: "asc" | "desc")
  observers: {},  // tableId -> MutationObserver
  originals: {},  // tableId -> original row order (for a third click = reset)
};

/* Parse a cell's text as a number, or null when it is not numeric. */
function tsNum(txt) {
  let s = String(txt == null ? "" : txt).trim();
  if (!s) return null;
  // Strip currency, thousands separators, trailing units and percent.
  s = s.replace(/[$€£]/g, "").replace(/,/g, "").replace(/\s+/g, "");
  s = s.replace(/%$/, "").replace(/h(rs)?$/i, "");
  if (s === "" || s === "—" || s === "-" || s === "–") return null;
  // A pure number, optionally signed / decimal. Reject "12 Jan" and "3 wks".
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/* The comparable value of one cell. */
function tsCellText(tr, idx) {
  const td = tr.children[idx];
  if (!td) return "";
  // An explicit sort key wins (used where the visible text is not orderable).
  if (td.dataset && td.dataset.sort !== undefined) return td.dataset.sort;
  // An editable cell sorts by what is typed in it, not by its surrounding markup.
  const inp = td.querySelector("input, select");
  if (inp) {
    if (inp.tagName === "SELECT") {
      const o = inp.selectedOptions && inp.selectedOptions[0];
      return (o && o.textContent) || "";
    }
    if (inp.value !== undefined && String(inp.value).trim() !== "") return inp.value;
  }
  return td.textContent.trim();
}

/* Is this table's current order already the requested one? */
function tsOrderMatches(tb, out) {
  const cur = Array.from(tb.rows);
  if (cur.length !== out.length) return false;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== out[i]) return false;
  return true;
}

function tsSortTable(table, idx, dir) {
  const tb = table.tBodies && table.tBodies[0];
  if (!tb) return;
  const rows = Array.from(tb.rows);
  const dataRows = rows.filter(
    (r) => !r.classList.contains("group-row") && !r.querySelector("td[colspan]")
  );
  if (dataRows.length < 2) return;

  // A column counts as NUMERIC when every NON-BLANK cell is a number. Requiring
  // every cell (including blanks) made one "—" placeholder demote the whole
  // column to a text sort, where "9" sorts above "100".
  const raw = dataRows.map((r) => tsCellText(r, idx));
  const nums = raw.map((t) => tsNum(t));
  const blanks = nums.filter((n) => n === null).length;
  const allNum = nums.length > blanks && (nums.length - blanks) >= 1
    && nums.filter((n) => n !== null).length === nums.length - blanks;

  const isBlank = (r) => {
    const t = tsCellText(r, idx).trim();
    return t === "" || t === "—" || t === "-" || t === "–" || t === "n/a";
  };

  const key = (r) => {
    if (allNum) return tsNum(tsCellText(r, idx));
    return String(tsCellText(r, idx)).toLowerCase();
  };

  // BLANKS ALWAYS LAST, whichever direction. Sorting a "Planned" column
  // descending should surface the biggest plans, not the rows nobody has entered
  // yet — and the placeholder character (U+2014) must not decide the order.
  //
  // The blank rule is applied WITHOUT the direction multiplier on purpose: this
  // comparator returned "blanks last" for ascending, and the caller then flipped
  // it with `dir === "desc" ? -1 : 1`, which put the blanks FIRST on descending.
  // Direction therefore has to be handled INSIDE, after the blank test.
  const cmp = (a, b) => {
    const ab = isBlank(a);
    const bb = isBlank(b);
    if (ab && bb) return 0;
    if (ab) return 1;          // blank -> after, always
    if (bb) return -1;
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return dir === "desc" ? 1 : -1;
    if (ka > kb) return dir === "desc" ? -1 : 1;
    return 0;
  };

  /* Sort the runs of data rows BETWEEN pinned rows, so group headers keep their
     members and placeholder rows stay put. */
  const out = [];
  let seg = [];
  const flush = () => {
    if (seg.length) {
      seg.sort(cmp);         // direction is handled inside cmp (see above)
      out.push.apply(out, seg);
      seg = [];
    }
  };
  for (const r of rows) {
    if (r.classList.contains("group-row") || r.querySelector("td[colspan]")) {
      flush();
      out.push(r);
    } else {
      seg.push(r);
    }
  }
  flush();

  if (tsOrderMatches(tb, out)) return;   // idempotent: no DOM write, observer quiesces
  const frag = document.createDocumentFragment();
  out.forEach((r) => frag.appendChild(r));
  // Appending a fragment MOVES the existing nodes, so every data-* attribute and
  // every event listener on the rows rides along — nothing is re-created.
  tb.appendChild(frag);
}

/* Paint the indicator on the header row that owns the active sort. */
function tsMark(table) {
  const s = TS.sorts[table.id];
  Array.from(table.querySelectorAll("thead th")).forEach((th) => {
    th.classList.remove("ts-asc", "ts-desc", "ts-on");
    const ind = th.querySelector(".ts-ind");
    if (ind) ind.remove();
  });
  if (!s) return;
  const heads = Array.from(table.querySelectorAll("thead tr"));
  for (const tr of heads) {
    const th = tr.children[s.idx];
    if (!th || th.colSpan > 1) continue;
    th.classList.add(s.dir === "asc" ? "ts-asc" : "ts-desc", "ts-on");
    const ind = document.createElement("span");
    ind.className = "ts-ind";
    ind.textContent = s.dir === "asc" ? "▲" : "▼";
    th.appendChild(ind);
    break;
  }
}

function tsApply(table) {
  const s = TS.sorts[table.id];
  if (!s) return;
  tsSortTable(table, s.idx, s.dir);
  tsMark(table);
}

/* Re-apply the remembered sort whenever a tbody is re-rendered. */
function tsObserve(table) {
  if (TS.observers[table.id]) return;
  const tb = table.tBodies && table.tBodies[0];
  if (!tb) return;
  const ob = new MutationObserver(() => {
    if (!TS.sorts[table.id]) return;   // nothing requested for this table
    tsApply(table);
  });
  ob.observe(tb, { childList: true });
  TS.observers[table.id] = ob;
}

/* Can this header be sorted? A colspan row (the month band) cannot: its cells do
   not map 1:1 to columns, so a click there would sort by the wrong field. */
function tsSortableHeader(th) {
  if (!th || th.tagName !== "TH") return false;
  if (th.colSpan > 1) return false;
  const tr = th.parentNode;
  if (!tr || !tr.parentNode || tr.parentNode.tagName !== "THEAD") return false;
  // A row mixing colspans with normal cells cannot be indexed reliably either.
  if (Array.from(tr.children).some((c) => c.colSpan > 1)) return false;
  if (!th.textContent.trim()) return false;      // blank action column
  if (th.classList.contains("no-sort")) return false;
  return true;
}

document.addEventListener("click", (e) => {
  const th = e.target.closest && e.target.closest("th");
  if (!th) return;
  if (!tsSortableHeader(th)) return;
  const table = th.closest("table");
  if (!table || !table.tBodies || !table.tBodies[0]) return;

  const tr = th.parentNode;
  const idx = Array.from(tr.children).indexOf(th);
  if (idx < 0) return;

  const cur = TS.sorts[table.id];
  // Three states, so a column can be sorted AND then put back: asc -> desc -> off.
  let dir;
  if (!cur || cur.idx !== idx) dir = "asc";
  else if (cur.dir === "asc") dir = "desc";
  else dir = null;

  if (!TS.originals[table.id]) {
    TS.originals[table.id] = Array.from(table.tBodies[0].rows);
  }

  if (dir === null) {
    const orig = TS.originals[table.id];
    const tb = table.tBodies[0];
    if (orig && orig.length === tb.rows.length && !tsOrderMatches(tb, orig)) {
      const frag = document.createDocumentFragment();
      orig.forEach((r) => frag.appendChild(r));
      tb.appendChild(frag);
    }
    delete TS.sorts[table.id];
    tsMark(table);
    return;
  }

  TS.sorts[table.id] = { idx: idx, dir: dir };
  tsApply(table);
});

/* Mark every sortable header, and attach an observer to every table.
   MUST run on every scan, not only when a table is first seen: the <thead> is
   filled by a later render in this app, so at first sight there are no <th>
   elements to mark. */
function tsScan() {
  document.querySelectorAll("table").forEach((t) => {
    if (!t.id) return;
    tsObserve(t);
    Array.from(t.querySelectorAll("thead th")).forEach((th) => {
      if (!tsSortableHeader(th)) {
        // A header that became unsortable (e.g. a column layout changed) must
        // lose the affordance rather than keep a stale cursor.
        th.classList.remove("ts-sortable");
        return;
      }
      if (!th.classList.contains("ts-sortable")) {
        th.classList.add("ts-sortable");
        th.title = (th.title ? th.title + " · " : "") + "Click to sort";
      }
    });
  });
}

const tsInit = tsScan;

try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tsInit);
  } else {
    tsInit();
  }
  // New tables appear after data loads, so re-scan. Cheap and bounded.
  const tsRescan = new MutationObserver(() => {
    // Re-mark on every mutation: headers are rendered after the table exists.
    // tsScan is idempotent (guarded by the class check) and bounded (a handful
    // of tables), so this is cheap.
    tsScan();
  });
  tsRescan.observe(document.body || document.documentElement, { childList: true, subtree: true });
} catch (err) {
  // Sorting must never be able to break the app.
  console.warn("table sorting unavailable:", err);
}
