#!/usr/bin/env python3
"""Reference-aware row/column insert and delete for .xlsx workbooks.

Unlike plain openpyxl insert_rows/delete_cols, this script also rewrites
workbook dependents. xlsx_edit.py shares the same structural implementation:


  * formula references in ALL sheets, including absolute refs ($B$2),
    ranges (B2:B9), and cross-sheet refs ('My Sheet'!A1 / Data!$B$8).
    References into a deleted region become #REF!.
  * merged-cell ranges (shifted; expanded when they span the insertion
    point; removed when fully deleted)
  * autofilter, freeze panes, validation and conditional-format ranges/formulas
  * native table schemas, filters, calculated/totals formulas and structured refs
  * workbook and sheet-local defined names, print areas and titles
  * chart sources/caches and chart/image anchors
  * row heights / column widths

It prints a JSON report of the changes. Full rewrite rules:
references/restructuring.md.

One structural operation per invocation:

Usage:
  xlsx_restructure.py book.xlsx --sheet Data --insert-rows 3:2
  xlsx_restructure.py book.xlsx --sheet Data --delete-rows 5
  xlsx_restructure.py book.xlsx --sheet Data --insert-cols B:1 --out new.xlsx
  xlsx_restructure.py book.xlsx --sheet Data --delete-cols 4:2
"""
from __future__ import annotations

import argparse
from copy import copy
from dataclasses import dataclass
import json
import re
import sys

from openpyxl import load_workbook
from openpyxl.worksheet.table import TableColumn
from openpyxl.utils import (column_index_from_string, get_column_letter,
                            range_boundaries)

# A1-style reference, optionally sheet-qualified, optionally a range.
# Guards: not preceded by a word char/$/. (avoids ABC123 identifiers) and
# not followed by a word char or "(" (avoids function names like LOG10().
REF_RE = re.compile(
    r"(?<![\w$.:])"
    r"(?P<sheet>(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?"
    r"(?P<start>\$?[A-Za-z]{1,3}\$?[0-9]{1,7})"
    r"(?::(?P<end>\$?[A-Za-z]{1,3}\$?[0-9]{1,7}))?"
    r"(?![\w(])")
COORD_RE = re.compile(r"^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$")


def shift_point(v, idx, n, delete):
    """New 1-based index for a single row/col, or None if deleted."""
    if delete:
        if v < idx:
            return v
        if v >= idx + n:
            return v - n
        return None
    return v + n if v >= idx else v


def shift_span(a, b, idx, n, delete):
    """New (start, end) for an inclusive span, or None if fully deleted."""
    if delete:
        na = a if a < idx else (a - n if a >= idx + n else idx)
        nb = b if b < idx else (b - n if b >= idx + n else idx - 1)
        return None if na > nb else (na, nb)
    return (a + n if a >= idx else a, b + n if b >= idx else b)


def shift_range(rng, axis, idx, n, delete):
    """Shift an A1 range string (no sheet prefix). None = fully deleted."""
    min_col, min_row, max_col, max_row = range_boundaries(rng)
    if axis == "rows":
        span = shift_span(min_row, max_row, idx, n, delete)
        if span is None:
            return None
        min_row, max_row = span
    else:
        span = shift_span(min_col, max_col, idx, n, delete)
        if span is None:
            return None
        min_col, max_col = span
    start = f"{get_column_letter(min_col)}{min_row}"
    end = f"{get_column_letter(max_col)}{max_row}"
    return start if start == end and ":" not in rng else f"{start}:{end}"


def shift_sort_state(state, axis, idx, n, delete):
    if state is None:
        return None
    shifted = shift_range(state.ref, axis, idx, n, delete)
    if shifted is None:
        return None
    state.ref = shifted
    conditions = []
    for condition in state.sortCondition:
        shifted = shift_range(condition.ref, axis, idx, n, delete)
        if shifted is not None:
            condition.ref = shifted
            conditions.append(condition)
    state.sortCondition = conditions
    return state


def shift_auto_filter(auto_filter, axis, idx, n, delete):
    if auto_filter is None or not auto_filter.ref:
        return
    previous = auto_filter.ref
    updated = shift_range(previous, axis, idx, n, delete)
    auto_filter.ref = updated
    if updated is None:
        auto_filter.filterColumn = []
        auto_filter.sortState = None
        return
    if axis == "cols":
        old_left, _, _, _ = range_boundaries(previous)
        new_left, _, _, _ = range_boundaries(updated)
        columns = []
        for column in auto_filter.filterColumn:
            absolute = shift_point(old_left + column.colId, idx, n, delete)
            if absolute is not None:
                column.colId = absolute - new_left
                columns.append(column)
        auto_filter.filterColumn = columns
    auto_filter.sortState = shift_sort_state(auto_filter.sortState, axis, idx, n, delete)


@dataclass
class TableChange:
    name: str
    sheet: str
    old_ref: str
    new_ref: str | None
    original: list
    surviving: list
    columns: list
    inserted: list
    header_count: int = 1
    removed_header: bool = False
    removed_totals: bool = False


def plan_table_changes(ws, axis, idx, n, delete):
    changes = {}
    for table in ws.tables.values():
        left, top, right, bottom = range_boundaries(table.ref)
        columns = list(table.tableColumns)
        if len(columns) != right - left + 1:
            raise ValueError(f"Table {table.name} has inconsistent column metadata")
        new_ref = shift_range(table.ref, axis, idx, n, delete)
        surviving = [column for position, column in enumerate(columns, left)
                     if axis != "cols" or shift_point(position, idx, n, delete) is not None]
        updated = list(surviving)
        inserted = []
        if axis == "cols" and not delete and left < idx <= right:
            used = {column.name.casefold() for column in columns}
            next_id = max((column.id for column in columns), default=0) + 1
            for offset in range(n):
                suffix = 1
                while f"Column{suffix}".casefold() in used:
                    suffix += 1
                name = f"Column{suffix}"
                used.add(name.casefold())
                column = TableColumn(id=next_id + offset, name=name)
                neighbor = columns[max(0, idx - left - 1)]
                for attr in ("headerRowDxfId", "dataDxfId", "totalsRowDxfId",
                             "headerRowCellStyle", "dataCellStyle", "totalsRowCellStyle"):
                    setattr(column, attr, getattr(neighbor, attr))
                inserted.append((idx + offset, column))
            updated[idx-left:idx-left] = [column for _, column in inserted]
        change = TableChange(
            table.name, ws.title, table.ref, new_ref, columns, surviving, updated, inserted, int(bool(table.headerRowCount)),
            axis == "rows" and delete and bool(table.headerRowCount) and idx <= top < idx+n,
            axis == "rows" and delete and bool(table.totalsRowCount) and idx <= bottom < idx+n)
        changes[table.name.casefold()] = change
        changes[table.displayName.casefold()] = change
    return changes


def structured_leaves(value):
    """Locate column selectors while honoring Excel's apostrophe escaping."""
    stack, leaves = [], []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "'" and index + 1 < len(value) and value[index+1] in "[]#@'":
            index += 2
            continue
        if char == "[":
            if stack: stack[-1][1] = True
            stack.append([index + 1, False])
        elif char == "]" and stack:
            start, nested = stack.pop()
            if not nested: leaves.append((start, index, value[start:index]))
        index += 1
    return leaves


def column_name(selector):
    row_prefix = "@" if selector.startswith("@") else ""
    raw = selector[len(row_prefix):]
    if raw.startswith("#") or not raw:
        return None, row_prefix
    return re.sub(r"'([\[\]#@'])", r"\1", raw), row_prefix


def escape_column(name):
    return re.sub(r"([\[\]#@'])", r"'\1", name)


def rewrite_structured(value, changes, home_table=None):
    if "[" not in value:
        change = changes.get(value.casefold())
        return "#REF!" if change and change.new_ref is None else value
    prefix, body = value.split("[", 1)
    # A qualifier outside brackets belongs to a sheet/workbook, whereas ! is
    # also a valid character in a table header. Do not confuse those cases.
    depth, index = 0, 0
    while index < len(value):
        char = value[index]
        if depth and char == "'" and index + 1 < len(value) and value[index+1] in "[]#@'":
            index += 2
            continue
        if char == "[": depth += 1
        elif char == "]": depth -= 1
        elif char == "!" and depth == 0: return value
        index += 1
    if not prefix and not home_table:
        return value
    name = prefix or home_table
    change = changes.get(name.casefold())
    if not change:
        return value
    if change.new_ref is None:
        return "#REF!"
    body = "[" + body
    original = {column.name.casefold(): index for index, column in enumerate(change.original)}
    survivors = {column.name.casefold() for column in change.surviving}
    leaves = structured_leaves(body)
    edits, paired = [], set()
    for i, (start, end, raw) in enumerate(leaves[:-1]):
        next_start, next_end, next_raw = leaves[i+1]
        if not re.fullmatch(r"\]\s*:\s*\[", body[end:next_start]):
            continue
        first, row_prefix = column_name(raw)
        last, last_prefix = column_name(next_raw)
        if first is None or last is None or first.casefold() not in original or last.casefold() not in original:
            continue
        lo, hi = sorted((original[first.casefold()], original[last.casefold()]))
        kept = [column.name for column in change.original[lo:hi+1] if column.name.casefold() in survivors]
        if not kept:
            return "#REF!"
        if original[first.casefold()] > original[last.casefold()]: kept.reverse()
        edits.extend([(start, end, raw if first.casefold() in survivors else row_prefix + escape_column(kept[0])),
                      (next_start, next_end, next_raw if last.casefold() in survivors else last_prefix + escape_column(kept[-1]))])
        paired.update((i, i+1))
    for i, (_, _, raw) in enumerate(leaves):
        if i in paired: continue
        name, _ = column_name(raw)
        if name is not None and name.casefold() in original and name.casefold() not in survivors:
            return "#REF!"
    for start, end, replacement in sorted(edits, reverse=True):
        body = body[:start] + replacement + body[end:]
    return prefix + body


def apply_table_change(ws, table, change, axis, idx, n, delete):
    if change.new_ref is None:
        del ws.tables[table.name]
        return
    table.ref = change.new_ref
    table.tableColumns = change.columns
    shift_auto_filter(table.autoFilter, axis, idx, n, delete)
    table.sortState = shift_sort_state(table.sortState, axis, idx, n, delete)
    if change.removed_header:
        # Removing a worksheet header row does not turn surviving data into labels.
        table.headerRowCount = 0
        table.autoFilter = None
    if change.removed_totals:
        table.totalsRowCount = 0
        table.totalsRowShown = False
    left, top, right, bottom = range_boundaries(table.ref)
    for position, column in change.inserted:
        neighbor = position - 1 if position > left else position + len(change.inserted)
        for row in range(top, bottom + 1):
            source, destination = ws.cell(row, neighbor), ws.cell(row, position)
            destination._style = copy(source._style)
            destination.alignment = copy(source.alignment)
            destination.protection = copy(source.protection)
        if table.headerRowCount:
            ws.cell(top, position, column.name)
    old_top, old_bottom = range_boundaries(change.old_ref)[1::2]
    if axis == "rows" and not delete and old_top < idx <= old_bottom:
        first_data = top + int(bool(table.headerRowCount))
        last_data = bottom - (table.totalsRowCount or 0)
        neighbor = idx - 1 if idx > first_data else idx + n
        if first_data <= neighbor <= last_data:
            for row in range(max(idx, first_data), min(idx+n-1, last_data)+1):
                for col in range(left, right+1):
                    ws.cell(row, col)._style = copy(ws.cell(neighbor, col)._style)


def calculated_formula_at(formula, change, original_column, cell, rewriter):
    """Translate the column template, preserving exceptions in existing cells."""
    from openpyxl.formula.translate import Translator
    left, top, _, _ = range_boundaries(change.old_ref)
    origin_row = top + change.header_count
    origin_col = left + original_column
    prefix = "" if formula.startswith("=") else "="
    old_row = cell.row
    inserted = False
    if rewriter.axis == "rows":
        if rewriter.delete:
            if old_row >= rewriter.idx: old_row += rewriter.n
        elif rewriter.idx <= old_row < rewriter.idx + rewriter.n:
            old_row = origin_row
            inserted = True
        elif old_row >= rewriter.idx + rewriter.n:
            old_row -= rewriter.n
    old_origin = f"{get_column_letter(origin_col)}{origin_row}"
    old_target = f"{get_column_letter(origin_col)}{old_row}"
    translated = Translator(prefix + formula, origin=old_origin).translate_formula(old_target)
    translated = rewriter.rewrite(translated, change.sheet, change.name)
    if inserted:
        shifted_origin = f"{get_column_letter(cell.column)}{shift_point(old_row, rewriter.idx, rewriter.n, False)}"
        translated = Translator(translated, origin=shifted_origin).translate_formula(cell.coordinate)
    return translated


def table_at_cell(sheet, cell, changes):
    for table in sheet.tables.values():
        change = changes.get(table.name.casefold())
        ref = change.new_ref if change else table.ref
        if not ref: continue
        left, top, right, bottom = range_boundaries(ref)
        if left <= cell.column <= right and top <= cell.row <= bottom:
            return table.name
    return None


class RefRewriter:
    """Rewrite A1 references in formula-like text for one shift op."""

    def __init__(self, target_sheet, axis, idx, n, delete, table_changes=None):
        self.target = target_sheet.casefold()
        self.table_changes = table_changes or {}
        self.axis, self.idx, self.n, self.delete = axis, idx, n, delete

    def _shift_coord(self, coord):
        m = COORD_RE.match(coord)
        col_abs, col, row_abs, row = m.groups()
        ci, ri = column_index_from_string(col.upper()), int(row)
        if self.axis == "rows":
            ri = shift_point(ri, self.idx, self.n, self.delete)
            if ri is None:
                return None
        else:
            ci = shift_point(ci, self.idx, self.n, self.delete)
            if ci is None:
                return None
        return f"{col_abs}{get_column_letter(ci)}{row_abs}{ri}"

    def _shift_pair(self, start, end):
        """Shift a range preserving $ flags; None = collapsed to #REF!."""
        new_start = self._shift_coord(start)
        new_end = self._shift_coord(end)
        if new_start is None or new_end is None:
            # spans may survive partial deletion: clamp via span math
            s, e = COORD_RE.match(start), COORD_RE.match(end)
            if self.axis == "rows":
                first, last = int(s.group(4)), int(e.group(4))
                span = shift_span(min(first, last), max(first, last),
                                  self.idx, self.n, self.delete)
                if span is None:
                    return None
                if first > last:
                    span = span[::-1]
                new_start = f"{s.group(1)}{s.group(2)}{s.group(3)}{span[0]}"
                new_end = f"{e.group(1)}{e.group(2)}{e.group(3)}{span[1]}"
            else:
                first = column_index_from_string(s.group(2).upper())
                last = column_index_from_string(e.group(2).upper())
                span = shift_span(min(first, last), max(first, last),
                                  self.idx, self.n, self.delete)
                if span is None:
                    return None
                if first > last:
                    span = span[::-1]
                new_start = (f"{s.group(1)}{get_column_letter(span[0])}"
                             f"{s.group(3)}{s.group(4)}")
                new_end = (f"{e.group(1)}{get_column_letter(span[1])}"
                           f"{e.group(3)}{e.group(4)}")
        return new_start, new_end

    def _sub(self, match, home_sheet):
        prefix = match.group("sheet") or ""
        if prefix:
            name = prefix[:-1]
            if name.startswith("'"):
                name = name[1:-1].replace("''", "'")
            ref_sheet = name
        else:
            ref_sheet = home_sheet
        if ref_sheet.casefold() != self.target:
            return match.group(0)
        start, end = match.group("start"), match.group("end")
        # Identifiers outside Excel's grid can be valid defined names (XFE1).
        for coordinate in (start, end):
            if coordinate is not None:
                parsed = COORD_RE.match(coordinate)
                if not (1 <= column_index_from_string(parsed.group(2).upper()) <= 16384
                        and 1 <= int(parsed.group(4)) <= 1048576):
                    return match.group(0)
        if end is None:
            new = self._shift_coord(start)
            return prefix + ("#REF!" if new is None else new)
        pair = self._shift_pair(start, end)
        return (prefix + "#REF!" if pair is None
                else f"{prefix}{pair[0]}:{pair[1]}")

    def _whole_range(self, value, home_sheet):
        prefix, coordinate = value.rsplit("!", 1) if "!" in value else ("", value)
        sheet = (prefix[1:-1].replace("''", "'") if prefix.startswith("'") and prefix.endswith("'") else prefix) if prefix else home_sheet
        match = re.fullmatch(r"(\$?)([A-Za-z]{1,3}|[0-9]+):(\$?)([A-Za-z]{1,3}|[0-9]+)", coordinate)
        if not match: return None
        if sheet.casefold() != self.target: return value
        a_abs, a, b_abs, b = match.groups()
        if a.isalpha() != b.isalpha(): return None
        if (a.isalpha() and self.axis != "cols") or (a.isdigit() and self.axis != "rows"):
            return value
        convert = column_index_from_string if a.isalpha() else int
        first, last = convert(a.upper()), convert(b.upper())
        maximum = 16384 if a.isalpha() else 1048576
        if not (1 <= first <= maximum and 1 <= last <= maximum):
            return value
        reverse = first > last
        shifted = shift_span(min(first,last), max(first,last), self.idx, self.n, self.delete)
        qualifier = prefix + "!" if prefix else ""
        if shifted is None: return qualifier + "#REF!"
        first, last = shifted[::-1] if reverse else shifted
        if a.isalpha(): first, last = get_column_letter(first), get_column_letter(last)
        return f"{qualifier}{a_abs}{first}:{b_abs}{last}"

    def rewrite(self, text, home_sheet, home_table=None):
        """Rewrite parsed A1/whole-range and structured selectors, preserving strings."""
        from openpyxl.formula.tokenizer import Tokenizer
        prefix = "" if text.startswith("=") else "="
        tokens = Tokenizer(prefix + text).items
        out = []
        for token in tokens:
            value = token.value
            if token.subtype == "RANGE":
                value = rewrite_structured(value, self.table_changes, home_table)
                if "[" not in value:
                    whole = self._whole_range(value, home_sheet)
                    value = whole if whole is not None else REF_RE.sub(lambda m: self._sub(m, home_sheet), value)
            out.append(value)
        return ("=" if not prefix else "") + "".join(out)


def shift_dimensions(dims, idx, n, delete, is_row):
    """Rebuild a row/column dimensions map with shifted keys."""
    items = list(dims.items())
    dims.clear()
    changed = 0
    for key, dim in items:
        pos = key if is_row else column_index_from_string(key)
        span = shift_span(pos if is_row else (dim.min or pos), pos if is_row else (dim.max or pos), idx, n, delete)
        if span is None:
            changed += 1
            continue
        new, end = span
        dim.index = new if is_row else get_column_letter(new)
        if not is_row:
            dim.min, dim.max = new, end
        dims[dim.index] = dim
        changed += int(new != pos)
    return changed


def restructure_workbook(wb, ws, axis, idx, n, delete):
    """Apply a structural edit in memory; shared by both spreadsheet CLIs."""
    from xlsx_restructure_dependents import snapshot_dependents, apply_dependents
    if axis not in ("rows", "cols") or idx < 1 or n < 1:
        raise ValueError("Structural axis, index and count must be valid and positive")
    dependents = snapshot_dependents(wb)
    table_changes = plan_table_changes(ws, axis, idx, n, delete)
    rewriter = RefRewriter(ws.title, axis, idx, n, delete, table_changes)
    report = {"ok": True, "sheet": ws.title, "axis": axis,
              "op": "delete" if delete else "insert", "index": idx, "count": n,
              "formulas": [], "merges": [], "tables": {}, "defined_names": {},
              "validations": [], "conditional_formats": [], "not_shifted": []}

    # 1. capture merge ranges (openpyxl does not move them), then unmerge
    old_merges = [str(r) for r in list(ws.merged_cells.ranges)]
    for rng in old_merges:
        ws.unmerge_cells(rng)

    # 2. structural move of cell values/styles/comments
    getattr(ws, f"{report['op']}_{axis}")(idx, n)

    # 3. formulas everywhere
    for sheet in wb.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    new = rewriter.rewrite(cell.value, sheet.title, table_at_cell(sheet, cell, table_changes))
                    if new != cell.value:
                        report["formulas"].append(
                            {"sheet": sheet.title, "cell": cell.coordinate,
                             "from": cell.value, "to": new})
                        cell.value = new

    # 4. merges back, shifted
    for rng in old_merges:
        new = shift_range(rng, axis, idx, n, delete)
        if new is None:
            report["merges"].append({"from": rng, "to": None})
        else:
            ws.merge_cells(new)
            if new != rng:
                report["merges"].append({"from": rng, "to": new})

    # 5. autofilter + freeze panes
    if ws.auto_filter.ref:
        new = shift_range(ws.auto_filter.ref, axis, idx, n, delete)
        if new != ws.auto_filter.ref:
            report["autofilter"] = {"from": ws.auto_filter.ref, "to": new}
        shift_auto_filter(ws.auto_filter, axis, idx, n, delete)
    if ws.freeze_panes:
        m = COORD_RE.match(ws.freeze_panes)
        ci = column_index_from_string(m.group(2).upper())
        ri = int(m.group(4))
        if axis == "rows":
            ri = shift_point(ri, idx, n, delete) or max(idx, 2)
        else:
            ci = shift_point(ci, idx, n, delete) or max(idx, 2)
        new = f"{get_column_letter(ci)}{ri}"
        if new != ws.freeze_panes:
            report["freeze_panes"] = {"from": ws.freeze_panes, "to": new}
            ws.freeze_panes = new

    # 6. table schemas, independent column metadata and structured formulas
    for table in list(ws.tables.values()):
        change = table_changes[table.name.casefold()]
        apply_table_change(ws, table, change, axis, idx, n, delete)
        if change.old_ref != change.new_ref or change.inserted or len(change.surviving) != len(change.original):
            report["tables"][table.displayName] = {
                "from": change.old_ref, "to": change.new_ref,
                "columns": [{"id": column.id, "name": column.name} for column in change.columns] if change.new_ref else [],
                "insertedColumns": [column.name for _, column in change.inserted],
                "deletedColumns": [column.name for column in change.original if column not in change.surviving],
                "headerRemoved": change.removed_header, "totalsRemoved": change.removed_totals,
            }
    for sheet in wb.worksheets:
        for table in sheet.tables.values():
            change = table_changes.get(table.name.casefold())
            left, top, right, bottom = range_boundaries(table.ref)
            first_data, last_data = top + int(bool(table.headerRowCount)), bottom - (table.totalsRowCount or 0)
            for offset, column in enumerate(table.tableColumns):
                formula = column.calculatedColumnFormula
                if formula is not None and formula.attr_text:
                    original = formula.attr_text
                    if change and column in change.original and first_data <= last_data:
                        original_column = change.original.index(column)
                        normalized = calculated_formula_at(original, change, original_column, sheet.cell(first_data,left+offset), rewriter)
                        formula.attr_text = normalized if original.startswith("=") else normalized[1:]
                        old_top, old_bottom = range_boundaries(change.old_ref)[1::2]
                        if axis == "rows" and not delete and old_top < idx <= old_bottom:
                            for row in range(max(idx,first_data), min(idx+n-1,last_data)+1):
                                cell = sheet.cell(row,left+offset)
                                cell.value = calculated_formula_at(original, change, original_column, cell, rewriter)
                    else:
                        formula.attr_text = rewriter.rewrite(original,sheet.title,table.name)
                formula = column.totalsRowFormula
                if formula is not None and formula.attr_text:
                    formula.attr_text = rewriter.rewrite(formula.attr_text,sheet.title,table.name)

    # 7. workbook-scope defined names
    for name, dn in wb.defined_names.items():
        if dn.attr_text:
            new = rewriter.rewrite(dn.attr_text, ws.title)
            if new != dn.attr_text:
                report["defined_names"][name] = {"from": dn.attr_text,
                                                 "to": new}
                dn.attr_text = new

    # 8. row heights / column widths
    if axis == "rows":
        shift_dimensions(ws.row_dimensions, idx, n, delete, is_row=True)
    else:
        shift_dimensions(ws.column_dimensions, idx, n, delete, is_row=False)

    # 9. Other dependents use original applied-range origins and current cells.
    report.update(apply_dependents(wb, dependents, ws, axis, idx, n, delete,
                                   rewriter.rewrite, shift_point, shift_range))

    return report


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Insert/delete rows or columns AND rewrite formula "
                    "references, merges, filters, validations, tables, and "
                    "defined names to match.",
        epilog="Includes table schemas, chart/image anchors, chart sources, "
               "and validation/conditional-format formulas. See references/restructuring.md.")
    ap.add_argument("file", help="path to .xlsx file")
    ap.add_argument("--sheet", help="target sheet (default: active)")
    ap.add_argument("--out", help="output path (default: edit in place)")
    op = ap.add_mutually_exclusive_group(required=True)
    op.add_argument("--insert-rows", metavar="IDX[:N]")
    op.add_argument("--delete-rows", metavar="IDX[:N]")
    op.add_argument("--insert-cols", metavar="COL[:N]",
                    help="COL is a letter (B) or 1-based number")
    op.add_argument("--delete-cols", metavar="COL[:N]")
    args = ap.parse_args(argv)

    raw = (args.insert_rows or args.delete_rows
           or args.insert_cols or args.delete_cols)
    idx_s, _, n_s = raw.partition(":")
    n = int(n_s) if n_s else 1
    axis = "rows" if (args.insert_rows or args.delete_rows) else "cols"
    delete = bool(args.delete_rows or args.delete_cols)
    if axis == "cols" and idx_s.isalpha():
        idx = column_index_from_string(idx_s.upper())
    else:
        idx = int(idx_s)

    if idx < 1 or n < 1:
        raise ValueError("Structural index and count must be positive")

    wb = load_workbook(args.file)
    ws = wb[args.sheet] if args.sheet else wb.active
    report = restructure_workbook(wb, ws, axis, idx, n, delete)

    out = args.out or args.file
    wb.save(out)
    report["output"] = out
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
