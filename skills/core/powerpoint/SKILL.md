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

Use the common rendering receipt for PDF, DOCX, XLSX and PPTX:
`/opt/qubicl/skills-venv/bin/python /opt/qubicl/artifact-render.py FILE --outdir DIR`.
Each invocation captures its source, uses an isolated Office profile, and writes a unique
run directory with PDF, exact numbered PNGs and `manifest.json`. Read `sourceSha256`,
`pages`, `warnings` and `validation`, then inspect the generated pages. Old previews
are never returned as this run's outputs. `visuallyInspected: false` is intentional:
the tool renders; the agent performs visual review. Office rendering needs workstation.

Outlines include all slides, with `show`, `hidden`, zero-based `index`, one-based
`slide_number`, stable `slide_id` and visible/hidden counts. The renderer explicitly
exports visible slides only; hidden content remains in the source and outline.
Its `presentation` inventory records each slide's `renderedPage` (null for hidden
slides), and each page has `sourceSlide` identity/order. Do not equate output page
numbers with source slide numbers. An all-hidden deck returns `rendered: false`,
`reason: no_visible_slides` and a manifest with the complete source inventory.

Replacement visits grouped shapes and all original matches across runs, preserving unaffected formatting. Slide duplication copies chart XML, embedded workbooks, styles/colors, notes and media into independent parts, including nested grouped charts. Editing the duplicate leaves the source data and styles unchanged. Layout/master definitions and links to other slides remain shared presentation references; self-links target the duplicate. The chart-data command indexes charts recursively through groups. Explicit replacement of a linked chart's data creates a private embedded workbook without accessing its external source. Footer placeholders receive unique shape IDs.

Slide deletion removes incoming click/hover actions, custom-show references and
section membership for that slide. Its unreachable notes, charts, embedded
workbooks and media are omitted from the saved package; resources still used by
surviving slides remain. `removed_slide_links` reports cleared incoming actions
and custom-show entries. Text on surviving link shapes is retained.

Chart outlines retain `type`, `categories` and flattened series `values`, and add
`plots` with each plot's index, type, kind, categories and series. Scatter series
include `xValues` and `yValues`; bubble series also include `bubbleSizes`. Sparse
points retain their positions. Missing caches are read from the embedded workbook,
including series names and date-valued coordinates, without fetching external links.

Use `"plot": N` in a chart-data specification to edit a combined chart's plot
(default `0`). Category specifications keep their existing `categories` and
`series` mapping. For scatter or bubble replacement use
`{"series": [{"name": "S", "xValues": [1, 2], "yValues": [3, 4], "bubbleSizes": [5, 6]}]}`;
omit `bubbleSizes` for scatter. `update_series` may change `xValues`, `yValues`
(or its compatible alias `values`) and `bubbleSizes` independently; omitted
coordinates and sizes remain intact. Combined-plot edits preserve other plots and
existing embedded worksheet formulas. An emptied plot can be populated again.
