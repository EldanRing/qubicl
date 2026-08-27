---
name: plan
description: Create a concrete, reviewable implementation or project plan without performing the planned changes. Use for architecture proposals, migration plans, release plans, debugging strategies, and any request to plan before acting.
---

# Plan

Stay in planning mode for this turn. Inspect relevant context with read-only Qubicl tools, but do not edit project files, start deployments, publish, commit, or perform the proposed work.

Write a concise Markdown plan in the active workspace. Prefer `write_file` for a new plan and `edit_file` for an existing one. Use a user-provided destination; otherwise write under `.agents/plans/` with a descriptive kebab-case filename.

Include only useful sections:

- goal and success criteria;
- current evidence and assumptions;
- ordered implementation steps;
- files or components likely to change;
- validation and rollback;
- risks, tradeoffs, and unresolved decisions.

Use exact local paths and commands when known. Clearly label anything inferred. End by summarizing the decisions required before implementation.
