---
name: xlsx
description: Create, inspect, edit, restructure, convert, and validate XLSX workbooks and CSV files using Qubicl's pinned local spreadsheet tools. Use for formulas, tables, charts, formatting, workbook structure, and CSV interoperability.
---

# Spreadsheet workflows

Keep workbook artifacts under `/home/qubicl`. Obtain this skill's `resourceRoot` from `skill_view` and run its helpers with `/opt/qubicl/skills-venv/bin/python`. The computer and workstation presets contain the pinned spreadsheet libraries; do not install packages during a task.

Useful helpers beneath `<resourceRoot>/scripts/`:

- `xlsx_read.py FILE --sheets|--json|--csv|--formulas|--notes|--names`
- `xlsx_create.py SPEC.json OUTPUT.xlsx`
- `xlsx_edit.py FILE` for values, rows, sheets, tables, names, links, notes, and protection
- `xlsx_restructure.py FILE` for reference-aware row or column changes
- `csv_to_xlsx.py INPUT.csv OUTPUT.xlsx`
- `xlsx_to_csv.py INPUT.xlsx OUTPUT.csv`
- `xlsx_recalc.py FILE` when LibreOffice is available

Read `references/restructuring.md` before inserting or deleting rows or columns in a formula-heavy workbook.

Inspect workbook structure and formulas before editing. Preserve formulas unless replacement is intentional, use a new output for risky transformations, and read the result back afterward. LibreOffice recalculation is available only on workstation computers; explain that limitation rather than manufacturing cached formula values.

`xlsx_read.py --formulas` includes normal, array and what-if data-table formulas.
Typed entries include `formula_type` and their result `ref`; array entries include
the expression in `formula`, while data-table entries include all input references
and flags in `attributes`. JSON/CSV sheet dumps represent typed formulas as JSON
objects rather than Python object names; standalone `xlsx_to_csv.py` uses the
same typed-formula and duration serialization. Elapsed-time values such as `[h]:mm`
use signed ISO 8601 durations (`P1DT3H15M` for 27 hours 15 minutes), preserving
days and fractional seconds. Dates and times retain their ISO date/time format.

Use the common rendering receipt for PDF, DOCX, XLSX and PPTX:
`/opt/qubicl/skills-venv/bin/python /opt/qubicl/artifact-render.py FILE --outdir DIR`.
Each invocation captures its source, uses an isolated Office profile, and writes a unique
run directory with PDF, exact numbered PNGs and `manifest.json`. Read `sourceSha256`,
`pages`, `warnings` and `validation`, then inspect the generated pages. Old previews
are never returned as this run's outputs. `visuallyInspected: false` is intentional:
the tool renders; the agent performs visual review. Office rendering needs workstation.

Rendering and `xlsx_recalc.py` report formula errors, missing cached results and changed
OOXML package parts. `recalculated: true` does not mean error-free, correct formulas,
or perfect Excel fidelity. Preserve the source and review formulas, formats, charts,
print areas and the rendered pages before delivering converted workbooks.

CSV imports preserve leading-zero/long identifiers and mixed-type columns; strings beginning with `=` stay literal by default, including headers. Default UTF-8 decoding accepts an initial BOM and preserves noninitial U+FEFF characters. Use `--column-types '{"A":"text","B":"number"}'` for deliberate types or `--allow-formulas` only when formulas are intended. Explicit typed empty cells become blanks; `--empty-cells reject` requires nonempty typed values. Numeric overflow/nonfinite values and invalid typed conversions fail with CSV row, column and cell context before saving. Imports preflight Excel's 1,048,576-row, 16,384-column, 32,767-character cell and 8,192-character formula limits; oversized input fails instead of silently truncating. The saved archive is reopened to verify dimensions and text/formulas before atomically replacing the destination, so a failed conversion preserves an existing output. Review the conversion report. `xlsx_to_csv.py --data-only` refuses missing formula caches before writing; `--allow-missing-results` explicitly permits them and reports affected cells. Restructuring supports native table column insertion/deletion, unique generated headers, calculated/totals formulas, filter criteria and sort ranges. It updates structured references throughout the workbook; deleted columns/tables become `#REF!`, while partially deleted column ranges retain surviving endpoints. Inserted table rows receive calculated-column formulas, and removing a header preserves the surviving data as a headerless table. Read the JSON transformation report and inspect the saved workbook.


`xlsx_edit.py --rename-sheet OLD:NEW` updates worksheet references in cells,
workbook/local names, tables, charts, validation/formatting rules and internal
hyperlinks; external workbook links and formula string literals are preserved.
Its row/column operations use the same reference-aware engine as
`xlsx_restructure.py`. `--table-append NAME=ROWJSON` inserts space before the next
row (or the totals row), preserving other content and formulas below the table.
Appended data inherits column formatting and calculated formulas; supplied values
replace only their corresponding columns. Totals, filters and chart series spanning the table data
expand with the table. Fixed named ranges and row-local calculations retain
their intended scope; structured table references include the new data. Use `--out` to retain the
original while reviewing a structural edit.

`xlsx_edit.py --copy-sheet SRC:NEW` copies cells, rich-text runs and typed
formulas, native charts and images, tables and pivot tables, validation and
conditional formatting, filters,
worksheet views, protection, print settings, headers/footers and sheet-local
names. Copies have independent objects and image data. Tables receive unique
names such as `Sales_Copy` (with a numeric suffix when needed), and copied
formulas/chart sources refer to the copied sheet and tables. Workbook-global
names, other-sheet references, external workbook links, 3D sheet intervals and
formula string literals retain their original meaning. Chart caches are retained
because copying does not change the source values. Existing sheet names are
rejected instead of silently choosing a different destination. Inspect table
names and saved chart references before making subsequent edits.

Copied pivots receive unique names. Pivots reading the copied sheet or its tables
receive independent cache definitions and records with new cache IDs and remapped
sources. Pivots reading unchanged external data, other worksheets or global names
retain their existing shared cache identity. Both `xlsx_edit.py` and
`xlsx_restructure.py` preserve mixed-run cell formatting when loading and saving.
