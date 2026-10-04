---
name: atp-micro-architect
description: Generate or refine ATP (Agent Task Protocol) execution plans as very small fresh-context micro-nodes. Use when Codex needs an ATP JSON graph where each node is one independently verifiable delivery step, usually a 5-25 minute execution turn with explicit scope, inputs, outputs, and acceptance checks. Prefer this over atp-architect when the user wants heavy decomposition, exact dependency ordering, or worker turns optimized for minimal context reconstruction.
---

# ATP Micro Architect

Use this skill to produce ATP planning output optimized for fresh-context execution.

## Start

1. Read [references/source-micro-architect-prompt.md](references/source-micro-architect-prompt.md) and [references/atp-schema.json](references/atp-schema.json) before drafting the final plan.
2. If you need an example of how to explode one oversized node into smaller steps, read [references/decomposer-prompt.md](references/decomposer-prompt.md).
3. Identify the smallest independently valuable state transitions in the work before writing node ids or dependencies.

## Planning Rules

- Output one valid JSON object and nothing else unless the user explicitly asks for explanation around it.
- Set `meta.version` to `"1.3"` and `meta.project_status` to `"DRAFT"`.
- Use `"READY"` only for root nodes and `"LOCKED"` for dependent nodes.
- Never include runtime-only execution fields.
- Keep the graph acyclic, readable, and explicit enough that a new worker can act without reconstructing hidden plan structure.

## Micro Architect Granularity

- Target nodes sized like one independently verifiable delivery step, often a 5-25 minute execution turn.
- Prefer one contract decision, one implementation slice, one test slice, one migration step, one documentation step, or one verification step per node.
- Make the stopping condition obvious inside each node instruction.
- Encode exact order with dependencies when sequencing matters. Do not rely on the worker to infer hidden ordering.
- Prefer meaningful over-splitting. Avoid trivial bookkeeping nodes unless they are real migration, compatibility, or verification boundaries.

## Choosing Between Architect Modes

- Use this skill when the user asks for micro nodes, fresh-context execution, many small steps, or aggressive decomposition.
- Use `atp-architect` instead when commit-sized nodes are sufficient and orchestration overhead should stay lower.

## Output Handling

- Return inline JSON unless the user explicitly wants a `.atp.json` file written to disk.
- If refining an existing plan, preserve stable ids where possible and only split nodes that truly need finer decomposition.

## Resources

- [references/source-micro-architect-prompt.md](references/source-micro-architect-prompt.md): canonical micro-architect prompt from `atp-runner`.
- [references/decomposer-prompt.md](references/decomposer-prompt.md): decomposition prompt from `atp`.
- [references/atp-schema.json](references/atp-schema.json): ATP schema reference.
