#!/usr/bin/env python3
# MIT License. Revision projection and complete story traversal for DOCX helpers.
"""Read-only final/original OOXML projections and anchored revision records."""
from __future__ import annotations

from copy import deepcopy
from io import BytesIO
import posixpath
import zipfile
from lxml import etree

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
NS = {'w': W, 'r': R}
CONTENT = {'ins', 'del', 'moveFrom', 'moveTo'}
CELL = {'cellIns', 'cellDel', 'cellMerge'}
CHANGES = {'rPrChange', 'pPrChange', 'tblPrChange', 'tblPrExChange', 'trPrChange',
           'tcPrChange', 'sectPrChange', 'tblGridChange', 'numberingChange'}
RANGES = {'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
          'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd',
          'customXmlMoveFromRangeStart', 'customXmlMoveFromRangeEnd', 'customXmlMoveToRangeStart', 'customXmlMoveToRangeEnd'}


def q(name): return '{' + W + '}' + name

def local(node): return etree.QName(node).localname if isinstance(node.tag, str) else ''

def parse(data): return etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))

def unwrap(node):
    parent = node.getparent()
    if parent is None: return
    index = parent.index(node)
    for child in list(node):
        parent.insert(index, child); index += 1
    parent.remove(node)


def revision_elements(root):
    return [node for node in root.iter() if isinstance(node.tag, str) and
            etree.QName(node).namespace == W and local(node) in CONTENT | CELL | CHANGES | RANGES]


def revision_records(root, part):
    records = []
    tree = root.getroottree()
    for node in revision_elements(root):
        name, parent = local(node), node.getparent()
        scope = 'row' if parent is not None and parent.tag == q('trPr') else 'cell' if name in CELL else 'paragraph-mark' if parent is not None and parent.tag == q('rPr') and parent.getparent() is not None and parent.getparent().tag == q('pPr') else 'properties' if name in CHANGES else 'content'
        record = {'part': part, 'path': tree.getpath(node), 'id': node.get(q('id')),
                  'type': {'ins': 'insertion', 'del': 'deletion'}.get(name, name),
                  'element': name, 'scope': scope, 'author': node.get(q('author')),
                  'date': node.get(q('date')), 'text': inline_text(node)}
        context = next((ancestor for ancestor in node.iterancestors() if ancestor.tag in {q('p'), q('tc'), q('tr')}), None)
        if context is not None: record['context'] = {'path': tree.getpath(context), 'text': inline_text(context)}
        if name in CHANGES | CELL:
            record['previousProperties'] = [etree.tostring(child, encoding='unicode') for child in node]
            record['attributes'] = {etree.QName(k).localname: value for k, value in node.attrib.items()}
            if parent is not None:
                record['currentProperties'] = [etree.tostring(child, encoding='unicode') for child in parent if child is not node and local(child) not in CHANGES]
        records.append(record)
    return records


def _property_projection(root, accept, selected):
    # Property snapshots can contain earlier revisions. Restore outer snapshots
    # first, then project the newly restored property tree in the same pass.
    while True:
        changes = [node for node in revision_elements(root) if local(node) in CHANGES - {'numberingChange'} and selected(node)]
        if not changes: break
        for node in changes:
            parent = node.getparent()
            if parent is None: continue
            previous = next((child for child in node if child.tag == parent.tag), None)
            if not accept and previous is not None:
                restored = deepcopy(previous)
                parent.attrib.clear(); parent.attrib.update(restored.attrib)
                for child in list(parent): parent.remove(child)
                parent.extend(list(restored))
            else:
                parent.remove(node)


def project_root(source, accept, rev_id=None):
    """Resolve tracked revisions on an independent XML copy, never on the source."""
    root = deepcopy(source)
    selected = lambda node: rev_id is None or node.get(q('id')) == rev_id
    _property_projection(root, accept, selected)
    # A deleted paragraph mark joins its text to the next paragraph, not deletes it.
    join_paragraphs = []
    for para in root.iter(q('p')):
        properties = para.find(q('pPr'))
        marks = properties.find(q('rPr')) if properties is not None else None
        if marks is not None and any(selected(node) and local(node) in ({'del', 'moveFrom'} if accept else {'ins', 'moveTo'}) for node in marks):
            join_paragraphs.append(para)
    # Rows and cells are structural revisions, distinct from content wrappers.
    for container_tag, property_tag, inserted, deleted in [('tr', 'trPr', 'ins', 'del'), ('tc', 'tcPr', 'cellIns', 'cellDel')]:
        for container in list(root.iter(q(container_tag))):
            properties = container.find(q(property_tag))
            if properties is None: continue
            remove = any(selected(node) and local(node) == (deleted if accept else inserted) for node in properties)
            if remove and container.getparent() is not None:
                container.getparent().remove(container)
    for node in list(root.iter(q('cellMerge'))):
        if not selected(node): continue
        parent = node.getparent()
        if parent is None: continue
        value = node.get(q('vMerge' if accept else 'vMergeOrig'))
        for existing in list(parent.findall(q('vMerge'))): parent.remove(existing)
        if value in ('cont', 'continue', 'rest', 'restart'):
            merged = etree.SubElement(parent, q('vMerge'))
            merged.set(q('val'), 'restart' if value in ('rest', 'restart') else 'continue')
        parent.remove(node)
    # Restore an original LISTNUM field's cached displayed value.
    for node in list(root.iter(q('numberingChange'))):
        if not selected(node): continue
        parent = node.getparent()
        if parent is None: continue
        if not accept and parent.tag == q('fldChar') and node.get(q('original')) is not None:
            para = next((a for a in parent.iterancestors() if a.tag == q('p')), None)
            if para is not None:
                elements = list(para.iter()); active = False; depth = 0; texts = []
                for element in elements[elements.index(parent) + 1:]:
                    if element.tag == q('fldChar'):
                        kind = element.get(q('fldCharType'))
                        if kind == 'begin': depth += 1
                        elif kind == 'end':
                            if depth == 0: break
                            depth -= 1
                        elif kind == 'separate' and depth == 0: active = True
                    elif active and element.tag == q('t'): texts.append(element)
                if texts:
                    texts[0].text = node.get(q('original'))
                    for text in texts[1:]: text.text = ''
        parent.remove(node)
    for node in list(root.iter()):
        name, parent = local(node), node.getparent()
        if parent is None or not selected(node): continue
        if node.tag in {q(item) for item in CONTENT}:
            if parent.tag in (q('rPr'), q('trPr')):
                parent.remove(node); continue
            keep = name in ({'ins', 'moveTo'} if accept else {'del', 'moveFrom'})
            if keep:
                for text in node.iter(q('delText')): text.tag = q('t')
                for text in node.iter(q('delInstrText')): text.tag = q('instrText')
                unwrap(node)
            else: parent.remove(node)
        elif name in CELL | RANGES and etree.QName(node).namespace == W:
            # Range markers describe moves/custom XML markup, not text deletion.
            parent.remove(node)
    for para in reversed(join_paragraphs):
        parent = para.getparent()
        if parent is None: continue
        following = para.getnext()
        boundary_markers = []
        while following is not None and local(following) in RANGES | {'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd'}:
            boundary_markers.append(following)
            following = following.getnext()
        if following is not None and following.tag == q('p'):
            # Keep the next paragraph's properties (its paragraph mark survives).
            old_properties = para.find(q('pPr'))
            if old_properties is not None: para.remove(old_properties)
            new_properties = following.find(q('pPr'))
            if new_properties is not None: para.insert(0, deepcopy(new_properties))
            # Anchors at the old paragraph boundary still precede the second
            # paragraph's text after its paragraph mark has been removed.
            para.extend(boundary_markers)
            para.extend(child for child in list(following) if child.tag != q('pPr'))
            parent.remove(following)
    return root


def project_package(path, accept, rev_id=None, part=None):
    output = BytesIO()
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename.startswith('word/') and info.filename.endswith('.xml') and (part is None or part == info.filename):
                root = parse(data)
                if revision_elements(root):
                    data = etree.tostring(project_root(root, accept, rev_id), encoding='UTF-8', xml_declaration=True, standalone=True)
            target.writestr(info, data)
    return output.getvalue()


def inline_text(node):
    """Visible text only: omit field instructions and separately exposed textboxes."""
    if not isinstance(node.tag, str): return ''
    if node.tag in {q('t'), q('delText'), '{' + M + '}t'}: return node.text or ''
    if node.tag in {q('tab'), q('ptab')}: return '\t'
    if node.tag in {q('br'), q('cr')}: return '\n'
    if node.tag == q('noBreakHyphen'): return '\u2011'
    if node.tag == q('softHyphen'): return '\u00ad'
    if node.tag in {q('instrText'), q('delInstrText'), q('txbxContent')} or local(node) in CHANGES or local(node).endswith('Pr'): return ''
    if node.tag == '{' + MC + '}AlternateContent':
        selected = next((child for child in node if local(child) == 'Choice'), None)
        if selected is None: selected = next(iter(node), None)
        return inline_text(selected) if selected is not None else ''
    return ''.join(inline_text(child) for child in node)


def content_children(root):
    """Unwrap structural content controls without descending into nested blocks."""
    for node in root:
        if node.tag in {q('sdt'), q('sdtContent'), q('customXml')}:
            yield from content_children(node)
        elif node.tag == '{' + MC + '}AlternateContent':
            chosen = next((child for child in node if local(child) == 'Choice'), next(iter(node), None))
            if chosen is not None: yield from content_children(chosen)
        else:
            yield node


def blocks(root, styles=None):
    out = []
    for node in content_children(root):
        if node.tag == q('p'):
            style = node.find('w:pPr/w:pStyle', NS)
            style_id = style.get(q('val')) if style is not None else 'Normal'
            record = {'type': 'paragraph', 'text': inline_text(node), 'style': (styles or {}).get(style_id, style_id)}
            references = [{'type': local(ref), 'id': ref.get(q('id'))} for ref in node.iter() if ref.tag in {q('footnoteReference'), q('endnoteReference'), q('commentReference')}]
            if references: record['references'] = references
            out.append(record)
        elif node.tag == q('tbl'):
            rows = []
            for row in (child for child in content_children(node) if child.tag == q('tr')):
                cells = []
                for cell in (child for child in content_children(row) if child.tag == q('tc')):
                    content = blocks(cell, styles)
                    span = cell.find('w:tcPr/w:gridSpan', NS)
                    merge = cell.find('w:tcPr/w:vMerge', NS)
                    cells.append({'text': block_text(content), 'blocks': content,
                                  'gridSpan': int(span.get(q('val'), '1')) if span is not None else 1,
                                  'verticalMerge': merge.get(q('val'), 'continue') if merge is not None else None})
                rows.append(cells)
            out.append({'type': 'table', 'rows': rows})
        elif node.tag not in {q('pPr'), q('tcPr'), q('tblPr'), q('trPr'), q('sectPr'), q('tblGrid'), q('sdtPr')}:
            # Content controls/custom XML are transparent, including tracked tables.
            if node.tag == '{' + MC + '}AlternateContent':
                chosen = next((child for child in node if local(child) == 'Choice'), next(iter(node), None))
                if chosen is not None: out.extend(blocks(chosen, styles))
            else: out.extend(blocks(node, styles))
    return out


def block_text(content):
    return '\n'.join(block['text'] if block['type'] == 'paragraph' else '\n'.join('\t'.join(cell['text'] for cell in row) for row in block['rows']) for block in content)


def package_records(path):
    records = []
    with zipfile.ZipFile(path) as package:
        for name in package.namelist():
            if name.startswith('word/') and name.endswith('.xml'):
                records.extend(revision_records(parse(package.read(name)), name))
    return records


def select_alternative_content(root):
    """Keep one DrawingML/VML representation for text and style inspection."""
    for alternative in list(root.iter('{' + MC + '}AlternateContent')):
        chosen = next((child for child in alternative if local(child) == 'Choice'), next(iter(alternative), None))
        for child in list(alternative):
            if child is not chosen: alternative.remove(child)
    return root


def read_projected(package_bytes):
    with zipfile.ZipFile(BytesIO(package_bytes)) as package:
        def story(name):
            # DrawingML/VML fallbacks describe the same text box. Read one
            # representation, rather than reporting its text twice.
            return select_alternative_content(parse(package.read(name)))
        document = story('word/document.xml')
        styles = {}
        if 'word/styles.xml' in package.namelist():
            for style in parse(package.read('word/styles.xml')).findall(q('style')):
                name = style.find(q('name'))
                styles[style.get(q('styleId'))] = name.get(q('val')) if name is not None else style.get(q('styleId'))
        relationships, related_stories = {}, {}
        relpath = 'word/_rels/document.xml.rels'
        if relpath in package.namelist():
            for rel in parse(package.read(relpath)):
                if rel.get('TargetMode') != 'External':
                    target = posixpath.normpath(posixpath.join('word', rel.get('Target', ''))).lstrip('/')
                    relationships[rel.get('Id')] = target
                    related_stories[rel.get('Type', '').rsplit('/', 1)[-1]] = target
        body = document.find(q('body'))
        body_blocks = blocks(body, styles)
        result = {'body': [block['text'] for block in body_blocks if block['type'] == 'paragraph'],
                  'tables': [[[cell['text'] for cell in row] for row in block['rows']] for block in body_blocks if block['type'] == 'table'],
                  'blocks': body_blocks, 'headers': [], 'footers': [], 'headerStories': [], 'footerStories': [],
                  'footnotes': [], 'endnotes': [], 'comments': [], 'textboxes': [], 'sections': []}
        inherited = {'header': {}, 'footer': {}}
        selected_parts = {'word/document.xml': document}
        for index, section in enumerate(document.iter(q('sectPr'))):
            for kind in inherited:
                for ref in section.findall(q(kind + 'Reference')):
                    target = relationships.get(ref.get('{' + R + '}id'))
                    if target: inherited[kind][ref.get(q('type'), 'default')] = target
            result['sections'].append({'index': index, 'headers': dict(inherited['header']), 'footers': dict(inherited['footer'])})
        for kind in ('header', 'footer'):
            collected = {}
            for section in result['sections']:
                for variant, name in section[kind + 's'].items():
                    record = collected.setdefault(name, {'part': name, 'uses': []})
                    record['uses'].append({'section': section['index'], 'type': variant})
            for name, record in collected.items():
                root = story(name); selected_parts[name] = root
                record['blocks'] = blocks(root, styles)
                result[kind + 'Stories'].append(record)
                result[kind + 's'].extend(block['text'] if block['type'] == 'paragraph' else block_text([block]) for block in record['blocks'])
        for kind in ('footnote', 'endnote', 'comment'):
            name = related_stories.get(kind + 's', 'word/' + kind + 's.xml')
            if name not in package.namelist(): continue
            references = {ref.get(q('id')) for root in selected_parts.values() for ref in root.iter(q(kind + 'Reference'))}
            for entry in story(name).findall(q(kind)):
                identifier = entry.get(q('id'))
                if identifier not in references: continue
                result[kind + 's'].append({'id': identifier, 'part': name, 'blocks': blocks(entry, styles)})
                selected_parts[name + '#' + identifier] = entry
        for name, root in selected_parts.items():
            for index, box in enumerate(root.iter(q('txbxContent'))):
                result['textboxes'].append({'part': name, 'index': index, 'blocks': blocks(box, styles)})
        return result
