#!/usr/bin/env python3
"""Document metadata and file attachments for PDFs (pypdf).

Modes (one required):
  --set-meta            set metadata keys given via --title/--author/...
  --clear-meta          drop all document info metadata
  --attach FILE         embed a file attachment
  --list-attachments    list embedded attachment names
  --extract-attachments DIR  write all attachments into DIR

Metadata note: values are stored in the classic DocInfo dictionary
(Title/Author/Subject/Keywords). XMP metadata, if present, is not
rewritten and may disagree in sophisticated viewers.
"""
from __future__ import annotations

import argparse
import json
import hashlib
import re
import tempfile
import os
import sys
from pathlib import Path


def extract_attachments(reader, directory):
    from pdf_preservation import attachment_records
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    planned, used = [], set()
    for name, index, data in attachment_records(reader):
        safe = re.split(r"[/\\]", name)[-1]
        safe = re.sub(r'[<>:"|?*\x00-\x1f\x7f]', '_', safe).strip(' .') or 'attachment.bin'
        stem, suffix = os.path.splitext(safe)
        # Bound UTF-8 filenames and leave room for collision suffixes.
        suffix = suffix[:20]
        while len((stem + suffix).encode()) > 160:
            stem = stem[:-1]
        if re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', stem):
            stem = 'attachment_' + stem
        safe = stem + suffix
        counter = 1
        while safe.casefold() in used:
            counter += 1
            safe = f'{stem}__{counter}{suffix}'
        used.add(safe.casefold())
        if os.path.lexists(directory / safe):
            raise FileExistsError(f'Attachment destination already exists: {directory / safe}; no files overwritten')
        planned.append((name, index, data, safe))
    published = []
    receipts = []
    try:
        with tempfile.TemporaryDirectory(prefix='.qubicl-attachments-', dir=directory) as temporary:
            for number, (name, index, data, safe) in enumerate(planned):
                staged = Path(temporary) / str(number)
                staged.write_bytes(data)
                staged.chmod(0o600)
                digest = hashlib.sha256(data).hexdigest()
                if hashlib.sha256(staged.read_bytes()).hexdigest() != digest:
                    raise ValueError('Attachment write verification failed')
                target = directory / safe
                # link is an atomic create-only publication, including symlinks.
                os.link(staged, target)
                published.append((target, target.stat().st_ino))
                receipts.append({'sourceName': name, 'payloadIndex': index, 'destination': str(target),
                                 'bytes': len(data), 'sha256': digest})
    except BaseException:
        for path, inode in published:
            if path.exists() and not path.is_symlink() and path.stat().st_ino == inode:
                path.unlink()
        raise
    return {'extracted': [item['destination'] for item in receipts], 'attachments': receipts,
            'payloadCount': len(receipts), 'indexBase': 0, 'overwrite': False}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Set/clear PDF metadata; manage attachments.")
    parser.add_argument("pdf", help="Input PDF path")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--set-meta", action="store_true", help="Set metadata fields")
    mode.add_argument("--clear-meta", action="store_true", help="Remove all DocInfo metadata")
    mode.add_argument("--attach", metavar="FILE", help="Embed FILE as an attachment")
    mode.add_argument("--list-attachments", action="store_true", help="List attachment names")
    mode.add_argument("--extract-attachments", metavar="DIR", help="Extract attachments into DIR")
    parser.add_argument("-o", "--output", help="Output PDF (required for write modes)")
    parser.add_argument("--title")
    parser.add_argument("--author")
    parser.add_argument("--subject")
    parser.add_argument("--keywords")
    parser.add_argument("--password", help="Password if the input is encrypted")
    args = parser.parse_args()

    try:
        from pypdf import PdfReader
        from pdf_preservation import attachment_records, cloned_writer, write_verified
    except ImportError:
        print("Required Qubicl PDF dependency is unavailable: pypdf", file=sys.stderr)
        return 2

    reader = PdfReader(args.pdf)
    if reader.is_encrypted:
        if args.password is None or not reader.decrypt(args.password):
            print("Error: input is encrypted; pass --password", file=sys.stderr)
            return 3

    if args.list_attachments:
        names = list(reader.attachments.keys())
        json.dump({"attachment_count": len(names), "attachments": names}, sys.stdout,
                  ensure_ascii=False, indent=2)
        print()
        return 0

    if args.extract_attachments:
        print(json.dumps(extract_attachments(reader, args.extract_attachments), ensure_ascii=False, indent=2))
        return 0

    if not args.output:
        print("Error: -o/--output is required for write modes", file=sys.stderr)
        return 4

    writer = cloned_writer(reader)
    attachments = list(attachment_records(reader))

    if args.set_meta:
        meta = {}
        for key, value in ((f"/{k.capitalize()}", getattr(args, k))
                           for k in ("title", "author", "subject", "keywords")):
            if value is not None:
                meta[key] = value
        if not meta:
            print("Error: --set-meta needs at least one of --title/--author/--subject/--keywords",
                  file=sys.stderr)
            return 4
        writer.add_metadata(meta)
        result = {"output": args.output, "set": {k.lstrip("/"): v for k, v in meta.items()}}
    elif args.clear_meta:
        writer.metadata = None
        result = {"output": args.output, "cleared": True}
    else:  # --attach
        attach_path = Path(args.attach)
        with open(attach_path, "rb") as fh:
            data = fh.read()
            writer.add_attachment(attach_path.name, data)
        index = sum(name == attach_path.name for name, _, _ in attachments)
        attachments.append((attach_path.name, index, data))
        attachments.sort(key=lambda item: (item[0], item[1]))
        result = {"output": args.output, "attached": attach_path.name}

    write_verified(writer, reader, args.output, args.password, attachments)
    result.update(preservationVerified=True, encrypted=reader.is_encrypted, attachmentPayloadCount=len(attachments))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
