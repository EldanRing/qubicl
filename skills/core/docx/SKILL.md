---
name: docx
description: Create, read, edit, template, validate, and review Word DOCX documents using Qubicl's pinned local document tools. Use for professional Word documents, tracked revisions, comments, structured edits, and DOCX templates.
---

# DOCX workflows

Keep inputs and outputs under `/home/qubicl`. Obtain this skill's `resourceRoot` from `skill_view` and run bundled helpers with `/opt/qubicl/skills-venv/bin/python`. Qubicl computer and workstation images contain the pinned libraries; never install dependencies as part of the workflow.

Useful helpers beneath `<resourceRoot>/scripts/`:

- `docx_read.py FILE --text|--structure|--styles|--revisions`
- `docx_create.py SPEC.json OUTPUT.docx`
- `docx_edit.py` for text, paragraph, style, and table-cell edits
- `docx_template.py TEMPLATE.docx VALUES.json OUTPUT.docx`
- `docx_comments.py` and `docx_revisions.py`
- `docx_validate.py FILE`

Read `references/revisions-and-comments.md` only for tracked-change or comment work.

Inspect before editing, write to a new output unless in-place work was requested, and validate after every mutation. On workstation computers, use LibreOffice for a final PDF render when visual layout matters; on computer computers, report that structured DOCX operations work but office rendering may be unavailable. Preserve unknown OOXML parts whenever a helper supports doing so.
