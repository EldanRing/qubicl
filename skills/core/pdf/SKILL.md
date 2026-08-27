---
name: pdf
description: Create, inspect, modify, render, merge, split, fill, watermark, secure, and validate PDF files using Qubicl's pinned local document tools. Use whenever a task substantially involves PDF input or output.
---

# PDF workflows

Use Qubicl file tools to inspect inputs and save outputs under `/home/qubicl`. Use `exec_command` for the deterministic helpers bundled with this skill. Obtain this package's `resourceRoot` from `skill_view`; do not assume a client-specific skill directory.

The curated browser, computer, and workstation images provide the declared Python libraries plus Poppler. Run helpers through `/opt/qubicl/skills-venv/bin/python`. If a dependency is absent, report that the current preset does not support the operation; do not install packages automatically.

Common helpers beneath `<resourceRoot>/scripts/`:

- `pdf_read.py FILE --text|--tables|--meta|--fields`
- `pdf_create.py SPEC.json -o OUTPUT.pdf`
- `pdf_merge.py INPUT... -o OUTPUT.pdf`
- `pdf_split.py FILE --pages 1-3,5 -o OUTPUT.pdf`
- `pdf_page_image.py FILE --out-dir DIR`
- `pdf_make_form.py SPEC.json -o OUTPUT.pdf`
- `pdf_fill_form.py FILE --fields-json VALUES.json -o OUTPUT.pdf`
- `pdf_stamp.py`, `pdf_watermark.py`, `pdf_meta.py`, and `pdf_secure.py`

Read `references/forms.md` only for AcroForm work.

For inspection, extract text first and render representative pages when layout matters. Use `take_screenshot` only for the live desktop; use generated page images for document QA. Verify important outputs by reopening them with a read helper and, when visual fidelity matters, by rendering pages. Never overwrite the only input copy unless the user explicitly requests in-place editing.
