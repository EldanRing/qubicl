---
name: blender
description: "Create, edit and render 3D scenes with workstation Blender using its Python API or desktop interface."
---

# Blender on Qubicl

Blender is bundled on workstation computers. Save `.blend` sources and requested renders or interchange files below `/home/qubicl`.

For reproducible scene construction, write a Python script and run `blender --background --python script.py` through `exec_command`. Blender's `bpy` lives in Blender's interpreter, not ordinary system Python. Inspect the installed Blender version before using version-specific APIs. Background renders can use retained tasks and `process_output`.

Use `open_desktop_application` with `blender` for interactive inspection. Blender's custom interface may expose no useful AT-SPI tree: use the explicit screenshot fallback, observed window geometry and bounded coordinate actions. A visible viewport does not prove a final render is correct.

A workstation has CPU rendering; GPU access is not promised. Start with a small representative render and choose resolution, samples and animation length for the user's task. Keep external textures linked under the durable home or pack them into the `.blend` when portability is requested. Check a rendered frame and the saved scene before delivering.
