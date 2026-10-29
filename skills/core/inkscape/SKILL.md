---
name: inkscape
description: "Create and edit SVG illustrations and vector layouts with workstation Inkscape, including PDF or PNG export."
---

# Inkscape on Qubicl

Inkscape is bundled on workstation computers. Keep the editable `.svg` in `/home/qubicl` and export the requested delivery format separately.

For deterministic SVG changes, use file tools or scripts and open the result with `open_desktop_application` using `inkscape`. For visual adjustments, inspect native controls with `desktop_snapshot`; use screenshots for the canvas and drawing handles. Target the observed window and geometry for coordinate input.

The CLI supports exports without driving dialogs. Inspect `inkscape --help` for installed options; for example, `inkscape drawing.svg --export-type=png --export-filename=drawing.png`. Choose page or drawing bounds deliberately and verify the exported size, fonts and clipping in a rendered view. Preserve editable text unless the user needs outlines or a delivery constraint requires them.

Normal close leaves unsaved-work dialogs available. Avoid process termination when a save/export dialog is still open.
