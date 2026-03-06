#!/usr/bin/env python3
"""
Plane.so MCP Server — project management interface for coding agents.

Tools:
  get_next_task_for_goal     — claim the next actionable task toward a goal
  set_task_working           — mark a task as actively being worked on
  update_task_progress       — post structured progress update
  set_task_ready_for_review  — mark task ready for reviewer
  submit_review              — reviewer approves (close) or requests changes (reopen)

Env vars (in .env):
  PLANE_API_KEY
  PLANE_WORKSPACE_SLUG
  PLANE_REVIEWER_TOKEN       — required to call submit_review
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import deque

from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Bootstrap: load .env
# ---------------------------------------------------------------------------
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

API_KEY        = os.environ.get("PLANE_API_KEY", "")
WORKSPACE      = os.environ.get("PLANE_WORKSPACE_SLUG", "")
REVIEWER_TOKEN = os.environ.get("PLANE_REVIEWER_TOKEN", "")
API_BASE       = "https://api.plane.so/api/v1"
CLAIM_TTL_SECS = 3600  # 60 minutes

CLAIMS_FILE = Path(__file__).parent / "claims.json"

# Required state names and their Plane groups
REQUIRED_STATES = {
    "In Progress": "started",
    "In Review":   "started",
    "Done":        "completed",
}

# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def _request(method: str, path: str, body: dict | None = None, retries: int = 6):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {
        "X-API-Key": API_KEY,
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** attempt
                print(f"[rate limited, retry in {wait}s]", file=sys.stderr)
                time.sleep(wait)
                continue
            body_text = e.read().decode()
            raise RuntimeError(f"HTTP {e.code} {method} {url}: {body_text}")
    raise RuntimeError(f"Exceeded retries for {url}")


def api_get(path):    return _request("GET", path)
def api_post(path, body):   return _request("POST", path, body)
def api_patch(path, body):  return _request("PATCH", path, body)


def fetch_all_pages(path: str) -> list:
    results = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        data = api_get(f"{path}{sep}page={page}&per_page=100")
        if isinstance(data, list):
            results.extend(data)
            break
        batch = data.get("results", [])
        results.extend(batch)
        if not data.get("next"):
            break
        page += 1
    return results


# ---------------------------------------------------------------------------
# State: loaded once at startup
# ---------------------------------------------------------------------------

# project_identifier → {state_name → state_id}
_project_states: dict[str, dict[str, str]] = {}
# project_identifier → project dict
_projects_by_identifier: dict[str, dict] = {}
# project_id → project identifier
_projects_by_id: dict[str, str] = {}
# issue_id → enriched issue dict (_ref, _pid, _identifier)
_issue_cache: dict[str, dict] = {}


def _bootstrap():
    print("[plane_mcp] Loading projects...", file=sys.stderr)
    allowed = {l.strip() for l in (Path(__file__).parent / "projects.list").read_text().splitlines() if l.strip()}

    all_projects = fetch_all_pages(f"/workspaces/{WORKSPACE}/projects/")
    projects = [p for p in all_projects if p.get("identifier") in allowed]

    for p in projects:
        pid        = p["id"]
        identifier = p["identifier"]
        _projects_by_identifier[identifier] = p
        _projects_by_id[pid] = identifier

        # Ensure required states exist
        states = fetch_all_pages(f"/workspaces/{WORKSPACE}/projects/{pid}/states/")
        state_map = {s["name"]: s["id"] for s in states}

        for name, group in REQUIRED_STATES.items():
            if name not in state_map:
                print(f"[plane_mcp] Creating state '{name}' for {identifier}", file=sys.stderr)
                created = api_post(f"/workspaces/{WORKSPACE}/projects/{pid}/states/", {"name": name, "group": group, "color": "#6b7280"})
                state_map[name] = created["id"]

        _project_states[identifier] = state_map

    # Prefetch all issues
    print("[plane_mcp] Loading issues...", file=sys.stderr)
    for p in projects:
        pid        = p["id"]
        identifier = p["identifier"]
        issues = fetch_all_pages(f"/workspaces/{WORKSPACE}/projects/{pid}/issues/")
        for i in issues:
            ref = f"{identifier}-{i['sequence_id']}"
            _issue_cache[i["id"]] = {**i, "_ref": ref, "_pid": pid, "_identifier": identifier}

    print(f"[plane_mcp] Ready. {len(_issue_cache)} issues across {len(projects)} projects.", file=sys.stderr)


# ---------------------------------------------------------------------------
# Claims registry (persisted to claims.json)
# ---------------------------------------------------------------------------

def _load_claims() -> dict:
    if CLAIMS_FILE.exists():
        try:
            return json.loads(CLAIMS_FILE.read_text())
        except Exception:
            pass
    return {}


def _save_claims(claims: dict):
    CLAIMS_FILE.write_text(json.dumps(claims, indent=2))


def _is_claimed(task_ref: str, claims: dict) -> bool:
    entry = claims.get(task_ref)
    if not entry:
        return False
    claimed_at = datetime.fromisoformat(entry["claimed_at"])
    return (datetime.now(timezone.utc) - claimed_at).total_seconds() < CLAIM_TTL_SECS


def _claim(task_ref: str, goal: str, claims: dict):
    claims[task_ref] = {
        "claimed_at": datetime.now(timezone.utc).isoformat(),
        "goal": goal,
    }
    _save_claims(claims)


# ---------------------------------------------------------------------------
# Dependency tree logic
# ---------------------------------------------------------------------------

def _resolve_ref(ref: str) -> dict | None:
    proj_str, _, seq_str = ref.rpartition("-")
    project = _projects_by_identifier.get(proj_str.upper())
    if not project:
        return None
    pid = project["id"]
    try:
        seq = int(seq_str)
    except ValueError:
        return None
    return next((i for i in _issue_cache.values() if i["_pid"] == pid and i["sequence_id"] == seq), None)


def _get_relations(issue: dict) -> dict:
    pid = issue["_pid"]
    iid = issue["id"]
    return api_get(f"/workspaces/{WORKSPACE}/projects/{pid}/issues/{iid}/relations/")


def _is_done(issue: dict) -> bool:
    identifier = issue["_identifier"]
    state_map = _project_states.get(identifier, {})
    done_id = state_map.get("Done")
    return issue.get("state") == done_id


def _find_next_actionable(goal_ref: str, claims: dict) -> dict | None:
    """
    BFS up the blocked_by tree. Returns the best unclaimed, open leaf ticket
    (i.e. an open ticket whose blocked_by dependencies are all done).
    """
    start = _resolve_ref(goal_ref)
    if not start:
        return None

    visited   = set()
    all_nodes = {start["id"]: start}
    parents   = {}  # issue_id → set of blocked_by issue ids
    queue     = deque([start["id"]])
    visited.add(start["id"])

    while queue:
        cid     = queue.popleft()
        current = all_nodes[cid]
        rels    = _get_relations(current)
        blocked_by_ids = rels.get("blocked_by", [])
        parents[cid] = set(blocked_by_ids)

        for bid in blocked_by_ids:
            if bid not in visited:
                visited.add(bid)
                resolved = _issue_cache.get(bid)
                if resolved:
                    all_nodes[bid] = resolved
                    queue.append(bid)

    # Collect open leaves: open tickets with all deps done
    leaves = []
    for iid, deps in parents.items():
        issue = all_nodes.get(iid)
        if not issue or _is_done(issue):
            continue
        all_deps_done = all(
            _is_done(all_nodes[d]) for d in deps if d in all_nodes
        )
        if all_deps_done:
            leaves.append(issue)

    # Filter out claimed ones
    unclaimed = [l for l in leaves if not _is_claimed(l["_ref"], claims)]
    if not unclaimed:
        return None

    # Pick: sort by ref for stable, deterministic selection
    unclaimed.sort(key=lambda i: i["_ref"])
    return unclaimed[0]


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------

def _fetch_comments(issue: dict) -> list[dict]:
    pid = issue["_pid"]
    iid = issue["id"]
    try:
        comments = fetch_all_pages(f"/workspaces/{WORKSPACE}/projects/{pid}/issues/{iid}/comments/")
        return [{"actor": c.get("actor_detail", {}).get("display_name", "unknown"),
                 "created_at": c.get("created_at", ""),
                 "comment": c.get("comment_stripped") or c.get("comment_html", "")}
                for c in sorted(comments, key=lambda c: c.get("created_at", ""))]
    except Exception:
        return []


def _post_comment(issue: dict, text: str):
    pid = issue["_pid"]
    iid = issue["id"]
    api_post(f"/workspaces/{WORKSPACE}/projects/{pid}/issues/{iid}/comments/",
             {"comment_html": f"<p>{text}</p>"})


def _set_state(issue: dict, state_name: str):
    identifier = issue["_identifier"]
    state_id = _project_states[identifier][state_name]
    pid = issue["_pid"]
    iid = issue["id"]
    updated = api_patch(f"/workspaces/{WORKSPACE}/projects/{pid}/issues/{iid}/", {"state": state_id})
    # Update cache
    _issue_cache[iid] = {**_issue_cache[iid], "state": state_id}
    return updated


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP("Plane Project Manager")


@mcp.tool()
def get_next_task_for_goal(goal: str) -> dict:
    """
    Returns the next unclaimed, actionable task toward the given goal ticket
    (e.g. 'MLLM-1'). Claims it for 60 minutes so other agents won't receive
    the same task. Includes the full comment chain for context.

    Returns a dict with:
      task_ref, name, description, state, claimed_until, comments[]
    Or {"status": "none_available", "reason": "..."} if nothing is ready.
    """
    claims = _load_claims()
    issue  = _find_next_actionable(goal, claims)

    if not issue:
        # Check if the goal itself is done
        goal_issue = _resolve_ref(goal)
        if goal_issue and _is_done(goal_issue):
            return {"status": "goal_complete", "reason": f"{goal} is already done."}
        return {"status": "none_available", "reason": "All open tasks are currently claimed or awaiting dependency completion. Try again soon."}

    ref = issue["_ref"]
    _claim(ref, goal, claims)

    comments = _fetch_comments(issue)
    claimed_until = (datetime.now(timezone.utc) + timedelta(seconds=CLAIM_TTL_SECS)).isoformat()

    return {
        "task_ref":      ref,
        "name":          issue["name"],
        "description":   issue.get("description_stripped") or issue.get("description_html") or "",
        "priority":      issue.get("priority", "none"),
        "state":         _get_state_name(issue),
        "claimed_until": claimed_until,
        "comments":      comments,
    }


@mcp.tool()
def set_task_working(task_ref: str) -> dict:
    """
    Mark a task as actively being worked on (moves to 'In Progress' in Plane).
    Call this once you have received a task and are starting work.
    """
    issue = _resolve_ref(task_ref)
    if not issue:
        return {"status": "error", "reason": f"Task {task_ref} not found."}
    _set_state(issue, "In Progress")
    _post_comment(issue, f"🔧 Agent started work on this task.")
    return {"status": "ok", "task_ref": task_ref, "state": "In Progress"}


@mcp.tool()
def update_task_progress(
    task_ref: str,
    git_branch: str,
    comments: str,
    files_created: list[str] | None = None,
    files_modified: list[str] | None = None,
) -> dict:
    """
    Post a structured progress update to a task. The git_branch and comments
    fields are required. files_created and files_modified are optional lists
    of file paths.
    """
    if not git_branch:
        return {"status": "error", "reason": "git_branch is required."}
    if not comments:
        return {"status": "error", "reason": "comments is required."}

    issue = _resolve_ref(task_ref)
    if not issue:
        return {"status": "error", "reason": f"Task {task_ref} not found."}

    lines = [f"📋 Progress update"]
    lines.append(f"Branch: {git_branch}")
    if files_created:
        lines.append(f"Files created: {', '.join(files_created)}")
    if files_modified:
        lines.append(f"Files modified: {', '.join(files_modified)}")
    lines.append(f"\n{comments}")

    _post_comment(issue, "\n".join(lines))
    return {"status": "ok", "task_ref": task_ref}


@mcp.tool()
def set_task_ready_for_review(task_ref: str, summary: str) -> dict:
    """
    Mark a task as ready for review (moves to 'In Review' in Plane).
    Provide a brief summary of what was completed.
    """
    issue = _resolve_ref(task_ref)
    if not issue:
        return {"status": "error", "reason": f"Task {task_ref} not found."}
    _set_state(issue, "In Review")
    _post_comment(issue, f"✅ Ready for review.\n\n{summary}")
    return {"status": "ok", "task_ref": task_ref, "state": "In Review"}


@mcp.tool()
def submit_review(
    task_ref: str,
    reviewer_token: str,
    comment: str,
    decision: str,
) -> dict:
    """
    Submit a review for a task. Requires the reviewer token.

    decision must be either:
      'close'  — approve and mark Done in Plane
      'reopen' — request changes; moves back to In Progress with your comment

    When reopened, the task re-enters the dependency chain and agents working
    on dependent goals will be forced to address it first.
    """
    if not REVIEWER_TOKEN:
        return {"status": "error", "reason": "No reviewer token configured on this server."}
    if reviewer_token != REVIEWER_TOKEN:
        return {"status": "error", "reason": "Invalid reviewer token."}
    if decision not in ("close", "reopen"):
        return {"status": "error", "reason": "decision must be 'close' or 'reopen'."}

    issue = _resolve_ref(task_ref)
    if not issue:
        return {"status": "error", "reason": f"Task {task_ref} not found."}

    if decision == "close":
        _set_state(issue, "Done")
        _post_comment(issue, f"✅ Reviewed and closed.\n\n{comment}")
        # Release claim if any
        claims = _load_claims()
        claims.pop(task_ref, None)
        _save_claims(claims)
        return {"status": "ok", "task_ref": task_ref, "state": "Done"}
    else:  # reopen
        _set_state(issue, "In Progress")
        _post_comment(issue, f"🔄 Returned for changes.\n\n{comment}")
        # Reset claim so it can be reassigned immediately
        claims = _load_claims()
        claims.pop(task_ref, None)
        _save_claims(claims)
        return {"status": "ok", "task_ref": task_ref, "state": "In Progress", "note": "Task is back in the dependency chain."}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_state_name(issue: dict) -> str:
    identifier = issue["_identifier"]
    state_map  = _project_states.get(identifier, {})
    sid        = issue.get("state")
    for name, mid in state_map.items():
        if mid == sid:
            return name
    return "unknown"


# ---------------------------------------------------------------------------
# Project and ticket management tools
# ---------------------------------------------------------------------------

@mcp.tool()
def create_project(name: str, identifier: str, description: str = "") -> dict:
    """
    Create a new Plane project and add it to the tracked projects list.

    identifier must be uppercase letters only, e.g. 'MNEW'. It will be used
    as the prefix for all ticket refs in this project (e.g. MNEW-1).
    """
    identifier = identifier.upper().strip()
    if not identifier.isalpha():
        return {"status": "error", "reason": "identifier must contain only letters (e.g. 'MNEW')."}
    if identifier in _projects_by_identifier:
        return {"status": "error", "reason": f"Project {identifier} already exists."}

    body = {"name": name, "identifier": identifier, "network": 2}
    if description:
        body["description"] = description

    project = api_post(f"/workspaces/{WORKSPACE}/projects/", body)
    pid = project["id"]

    # Create required states
    states = fetch_all_pages(f"/workspaces/{WORKSPACE}/projects/{pid}/states/")
    state_map = {s["name"]: s["id"] for s in states}
    for sname, group in REQUIRED_STATES.items():
        if sname not in state_map:
            created = api_post(f"/workspaces/{WORKSPACE}/projects/{pid}/states/",
                               {"name": sname, "group": group, "color": "#6b7280"})
            state_map[sname] = created["id"]

    # Update in-memory state
    _projects_by_identifier[identifier] = project
    _projects_by_id[pid] = identifier
    _project_states[identifier] = state_map

    # Append to projects.list
    list_file = Path(__file__).parent / "projects.list"
    existing = list_file.read_text().strip()
    list_file.write_text(existing + ("\n" if existing else "") + identifier + "\n")

    return {"status": "ok", "identifier": identifier, "project_id": pid, "name": name}


@mcp.tool()
def create_ticket(
    project_identifier: str,
    name: str,
    description: str = "",
    priority: str = "none",
) -> dict:
    """
    Create a new ticket (issue) in an existing project.

    project_identifier: e.g. 'MCORE'
    priority: 'urgent', 'high', 'medium', 'low', or 'none'
    Returns the new ticket ref (e.g. 'MCORE-12').
    """
    identifier = project_identifier.upper().strip()
    project = _projects_by_identifier.get(identifier)
    if not project:
        return {"status": "error", "reason": f"Project '{identifier}' not found. Is it in projects.list?"}

    valid_priorities = {"urgent", "high", "medium", "low", "none"}
    if priority not in valid_priorities:
        return {"status": "error", "reason": f"priority must be one of: {', '.join(sorted(valid_priorities))}"}

    pid = project["id"]
    body: dict = {"name": name, "priority": priority}
    if description:
        body["description_html"] = f"<p>{description}</p>"

    issue = api_post(f"/workspaces/{WORKSPACE}/projects/{pid}/issues/", body)
    ref = f"{identifier}-{issue['sequence_id']}"

    # Add to cache
    _issue_cache[issue["id"]] = {**issue, "_ref": ref, "_pid": pid, "_identifier": identifier}

    return {"status": "ok", "task_ref": ref, "name": name, "project": identifier}


@mcp.tool()
def set_dependency(ticket_ref: str, blocked_by_ref: str) -> dict:
    """
    Set a dependency between two tickets: ticket_ref is blocked by blocked_by_ref.
    This means blocked_by_ref must be completed before ticket_ref can start.

    Both tickets must already exist. Cross-project dependencies are supported.
    """
    issue = _resolve_ref(ticket_ref)
    if not issue:
        return {"status": "error", "reason": f"Ticket '{ticket_ref}' not found."}

    blocker = _resolve_ref(blocked_by_ref)
    if not blocker:
        return {"status": "error", "reason": f"Ticket '{blocked_by_ref}' not found."}

    if issue["id"] == blocker["id"]:
        return {"status": "error", "reason": "A ticket cannot depend on itself."}

    pid = issue["_pid"]
    iid = issue["id"]

    api_post(
        f"/workspaces/{WORKSPACE}/projects/{pid}/issues/{iid}/relations/",
        {"relation_type": "blocked_by", "issues": [blocker["id"]]},
    )

    return {
        "status": "ok",
        "ticket": ticket_ref,
        "blocked_by": blocked_by_ref,
        "meaning": f"{ticket_ref} cannot start until {blocked_by_ref} is done.",
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if not API_KEY or not WORKSPACE:
        print("Error: PLANE_API_KEY and PLANE_WORKSPACE_SLUG must be set.", file=sys.stderr)
        sys.exit(1)
    _bootstrap()
    mcp.run(transport="stdio")
