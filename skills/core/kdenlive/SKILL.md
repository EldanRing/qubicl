---
name: kdenlive
description: "Edit video timelines in workstation Kdenlive, retain project media, and render requested video deliverables."
---

# Kdenlive on Qubicl

Kdenlive is bundled on workstation computers. Save `.kdenlive` projects and source media below `/home/qubicl` so the timeline remains usable after a restart. A project file does not embed its media by default.

Launch `kdenlive` with `open_desktop_application`. Use native snapshots for menus and dialogs where available; the timeline and monitor may need screenshots and window-targeted coordinates. Let startup finish before deciding that a sparse accessibility tree is the final application state.

Match the project frame rate, resolution and audio layout to the requested delivery. Keep source media intact; use proxy media when its performance benefit matters. Check the render profile and output path before starting a potentially long export. CPU rendering is available; hardware codecs and GPU acceleration are not guaranteed.

Verify the exported duration, video/audio streams and representative frames with the tools actually installed; check playback or audio when the task depends on synchronization. Preserve the editable project alongside the requested delivery. Normal close allows Save/Discard/Cancel handling.
