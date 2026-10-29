---
name: docx
description: Create, read, edit, template, validate, and review Word DOCX documents using Qubicl's pinned local document tools. Use for professional Word documents, tracked revisions, comments, structured edits, and DOCX templates.
---

# DOCX workflows

Keep inputs and outputs under `/home/qubicl`. Obtain this skill's `resourceRoot` from `skill_view` and run bundled helpers with `/opt/qubicl/skills-venv/bin/python`. Qubicl computer and workstation images contain the pinned libraries; never install dependencies as part of the workflow.

Useful helpers beneath `<resourceRoot>/scripts/`:

- `docx_read.py FILE --text|--structure|--styles|--revisions [--mode final|original|markup]`
- `docx_create.py SPEC.json OUTPUT.docx`
- `docx_edit.py` for text, paragraph, style, and table-cell edits
- `docx_template.py TEMPLATE.docx VALUES.json OUTPUT.docx`
- `docx_comments.py` and `docx_revisions.py`
- `docx_validate.py FILE`

Read `references/revisions-and-comments.md` only for tracked-change or comment work.

Inspect before editing, write to a new output unless in-place work was requested, and validate after every mutation. On workstation computers, use LibreOffice for a final PDF render when visual layout matters; on computer computers, report that structured DOCX operations work but office rendering may be unavailable. Preserve unknown OOXML parts whenever a helper supports doing so.

Use the common rendering receipt for PDF, DOCX, XLSX and PPTX:
`/opt/qubicl/skills-venv/bin/python /opt/qubicl/artifact-render.py FILE --outdir DIR`.
Each invocation captures its source, uses an isolated Office profile, and writes a unique
run directory with PDF, exact numbered PNGs and `manifest.json`. Read `sourceSha256`,
`pages`, `warnings` and `validation`, then inspect the generated pages. Old previews
are never returned as this run's outputs. `visuallyInspected: false` is intentional:
the tool renders; the agent performs visual review. Office rendering needs workstation.

Text replacements use original matches once and preserve drawings and run properties. Edits across unsupported tabs/breaks/field structures fail explicitly. Comment anchors use consistent text offsets across tabs, line breaks, position tabs and nonbreaking hyphens; splitting preserves inline objects, and comment reads retain tabs and line breaks in both anchor text and comment bodies.

Read tracked documents with `--mode final` (default, accept revisions in memory), `--mode original` (reject them in memory), or `--mode markup` (both views and anchored revision records). Reading preserves the source file. These modes resolve inserted/deleted/moved content, paragraph marks, revised rows/cells and property snapshots across body content, nested tables, all header/footer variants, notes, comments and text boxes. Text JSON includes ordered `blocks`, `headerStories`/`footerStories`, `footnotes`, `endnotes`, `comments` and `textboxes`, alongside the compatible `body`/`tables`/`headers`/`footers` fields. Include the related stories when reviewing the whole document. Revision records identify the original package part, XML path, author/date, context and previous/current properties. Use `docx_revisions.py` only when an accepted/rejected output file is wanted; `--part` can scope a reused revision ID to one story. Text extraction reports stored field results; rendering remains the way to inspect pagination and visual appearance.
