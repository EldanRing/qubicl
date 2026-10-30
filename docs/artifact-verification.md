# Artifact rendering and verification

The 0.8 development workstation provides a common command for PDF, DOCX, XLSX
and PPTX artifacts:

```sh
/opt/qubicl/skills-venv/bin/python /opt/qubicl/artifact-render.py report.docx --outdir previews
```

The renderer captures the source before conversion and hashes those exact bytes.
A unique directory contains `document.pdf`, numerically ordered PNG pages, and
`manifest.json`. The response identifies the source hash, each generated page and
its hash, conversion warnings and structural validation. It never scans an old
output directory for previously generated pages. Existing files and previous runs
are preserved. A failed invocation removes only its own new directory.

LibreOffice uses a fresh isolated profile with macros disabled and untrusted
external links blocked. Embedded charts remain enabled: LibreOffice's broader
active-content switch also suppresses ordinary chart rendering.
PDF inputs use Poppler directly. DOCX, XLSX and PPTX rendering requires LibreOffice,
provided by workstation; unavailable tools produce `rendered: false`, no files and
explicit guidance. Existing `pptx_render.py` delegates to this renderer while
preserving its positional input and `--outdir`, `--prefix`, `--dpi` options.

PPTX export explicitly includes visible slides only, in source order, without
notes pages. `presentation` reports the policy, visible/hidden counts and every
source slide's zero-based `index`, one-based `number`, stable `id`, package part,
visibility and `renderedPage` (null when hidden). Each generated page's `sourceSlide`
maps back to that inventory. A mismatched visible-slide/page count fails instead
of publishing an uncertain mapping. Hidden slides are preserved in the source
and included by `pptx_read.py --outline`. An all-hidden deck returns no pages,
`rendered: false`, `reason: no_visible_slides` and its inventory manifest.

Open the images listed by the returned manifest and inspect the content and layout
that matters to the task. `rendered: true` means pages were generated and counted;
`visuallyInspected` and `fidelityVerified` stay false. It does not imply Word,
PowerPoint or Excel fidelity. Fonts, pagination, graphs and embedded objects can
render differently in LibreOffice.

Office editing helpers preserve editable content before rendering: PowerPoint
chart-slide copies own independent chart/workbook parts, and spreadsheet
row/column edits update native tables, chart sources, drawings and dependent
formulas. Word `docx_read.py --mode final|original|markup` reads tracked changes
without saving the source; markup includes both views and revision locations.
For a visual rendering of a selected Word revision view, use
`docx_revisions.py accept-all|reject-all INPUT -o COPY.docx` and render that copy.

For XLSX, the renderer first recalculates a captured copy, then renders it. The
receipt reports cached formula counts, missing results, exact error cells and
changed workbook package parts. `noFormulaErrors` reports observed error values,
not the correctness of formula logic. Missing cached values remain distinct from
empty cells. Recalculation can alter OOXML formatting and unsupported Excel features;
`formatChangesPossible` and `changedPackageParts` expose that uncertainty. Volatile
formulas can change again when opened. `xlsx_recalc.py` uses the same checks and
isolated profile and preserves the original when a conversion fails or a concurrent
input change is detected before an in-place save. Prefer `--out` for reviewable work.

PDF form filling regenerates supported field appearances. `--flatten` merges all
supported appearances (including fields not in the input values), then removes
widgets and the form dictionary. Invisible fields remain invisible. Unsupported
widgets cause an error before destination replacement. Reopen and render the output
when appearance matters, especially for unusual fonts and radio/checkbox widgets.
