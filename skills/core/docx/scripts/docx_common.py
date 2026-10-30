#!/usr/bin/env python3
# MIT License. Shared helpers for the docx skill scripts.
"""Shared helpers: paragraph iteration and run-preserving text replacement."""
from __future__ import annotations


def iter_all_paragraphs(doc, include_headers_footers: bool = True):
    """Yield every paragraph in body, tables (recursively), headers, footers."""
    seen = set()
    containers = [doc]
    if include_headers_footers:
        for section in doc.sections:
            containers.extend((section.header, section.footer, section.first_page_header,
                               section.first_page_footer, section.even_page_header,
                               section.even_page_footer))
    for container in containers:
        if container is None:
            continue
        for paragraph in _iter_container(container):
            if paragraph._p not in seen:
                seen.add(paragraph._p)
                yield paragraph


def _iter_container(container):
    for para in container.paragraphs:
        yield para
    for table in container.tables:
        yield from _iter_table(table)


def _iter_table(table):
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                yield para
            for nested in cell.tables:
                yield from _iter_table(nested)


def iter_part_roots(doc):
    """Yield the XML root of the body plus every header/footer part."""
    yield doc.element.body
    seen = set()
    for section in doc.sections:
        for part in (
            section.header, section.footer,
            section.first_page_header, section.first_page_footer,
            section.even_page_header, section.even_page_footer,
        ):
            if part is not None and id(part._element) not in seen:
                seen.add(id(part._element))
                yield part._element


def replace_in_paragraph(para, old: str, new: str) -> int:
    """Edit original matches once; never join text across structural boundaries."""
    import re
    if not old:
        return 0
    return replace_matches_in_paragraph(para, re.compile(re.escape(old)), lambda match: new)


def replace_matches_in_paragraph(para, pattern, replacement) -> int:
    """Replace original regex spans once, retaining the first matched run's style.

    ``replacement`` receives an original match. Its returned text is literal:
    inserted token-like text is never searched or interpreted as a backreference.
    """
    import re
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    segments, current = [], []
    def boundary():
        if current:
            segments.append(list(current))
            current.clear()
    for child in para._p:
        if child.tag == qn("w:pPr"):
            continue
        if child.tag != qn("w:r"):
            boundary()
            continue
        for node in child:
            if node.tag == qn("w:t"):
                current.append(node)
            elif node.tag != qn("w:rPr"):
                boundary()
    boundary()
    plans = []
    for nodes in segments:
        text = "".join(node.text or "" for node in nodes)
        matches = list(pattern.finditer(text))
        plans.append((nodes, matches))
    count = sum(len(matches) for _, matches in plans)
    # An unsupported visible match must not be silently skipped alongside safe ones.
    if count != len(list(pattern.finditer(para.text))):
        raise ValueError("Replacement crosses a tab, break, field, drawing or unsupported paragraph structure; edit a plain-text span instead")
    for nodes, matches in plans:
        offsets, pos = [], 0
        for node in nodes:
            offsets.append((node, pos, pos + len(node.text or "")))
            pos = offsets[-1][2]
        for match in reversed(matches):
            new = replacement(match)
            first = True
            for node, start, end in offsets:
                if end <= match.start() or start >= match.end():
                    continue
                a, b = max(start, match.start()) - start, min(end, match.end()) - start
                text = (node.text or "")[:a] + (new if first else "") + (node.text or "")[b:]
                pieces = re.split(r"([\t\n])", text.replace("\r\n", "\n").replace("\r", "\n"))
                node.text = pieces[0]
                node.set(qn("xml:space"), "preserve")
                previous = node
                for piece in pieces[1:]:
                    element = OxmlElement("w:tab" if piece == "\t" else "w:br" if piece == "\n" else "w:t")
                    if element.tag == qn("w:t"):
                        element.text = piece
                        element.set(qn("xml:space"), "preserve")
                    previous.addnext(element)
                    previous = element
                first = False
    return count
