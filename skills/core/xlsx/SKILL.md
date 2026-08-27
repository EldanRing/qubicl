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
