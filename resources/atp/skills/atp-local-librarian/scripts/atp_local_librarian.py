#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

ALLOWED_STATUSES = {"LOCKED", "READY", "CLAIMED", "COMPLETED", "FAILED"}
ALLOWED_REASONING_EFFORT = {"minimal", "low", "medium", "high", "xhigh"}
ALLOWED_FUTURE_STATE = {"CLOSED", "SUPERSEDED"}
ALLOWED_PROJECT_STATUSES = {"DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def resolve_paths(plan_path: Optional[str]) -> Tuple[Path, Path]:
    plan = Path(plan_path or os.environ.get("ATP_FILE", ".atp.json")).expanduser()
    if not plan.is_absolute():
        plan = Path.cwd() / plan
    lock_env = os.environ.get("ATP_LOCK_FILE")
    lock = Path(lock_env).expanduser() if lock_env else Path(f"{plan}.lock")
    return plan, lock


def ensure_string(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string.")


def ensure_string_list(value: object, field_name: str) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{field_name} must be a list of strings.")


def validate_node(node_id: str, node: object) -> None:
    if not isinstance(node, dict):
        raise ValueError(f"Node {node_id} must be an object.")
    for field_name in ("title", "instruction", "dependencies", "status"):
        if field_name not in node:
            raise ValueError(f"Node {node_id} is missing required field {field_name}.")
    ensure_string(node["title"], f"{node_id}.title")
    ensure_string(node["instruction"], f"{node_id}.instruction")
    ensure_string_list(node["dependencies"], f"{node_id}.dependencies")
    status = node["status"]
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"Node {node_id} has invalid status {status}.")
    if "scope_children" in node:
        ensure_string_list(node["scope_children"], f"{node_id}.scope_children")
    if "artifacts" in node:
        ensure_string_list(node["artifacts"], f"{node_id}.artifacts")
    if "reasoning_effort" in node and node["reasoning_effort"] not in ALLOWED_REASONING_EFFORT:
        raise ValueError(
            f"Node {node_id} has invalid reasoning_effort {node['reasoning_effort']}."
        )
    if "future_state" in node and node["future_state"] not in ALLOWED_FUTURE_STATE:
        raise ValueError(f"Node {node_id} has invalid future_state {node['future_state']}.")


def ensure_dependencies_exist(graph: Dict) -> None:
    nodes = graph.get("nodes", {})
    missing: List[Tuple[str, str]] = []
    for node_id, node in nodes.items():
        for dep in node.get("dependencies", []):
            if dep not in nodes:
                missing.append((node_id, dep))
        for child_id in node.get("scope_children", []):
            if child_id not in nodes:
                missing.append((node_id, child_id))
    if missing:
        pairs = ", ".join(f"{nid}->{dep}" for nid, dep in missing)
        raise ValueError(f"Graph references missing dependencies: {pairs}")


def validate_graph(graph: object) -> None:
    if not isinstance(graph, dict):
        raise ValueError("ATP graph must be a JSON object.")
    meta = graph.get("meta", {})
    if meta is not None and not isinstance(meta, dict):
        raise ValueError("meta must be an object when present.")
    if isinstance(meta, dict) and "project_status" in meta:
        project_status = meta["project_status"]
        if project_status not in ALLOWED_PROJECT_STATUSES:
            raise ValueError(f"meta.project_status has invalid value {project_status}.")
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        raise ValueError("nodes must be an object keyed by node ID.")
    for node_id, node in nodes.items():
        if not isinstance(node_id, str) or not node_id:
            raise ValueError("All node IDs must be non-empty strings.")
        validate_node(node_id, node)
    ensure_dependencies_exist(graph)


def load_graph(plan_file: Path) -> Dict:
    if not plan_file.exists():
        raise FileNotFoundError(
            f"No ATP graph found at {plan_file}. Create a file matching the ATP contract."
        )
    data = json.loads(plan_file.read_text())
    validate_graph(data)
    return data


def atomic_write_json(plan_file: Path, graph: Dict) -> None:
    validate_graph(graph)
    plan_file.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=plan_file.parent, prefix=plan_file.name, delete=False
    ) as handle:
        json.dump(graph, handle, indent=2)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, plan_file)


@contextmanager
def file_lock(lock_file: Path) -> Iterable[None]:
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with lock_file.open("a+", encoding="utf-8") as handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            if handle.tell() == 0:
                handle.write(" ")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def locked_graph(plan_path: Optional[str]) -> Iterable[Tuple[Dict, Path]]:
    plan_file, lock_file = resolve_paths(plan_path)
    with file_lock(lock_file):
        graph = load_graph(plan_file)
        yield graph, plan_file
        atomic_write_json(plan_file, graph)


def compute_graph_version(graph: Dict) -> str:
    snapshot = copy.deepcopy(graph)
    meta = snapshot.get("meta")
    if isinstance(meta, dict):
        meta.pop("graph_version", None)
    encoded = json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def graph_with_runtime_meta(graph: Dict) -> Dict:
    snapshot = copy.deepcopy(graph)
    snapshot.setdefault("meta", {})["graph_version"] = compute_graph_version(graph)
    return snapshot


def dependencies_satisfied(nodes: Dict[str, Dict], dependencies: List[str]) -> bool:
    return all(nodes[dep]["status"] == "COMPLETED" for dep in dependencies)


def node_is_closed(node: Dict) -> bool:
    return node.get("future_state") in ALLOWED_FUTURE_STATE


def node_is_mutable_future(node: Dict) -> bool:
    return node.get("type") != "SCOPE" and not node_is_closed(node) and node["status"] in {
        "READY",
        "LOCKED",
    }


def find_children(nodes: Dict[str, Dict], node_id: str) -> List[str]:
    return [nid for nid, node in nodes.items() if node_id in node.get("dependencies", [])]


def refresh_ready_nodes(graph: Dict) -> List[str]:
    unblocked: List[str] = []
    nodes = graph["nodes"]
    for node_id, node in nodes.items():
        if node.get("type") == "SCOPE":
            continue
        if node_is_closed(node):
            continue
        if node["status"] != "LOCKED":
            continue
        if dependencies_satisfied(nodes, node.get("dependencies", [])):
            node["status"] = "READY"
            unblocked.append(node_id)
    return unblocked


def clear_worker(node: Dict) -> None:
    node.pop("worker_id", None)
    node.pop("lease_expires_at", None)
    node.pop("lease_renewed_at", None)


def maybe_complete_scopes(graph: Dict, now: datetime) -> List[str]:
    closed: List[str] = []
    nodes = graph["nodes"]
    for node_id, node in nodes.items():
        if node.get("type") != "SCOPE":
            continue
        if node["status"] in {"COMPLETED", "FAILED"}:
            continue
        children = node.get("scope_children", [])
        if children and all(nodes[child]["status"] == "COMPLETED" for child in children):
            node["status"] = "COMPLETED"
            node["completed_at"] = isoformat(now)
            clear_worker(node)
            closed.append(node_id)
    return closed


def format_dependency_context(nodes: Dict[str, Dict], node: Dict) -> str:
    lines: List[str] = []
    for dep_id in node.get("dependencies", []):
        dep_node = nodes[dep_id]
        report = dep_node.get("report") or "(no handoff provided)"
        lines.append(f"- From {dep_id} ({dep_node['status']}): {report}")
    if not lines:
        lines.append("- No parent context; follow the instruction directly.")
    return "\n".join(lines)


def format_assignment(node_id: str, node: Dict, nodes: Dict[str, Dict]) -> str:
    static_context = node.get("context")
    static_block = f"\nSTATIC CONTEXT:\n{static_context}\n" if static_context else ""
    return (
        f"TASK ASSIGNED: {node_id} - {node['title']}\n"
        f"STATUS: {node['status']}\n"
        f"INSTRUCTION:\n{node['instruction']}\n"
        f"{static_block}"
        f"CONTEXT FROM DEPENDENCIES:\n{format_dependency_context(nodes, node)}\n"
        "INSTRUCTION: Execute this node's full declared contract. Do not decompose it "
        "merely because it is difficult or touches multiple files or systems. If the "
        "node is contradictory or contains genuinely independent outcomes, report the "
        "plan defect before editing and decompose only with explicit orchestrator authority."
    )


def project_active(graph: Dict) -> bool:
    return graph.get("meta", {}).get("project_status") == "ACTIVE"


def claim_ready_nodes(graph: Dict, agent_id: str, now: datetime) -> Tuple[Optional[str], str]:
    nodes = graph["nodes"]
    existing_claims = [
        (node_id, node)
        for node_id, node in nodes.items()
        if node["status"] == "CLAIMED" and node.get("worker_id") == agent_id
    ]
    if len(existing_claims) > 1:
        claimed = ", ".join(node_id for node_id, _node in existing_claims)
        raise ValueError(f"Agent {agent_id} owns multiple claims: {claimed}.")
    if existing_claims:
        node_id, node = existing_claims[0]
        node.pop("lease_expires_at", None)
        node.pop("lease_renewed_at", None)
        return node_id, format_assignment(node_id, node, nodes)

    ready_nodes = [
        (node_id, node)
        for node_id, node in nodes.items()
        if node["status"] == "READY" and node.get("type") != "SCOPE" and not node_is_closed(node)
    ]
    if not ready_nodes:
        return None, "NO_TASKS_AVAILABLE: All tasks are blocked, claimed, or the project is finished."

    ready_nodes.sort(key=lambda item: (len(item[1].get("dependencies", [])), item[0]))
    node_id, node = ready_nodes[0]
    node["status"] = "CLAIMED"
    node["worker_id"] = agent_id
    node["started_at"] = isoformat(now)
    node.pop("lease_expires_at", None)
    node.pop("lease_renewed_at", None)
    return node_id, format_assignment(node_id, node, nodes)


def normalize_completion_status(status: str) -> str:
    status_map = {"DONE": "COMPLETED", "COMPLETED": "COMPLETED", "FAILED": "FAILED"}
    normalized = status_map.get(status.upper())
    if not normalized:
        raise ValueError("status must be one of DONE or FAILED.")
    return normalized


def validate_subtasks(subtasks: List[Dict]) -> None:
    if not subtasks:
        raise ValueError("Provide at least one subtask.")
    ids = [task["id"] for task in subtasks if "id" in task]
    if len(ids) != len(subtasks):
        raise ValueError("Each subtask must include an id.")
    if len(ids) != len(set(ids)):
        raise ValueError("Subtask IDs must be unique within the decomposition request.")
    for task in subtasks:
        if "description" not in task:
            raise ValueError(f"Subtask {task['id']} is missing description.")
        deps = task.get("dependencies", [])
        if not isinstance(deps, list) or any(not isinstance(dep, str) for dep in deps):
            raise ValueError(f"Subtask {task['id']} has invalid dependencies.")
        unknown = [dep for dep in deps if dep not in ids]
        if unknown:
            raise ValueError(
                f"Subtask {task['id']} has dependencies outside the subgraph: {', '.join(unknown)}"
            )

    adjacency: Dict[str, List[str]] = {task["id"]: task.get("dependencies", []) for task in subtasks}
    visited: Dict[str, str] = {}

    def dfs(node_id: str) -> None:
        visited[node_id] = "VISITING"
        for dep in adjacency.get(node_id, []):
            state = visited.get(dep)
            if state == "VISITING":
                raise ValueError("Subtasks contain a cycle.")
            if state is None:
                dfs(dep)
        visited[node_id] = "VISITED"

    for node_id in adjacency:
        if visited.get(node_id) is None:
            dfs(node_id)


def graft_subgraph(
    graph: Dict, parent_id: str, subtasks: List[Dict], now: datetime
) -> Tuple[List[str], List[str]]:
    nodes = graph["nodes"]
    parent = nodes[parent_id]
    original_dependencies = parent.get("dependencies", [])
    original_children = find_children(nodes, parent_id)

    validate_subtasks(subtasks)

    new_ids = [task["id"] for task in subtasks]
    collisions = sorted(node_id for node_id in new_ids if node_id in nodes)
    if collisions:
        raise ValueError("Subtask IDs already exist in the graph: " + ", ".join(collisions))

    subgraph_dependencies = {task["id"]: task.get("dependencies", []) for task in subtasks}
    dependents: Dict[str, List[str]] = {task_id: [] for task_id in new_ids}
    for node_id, deps in subgraph_dependencies.items():
        for dep in deps:
            dependents.setdefault(dep, []).append(node_id)

    start_nodes = [task_id for task_id, deps in subgraph_dependencies.items() if not deps]
    end_nodes = [task_id for task_id in new_ids if not dependents.get(task_id)]

    for task in subtasks:
        task_id = task["id"]
        deps = list(task.get("dependencies", []))
        if task_id in start_nodes:
            deps = list(dict.fromkeys(original_dependencies + deps))
        node_payload = {
            "title": task.get("title") or task["description"],
            "instruction": task.get("instruction") or task["description"],
            "dependencies": deps,
            "status": "LOCKED",
            "artifacts": [],
        }
        if task.get("context"):
            node_payload["context"] = task["context"]
        if task.get("reasoning_effort"):
            node_payload["reasoning_effort"] = task["reasoning_effort"]
        nodes[task_id] = node_payload

    parent["type"] = "SCOPE"
    parent["status"] = "CLAIMED"
    parent["scope_children"] = new_ids
    clear_worker(parent)
    parent.setdefault("started_at", isoformat(now))

    for child_id in original_children:
        child = nodes[child_id]
        deps = [dep for dep in child.get("dependencies", []) if dep != parent_id]
        child["dependencies"] = list(dict.fromkeys(deps + end_nodes))

    refresh_ready_nodes(graph)
    return start_nodes, end_nodes


def claimed_node_count(graph: Dict) -> int:
    return sum(1 for node in graph.get("nodes", {}).values() if node["status"] == "CLAIMED")


def normalize_future_status(value: Optional[str]) -> str:
    if value is None:
        return "LOCKED"
    status = value.upper()
    if status not in {"LOCKED", "READY"}:
        raise ValueError("Future patch node status must be LOCKED or READY.")
    return status


def ensure_patch_ids_unique(add_nodes: List[Dict]) -> None:
    ids = [node["id"] for node in add_nodes if "id" in node]
    if len(ids) != len(add_nodes):
        raise ValueError("Each add_nodes entry must include an id.")
    if len(ids) != len(set(ids)):
        raise ValueError("Patch add_nodes entries must have unique IDs.")


def ensure_dependencies_known(
    dependencies: List[str], known_ids: set[str], field_name: str, node_id: str
) -> None:
    unknown = [dep for dep in dependencies if dep not in known_ids]
    if unknown:
        raise ValueError(
            f"{field_name} for {node_id} references unknown dependencies: {', '.join(unknown)}"
        )


def recompute_future_readiness(graph: Dict) -> None:
    nodes = graph["nodes"]
    for node in nodes.values():
        if node.get("type") == "SCOPE" or node_is_closed(node):
            continue
        if node["status"] in {"READY", "LOCKED"}:
            node["status"] = (
                "READY" if dependencies_satisfied(nodes, node.get("dependencies", [])) else "LOCKED"
            )


def ensure_no_active_dependency_on_closed_node(graph: Dict) -> None:
    nodes = graph["nodes"]
    closed_ids = {node_id for node_id, node in nodes.items() if node_is_closed(node)}
    if not closed_ids:
        return
    offenders: List[str] = []
    for node_id, node in nodes.items():
        if node_id in closed_ids or node["status"] in {"COMPLETED", "FAILED"}:
            continue
        for dep in node.get("dependencies", []):
            if dep in closed_ids:
                offenders.append(f"{node_id}->{dep}")
    if offenders:
        raise ValueError(
            "Future patch leaves active nodes depending on closed nodes: "
            + ", ".join(sorted(offenders))
        )


def apply_future_patch_to_graph(
    graph: Dict, patch: Dict, reason: str, actor_id: str, now: datetime
) -> Dict[str, int]:
    nodes = graph["nodes"]
    add_nodes = patch.get("add_nodes", []) or []
    update_nodes = patch.get("update_nodes", []) or []
    close_nodes = patch.get("close_nodes", []) or []
    rewire_edges = patch.get("rewire_edges", []) or []

    ensure_patch_ids_unique(add_nodes)
    new_ids = {node["id"] for node in add_nodes}
    collisions = sorted(node_id for node_id in new_ids if node_id in nodes)
    if collisions:
        raise ValueError(
            "Future patch add_nodes contains IDs already present in graph: " + ", ".join(collisions)
        )

    known_ids = set(nodes.keys()) | new_ids
    patch_timestamp = isoformat(now)

    for payload in add_nodes:
        dependencies = list(payload.get("dependencies", []))
        ensure_dependencies_known(dependencies, known_ids, "dependencies", payload["id"])
        nodes[payload["id"]] = {
            "title": payload["title"],
            "instruction": payload["instruction"],
            "dependencies": dependencies,
            "status": normalize_future_status(payload.get("status")),
            "reasoning_effort": payload.get("reasoning_effort", "medium"),
            "future_patch_reason": reason,
            "future_patched_at": patch_timestamp,
            "future_patched_by": actor_id,
        }
        if payload.get("context"):
            nodes[payload["id"]]["context"] = payload["context"]

    for payload in update_nodes:
        node_id = payload["id"]
        if node_id not in nodes:
            raise ValueError(f"Cannot update missing node {node_id}.")
        node = nodes[node_id]
        if not node_is_mutable_future(node):
            raise ValueError(f"Node {node_id} is not a mutable future node.")
        for field_name in ("title", "instruction", "reasoning_effort"):
            if field_name in payload:
                node[field_name] = payload[field_name]
        if "context" in payload:
            if payload["context"] in (None, ""):
                node.pop("context", None)
            else:
                node["context"] = payload["context"]
        if "status" in payload:
            node["status"] = normalize_future_status(payload["status"])
        node["future_patch_reason"] = reason
        node["future_patched_at"] = patch_timestamp
        node["future_patched_by"] = actor_id

    for payload in rewire_edges:
        node_id = payload.get("id") or payload.get("node_id")
        if not node_id or node_id not in nodes:
            raise ValueError(f"Cannot rewire missing node {node_id}.")
        node = nodes[node_id]
        if not node_is_mutable_future(node):
            raise ValueError(f"Node {node_id} is not a mutable future node.")
        dependencies = list(payload.get("dependencies", []))
        ensure_dependencies_known(dependencies, known_ids, "rewire dependencies", node_id)
        node["dependencies"] = dependencies
        node["future_patch_reason"] = reason
        node["future_patched_at"] = patch_timestamp
        node["future_patched_by"] = actor_id

    for payload in close_nodes:
        if isinstance(payload, str):
            node_id = payload
            future_state = "SUPERSEDED"
            superseded_by = None
        else:
            node_id = payload["id"]
            future_state = payload.get("future_state", "SUPERSEDED")
            superseded_by = payload.get("superseded_by")
        if node_id not in nodes:
            raise ValueError(f"Cannot close missing node {node_id}.")
        node = nodes[node_id]
        if not node_is_mutable_future(node):
            raise ValueError(f"Node {node_id} is not a mutable future node.")
        node["future_state"] = future_state
        node["future_patch_reason"] = reason
        node["future_patched_at"] = patch_timestamp
        node["future_patched_by"] = actor_id
        if superseded_by:
            node["superseded_by"] = superseded_by

    recompute_future_readiness(graph)
    ensure_no_active_dependency_on_closed_node(graph)
    refresh_ready_nodes(graph)
    return {
        "add_nodes": len(add_nodes),
        "update_nodes": len(update_nodes),
        "close_nodes": len(close_nodes),
        "rewire_edges": len(rewire_edges),
    }


def summarize_status(graph: Dict) -> str:
    nodes = graph.get("nodes", {})
    counts: Dict[str, int] = {"LOCKED": 0, "READY": 0, "CLAIMED": 0, "COMPLETED": 0, "FAILED": 0}
    claimed: List[str] = []
    closed_count = 0
    for node_id, node in nodes.items():
        if node_is_closed(node):
            closed_count += 1
            continue
        counts[node["status"]] = counts.get(node["status"], 0) + 1
        if node["status"] == "CLAIMED":
            claimed.append(f"{node_id} ({node.get('worker_id') or 'unassigned'})")
    lines = [
        f"ATP Project Status: {graph.get('meta', {}).get('project_name', 'Unknown')} "
        f"({graph.get('meta', {}).get('project_status', 'UNKNOWN')})",
        f"Graph version: {compute_graph_version(graph)}",
        f"READY: {counts['READY']} | CLAIMED: {counts['CLAIMED']} | COMPLETED: {counts['COMPLETED']} | FAILED: {counts['FAILED']}",
    ]
    if closed_count:
        lines.append(f"Closed future nodes: {closed_count}")
    if claimed:
        lines.append("Claimed tasks:")
        lines.extend(f"- {entry}" for entry in claimed)
    ready = [nid for nid, node in nodes.items() if node["status"] == "READY" and not node_is_closed(node)]
    if ready:
        lines.append("Ready to start:")
        lines.extend(f"- {nid}: {nodes[nid]['title']}" for nid in ready)
    return "\n".join(lines)


def render_local_view(graph: Dict, center: str) -> str:
    nodes = graph.get("nodes", {})
    if center not in nodes:
        raise ValueError(f"Node {center} does not exist.")
    node = nodes[center]
    parents = node.get("dependencies", [])
    children = find_children(nodes, center)
    lines = [
        f"Graph version: {compute_graph_version(graph)}",
        f"{center}: {node['title']} [{node['status']}]",
        f"Instruction: {node['instruction']}",
        f"Dependencies: {', '.join(parents) if parents else 'None'}",
        f"Children: {', '.join(children) if children else 'None'}",
    ]
    if node_is_closed(node):
        lines.append(f"Future state: {node.get('future_state')}")
    for dep_id in parents:
        parent = nodes[dep_id]
        lines.append(f"- Parent {dep_id} [{parent['status']}]: {parent.get('report') or 'no report'}")
    for child_id in children:
        child = nodes[child_id]
        lines.append(f"- Child {child_id} [{child['status']}]: {child['title']}")
    return "\n".join(lines)


def read_text_arg(inline_text: Optional[str], file_path: Optional[str]) -> str:
    if inline_text is not None:
        return inline_text.strip()
    if file_path == "-":
        return sys.stdin.read().strip()
    if not file_path:
        raise ValueError("A text value or file path is required.")
    return Path(file_path).read_text().strip()


def read_json_arg(file_path: str) -> object:
    raw = sys.stdin.read() if file_path == "-" else Path(file_path).read_text()
    return json.loads(raw)


def cmd_claim_task(args: argparse.Namespace) -> str:
    now = utc_now()
    with locked_graph(args.plan_path) as (graph, _plan_file):
        if not project_active(graph):
            status = graph.get("meta", {}).get("project_status")
            return f"Project is not ACTIVE (status={status}). Resume the project before claiming work."
        unblocked = refresh_ready_nodes(graph)
        closed_scopes = maybe_complete_scopes(graph, now)
        scope_unblocked = refresh_ready_nodes(graph)
        node_id, message = claim_ready_nodes(graph, args.agent_id, now)

    if node_id:
        return message
    extra = []
    if unblocked:
        extra.append(f"Newly READY: {', '.join(unblocked)}.")
    if closed_scopes:
        extra.append(f"Scopes completed: {', '.join(closed_scopes)}.")
    if scope_unblocked:
        extra.append(f"READY after scope closure: {', '.join(scope_unblocked)}.")
    suffix = " " + " ".join(extra) if extra else ""
    return message + suffix


def cmd_release_claim(args: argparse.Namespace) -> str:
    now = utc_now()
    reason = args.reason.strip()
    ensure_string(reason, "reason")
    with locked_graph(args.plan_path) as (graph, _plan_file):
        nodes = graph["nodes"]
        if args.node_id not in nodes:
            raise ValueError(f"Node {args.node_id} does not exist.")
        node = nodes[args.node_id]
        if node["status"] != "CLAIMED":
            raise ValueError(
                f"Node {args.node_id} is not CLAIMED; current status={node['status']}."
            )
        owner = node.get("worker_id")
        if owner != args.agent_id:
            raise ValueError(
                f"Node {args.node_id} is owned by {owner or 'no agent'}, not {args.agent_id}."
            )
        node["status"] = "READY"
        node["released_at"] = isoformat(now)
        node["released_by"] = args.agent_id
        node["release_reason"] = reason
        clear_worker(node)
    return f"Claim released: {args.node_id} is READY."


def cmd_activate_project(args: argparse.Namespace) -> str:
    now = utc_now()
    reason = args.reason.strip()
    ensure_string(reason, "reason")
    ensure_string(args.actor_id, "actor_id")
    with locked_graph(args.plan_path) as (graph, _plan_file):
        meta = graph.setdefault("meta", {})
        current_status = meta.get("project_status")
        if current_status == "ACTIVE":
            return "Project is already ACTIVE."
        if current_status not in {"DRAFT", "PAUSED"}:
            raise ValueError(
                "Only DRAFT or PAUSED projects can be activated; "
                f"current status={current_status}."
            )
        meta["project_status"] = "ACTIVE"
        meta["activated_at"] = isoformat(now)
        meta["activated_by"] = args.actor_id
        meta["activation_reason"] = reason

    return f"Project activated: {current_status} -> ACTIVE by {args.actor_id}."


def cmd_complete_task(args: argparse.Namespace) -> str:
    now = utc_now()
    report = read_text_arg(args.report, args.report_file)
    ensure_string(report, "report")
    new_status = normalize_completion_status(args.status)
    artifacts = args.artifact or []
    if args.judge_id is not None:
        ensure_string(args.judge_id, "judge_id")
    with locked_graph(args.plan_path) as (graph, _plan_file):
        nodes = graph["nodes"]
        if args.node_id not in nodes:
            raise ValueError(f"Node {args.node_id} does not exist.")
        node = nodes[args.node_id]
        if node.get("type") == "SCOPE":
            raise ValueError("Scope nodes close automatically once their children are done.")
        if node["status"] != "CLAIMED":
            raise ValueError(
                f"Node {args.node_id} must be CLAIMED before completion; "
                f"current status={node['status']}."
            )

        node["status"] = new_status
        node["report"] = report
        node["artifacts"] = artifacts
        node["completed_at"] = isoformat(now)
        if args.judge_id is not None:
            node["judged_by"] = args.judge_id
            node["judged_at"] = isoformat(now)
        clear_worker(node)

        if new_status == "FAILED":
            return f"Task {args.node_id} marked as FAILED. Dependent tasks remain blocked."

        unblocked = refresh_ready_nodes(graph)
        closed_scopes = maybe_complete_scopes(graph, now)
        ready_after_parent = refresh_ready_nodes(graph)
        newly_ready = list(dict.fromkeys(unblocked + closed_scopes + ready_after_parent))

    if newly_ready:
        return f"Task {args.node_id} completed. Newly READY: {', '.join(newly_ready)}."
    return f"Task {args.node_id} completed. No downstream tasks were unblocked."


def cmd_decompose_task(args: argparse.Namespace) -> str:
    now = utc_now()
    subtasks = read_json_arg(args.subtasks_file)
    if not isinstance(subtasks, list):
        raise ValueError("subtasks-file must contain a JSON array of subtasks.")
    with locked_graph(args.plan_path) as (graph, _plan_file):
        nodes = graph["nodes"]
        if args.parent_id not in nodes:
            raise ValueError(f"Node {args.parent_id} does not exist.")
        parent = nodes[args.parent_id]
        if parent.get("type") == "SCOPE":
            raise ValueError(f"Node {args.parent_id} is already a scope.")
        if parent["status"] not in {"CLAIMED", "READY"}:
            raise ValueError(
                f"Node {args.parent_id} must be CLAIMED or READY to decompose."
            )

        start_nodes, end_nodes = graft_subgraph(graph, args.parent_id, subtasks, now)
        closed_scopes = maybe_complete_scopes(graph, now)
        refresh_ready_nodes(graph)

    return (
        "Decomposition successful. Parent converted to SCOPE and will close after children finish. "
        f"Start nodes: {', '.join(start_nodes)}. End nodes: {', '.join(end_nodes)}. "
        f"You are released; run 'atp-claim-task' to continue. "
        f"Scopes closed during this operation: {', '.join(closed_scopes) if closed_scopes else 'none'}."
    )


def cmd_apply_future_patch(args: argparse.Namespace) -> str:
    now = utc_now()
    patch = read_json_arg(args.patch_file)
    if not isinstance(patch, dict):
        raise ValueError("patch-file must contain a JSON object.")
    with locked_graph(args.plan_path) as (graph, _plan_file):
        current_graph_version = compute_graph_version(graph)
        if current_graph_version != args.expected_graph_version:
            raise ValueError(
                "Graph version mismatch. "
                f"expected_graph_version={args.expected_graph_version}, "
                f"current_graph_version={current_graph_version}"
            )
        if claimed_node_count(graph) != 0:
            raise ValueError("Future patch apply requires zero_claimed nodes.")

        candidate = copy.deepcopy(graph)
        summary = apply_future_patch_to_graph(
            candidate, patch, args.reason.strip(), args.actor_id, now
        )
        validate_graph(candidate)
        graph.clear()
        graph.update(candidate)
        next_graph_version = compute_graph_version(graph)

    return (
        "Future patch applied. "
        f"graph_version: {args.expected_graph_version} -> {next_graph_version}. "
        f"add_nodes={summary['add_nodes']}, update_nodes={summary['update_nodes']}, "
        f"close_nodes={summary['close_nodes']}, rewire_edges={summary['rewire_edges']}."
    )


def cmd_read_graph(args: argparse.Namespace) -> str:
    graph = load_graph(resolve_paths(args.plan_path)[0])
    if args.view_mode == "full":
        return json.dumps(graph_with_runtime_meta(graph), indent=2)
    if args.view_mode == "local":
        if not args.node_id:
            raise ValueError("node_id is required for local view.")
        return render_local_view(graph, args.node_id)
    raise ValueError("view_mode must be 'full' or 'local'.")


def cmd_status_summary(args: argparse.Namespace) -> str:
    graph = load_graph(resolve_paths(args.plan_path)[0])
    return summarize_status(graph)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local ATP librarian CLI without MCP.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    activate = subparsers.add_parser(
        "atp-activate-project",
        aliases=["activate-project"],
        help="Activate a DRAFT or PAUSED ATP project before claiming work.",
    )
    activate.add_argument("--plan-path", default=None)
    activate.add_argument("--actor-id", required=True)
    activate.add_argument("--reason", required=True)
    activate.set_defaults(handler=cmd_activate_project)

    claim = subparsers.add_parser(
        "atp-claim-task", aliases=["claim-task"], help="Claim the next READY ATP node."
    )
    claim.add_argument("--plan-path", default=None)
    claim.add_argument("--agent-id", required=True)
    claim.set_defaults(handler=cmd_claim_task)

    release = subparsers.add_parser(
        "atp-release-claim",
        aliases=["release-claim"],
        help="Release one stopped runner's ATP claim back to READY.",
    )
    release.add_argument("--plan-path", default=None)
    release.add_argument("--node-id", required=True)
    release.add_argument("--agent-id", required=True)
    release.add_argument("--reason", required=True)
    release.set_defaults(handler=cmd_release_claim)

    complete = subparsers.add_parser(
        "atp-complete-task", aliases=["complete-task"], help="Complete or fail an ATP node."
    )
    complete.add_argument("--plan-path", default=None)
    complete.add_argument("--node-id", required=True)
    complete.add_argument("--status", default="DONE")
    complete.add_argument("--judge-id")
    report_group = complete.add_mutually_exclusive_group(required=True)
    report_group.add_argument("--report")
    report_group.add_argument("--report-file")
    complete.add_argument("--artifact", action="append")
    complete.set_defaults(handler=cmd_complete_task)

    decompose = subparsers.add_parser(
        "atp-decompose-task", aliases=["decompose-task"], help="Decompose a node into subtasks."
    )
    decompose.add_argument("--plan-path", default=None)
    decompose.add_argument("--parent-id", required=True)
    decompose.add_argument("--subtasks-file", required=True)
    decompose.set_defaults(handler=cmd_decompose_task)

    future_patch = subparsers.add_parser(
        "atp-apply-future-patch",
        aliases=["apply-future-patch"],
        help="Apply a bounded ATP v1.4 future patch.",
    )
    future_patch.add_argument("--plan-path", default=None)
    future_patch.add_argument("--expected-graph-version", required=True)
    future_patch.add_argument("--patch-file", required=True)
    future_patch.add_argument("--reason", required=True)
    future_patch.add_argument("--actor-id", required=True)
    future_patch.set_defaults(handler=cmd_apply_future_patch)

    read = subparsers.add_parser(
        "atp-read-graph", aliases=["read-graph"], help="Read the ATP graph."
    )
    read.add_argument("--plan-path", default=None)
    read.add_argument("--view-mode", default="full")
    read.add_argument("--node-id")
    read.set_defaults(handler=cmd_read_graph)

    status = subparsers.add_parser(
        "atp-status-summary",
        aliases=["status-summary"],
        help="Print the ATP status dashboard.",
    )
    status.add_argument("--plan-path", default=None)
    status.set_defaults(handler=cmd_status_summary)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.handler(args)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if result:
        print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
