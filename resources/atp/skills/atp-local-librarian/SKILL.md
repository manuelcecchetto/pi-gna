---
name: atp-local-librarian
description: "Operate ATP `.atp.json` plans locally without MCP. Use when Codex needs the ATP librarian behaviors through direct filesystem commands instead of MCP tools: activate a reviewed plan, claim the next READY node, inspect graph state, complete or fail a claimed node with a handoff report, decompose an oversized node into subtasks, read local/full graph views, or apply ATP v1.4 future patches during adaptive replanning."
---

# ATP Local Librarian

Use the bundled CLI to mutate ATP plans safely under a local file lock. Treat it as the direct replacement for the old MCP librarian surface.

## Workflow

1. Read [references/command-patterns.md](references/command-patterns.md) first.
2. Resolve the absolute `plan_path` you will operate on.
3. Never edit the `.atp.json` file directly. Use the bundled CLI for every graph mutation.
4. For normal execution, loop:
   - activate a reviewed `DRAFT` or `PAUSED` plan with `atp-activate-project`
     after explicit execution authority
   - inspect with `atp-status-summary` or `atp-read-graph`
   - claim with `atp-claim-task`
   - execute or decompose
   - complete, fail, or explicitly release the claim as soon as its runner stops
   - complete with `atp-complete-task`
   - claim again until no READY work remains or a real blocker stops progress
5. Use `atp-apply-future-patch` only for bounded ATP v1.4 future-graph updates after reading the full graph and capturing `meta.graph_version`.

## Command Surface

The CLI lives at [scripts/atp_local_librarian.py](scripts/atp_local_librarian.py).

It exposes subcommands for local graph operation:

- `atp-activate-project`: atomically transition a reviewed `DRAFT` or `PAUSED`
  project to `ACTIVE` with an actor and reason
- `atp-claim-task`: refresh READY nodes and claim the highest-priority READY node
  for an `agent_id`; claims do not expire
- `atp-release-claim`: move one exact `CLAIMED` node back to `READY` after its
  runner stops without completing or terminally failing the node
- `atp-complete-task`: mark a node `DONE` or `FAILED`, store the report and artifacts, and unlock downstream work
- `atp-decompose-task`: turn a task into a `SCOPE` and graft a child DAG under it
- `atp-read-graph`: print the full graph JSON with runtime `meta.graph_version`, or a local neighborhood view
- `atp-status-summary`: print the read-only status dashboard that replaces the MCP status resource
- `atp-apply-future-patch`: apply a bounded ATP v1.4 future patch when claimed-node count is zero and the graph version matches

Prefer the explicit `atp-*` subcommand names to keep muscle memory aligned with the former MCP tools.

## Operating Rules

- Always pass an absolute `plan_path`.
- Activate only after explicit execution authority. Never activate an archived
  plan or use activation to imply that implementation has begun before a claim.
- Keep a stable `agent_id`. Default to `CODEX` unless the user or orchestrator specifies another value.
- `CLAIMED` means its exact runner is currently working. Claims never expire and
  require no heartbeat. When that runner stops, immediately complete the node,
  fail it for a terminal blocker, or use `atp-release-claim` to return unfinished
  retryable work to `READY`. Never leave stopped or queued work `CLAIMED`.
- Write completion reports for downstream workers, not just for the current turn. Include the outcome, key facts learned, files touched, verification, risks, and the recommended next step when useful.
- Complete only a `CLAIMED` node and provide a non-empty report. When a separate
  orchestrator judges the work, pass its stable identity with `--judge-id` so
  the accepted node records who performed the judgment.
- Prefer `atp-read-graph --view-mode local --node-id <node>` over broad full-graph reads when you only need nearby context.
- Never decompose merely because a node is difficult or touches multiple files.
  Decompose only before implementation, when the node contains genuinely
  independent outcomes or materially different verification paths and the
  orchestrator has explicit adaptive-replanning authority.
- Use temp files for `--report-file`, `--subtasks-file`, and `--patch-file` instead of trying to squeeze large JSON or multiline reports into one shell argument.
- Treat `SCOPE` nodes as containers. Do not manually complete or decompose a node that is already a `SCOPE`.

## If The ATP Repo Is Present

Treat these repo files as canonical behavioral guidance and use the bundled CLI only for the graph mutations themselves:

- `atp-runner/RUNNER.md`
- `atp-protocol/prompts/atp_executor_prompt.md`
- `evidence/runner_codex_delivery_contract.md`

## Resources

- [references/command-patterns.md](references/command-patterns.md): command shapes, temp-file patterns, and JSON payload examples for decomposition and future patches.
- [scripts/atp_local_librarian.py](scripts/atp_local_librarian.py): local no-MCP ATP librarian CLI.
