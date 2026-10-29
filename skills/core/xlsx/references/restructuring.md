# Reference-aware restructuring (xlsx_restructure.py)

`scripts/xlsx_restructure.py` performs one row/column insert or delete
and rewrites everything that references the moved cells. This document
gives the exact rewrite rules and honest limits.

## What gets rewritten

| Artifact | Scope | Behavior |
|---|---|---|
| Formula references | ALL sheets | A1 refs into the edited sheet are shifted; refs into a fully deleted region become `#REF!` |
| Merged-cell ranges | edited sheet | shifted; expanded when they span the insertion point; dropped (reported `to: null`) when fully deleted |
| Autofilter | edited sheet | range, relative filter-column IDs and sort ranges shift together; deleted criteria are removed |
| Freeze panes | edited sheet | anchor cell shifted (never below row/col of the pane's own minimum) |
| Data validations | edited sheet | each range in the sqref shifted; deleted ranges removed |
| Conditional formats | edited sheet | applied range (sqref) shifted |
| Native tables | edited sheet | table/filter/sort ranges shift together; partial table-column schema changes are rejected before saving |
| Defined names | workbook scope | `attr_text` refs into the edited sheet rewritten |
| Row heights / column widths | edited sheet | dimension keys re-indexed |

## Reference grammar handled

- Relative and absolute coordinates in any mix: `B2`, `$B2`, `B$2`,
  `$B$2` — the `$` flags are preserved through the shift.
- Ranges `B2:D9`, including partial-absolute endpoints.
- Cross-sheet refs: `Data!B2`, `'My Sheet'!$A$1:$C$9` (quoted names may
  contain doubled quotes `''`). Only refs whose sheet qualifier matches
  the edited sheet are touched; unqualified refs are interpreted
  relative to the formula's own sheet.
- String literals inside formulas (`"See B2"`) are never rewritten.
- Function names that look like cells (`LOG10(...)`) are not touched
  (a reference is never followed by `(`).
- Whole-row/column refs (`B:B`, `2:2`) pass through unchanged — Excel
  semantics keep them valid across inserts within the span.

## Shift semantics

Insert of N at index i: every coordinate >= i moves +N; range endpoints
move independently, so a range spanning i grows by N.

Delete of N at index i: coordinates before i are unchanged; coordinates
past the deleted block move -N; a single cell inside the block becomes
`#REF!`; a RANGE partially covering the block is clamped (Excel does the
same); a range entirely inside the block becomes `#REF!` (formulas) or
is removed (merges/validations).

## What it CANNOT shift (honest limits)

- **Chart anchors and plotted ranges** — openpyxl chart objects are not
  reliably round-tripped; anchors stay where they were. Re-create
  charts after restructuring if their data moved.
- **Images / drawings** — same reason.
- **Conditional-format RULE formulas** — the applied range (sqref) is
  shifted, but formulas inside `cell_is`/`expression` rules (e.g.
  `$B1>100`) are left as-is. Review them if they reference moved cells.
- **Sheet-local defined names** and names using R1C1 or union/
  intersection operators are rewritten only if they parse as plain A1
  refs; anything else passes through untouched.
- **Structured table references** in formulas (`Table1[Sales]`) don't
  need shifting (they follow the table), and are left alone.

Every run prints a JSON report listing exactly which formulas, merges,
tables, names, and ranges were changed, plus a fixed `not_shifted` list
of the above limits — inspect it after any structural edit.

## One op per invocation

The CLI takes exactly one of `--insert-rows/--delete-rows/
--insert-cols/--delete-cols` (as `IDX[:N]`; columns accept letters).
For multiple operations run it repeatedly — ordering compound shifts in
one pass is where spreadsheet tools historically corrupt references.

## Table column schema changes

Inserting a column strictly inside a table, or deleting some but not all table
columns, requires coordinating header names, `tableColumns`, structured formulas
and filter criteria. This helper rejects those operations before saving rather
than silently changing the table schema. Inserting/deleting columns before a
table still shifts it; deleting all its columns removes the table. To change a
table schema, explicitly rebuild its headers/columns and affected formulas, then
validate the saved workbook. Revisit this restriction when that schema-aware
transformation is implemented and verified.
