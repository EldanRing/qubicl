---
name: plan
description: Create a concrete, reviewable implementation or project plan without performing the planned changes. Use for architecture proposals, migration plans, release plans, debugging strategies, and any request to plan before acting.
---

# Plan

Plan the requested work without implementing it. Inspect relevant context with read-only Qubicl tools. Do not change implementation files, start deployments, publish, or commit as part of planning.

Return a concise Markdown plan in the conversation. If the user requests a saved plan, writing that plan is the only planned file change: prefer `write_file` for a new plan and `edit_file` for an existing one. Use a user-provided destination; otherwise use `.agents/plans/` with a descriptive kebab-case filename. A request for read-only planning does not authorize creating a plan file.

Include only useful sections:

- goal and success criteria;
- current evidence and assumptions;
- ordered implementation steps;
- files or components likely to change;
- validation and rollback;
- risks, tradeoffs, and unresolved decisions.

Use exact local paths and commands when known. Clearly label anything inferred. End by summarizing the decisions required before implementation.
