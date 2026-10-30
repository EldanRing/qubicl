"""Verified full-document cloning for nonstructural PDF edits (pinned pypdf)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
from collections import Counter

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, StreamObject, BooleanObject


def fingerprint(value, omit=()):
    """Compare decoded PDF graphs without depending on serialized object numbers."""
    seen = {}
    def describe(obj, path=()):
        if isinstance(obj, IndirectObject):
            obj = obj.get_object()
        if isinstance(obj, (dict, list, DictionaryObject, ArrayObject)):
            identity = id(obj)
            if identity in seen:
                return ['ref', seen[identity]]
            seen[identity] = len(seen)
            if isinstance(obj, (list, ArrayObject)):
                return ['array', [describe(item, path + (str(i),)) for i, item in enumerate(obj)]]
            result = ['dictionary', [[str(key), describe(obj[key], path + (str(key),))]
                                     for key in sorted(obj) if path + (str(key),) not in omit
                                     and not (isinstance(obj, StreamObject) and key == '/Length')]]
            if isinstance(obj, StreamObject):
                result.append(hashlib.sha256(obj.get_data()).hexdigest())
            return result
        if isinstance(obj, bytes):
            return ['bytes', obj.hex()]
        if isinstance(obj, BooleanObject):
            return ['boolean', obj.value]
        return [type(obj).__name__, str(obj)]
    return hashlib.sha256(json.dumps(describe(value), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def attachment_records(reader):
    for name in sorted(reader.attachments):
        payloads = reader.attachments[name]
        for index, payload in enumerate(payloads if isinstance(payloads, list) else [payloads]):
            yield str(name), index, bytes(payload)


def content_identity(document):
    root = document.root_object
    names = root.get('/Names')
    names = names.get_object() if names is not None else {}
    return {'root': fingerprint(root, omit=(('/Names',),)),
            'names': fingerprint({key: value for key, value in names.items() if key != '/EmbeddedFiles'})}


def attachment_identities(document):
    """Retain original file-spec metadata as well as the extracted payload bytes."""
    names = document.root_object.get('/Names')
    embedded = names.get_object().get('/EmbeddedFiles') if names else None
    def entries(node):
        node = node.get_object()
        values = node.get('/Names', [])
        for index in range(0, len(values), 2):
            yield str(values[index]), fingerprint(values[index + 1])
        for child in node.get('/Kids', []):
            yield from entries(child)
    return Counter(entries(embedded)) if embedded else Counter()


def cloned_writer(reader):
    # Rewriting signed bytes cannot retain their cryptographic validity.
    if reader.root_object.get('/Perms') or any(field.get('/FT') == '/Sig' and field.get('/V')
                                               for field in (reader.get_fields() or {}).values()):
        raise ValueError('Signed/certified PDFs cannot be rewritten without invalidating their security policy; no output written')
    writer = PdfWriter(clone_from=reader)
    if content_identity(writer) != content_identity(reader):
        raise ValueError('Full document cloning changed unsupported content; no output written')
    if reader.is_encrypted:
        # The pinned writer can encrypt full rewrites with the already decrypted
        # file key. Retain the original handler, passwords, permissions, filters
        # and file ID; encrypt(user_password) would silently reset owner policy.
        if (reader.trailer['/Encrypt'].get('/Filter') != '/Standard'
                or reader._encryption is None or not reader.trailer.get('/ID')):
            raise ValueError('Cannot preserve this PDF encryption policy; no output written')
        writer._encryption = reader._encryption
        writer._encrypt_entry = writer._add_object(reader.trailer['/Encrypt'].clone(writer)).get_object()
    return writer


def write_verified(writer, source, destination, password, attachments):
    expected_root = content_identity(source)
    expected_meta = fingerprint(writer.metadata or {})
    expected_attachments = [(name, index, hashlib.sha256(data).hexdigest()) for name, index, data in attachments]
    destination = Path(destination)
    fd, temporary = tempfile.mkstemp(prefix='.qubicl-pdf-', suffix='.pdf', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            writer.write(stream)
            stream.flush()
            os.fsync(stream.fileno())
        check = PdfReader(temporary)
        if check.is_encrypted != source.is_encrypted:
            raise ValueError('PDF encryption changed during write')
        if source.is_encrypted:
            if not check.decrypt(password):
                raise ValueError('Original password no longer opens the rewritten PDF')
            if (fingerprint(check.trailer['/Encrypt']) != fingerprint(source.trailer['/Encrypt'])
                    or fingerprint(check.trailer['/ID'][0]) != fingerprint(source.trailer['/ID'][0])):
                raise ValueError('PDF encryption handler, permissions or file identity changed')
        actual_attachments = [(name, index, hashlib.sha256(data).hexdigest()) for name, index, data in attachment_records(check)]
        if (content_identity(check) != expected_root or fingerprint(check.metadata or {}) != expected_meta
                or actual_attachments != expected_attachments
                or attachment_identities(source) - attachment_identities(check)):
            raise ValueError('PDF content, metadata or attachment preservation check failed')
        check.close()
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
