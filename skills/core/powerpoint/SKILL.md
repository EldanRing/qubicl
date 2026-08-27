---
name: powerpoint
description: Create, inspect, edit, template, render, and verify PowerPoint PPTX presentations using Qubicl's pinned local presentation tools. Use for slide decks, speaker notes, charts, images, templates, and visual presentation review.
---

# PowerPoint workflows

Keep decks and rendered previews under `/home/qubicl`. Obtain this skill's `resourceRoot` from `skill_view` and run bundled helpers with `/opt/qubicl/skills-venv/bin/python`. Qubicl computer and workstation images contain the pinned PPTX library; do not install dependencies during a task.

Useful helpers beneath `<resourceRoot>/scripts/`:

- `pptx_read.py FILE --outline|--notes|--images DIR`
- `pptx_create.py SPEC.json OUTPUT.pptx`
- `pptx_edit.py FILE` for text, charts, images, slide order, backgrounds, links, footers, and notes
- `pptx_from_template.py TEMPLATE.pptx OUTPUT.pptx --values VALUES.json`
- `pptx_render.py FILE --outdir DIR`

Inspect the source deck before editing. Prefer a new output for structural changes. Validate by reading the resulting outline and notes. On workstation computers, render slides through LibreOffice and Poppler for visual QA; on computer computers, structured operations remain available but rendering may be unavailable. Check representative first, middle, and last slides rather than assuming a successful save preserved layout.
