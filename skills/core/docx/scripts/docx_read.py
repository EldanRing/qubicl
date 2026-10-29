#!/usr/bin/env python3
# MIT-licensed helper adapted for Qubicl's native DOCX skill.
"""Read a .docx: text, structure outline, styles, images, revision detection.

Usage:
  docx_read.py file.docx --text        # full text incl. tables + headers/footers
  docx_read.py file.docx --structure   # JSON outline (headings, tables, counts)
  docx_read.py file.docx --styles      # JSON list of styles actually used
  docx_read.py file.docx --images DIR  # extract embedded images into DIR
  docx_read.py file.docx --revisions   # JSON: tracked changes / comments present?

Text output is JSON: {"body": [...], "tables": [[...rows]], "headers": [...],
"footers": [...]}, plus ordered blocks and related stories. --mode final (default)
accepts revisions in memory; original rejects them; markup returns both views and
anchored revision records. The source file is never modified by reading.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from io import BytesIO
from docx_revision_view import project_package, read_projected, package_records, CHANGES, parse, q, select_alternative_content

from docx import Document


def extract_text(doc, mode="final") -> dict:
    """Read a loaded python-docx document without changing its XML or saving it."""
    package = BytesIO()
    doc.save(package)
    return read_view(package, mode)


def extract_structure(doc, mode="final") -> dict:
    view = extract_text(doc, mode)
    if mode == "markup":
        return {**view, "final": view_structure(view["final"]), "original": view_structure(view["original"])}
    return view_structure(view)


def _projected_styles(package_bytes) -> list:
    from docx.enum.style import WD_STYLE_TYPE
    doc = Document(BytesIO(package_bytes))
    view = read_projected(package_bytes)
    selected = {'word/document.xml': None}
    for key in ('headerStories', 'footerStories'):
        selected.update({story['part']: None for story in view[key]})
    for key in ('footnotes', 'endnotes', 'comments'):
        for story in view[key]: selected.setdefault(story['part'], set()).add(story['id'])
    names = {style.style_id: style.name for style in doc.styles}
    defaults = {tag: doc.styles.default(kind) for tag, kind in
                [('p', WD_STYLE_TYPE.PARAGRAPH), ('r', WD_STYLE_TYPE.CHARACTER), ('tbl', WD_STYLE_TYPE.TABLE)]}
    properties = {'p': ('pPr', 'pStyle'), 'r': ('rPr', 'rStyle'), 'tbl': ('tblPr', 'tblStyle')}
    used = set()
    with zipfile.ZipFile(BytesIO(package_bytes)) as package:
        for name, identifiers in selected.items():
            root = select_alternative_content(parse(package.read(name)))
            if identifiers is not None:
                for child in list(root):
                    if child.get(q('id')) not in identifiers: root.remove(child)
            for tag, (props, style_tag) in properties.items():
                for node in root.iter(q(tag)):
                    style = node.find(q(props) + '/' + q(style_tag))
                    if style is not None:
                        identifier = style.get(q('val')); used.add(names.get(identifier, identifier))
                    elif defaults[tag] is not None:
                        used.add(defaults[tag].name)
    return sorted(used)


def styles_used(doc, mode="final") -> list:
    """Styles in the selected revision view, including all referenced stories."""
    if mode not in {'final', 'original'}: raise ValueError('style mode must be final or original')
    package = BytesIO(); doc.save(package)
    return _projected_styles(project_package(package, mode == 'final'))


def extract_images(path: str, outdir: str) -> list:
    os.makedirs(outdir, exist_ok=True)
    written = []
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if name.startswith("word/media/"):
                target = os.path.join(outdir, os.path.basename(name))
                with open(target, "wb") as f:
                    f.write(zf.read(name))
                written.append(target)
    return written


def detect_revisions(path: str) -> dict:
    records = package_records(path)
    with zipfile.ZipFile(path) as package:
        comments = any(name.startswith("word/comments") for name in package.namelist())
        if 'word/_rels/document.xml.rels' in package.namelist():
            comments |= any(rel.get('Type', '').endswith('/comments') for rel in parse(package.read('word/_rels/document.xml.rels')))
    return {"insertions": any(record["element"] in {"ins", "moveTo", "cellIns"} for record in records),
            "deletions": any(record["element"] in {"del", "moveFrom", "cellDel"} for record in records),
            "format_changes": any(record["element"] in CHANGES | {"cellMerge"} for record in records),
            "comments": comments, "has_tracked_changes": bool(records), "records": records}


def read_view(path, mode="final"):
    if mode not in {"final", "original", "markup"}:
        raise ValueError("mode must be final, original, or markup")
    revisions = detect_revisions(path)
    if mode == "markup":
        return {"mode": mode, "completeView": True, "revisions": revisions,
                "final": read_projected(project_package(path, True)),
                "original": read_projected(project_package(path, False))}
    view = read_projected(project_package(path, mode == "final"))
    return {**view, "mode": mode, "completeView": True,
            "completeFinalView": mode == "final", "revisions": revisions}


def view_structure(view):
    outline = []
    paragraphs, tables = [], []
    def visit(items):
        for block in items:
            if block["type"] == "paragraph":
                index = len(paragraphs); paragraphs.append(block)
                if block["style"].lower().startswith("heading"):
                    try: level = int(block["style"].split()[-1])
                    except ValueError: level = 1
                    outline.append({"index": index, "level": level, "text": block["text"]})
            else:
                tables.append({"rows": len(block["rows"]), "cols": max((sum(cell["gridSpan"] for cell in row) for row in block["rows"]), default=0)})
                for row in block["rows"]:
                    for cell in row: visit(cell["blocks"])
    visit(view["blocks"])
    return {"outline": outline, "paragraph_count": len(paragraphs), "table_count": len(tables),
            "tables": tables, "section_count": len(view["sections"])}


def main() -> int:
    ap = argparse.ArgumentParser(description="Read/inspect a .docx file.")
    ap.add_argument("path", help=".docx file to read")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--text", action="store_true", help="extract all text as JSON")
    g.add_argument("--structure", action="store_true", help="outline JSON")
    g.add_argument("--styles", action="store_true", help="styles used, JSON")
    g.add_argument("--images", metavar="DIR", help="extract images to DIR")
    g.add_argument("--revisions", action="store_true",
                   help="detect tracked changes / comments")
    ap.add_argument("--mode", choices=["final", "original", "markup"], default="final",
                    help="revision view: final accepts, original rejects, markup includes both and anchored changes; read-only")
    args = ap.parse_args()

    if args.images:
        print(json.dumps({"images": extract_images(args.path, args.images)},
                         ensure_ascii=False))
        return 0
    if args.revisions:
        print(json.dumps(detect_revisions(args.path), ensure_ascii=False))
        return 0

    out = read_view(args.path, args.mode)
    if args.structure:
        if args.mode == "markup":
            out["final"] = view_structure(out["final"])
            out["original"] = view_structure(out["original"])
        else:
            out = {**view_structure(out), "mode": args.mode, "completeView": True, "completeFinalView": args.mode == "final", "revisions": out["revisions"]}
    elif args.styles:
        def projected_styles(accept):
            return _projected_styles(project_package(args.path, accept))
        if args.mode == "markup":
            out = {"mode": args.mode, "completeView": True, "revisions": out["revisions"], "final": {"styles": projected_styles(True)}, "original": {"styles": projected_styles(False)}}
        else:
            out = {"mode": args.mode, "completeView": True, "completeFinalView": args.mode == "final", "revisions": out["revisions"], "styles": projected_styles(args.mode == "final")}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
