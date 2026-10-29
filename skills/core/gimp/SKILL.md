---
name: gimp
description: "Edit layered raster images with the workstation GIMP application; preserve XCF sources and export requested image formats."
---

# GIMP on Qubicl

GIMP is bundled on workstation computers. Launch `gimp` with `open_desktop_application`; file arguments must already exist inside `/home/qubicl`.

Use `list_desktop_windows` and `desktop_snapshot` to locate menus, layers and dialogs. GTK controls generally expose accessibility; canvas painting and selections often need `take_screenshot` and `control_computer`. Use the observed window ID and geometry token with screen coordinates. Request an observation after an action when the next step depends on its effect.

Save the editable project as `.xcf`; export PNG, JPEG or another requested delivery format separately. Preserve layers and transparency when the task needs them. Check the exported dimensions and a representative view; a successful save alone does not verify the image.

GIMP batch APIs differ between major versions. Inspect `gimp --version` and `gimp --help` before choosing a script interface. Do not assume a Python console/plugin is installed. A normal close request may open a save dialog; handle it through observed controls.
