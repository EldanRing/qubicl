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

CSV imports preserve leading-zero/long identifiers and mixed-type columns; strings beginning with `=` stay literal by default, including headers. Use `--column-types '{"A":"text","B":"number"}'` for deliberate types or `--allow-formulas` only when formulas are intended. Review the conversion report. `xlsx_to_csv.py --data-only` refuses missing formula caches before writing; `--allow-missing-results` explicitly permits them and reports affected cells. Restructuring preserves structured references and shifts table filters/dimensions; deleted validation/table ranges are removed.
