---
name: freecad
description: "Build or edit parametric CAD models in workstation FreeCAD and export STEP, STL or drawing outputs."
---

# FreeCAD on Qubicl

FreeCAD is bundled on workstation computers. Keep the parametric `.FCStd` source in `/home/qubicl`; STEP preserves solid geometry while STL is a tessellated mesh. Choose units and export tolerances for the requested use.

Launch `freecad` with `open_desktop_application`. Inspect the window tree when it exposes useful controls, otherwise use screenshots for the 3D view and selection. Use the current window geometry token before coordinate input. Startup or custom view widgets may provide only partial accessibility.

For repeatable geometry, use FreeCAD's own Python/macro environment. Do not assume `import FreeCAD` works in the generic Python environment. Inspect the installed executable/help before selecting a command-line or macro invocation. Recompute the document after parameter changes; inspect shape validity and dimensions before export.

Keep the feature history when editing an existing parametric part. Verify an exported solid or mesh by reopening it or inspecting its geometry, with one representative view for orientation and scale. A successful export does not establish manufacturability or engineering fitness.
