# Reference-aware restructuring (xlsx_restructure.py)

`scripts/xlsx_restructure.py` performs one row/column insert or delete
and rewrites everything that references the moved cells. This document
gives the rewrite rules and the role of recalculation.

## What gets rewritten

| Artifact | Scope | Behavior |
|---|---|---|
| Formula references | ALL sheets | A1 refs into the edited sheet are shifted; refs into a fully deleted region become `#REF!` |
| Array and what-if data-table formulas | ALL sheets | expressions/input refs update; result ranges and anchors move on the edited sheet, including promotion of a surviving anchor when the original is deleted |
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

Array formulas retain their typed OOXML representation: the anchor, result
`ref` and expression move together. If deletion removes an anchor but leaves
part of the result range, the first surviving cell becomes the anchor; deleting
the entire range removes the formula. Array expressions on other worksheets
also update their references into the edited worksheet. What-if data tables
retain their result range, input references and flags; deleted input references
set the corresponding `del1`/`del2` flag. Typed formulas appear with their
metadata in both the transformation report and `xlsx_read.py --formulas`.
The workbook is marked for recalculation; these structural operations do not
invent formula results.

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

## Copying a worksheet

`xlsx_edit.py FILE --copy-sheet SRC:NEW --out COPY.xlsx` preserves the worksheet's
cells, styles, dimensions and merged ranges plus independently editable charts,
images, native tables, data validation, conditional formatting, auto-filter,
views/freeze panes, protection, page breaks, print areas/titles, page setup,
headers/footers and sheet-local defined names. Image streams and chart graphs are
independent; saving the workbook does not consume an image shared with its copy.
Array/data-table formula objects and rich-text runs/inline formatting are copied
independently too. Both native workbook-editing helpers load rich text without
flattening its formatting; rich-text chart category labels remain readable.

Table names are workbook-wide, so copied tables use a unique `_Copy` suffix.
Structured references and explicit references to the source sheet are rewritten
inside copied cells, tables, chart sources, rules, internal hyperlinks and local
names. Existing worksheets and workbook-global names are not rewritten.
Other-sheet and external workbook references remain unchanged; 3D references
keep their original interval instead of expanding it to include the newly
appended sheet. Chart data caches are preserved, including external data that is
not available locally. A duplicate destination sheet name is an error.

Pivot tables receive unique names. A cache sourced from the copied worksheet or
one of its copied tables gets an independent definition, independent record part,
and new workbook cache ID; its worksheet/table source points at the copy. Multiple
pivots sharing that internal cache share the corresponding new cache within the
copy. Caches referring to unchanged external data, another worksheet or a global
named source intentionally keep their original cache identity, matching the
unchanged data source. Pivot-chart source metadata names the copied pivot and
sheet. Pivot fields, layout and cached values are preserved.
