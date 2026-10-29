#!/usr/bin/env python3
# MIT-licensed helper adapted for Qubicl's native DOCX skill.
"""Inspect and resolve tracked changes throughout a .docx package.

Subcommands:
  list        JSON list of revisions: id, author, date, type, text
  accept-all  accept every tracked revision
  reject-all  reject every tracked revision
  accept      accept one revision by --id
  reject      reject one revision by --id

Examples:
  docx_revisions.py list report.docx
  docx_revisions.py accept-all report.docx -o accepted.docx
  docx_revisions.py reject report.docx --id 3 -o out.docx

Final/original projection handles insertion, deletion and movement of content,
paragraph marks, rows/cells, property snapshots and related document stories.
The reader uses the same engine without saving a modified file. --part scopes
an ID to one package part when revision IDs are reused across stories.
"""
from __future__ import annotations

import argparse
import json
import sys
import os
import tempfile
from pathlib import Path
from docx_revision_view import project_package, package_records, project_root, revision_elements, q


def resolve(doc, accept: bool, rev_id: str | None = None) -> int:
    """Project loaded package parts too, retaining the legacy in-memory helper API."""
    count = 0
    from lxml import etree
    for part in doc.part.package.parts:
        if not str(part.partname).startswith('/word/') or not str(part.partname).endswith('.xml'): continue
        root = getattr(part, '_element', None)
        if root is None:
            root = etree.fromstring(part.blob, etree.XMLParser(resolve_entities=False, no_network=True))
        selected = [node for node in revision_elements(root) if rev_id is None or node.get(q('id')) == rev_id]
        if not selected: continue
        count += len(selected)
        projected = project_root(root, accept, rev_id)
        if hasattr(part, '_element'):
            root.attrib.clear(); root.attrib.update(projected.attrib)
            for child in list(root): root.remove(child)
            root.extend(list(projected))
        else:
            part._blob = etree.tostring(projected, encoding='UTF-8', xml_declaration=True, standalone=True)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(
        description="List, accept, or reject tracked changes in a .docx.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, out=True):
        p.add_argument("path", help="input .docx")
        if out:
            p.add_argument("-o", "--output",
                           help="output path (default: overwrite input)")

    common(sub.add_parser("list", help="list revisions as JSON"), out=False)
    common(sub.add_parser("accept-all", help="accept every revision"))
    common(sub.add_parser("reject-all", help="reject every revision"))
    for name in ("accept", "reject"):
        p = sub.add_parser(name, help=f"{name} one revision by id")
        common(p)
        p.add_argument("--id", required=True, help="revision id (w:id)")
        p.add_argument("--part", help="optional package part, e.g. word/document.xml")

    args = ap.parse_args()
    records = package_records(args.path)
    if args.cmd == "list":
        print(json.dumps({"ok": True, "revisions": records}, ensure_ascii=False))
        return 0

    accept = args.cmd in ("accept-all", "accept")
    rev_id = getattr(args, "id", None)
    part = getattr(args, "part", None)
    selected = [record for record in records if (rev_id is None or record["id"] == rev_id) and (part is None or record["part"] == part)]
    n = len(selected)
    if rev_id is not None and n == 0:
        print(json.dumps({"ok": False, "error": f"no revision with id {rev_id}"}))
        return 1
    data = project_package(args.path, accept, rev_id, part)
    out = args.output or args.path
    destination = Path(out).resolve()
    descriptor, temporary = tempfile.mkstemp(prefix='.qubicl-revisions-', suffix='.docx', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    print(json.dumps({"ok": True, "output": out, "resolved": n,
                      "action": "accept" if accept else "reject"},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
