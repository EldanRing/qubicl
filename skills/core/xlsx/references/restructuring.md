# Reference-aware restructuring (xlsx_restructure.py)

`scripts/xlsx_restructure.py` performs one row/column insert or delete
and rewrites everything that references the moved cells. This document
gives the rewrite rules and the role of recalculation.

## What gets rewritten

| Artifact | Scope | Behavior |
|---|---|---|
| Formula references | ALL sheets | A1 refs into the edited sheet are shifted; refs into a fully deleted region become `#REF!` |
| Merged-cell ranges | edited sheet | shifted; expanded when they span the insertion point; dropped (reported `to: null`) when fully deleted |
| Autofilter | edited sheet | range, relative filter-column IDs and sort ranges shift together; deleted criteria are removed |
| Freeze panes | edited sheet | anchor cell shifted (never below row/col of the pane's own minimum) |
| Data validations | ALL sheets | applied ranges on the edited sheet shift; relative formula origins and references update; fully deleted rules are removed |
| Conditional formats | ALL sheets | applied ranges, rule formulas and formula-based thresholds update; fully deleted rules are removed |
| Native tables | edited sheet | table/filter/sort ranges, column schema and calculated/totals formulas shift together; deleted columns and tables update structured references throughout the workbook |
| Defined names | workbook and sheet-local scopes | `attr_text` refs into the edited sheet rewritten |
| Charts | ALL sheets | series/category/title references update; static source caches refresh from the resulting cells |
| Chart/image anchors | edited sheet | one-cell anchors move, two-cell anchors move/resize, and absolute anchors remain fixed |
| Print settings | edited sheet | print areas and repeated row/column titles shift or disappear when fully deleted |
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
- Whole-row/column refs (`B:B`, `$2:$9`) and A1 union/intersection operands
  shift using the same span rules. Deleting their entire span produces `#REF!`.
- Structured table references (`Sales[Revenue]`, `[@Revenue]`,
  `Sales[[#Data],[First]:[Last]]`) follow surviving columns. Deleting a
  referenced column or the whole table produces `#REF!`; a partially deleted
  column range shrinks to its surviving endpoints. Escaped column names are
  preserved. References into external workbooks remain unchanged.

## Shift semantics

Insert of N at index i: every coordinate >= i moves +N; range endpoints
move independently, so a range spanning i grows by N.

Delete of N at index i: coordinates before i are unchanged; coordinates
past the deleted block move -N; a single cell inside the block becomes
`#REF!`; a RANGE partially covering the block is clamped (Excel does the
same); a range entirely inside the block becomes `#REF!` (formulas) or
is removed (merges/validations).

## Dependent formulas, charts and drawings

Validation and conditional-format formulas retain their relative origin when an
edit removes the first cells of an applied range. This includes formula-based
color-scale, data-bar and icon-set thresholds. References from rules on other
worksheets are updated when they point into the edited worksheet.

Charts keep their objects and formatting. Their source references are rewritten
throughout the workbook, including combined charts and named sources. Static
numeric/text caches are rebuilt from the resulting cells. Formula-derived or
dynamic sources retain their formulas and recalculate when the workbook opens;
stale cached points are removed instead of displaying data from the old range.
The workbook is marked for full recalculation. For immediate rendered output,
use `xlsx_recalc.py` on a workstation before rendering.

Drawing movement follows each anchor's mode: absolute-position objects stay
fixed; one-cell objects move with their origin; two-cell objects move and resize
with both endpoints. Objects whose entire anchor span was deleted remain visible
at the deletion boundary. Image content and chart formatting are preserved.

Every run prints a JSON report of changed formulas, tables, ranges, names,
charts, anchors and print settings. `not_shifted` remains an empty list for
compatibility with earlier report consumers.

## One op per invocation

The CLI takes exactly one of `--insert-rows/--delete-rows/
--insert-cols/--delete-cols` (as `IDX[:N]`; columns accept letters).
For multiple operations run it repeatedly — ordering compound shifts in
one pass is where spreadsheet tools historically corrupt references.

## Table column and row changes

Inserting columns strictly inside a native table expands its schema and writes
unique `Column1`, `Column2`, … header names, avoiding existing names without
regard to case. Existing columns retain their IDs, names, calculated formulas,
totals settings and formatting metadata. New columns receive new IDs and the
adjacent column's formatting, but no copied values or unrelated formulas.
Inserting at the table's left boundary moves the table instead of adding a column.

Partial column deletion removes the matching schema entries, filter criteria and
sort conditions. Surviving filter-column IDs remain relative to the new filter
range. References to deleted columns become `#REF!` in cells, calculated/totals
formulas and defined names; ranges retain surviving columns. Deleting an entire
table removes its metadata and invalidates its structured references.

Inserted rows inside a table receive formulas from each calculated-column
template; existing formula exceptions are preserved. Templates remain aligned
with the first data row after insertion/deletion. Deleting the header row creates
a headerless table without replacing the first surviving data row with labels.
Deleting the totals row clears its presence flag. Deleting all table rows removes
the table. The JSON report records the old/new range, column IDs and names,
inserted/deleted columns and removed header/totals rows.

## Editing and appending through xlsx_edit.py

The general editor shares this structural engine for insert/delete operations.
Sheet renaming parses formula operands and updates references throughout cells,
names, table formulas, charts, validation and formatting rules. It also updates
internal hyperlink locations. Quoted names and apostrophes are escaped correctly;
external workbooks and text literals remain unchanged. Case-only renames retain
the requested name, and an existing different sheet is never silently renamed.

`--table-append` inserts a worksheet row before the next data position, including
before a totals row. This preserves all existing content below the table and
updates its references. New data inherits formatting and calculated-column
formulas; explicitly supplied values override those columns. Filters, totals and
chart series spanning the full table data range expand to include the new row.
Other cell formulas and fixed defined-name ranges retain their original scope
after moved references are updated. Calculated-column templates and row-local
formulas stay row-local; structured table references naturally include new data.
Chart series with a single-cell data source also expand when that cell was the
entire table data range; ordinary scalar references stay scalar.
