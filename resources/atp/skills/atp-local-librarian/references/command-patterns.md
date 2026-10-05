# Command Patterns

Use these patterns instead of editing the plan file directly.

## Activate A Reviewed Plan

Activation is a real graph mutation. Use it only after the user authorizes
execution:

```bash
python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-activate-project \
  --plan-path /abs/path/to/plan.atp.json \
  --actor-id CODEX-SOL \
  --reason "User authorized execution of the reviewed ATP plan."
```

The command accepts only `DRAFT -> ACTIVE` and `PAUSED -> ACTIVE`. Repeating it
on an active project is idempotent; archived projects remain closed.

## Inspect And Claim

```bash
python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-status-summary \
  --plan-path /abs/path/to/plan.atp.json

python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-read-graph \
  --plan-path /abs/path/to/plan.atp.json \
  --view-mode local \
  --node-id T03

python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-claim-task \
  --plan-path /abs/path/to/plan.atp.json \
  --agent-id CODEX
```

## Release A Stopped Claim

Claims do not expire or require heartbeats. If the runner stops before the node
is completed or terminally failed, return the exact node to `READY`:

```bash
python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-release-claim \
  --plan-path /abs/path/to/plan.atp.json \
  --node-id T03 \
  --agent-id CODEX \
  --reason "Runner stopped before satisfying the node contract."
```

The node must still be `CLAIMED` by that exact agent. A different owner or
status fails closed. Use completion with `DONE` or `FAILED` instead when the
judge has a terminal disposition.

## Complete A Node

Prefer a report file for multiline handoffs:

```bash
cat >/tmp/t03-report.txt <<'EOF'
Outcome: Implemented the parser fix and tightened validation.
Files Touched: src/parser.ts, src/parser.test.ts
Verification: npm test -- parser
Risks: Full integration suite not re-run in this node.
Recommended Next Step: Claim the downstream integration node.
EOF

python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-complete-task \
  --plan-path /abs/path/to/plan.atp.json \
  --node-id T03 \
  --status DONE \
  --judge-id CODEX-SOL \
  --report-file /tmp/t03-report.txt \
  --artifact src/parser.ts \
  --artifact src/parser.test.ts
```

Completion requires the node to be `CLAIMED` and the report to be non-empty.
Use `--judge-id` whenever a separate orchestrator inspected and accepted the
runner's work.

## Decompose A Node

Write the subgraph payload as JSON. The file must contain a JSON array of subtasks.

```json
[
  {
    "id": "T12a_contract",
    "title": "Define API contract",
    "description": "Write the API contract and request-response shapes.",
    "instruction": "Define the HTTP contract for the new endpoint and update the shared schema docs."
  },
  {
    "id": "T12b_impl",
    "description": "Implement the backend endpoint using the approved contract.",
    "dependencies": ["T12a_contract"]
  }
]
```

Then apply it:

```bash
python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-decompose-task \
  --plan-path /abs/path/to/plan.atp.json \
  --parent-id T12 \
  --subtasks-file /tmp/t12-subtasks.json
```

## Apply A Future Patch

1. Read the full graph first to capture `meta.graph_version`.
2. Ensure no nodes are currently `CLAIMED`.
3. Prepare a patch JSON object with any of `add_nodes`, `update_nodes`, `close_nodes`, and `rewire_edges`.

Example patch:

```json
{
  "add_nodes": [
    {
      "id": "J07_followup",
      "title": "Harden retry handling",
      "instruction": "Add the retry-path regression test and tighten error telemetry.",
      "dependencies": ["T08"],
      "status": "LOCKED",
      "reasoning_effort": "medium"
    }
  ],
  "close_nodes": [
    {
      "id": "T09",
      "future_state": "SUPERSEDED",
      "superseded_by": "J07_followup"
    }
  ]
}
```

Apply it:

```bash
python3 /abs/path/to/skills/atp-local-librarian/scripts/atp_local_librarian.py atp-apply-future-patch \
  --plan-path /abs/path/to/plan.atp.json \
  --expected-graph-version 1234abcd5678ef90 \
  --patch-file /tmp/future-patch.json \
  --reason "Judge determined the old follow-up node was superseded by a narrower retry hardening task." \
  --actor-id CODEX-JUDGE
```

## Notes

- `--report-file -`, `--subtasks-file -`, and `--patch-file -` read from stdin.
- `atp-read-graph --view-mode full` prints JSON and injects `meta.graph_version` at runtime.
- Closed future nodes are tracked through `future_state`; they are not claimable and do not count as READY work.

## Retry a Failed Node

When a blocker is resolved (including human confirmation of a device gate), use
`atp-retry-task --plan-path /absolute/plan.atp.json --node-id T21 --actor-id CODEX --reason "Human confirmed the gate checks"`.
This preserves the old report in `retry_history` and recomputes readiness under the
file lock. Then claim and complete normally. Do not edit graph JSON or mark
unreported tests as passed; record precisely what the human confirmed.
