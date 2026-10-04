---
name: atp-architect
description: Generate or refine ATP (Agent Task Protocol) execution plans from tickets, stories, epics, bugs, RFCs, or project briefs. Use when Codex needs a dependency-based ATP JSON graph with normal-granularity nodes sized roughly like one coherent commit or PR, including design, implementation, tests, docs, migrations, and rollout work. Prefer this over atp-micro-architect when the user wants a practical execution plan rather than ultra-fine fresh-context micro-nodes.
---

# ATP Architect

Use this skill to produce ATP planning output, not implementation output.

## Start

1. Read [references/source-architect-prompt.md](references/source-architect-prompt.md) and [references/atp-schema.json](references/atp-schema.json) before drafting the final plan.
2. If the user is revising an existing ATP graph, also read [references/refiner-prompt.md](references/refiner-prompt.md) and inspect the current graph first.
3. Extract the project goal, constraints, acceptance criteria, interfaces, migrations, testing needs, documentation needs, and rollout work before naming nodes.

## Planning Rules

- Output one valid JSON object and nothing else unless the user explicitly asks for explanation around it.
- Set `meta.version` to `"1.3"` and `meta.project_status` to `"DRAFT"`.
- Use `"READY"` only for nodes with no dependencies. Use `"LOCKED"` for all other planned nodes.
- Never include runtime-only fields such as `worker_id`, `started_at`, `completed_at`, `artifacts`, or `report`.
- Keep the graph acyclic and keep node ids stable and readable, typically `T01_*`, `T02_*`, and so on.

## Normal Architect Granularity

- Target nodes sized like one coherent commit or PR, usually a 30-90 minute focused work item.
- Give each node one main responsibility and one main verification path.
- Split design, implementation, tests, docs, migrations, and rollout into separate nodes when they would not belong in the same clean change set.
- Preserve useful parallelism, but do not invent dependencies or parallel branches that add no execution value.

## Refinement Rules

- Preserve existing node ids unless a split or merge is truly necessary.
- Avoid mutating `COMPLETED` work unless the user explicitly wants a rewrite or the current graph is clearly invalid.
- When inserting new work in the middle of a chain, rewire downstream dependencies carefully instead of duplicating paths.
- If the user asks for a narrower, fresh-context plan with 5-25 minute steps, switch to `atp-micro-architect` rather than overloading this skill.

## Output Handling

- Return inline JSON unless the user explicitly wants a `.atp.json` file written to disk.
- If you write a file, keep the file name obvious, such as `.atp.json` or `<project>.atp.json`.

## Resources

- [references/source-architect-prompt.md](references/source-architect-prompt.md): canonical normal-granularity architect prompt from `atp-runner`.
- [references/refiner-prompt.md](references/refiner-prompt.md): graph refinement rules from `atp`.
- [references/atp-schema.json](references/atp-schema.json): ATP schema reference.
