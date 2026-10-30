#!/usr/bin/env python3
"""Edit an existing .xlsx workbook in place (or to --out).

Operations (repeatable where noted, applied in the order listed below):
  --rename-sheet OLD:NEW        rename a sheet
  --copy-sheet SRC:NEW          duplicate a sheet under a new name
  --insert-rows IDX[:N]         insert N rows before row IDX (default N=1)
  --delete-rows IDX[:N]         delete N rows starting at row IDX
  --insert-cols IDX[:N]         insert N columns before column IDX (number)
  --delete-cols IDX[:N]         delete N columns starting at column IDX
  --set CELL=VALUE              repeatable; type-inferred (int, float, bool,
                                ISO date, else string). '=...' sets a formula.
  --append ROWJSON              repeatable; JSON array appended as a row
  --add-table NAME:RANGE[:STYLE]  create a native Excel table (ListObject)
  --table-append NAME=ROWJSON   append a row inside a table, auto-extending
                                the table's range (repeatable)
  --list-tables                 print tables on the target sheet and exit
  --define-name NAME=REF        workbook-scope defined name, e.g.
                                "Rates='Data'!$B$2:$B$9" (repeatable)
  --delete-name NAME            remove a defined name (repeatable)
  --hyperlink CELL=URL[|TEXT]   set a hyperlink (optional display text)
  --note CELL=TEXT[|AUTHOR]     set a cell note/comment (repeatable)
  --clear-note CELL             remove a cell note (repeatable)
  --protect [PASSWORD]          enable sheet protection; combine with
                                --unlock RANGE to leave ranges editable.
                                NOT security: trivially strippable (see
                                SKILL.md Pitfalls).
  --recalc                      set fullCalcOnLoad so Excel/LibreOffice
                                recomputes all formulas on next open

Row/column edits and table appends share xlsx_restructure.py's reference-aware
transformations. Sheet renames update formula-bearing dependents throughout the
workbook. Inspect the saved result before delivering it.

Usage:
  xlsx_edit.py book.xlsx --sheet Data --set B2=42 --set C2=2026-01-01 \
      --set "D2==SUM(B2:C2)" --recalc
  xlsx_edit.py book.xlsx --sheet Data --append '["Widget", 9.99, true]'
  xlsx_edit.py book.xlsx --copy-sheet Data:Backup --rename-sheet Data:Main
"""
from __future__ import annotations

import argparse
from copy import copy, deepcopy
from io import BytesIO
import json
import re
import sys
from datetime import date, datetime

from openpyxl import load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Protection
from openpyxl.utils import get_column_letter, range_boundaries, quote_sheetname
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.workbook.properties import CalcProperties
from openpyxl.worksheet.table import Table, TableStyleInfo
from xlsx_formula_values import is_typed_formula, rewrite_typed_formula


def infer(text):
    if text.startswith("="):
        return text  # formula
    low = text.lower()
    if low in ("true", "false"):
        return low == "true"
    for caster in (int, float):
        try:
            return caster(text)
        except ValueError:
            pass
    for parser in (date.fromisoformat, datetime.fromisoformat):
        try:
            return parser(text)
        except ValueError:
            pass
    return text


def parse_idx(arg):
    if ":" in arg:
        idx, n = arg.split(":", 1)
        return int(idx), int(n)
    return int(arg), 1


def add_table(ws, spec):
    parts = spec.split(":")
    if len(parts) < 3:
        raise ValueError("--add-table needs NAME:RANGE like Sales:A1:C9")
    name = parts[0]
    rng = ":".join(parts[1:3])
    style = parts[3] if len(parts) > 3 else "TableStyleMedium9"
    table = Table(displayName=name, ref=rng)
    table.tableStyleInfo = TableStyleInfo(name=style, showRowStripes=True)
    table._initialise_columns()
    left, top, _, _ = range_boundaries(table.ref)
    for offset, column in enumerate(table.tableColumns):
        column.name = str(ws.cell(top, left+offset).value)
    ws.add_table(table)


def rewrite_workbook_references(wb, ws, rewrite, snapshots=None):
    """Rewrite formula-bearing dependents without moving worksheet cells."""
    from xlsx_restructure import shift_point, shift_range
    from xlsx_restructure_dependents import snapshot_dependents, apply_dependents
    snapshots = snapshot_dependents(wb) if snapshots is None else snapshots
    for sheet in wb.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    cell.value = rewrite(cell.value, sheet.title)
                elif is_typed_formula(cell.value):
                    cell.value = rewrite_typed_formula(cell.value, rewrite, sheet.title)
                if cell.hyperlink and cell.hyperlink.location:
                    cell.hyperlink.location = rewrite(cell.hyperlink.location, sheet.title)
                if cell.hyperlink and cell.hyperlink.target and cell.hyperlink.target.startswith("#"):
                    cell.hyperlink.target = "#" + rewrite(cell.hyperlink.target[1:], sheet.title)
        for table in sheet.tables.values():
            for column in table.tableColumns:
                for attr in ("calculatedColumnFormula", "totalsRowFormula"):
                    formula = getattr(column, attr)
                    if formula is not None and formula.attr_text:
                        formula.attr_text = rewrite(formula.attr_text, sheet.title)
    for name in wb.defined_names.values():
        if name.attr_text:
            name.attr_text = rewrite(name.attr_text, ws.title)
    return apply_dependents(wb, snapshots, ws, "rows", 1, 0, False,
                            rewrite, shift_point, shift_range)


def rewrite_range_tokens(text, callback):
    from openpyxl.formula.tokenizer import Tokenizer
    prefix = "" if text.startswith("=") else "="
    tokens = Tokenizer(prefix + text).items
    rewritten = "".join(callback(token.value) if token.subtype == "RANGE" else token.value
                        for token in tokens)
    return ("=" if not prefix else "") + rewritten


def rename_sheet(wb, old, new):
    from xlsx_restructure_dependents import snapshot_dependents
    ws = wb[old]
    if any(sheet is not ws and sheet.title.casefold() == new.casefold() for sheet in wb):
        raise ValueError(f"A worksheet named {new!r} already exists")
    snapshots = snapshot_dependents(wb)
    if old.casefold() == new.casefold() and old != new:
        temporary = "_qubicl_rename"
        while temporary.casefold() in {sheet.title.casefold() for sheet in wb}:
            temporary += "_"
        ws.title = temporary
    ws.title = new
    actual = ws.title

    def rewrite(text, home):
        def token(value):
            qualified = re.fullmatch(r"('(?:[^']|'')+'|[^!\[\]]+)!(.*)", value)
            if not qualified:
                return value
            qualifier, coordinate = qualified.groups()
            name = qualifier[1:-1].replace("''", "'") if qualifier.startswith("'") and qualifier.endswith("'") else qualifier
            if "[" in name or "]" in name:
                return value
            endpoints = name.split(":")
            replaced = [actual if endpoint.casefold() == old.casefold() else endpoint for endpoint in endpoints]
            if replaced == endpoints:
                return value
            return quote_sheetname(":".join(replaced)) + "!" + coordinate
        return rewrite_range_tokens(text, token)

    rewrite_workbook_references(wb, ws, rewrite, snapshots)
    return actual


def copy_sheet(wb, source_title, new_title):
    """Copy the sheet's independently editable objects and local references."""
    from xlsx_restructure import shift_point, shift_range
    from xlsx_restructure_dependents import snapshot_dependents, apply_dependents, _walk_objects
    from openpyxl.chart.data_source import NumRef, StrRef, MultiLevelStrRef
    from openpyxl.chart.pivot import PivotSource
    source = wb[source_title]
    if any(sheet.title.casefold() == new_title.casefold() for sheet in wb):
        raise ValueError(f"A worksheet named {new_title!r} already exists")
    target = wb.copy_worksheet(source)
    try:
        target.title = new_title
        for name in ("sheet_state", "sheet_format", "sheet_properties", "merged_cells",
                     "page_margins", "print_options", "protection", "views",
                     "row_breaks", "col_breaks", "HeaderFooter", "scenarios",
                     "auto_filter", "data_validations", "conditional_formatting"):
            setattr(target, name, deepcopy(getattr(source, name)))
        target.page_setup = copy(source.page_setup)
        target.page_setup._parent = target
        target.print_area = source.print_area
        target.print_title_rows = source.print_title_rows
        target.print_title_cols = source.print_title_cols
        for name, definition in source.defined_names.items():
            clone = deepcopy(definition)
            clone.localSheetId = wb.index(target)
            target.defined_names[name] = clone

        # Table identities are workbook-wide. Column IDs and filters belong to
        # their table and can retain their values inside an independent clone.
        occupied = {name.casefold() for sheet in wb for name in sheet.tables}
        occupied.update(name.casefold() for name in wb.defined_names)
        occupied.update(name.casefold() for sheet in wb for name in sheet.defined_names)
        table_names = {}
        for table in source.tables.values():
            base = table.displayName[:240] + "_Copy"
            candidate, suffix = base, 2
            while candidate.casefold() in occupied:
                candidate = f"{base}{suffix}"
                suffix += 1
            occupied.add(candidate.casefold())
            clone = deepcopy(table)
            table_names[table.name.casefold()] = candidate
            table_names[table.displayName.casefold()] = candidate
            clone.name = clone.displayName = candidate
            target.add_table(clone)

        def rewrite(text, _home):
            def token(value):
                qualified = re.fullmatch(r"('(?:[^']|'')+'|[^!\[\]]+)!(.*)", value)
                prefix, coordinate = "", value
                if qualified:
                    qualifier, coordinate = qualified.groups()
                    name = qualifier[1:-1].replace("''", "'") if qualifier.startswith("'") else qualifier
                    # External workbook references retain their original scope.
                    if "[" in name or "]" in name or ":" in name:
                        return value
                    if name.casefold() != source.title.casefold():
                        return value
                    prefix = quote_sheetname(target.title) + "!"
                table_name, bracket, selectors = coordinate.partition("[")
                mapped = table_names.get(table_name.casefold())
                if mapped:
                    coordinate = mapped + (bracket + selectors if bracket else "")
                return prefix + coordinate
            return rewrite_range_tokens(text, token)

        for cell in target._cells.values():
            # Rich-text runs and other supported mutable values must not remain
            # shared through WorksheetCopy's shallow _value assignment.
            cell._value = deepcopy(cell._value)
            if is_typed_formula(cell.value):
                cell.value = rewrite_typed_formula(cell.value, rewrite, target.title)
            elif isinstance(cell.value, str) and cell.value.startswith("="):
                cell.value = rewrite(cell.value, target.title)
            if cell.hyperlink:
                if cell.hyperlink.location:
                    cell.hyperlink.location = rewrite(cell.hyperlink.location, target.title)
                if cell.hyperlink.target and cell.hyperlink.target.startswith("#"):
                    cell.hyperlink.target = "#" + rewrite(cell.hyperlink.target[1:], target.title)
        for table in target.tables.values():
            for column in table.tableColumns:
                for attribute in ("calculatedColumnFormula", "totalsRowFormula"):
                    formula = getattr(column, attribute)
                    if formula is not None and formula.attr_text:
                        formula.attr_text = rewrite(formula.attr_text, target.title)

        pivot_names = {pivot.name.casefold() for sheet in wb for pivot in sheet._pivots}
        cache_ids = {pivot.cacheId for sheet in wb for pivot in sheet._pivots}
        next_cache_id = max(cache_ids, default=-1) + 1
        copied_caches = {}
        pivot_renames = {}
        for pivot in source._pivots:
            cache = pivot.cache
            if cache is not None and id(cache) not in copied_caches:
                cache_source = cache.cacheSource
                worksheet_source = cache_source.worksheetSource if cache_source is not None else None
                mapped_sheet = worksheet_source.sheet if worksheet_source is not None else None
                mapped_name = worksheet_source.name if worksheet_source is not None else None
                if mapped_sheet and mapped_sheet.casefold() == source.title.casefold():
                    mapped_sheet = target.title
                if mapped_name:
                    mapped_name = rewrite(mapped_name, target.title)
                if worksheet_source is not None and (mapped_sheet != worksheet_source.sheet or mapped_name != worksheet_source.name):
                    clone_cache = deepcopy(cache)
                    clone_cache.cacheSource.worksheetSource.sheet = mapped_sheet
                    clone_cache.cacheSource.worksheetSource.name = mapped_name
                    copied_caches[id(cache)] = (clone_cache, next_cache_id)
                    next_cache_id += 1
                else:
                    # A pivot reading unchanged external/other-sheet/global
                    # data intentionally uses the existing cache. Internal copy
                    # sources get separate cache definitions AND record parts.
                    copied_caches[id(cache)] = (cache, pivot.cacheId)
            selected_cache, cache_id = copied_caches.get(id(cache), (None, pivot.cacheId))
            clone = deepcopy(pivot, {id(cache): selected_cache} if cache is not None else {})
            clone.cacheId = cache_id
            base = pivot.name[:240] + "_Copy"
            candidate, suffix = base, 2
            while candidate.casefold() in pivot_names:
                candidate = f"{base}{suffix}"
                suffix += 1
            pivot_names.add(candidate.casefold())
            clone.name = candidate
            pivot_renames[pivot.name.casefold()] = candidate
            target.add_pivot(clone)

        target._charts = deepcopy(source._charts)
        for chart in target._charts:
            for reference in _walk_objects(chart):
                if isinstance(reference, (NumRef, StrRef, MultiLevelStrRef)) and reference.f:
                    reference.f = rewrite(reference.f, target.title)
                elif isinstance(reference, PivotSource) and reference.name:
                    qualifier, separator, name = reference.name.rpartition("!")
                    mapped = pivot_renames.get(name.casefold())
                    if not mapped:
                        continue
                    if not separator:
                        reference.name = mapped
                        continue
                    decoded = qualifier[1:-1].replace("''", "'") if qualifier.startswith("'") and qualifier.endswith("'") else qualifier
                    workbook, closing_bracket, sheet = decoded.rpartition("]")
                    workbook = workbook + "]" if closing_bracket else ""
                    if sheet.casefold() == source.title.casefold():
                        reference.name = quote_sheetname(workbook + target.title) + "!" + mapped
        # Cell values do not change during copying. Retain the chart's original
        # caches, including external/dynamic sources unavailable to this process.
        # Structural edits refresh caches separately when their data changes.
        # _data closes a loaded image's backing stream. Give the source and copy
        # separate fresh streams so saving both sheets cannot consume either one.
        for image in source._images:
            data = image._data()
            image.ref = BytesIO(data)
            clone = copy(image)
            clone.ref = BytesIO(data)
            clone.anchor = deepcopy(image.anchor)
            target.add_image(clone)
        snapshots = [snapshot for snapshot in snapshot_dependents(wb) if snapshot["sheet"] is target]
        for snapshot in snapshots: snapshot["drawings"] = []
        apply_dependents(wb, snapshots, target, "rows", 1, 0, False,
                         rewrite, shift_point, shift_range)
        return target
    except Exception:
        wb.remove(target)
        raise


def table_append(ws, name, row_values):
    from openpyxl.formula.translate import Translator
    from xlsx_restructure import restructure_workbook, REF_RE, COORD_RE
    table = ws.tables[name]
    left, top, right, bottom = range_boundaries(table.ref)
    if not isinstance(row_values, list) or len(row_values) > right-left+1:
        raise ValueError("A table row must be a JSON array no wider than the table")
    first_data = top + int(bool(table.headerRowCount))
    last_data = bottom - (table.totalsRowCount or 0)
    new_row = last_data + 1

    # Insert a worksheet row so unrelated data, formulas and dependents below
    # the table cannot be overwritten. Totals rows remain below the new data.
    restructure_workbook(ws.parent, ws, "rows", new_row, 1, False)
    table = ws.tables[name]
    if not table.totalsRowCount:
        table.ref = f"{get_column_letter(left)}{top}:{get_column_letter(right)}{bottom+1}"
    for col in range(left, right+1):
        if last_data >= first_data:
            ws.cell(new_row, col)._style = copy(ws.cell(last_data, col)._style)
        formula = table.tableColumns[col-left].calculatedColumnFormula
        if formula is not None and formula.attr_text:
            text = formula.attr_text
            text = text if text.startswith("=") else "=" + text
            ws.cell(new_row, col).value = Translator(text, origin=f"{get_column_letter(col)}{first_data}").translate_formula(f"{get_column_letter(col)}{new_row}")
    for offset, value in enumerate(row_values):
        ws.cell(new_row, left+offset).value = value

    def expand_range(value):
        a, first, b, last = range_boundaries(value)
        if first in (top, first_data) and last == last_data and left <= a <= b <= right:
            return f"{get_column_letter(a)}{first}:{get_column_letter(b)}{last+1}"
        return value
    if table.autoFilter and table.autoFilter.ref:
        table.autoFilter.ref = expand_range(table.autoFilter.ref)
    for state in (table.sortState, table.autoFilter.sortState if table.autoFilter else None):
        if state:
            state.ref = expand_range(state.ref)
            for condition in state.sortCondition:
                condition.ref = expand_range(condition.ref)

    def expand_formula(text, home, chart_source=False):
        def token(value):
            original = value
            if "[" in value:
                return original
            match = REF_RE.fullmatch(value)
            if not match:
                return original
            if not match.group("end"):
                if not chart_source or first_data != last_data:
                    return original
                value += ":" + match.group("start")
                match = REF_RE.fullmatch(value)
            qualifier = match.group("sheet") or ""
            sheet = qualifier[:-1] if qualifier else home
            if sheet.startswith("'"):
                sheet = sheet[1:-1].replace("''", "'")
            if sheet.casefold() != ws.title.casefold():
                return original
            start, end = COORD_RE.fullmatch(match.group("start")), COORD_RE.fullmatch(match.group("end"))
            a, first, b, last = range_boundaries(match.group("start") + ":" + match.group("end"))
            if min(first,last) not in (top,first_data) or max(first,last) != last_data or not (left <= min(a,b) <= max(a,b) <= right):
                return original
            start_row = first + 1 if first == last_data else first
            end_row = last + 1 if last == last_data else last
            # A single-row range expands its end; its start remains anchored.
            if first == last: start_row = first
            return (qualifier + f"{start.group(1)}{start.group(2)}{start.group(3)}{start_row}:"
                    f"{end.group(1)}{end.group(2)}{end.group(3)}{end_row}")
        return rewrite_range_tokens(text, token)

    # A one-row chart series is commonly serialized as a single cell rather
    # than A2:A2. Expand only series data here; ordinary scalar formulas and
    # chart titles must remain single-cell references.
    from openpyxl.chart.series import Series
    from openpyxl.chart.data_source import NumRef, StrRef, MultiLevelStrRef
    from openpyxl.chart.pivot import PivotSource
    from xlsx_restructure_dependents import _walk_objects, _refresh_cache, _cells_for_reference
    for sheet in ws.parent.worksheets:
        for chart in sheet._charts:
            for series in _walk_objects(chart):
                if not isinstance(series, Series):
                    continue
                for attr in ("val", "cat", "xVal", "yVal", "bubbleSize"):
                    for ref in _walk_objects(getattr(series, attr, None)):
                        if isinstance(ref, (NumRef, StrRef, MultiLevelStrRef)) and ref.f:
                            ref.f = expand_formula(ref.f, sheet.title, chart_source=True)
                            _refresh_cache(ref, _cells_for_reference(ws.parent, sheet.title, ref.f), ws.parent)
    if table.totalsRowCount:
        totals_row = range_boundaries(table.ref)[3]
        for offset, column in enumerate(table.tableColumns):
            formula = column.totalsRowFormula
            if formula is not None and formula.attr_text:
                formula.attr_text = expand_formula(formula.attr_text, ws.title)
            cell = ws.cell(totals_row, left+offset)
            if isinstance(cell.value, str) and cell.value.startswith("="):
                cell.value = expand_formula(cell.value, ws.title)
    return new_row


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Edit an existing .xlsx workbook.",
        epilog="Structural edits and table appends preserve workbook references; "
               "sheet renames update formulas and dependents.")
    ap.add_argument("file", help="path to .xlsx file")
    ap.add_argument("--sheet", help="target sheet (default: active)")
    ap.add_argument("--out", help="output path (default: edit in place)")
    ap.add_argument("--rename-sheet", action="append", default=[],
                    metavar="OLD:NEW")
    ap.add_argument("--copy-sheet", action="append", default=[],
                    metavar="SRC:NEW")
    ap.add_argument("--insert-rows", action="append", default=[],
                    metavar="IDX[:N]")
    ap.add_argument("--delete-rows", action="append", default=[],
                    metavar="IDX[:N]")
    ap.add_argument("--insert-cols", action="append", default=[],
                    metavar="IDX[:N]")
    ap.add_argument("--delete-cols", action="append", default=[],
                    metavar="IDX[:N]")
    ap.add_argument("--set", action="append", default=[], metavar="CELL=VALUE")
    ap.add_argument("--append", action="append", default=[], metavar="ROWJSON")
    ap.add_argument("--add-table", action="append", default=[],
                    metavar="NAME:RANGE[:STYLE]")
    ap.add_argument("--table-append", action="append", default=[],
                    metavar="NAME=ROWJSON")
    ap.add_argument("--list-tables", action="store_true",
                    help="print tables on the target sheet and exit")
    ap.add_argument("--define-name", action="append", default=[],
                    metavar="NAME=REF")
    ap.add_argument("--delete-name", action="append", default=[],
                    metavar="NAME")
    ap.add_argument("--hyperlink", action="append", default=[],
                    metavar="CELL=URL[|TEXT]")
    ap.add_argument("--note", action="append", default=[],
                    metavar="CELL=TEXT[|AUTHOR]")
    ap.add_argument("--clear-note", action="append", default=[],
                    metavar="CELL")
    ap.add_argument("--protect", nargs="?", const="", metavar="PASSWORD",
                    help="protect the target sheet (integrity signal only, "
                    "NOT security)")
    ap.add_argument("--unlock", action="append", default=[], metavar="RANGE",
                    help="cell range left editable under --protect")
    ap.add_argument("--recalc", action="store_true",
                    help="force full recalculation when the file is opened")
    args = ap.parse_args(argv)

    wb = load_workbook(args.file, rich_text=True)
    selected_ws = wb[args.sheet] if args.sheet and args.sheet in wb.sheetnames else None
    changes = []

    for pair in args.rename_sheet:
        old, new = pair.split(":", 1)
        actual = rename_sheet(wb, old, new)
        changes.append(f"rename {old}->{actual}")
    for pair in args.copy_sheet:
        src, new = pair.split(":", 1)
        copied = copy_sheet(wb, src, new)
        changes.append(f"copy {src}->{copied.title}")

    ws = selected_ws or (wb[args.sheet] if args.sheet else wb.active)

    if args.list_tables:
        print(json.dumps({"ok": True, "sheet": ws.title,
                          "tables": {t.displayName: {
                              "ref": t.ref,
                              "style": t.tableStyleInfo.name
                              if t.tableStyleInfo else None}
                              for t in ws.tables.values()}},
                         ensure_ascii=False))
        return 0

    from xlsx_restructure import restructure_workbook

    for arg in args.insert_rows:
        idx, n = parse_idx(arg)
        restructure_workbook(wb, ws, "rows", idx, n, False)
        changes.append(f"insert_rows {idx}x{n}")
    for arg in args.delete_rows:
        idx, n = parse_idx(arg)
        restructure_workbook(wb, ws, "rows", idx, n, True)
        changes.append(f"delete_rows {idx}x{n}")
    for arg in args.insert_cols:
        idx, n = parse_idx(arg)
        restructure_workbook(wb, ws, "cols", idx, n, False)
        changes.append(f"insert_cols {idx}x{n}")
    for arg in args.delete_cols:
        idx, n = parse_idx(arg)
        restructure_workbook(wb, ws, "cols", idx, n, True)
        changes.append(f"delete_cols {idx}x{n}")

    for assignment in args.set:
        coord, raw = assignment.split("=", 1)
        ws[coord] = infer(raw)
        changes.append(f"set {coord}")
    for row_json in args.append:
        ws.append(json.loads(row_json))
        changes.append(f"append row {ws.max_row}")

    for spec in args.add_table:
        add_table(ws, spec)
        changes.append(f"add_table {spec.split(':')[0]}")
    for spec in args.table_append:
        name, row_json = spec.split("=", 1)
        table_append(ws, name, json.loads(row_json))
        changes.append(f"table_append {name} -> {ws.tables[name].ref}")

    for spec in args.define_name:
        name, ref = spec.split("=", 1)
        wb.defined_names[name] = DefinedName(name, attr_text=ref)
        changes.append(f"define_name {name}")
    for name in args.delete_name:
        del wb.defined_names[name]
        changes.append(f"delete_name {name}")

    for spec in args.hyperlink:
        coord, rest = spec.split("=", 1)
        url, _, text = rest.partition("|")
        cell = ws[coord]
        cell.hyperlink = url
        cell.value = text or (cell.value if cell.value is not None else url)
        cell.style = "Hyperlink"
        changes.append(f"hyperlink {coord}")
    for spec in args.note:
        coord, rest = spec.split("=", 1)
        text, _, author = rest.partition("|")
        ws[coord].comment = Comment(text, author or "xlsx-skill")
        changes.append(f"note {coord}")
    for coord in args.clear_note:
        ws[coord].comment = None
        changes.append(f"clear_note {coord}")

    if args.protect is not None:
        for rng in args.unlock:
            for row in ws[rng]:
                for cell in row:
                    cell.protection = Protection(locked=False)
        if args.protect:
            ws.protection.password = args.protect
        ws.protection.sheet = True
        changes.append(f"protect {ws.title}"
                       + (f" (unlocked {len(args.unlock)} ranges)"
                          if args.unlock else ""))

    if args.recalc:
        if wb.calculation is None: wb.calculation = CalcProperties()
        wb.calculation.fullCalcOnLoad = True
        changes.append("fullCalcOnLoad")

    out = args.out or args.file
    wb.save(out)
    print(json.dumps({"ok": True, "output": out, "sheet": ws.title,
                      "changes": changes}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
