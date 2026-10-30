#!/usr/bin/env python3
"""Merge multiple PDFs into one, optionally adding a bookmark per source file."""
from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Merge PDFs (pypdf).")
    parser.add_argument("inputs", nargs="+", help="Input PDF paths, in order")
    parser.add_argument("-o", "--output", required=True, help="Output PDF path")
    parser.add_argument("--bookmarks", action="store_true",
                        help="Add a top-level bookmark per input file (its basename)")
    parser.add_argument("--duplicate-fields", choices=("rename", "error"), default="rename",
                        help="Namespace later colliding form fields as source_N.name (default), or fail")
    args = parser.parse_args()

    try:
        from pypdf import PdfReader
        from pdf_assembly import FormAssembler
    except ImportError:
        print("Required Qubicl PDF dependency is unavailable: pypdf", file=sys.stderr)
        return 2

    assembly = FormAssembler(args.duplicate_fields)
    total = 0
    for path in args.inputs:
        reader = PdfReader(path)
        if reader.is_encrypted:
            print(f"Error: {path} is encrypted; decrypt it first with pdf_secure.py --decrypt", file=sys.stderr)
            return 3
        assembly.append(reader, bookmark=os.path.splitext(os.path.basename(path))[0] if args.bookmarks else None)
        total += len(reader.pages)
    details = assembly.save(args.output)
    print(json.dumps({"output": args.output, "inputs": len(args.inputs), "page_count": total, **details}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
