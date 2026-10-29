#!/usr/bin/env python3
"""Recalculate a workbook's formulas headlessly with LibreOffice.

openpyxl never computes formulas. This script shells out to `soffice`
(LibreOffice) to open the workbook, recalculate, and re-save it, so
cached formula results become available to `xlsx_read.py --data-only`
and `--formulas`.

Behavior:
  * soffice on PATH: converts the file to .xlsx in a temp dir (which
    recalculates all formulas) and replaces the original (or writes
    --out). Prints {"recalculated": true, ...} and exits 0.
  * soffice absent: prints {"recalculated": false, "reason": ...} with
    Qubicl preset guidance and STILL exits 0 — callers can branch on the JSON
    instead of the exit code.

Note: LibreOffice recalculates .xlsx on load per its default
calculation settings; conversion re-saves with fresh cached values.

Usage:
  xlsx_recalc.py book.xlsx
  xlsx_recalc.py book.xlsx --out recalced.xlsx
  xlsx_recalc.py book.xlsx --timeout 120
"""
from __future__ import annotations

import argparse
import os
import runpy
import json
import shutil
import sys
import tempfile
from pathlib import Path


def artifact_helpers():
    return runpy.run_path(os.environ.get('QUBICL_ARTIFACT_RENDERER', '/opt/qubicl/artifact-render.py'))


def count_cached(path):
    result = artifact_helpers()['workbook_validation'](path)
    return result['formulaCells'], result['withCachedValues']


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Recalculate .xlsx formulas headlessly via LibreOffice.")
    ap.add_argument("file", help="path to .xlsx file")
    ap.add_argument("--out", help="output path (default: replace input)")
    ap.add_argument("--timeout", type=int, default=180,
                    help="seconds to wait for soffice (default 180)")
    args = ap.parse_args(argv)

    src = Path(args.file).resolve()
    if not src.exists():
        print(json.dumps({"ok": False, "error": f"no such file: {src}"}),
              file=sys.stderr)
        return 1

    soffice = shutil.which("soffice")
    if not soffice:
        print(json.dumps({
            "ok": True, "recalculated": False,
            "reason": "LibreOffice (soffice) not found on PATH",
            "guidance": "Formula recalculation is supported by the Qubicl "
                        "workstation preset. Use that preset or ask the user "
                        "to open and re-save the workbook in an office app.",
        }, ensure_ascii=False))
        return 0

    helper = artifact_helpers()
    with tempfile.TemporaryDirectory() as tmp:
        captured = Path(tmp) / 'source.xlsx'
        shutil.copyfile(src, captured)
        source_hash = helper['sha256'](captured)
        produced = helper['convert_office'](captured, Path(tmp) / 'converted', 'xlsx:Calc MS Excel 2007 XML', args.timeout)
        validation = helper['workbook_validation'](produced)
        validation.update(helper['workbook_changes'](captured, produced))
        dest = Path(args.out).resolve() if args.out else src
        # Do not overwrite an input changed by another editor during conversion.
        if dest == src and helper['sha256'](src) != source_hash:
            raise RuntimeError('Source workbook changed during recalculation; original preserved')
        with tempfile.NamedTemporaryFile(prefix='.qubicl-recalc-', dir=dest.parent, delete=False) as staged:
            staged_path = Path(staged.name)
        try:
            shutil.copyfile(produced, staged_path)
            os.replace(staged_path, dest)
        finally:
            staged_path.unlink(missing_ok=True)

    print(json.dumps({
        "ok": True, "recalculated": True, "output": str(dest),
        "formula_cells": validation["formulaCells"], "with_cached_values": validation["withCachedValues"],
        "sourceSha256": source_hash, "outputSha256": helper["sha256"](dest),
        "validation": validation,
        "warnings": ["Recalculated does not mean error-free or faithful to Excel. Review formulaErrors, missingFormulaResults and changedPackageParts; inspect rendered pages."],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
