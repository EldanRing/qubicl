"""Form-aware PDF assembly with explicit name collisions and verified publication."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject,
                           DictionaryObject, IndirectObject, NameObject, TextStringObject)


def field_nodes(form):
    seen = set()
    def visit(ref):
        node = ref.get_object()
        if id(node) in seen:
            return
        seen.add(id(node))
        yield node
        for child in (node['/Kids'] if '/Kids' in node else []):
            yield from visit(child)
    for root in (form['/Fields'] if '/Fields' in form else []):
        yield from visit(root)


def widget_record(widget):
    names, inherited, seen = [], {}, set()
    node = widget
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        if '/T' in node:
            names.append(str(node['/T']))
        for key in ('/FT', '/V', '/Ff'):
            if key in node and key not in inherited:
                inherited[key] = str(node[key])
        node = node['/Parent'] if '/Parent' in node else None
    return {"name": '.'.join(reversed(names)), **inherited}


def page_widgets(page):
    return [ref.get_object() for ref in (page['/Annots'] if '/Annots' in page else [])
            if ref.get_object().get('/Subtype') == '/Widget']


class FormAssembler:
    def __init__(self, duplicate_fields='rename'):
        self.writer = PdfWriter()
        self.duplicate_fields = duplicate_fields
        self.names = set()
        self.renamed = []
        self.expected_widgets = []
        self.source_count = 0

    def append(self, reader, indices=None, bookmark=None):
        self.source_count += 1
        indices = list(range(len(reader.pages))) if indices is None else list(indices)
        form = reader.root_object.get('/AcroForm')
        form = form.get_object() if form is not None else None
        fields = reader.get_fields() or {}
        collisions = self.names.intersection(fields)
        if collisions:
            if self.duplicate_fields == 'error':
                raise ValueError(f"Duplicate form field names: {', '.join(sorted(collisions))}")
            prefix = f'source_{self.source_count}'
            while prefix in self.names or any(f'{prefix}.{name}' in self.names for name in fields):
                prefix += '_'
            reader.add_form_topname(prefix)
            self.renamed.append({"input": self.source_count, "prefix": prefix,
                                 "fields": {name: f'{prefix}.{name}' for name in fields}})
            fields = reader.get_fields() or {}
        self.names.update(fields)
        if form is not None:
            self._prepare_appearances(reader, form)
        self.expected_widgets.extend([[widget_record(widget) for widget in page_widgets(reader.pages[index])]
                                      for index in indices])
        # append() otherwise clones /CO before filtering the selected pages,
        # which can pull omitted widgets (and their /P page contents) back in.
        calculation_order = form.pop('/CO', None) if form is not None else None
        try:
            self.writer.append(reader, pages=indices, import_outline=False, outline_item=bookmark)
        finally:
            if calculation_order is not None:
                form[NameObject('/CO')] = calculation_order
        if form is not None:
            target = self.writer.root_object['/AcroForm']
            # append() retains the first source's defaults only. Later fonts and
            # other default resources are needed when a merged field is edited.
            resources = target.setdefault(NameObject('/DR'), DictionaryObject()).get_object()
            for category, entries in (form['/DR'] if '/DR' in form else {}).items():
                entries = entries.get_object()
                if isinstance(entries, DictionaryObject):
                    destination = resources.setdefault(category, DictionaryObject()).get_object()
                    for name, resource in entries.items():
                        destination[name] = resource.clone(self.writer)
            # Nonvisual fields can participate in calculations without a page
            # widget. Keep them, and their calculation order, in the root tree.
            target_fields = target['/Fields']
            translated = self.writer._id_translated[id(reader)]
            for node in field_nodes(form):
                ref = node.indirect_reference
                if (ref is None or ref.idnum in translated
                        or any(child.get('/Subtype') == '/Widget' for child in field_nodes({'/Fields': [node]}))):
                    continue
                cloned = node.clone(self.writer, ignore_fields=('/Parent',))
                parent = node.get('/Parent')
                if parent is not None and parent.idnum in translated:
                    parent_ref = IndirectObject(translated[parent.idnum], 0, self.writer)
                    cloned[NameObject('/Parent')] = parent_ref
                    kids = parent_ref.get_object().setdefault(NameObject('/Kids'), ArrayObject()).get_object()
                    if cloned.indirect_reference not in kids:
                        kids.append(cloned.indirect_reference)
                elif cloned.indirect_reference not in target_fields:
                    target_fields.append(cloned.indirect_reference)
            if calculation_order is not None:
                order = target.setdefault(NameObject('/CO'), ArrayObject()).get_object()
                for ref in calculation_order.get_object():
                    if ref.idnum not in translated:
                        continue  # An omitted page's field is not part of this output.
                    cloned = IndirectObject(translated[ref.idnum], 0, self.writer)
                    if cloned not in order:
                        order.append(cloned)

    def _prepare_appearances(self, reader, form):
        resources = form['/DR'] if '/DR' in form else {}
        # Default resources can share dictionaries with existing appearance or
        # page streams. Rename only private maps for /DA; their unchanged /AP
        # programs must continue to resolve the original resource names.
        if resources:
            resources = DictionaryObject({category: DictionaryObject(entries.get_object())
                                          if isinstance(entries.get_object(), DictionaryObject) else entries
                                          for category, entries in resources.items()})
            form[NameObject('/DR')] = resources
        names = {name for entries in resources.values()
                 if isinstance(entries.get_object(), DictionaryObject)
                 for name in entries.get_object()}
        rename = {name: NameObject(f'/Qubicl{self.source_count}_{str(name)[1:]}')
                  for name in names} if self.source_count > 1 else {}
        for entries in resources.values():
            entries = entries.get_object()
            if isinstance(entries, DictionaryObject):
                for name in list(entries):
                    if name in rename:
                        entries[rename[name]] = entries.pop(name)
        for node in [form, *field_nodes(form)]:
            if '/DA' not in node or not rename:
                continue
            stream = DecodedStreamObject()
            value = node['/DA']
            stream.set_data(value.encode('latin-1') if isinstance(value, str) else bytes(value))
            content = ContentStream(stream, reader)
            for operands, _operator in content.operations:
                for index, operand in enumerate(operands):
                    if isinstance(operand, NameObject) and operand in rename:
                        operands[index] = rename[operand]
            node[NameObject('/DA')] = TextStringObject(content.get_data().decode('latin-1'))
        # Source-root defaults must not be replaced by the first PDF's defaults.
        for node in field_nodes(form):
            if '/FT' not in node or '/DA' in node:
                continue
            ancestor, seen = node, set()
            while '/DA' not in ancestor and '/Parent' in ancestor and id(ancestor) not in seen:
                seen.add(id(ancestor))
                ancestor = ancestor['/Parent']
            appearance = ancestor.get('/DA', form.get('/DA'))
            if appearance is not None:
                node[NameObject('/DA')] = appearance

    def save(self, output):
        destination = Path(output)
        with tempfile.NamedTemporaryFile(prefix='.qubicl-pdf-', suffix='.pdf',
                                         dir=destination.parent, delete=False) as stream:
            staged = Path(stream.name)
        try:
            self.writer.write(staged)
            saved = PdfReader(staged)
            observed = [[widget_record(widget) for widget in page_widgets(page)] for page in saved.pages]
            if observed != self.expected_widgets:
                raise ValueError('Saved PDF changed form field names, types, values or page widgets')
            form = saved.root_object.get('/AcroForm')
            reachable = {id(node) for node in field_nodes(form.get_object())} if form is not None else set()
            if any(id(widget) not in reachable for page in saved.pages for widget in page_widgets(page)):
                raise ValueError('Saved PDF has a widget missing from the interactive form field tree')
            # Exercise the public discovery path used by the bundled form filler.
            fields = saved.get_fields() or {}
            saved.close()
            os.replace(staged, destination)
            return {"field_count": len(fields), "renamed_fields": self.renamed}
        finally:
            staged.unlink(missing_ok=True)
