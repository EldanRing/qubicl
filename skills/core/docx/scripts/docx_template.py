#!/usr/bin/env python3
# MIT-licensed helper adapted for Qubicl's native DOCX skill.
"""Fill {{placeholder}} tokens in a .docx from a JSON mapping.

Tokens are replaced everywhere: body paragraphs, tables (including nested
tables), headers and footers. Run formatting is preserved; tokens split
across runs are handled. Replacement values are literal and substituted once
into original token spans; inserted {{tokens}} are not expanded recursively.

Usage:
  docx_template.py template.docx values.json output.docx
  docx_template.py template.docx values.json output.docx --strict

values.json: {"name": "Ada", "date": "2026-01-01"}  fills {{name}}, {{date}}.
With --strict, exits 1 if any original {{token}} has no supplied value.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

from docx import Document

from docx_common import iter_all_paragraphs, replace_matches_in_paragraph

TOKEN_RE = re.compile(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fill {{token}} placeholders in a .docx from JSON.")
    ap.add_argument("template", help="input .docx with {{tokens}}")
    ap.add_argument("values", help="JSON file of token -> value")
    ap.add_argument("output", help="output .docx path")
    ap.add_argument("--strict", action="store_true",
                    help="fail if an original template token has no supplied value")
    args = ap.parse_args()

    with open(args.values, encoding="utf-8") as f:
        values = json.load(f)
    if not isinstance(values, dict):
        raise ValueError("Template values must be a JSON object")

    doc = Document(args.template)
    filled = {}
    remaining = set()
    def replacement(match):
        name = match.group(1)
        if name not in values:
            remaining.add(name)
            return match.group(0)
        filled[name] = filled.get(name, 0) + 1
        return str(values[name])
    for para in iter_all_paragraphs(doc):
        replace_matches_in_paragraph(para, TOKEN_RE, replacement)
    remaining = sorted(remaining)
    result = {"ok": True, "output": args.output, "filled": filled,
              "unfilled_tokens": remaining, "replacement_mode": "literal_single_pass"}
    if args.strict and remaining:
        result["ok"] = False
        result["output_written"] = False
        print(json.dumps(result, ensure_ascii=False))
        return 1
    doc.save(args.output)
    result["output_written"] = True
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
