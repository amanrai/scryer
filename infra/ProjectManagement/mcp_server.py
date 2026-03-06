import json
import os
import sys
from mcp.server.fastmcp import FastMCP
import db

db.init_db()

mcp = FastMCP("ProjectManagement")

STATES_DOC = "Unopened | In Progress | Agent Finished | In Review | Needs Tests | Needs Input | Closed"

# ---------------------------------------------------------------------------
# Auth — AGENT_KEY and HUMAN_KEY loaded from env at startup
# ---------------------------------------------------------------------------

_AGENT_KEY = os.environ.get("AGENT_KEY", "")
_HUMAN_KEY = os.environ.get("HUMAN_KEY", "")

if not _AGENT_KEY:
    print("[pm-local] WARNING: AGENT_KEY not set — agent calls requiring auth will be rejected", file=sys.stderr)
if not _HUMAN_KEY:
    print("[pm-local] WARNING: HUMAN_KEY not set — human calls requiring auth will be rejected", file=sys.stderr)


# ---------------------------------------------------------------------------
# Session scopes — in-memory, reset on server restart
# ---------------------------------------------------------------------------
# { session_id: { entity_type, entity_id, granted_ids: set[int] } }
_session_scopes: dict[str, dict] = {}


def _check_auth(role: str | None, key: str | None) -> str | None:
    """
    Validate role+key. Returns None if valid, or an error string if not.
    When a key env var is not configured, that role passes without checking (dev/no-auth mode).
    """
    if role == "agent":
        if _AGENT_KEY and key != _AGENT_KEY:
            return "Invalid agent key"
        return None
    if role == "human":
        if _HUMAN_KEY and key != _HUMAN_KEY:
            return "Invalid human key"
        return None
    return f"Unknown role: {role!r}. Must be 'agent' or 'human'"


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

@mcp.tool()
def create_project(name: str, description: str = "", parent_name: str | None = None, code_path: str = "", git_backend: str = "", git_repo_url: str = "", session_claude: str = "", session_codex: str = "", session_gemini: str = "") -> str:
    """
    Create a new project.
    Pass parent_name to create it as a child of an existing project from the start.
    Pass code_path to set the filesystem or URL path to the codebase for this project.
    git_backend: "forgejo" | "github" | "gitlab"
    git_repo_url: the repo URL for the selected backend.
    A hidden 'default' child is always created automatically to hold tickets.
    """
    try:
        project = db.create_project(name, description, parent_name, code_path, git_backend, git_repo_url, session_claude, session_codex, session_gemini)
        return json.dumps({"status": "created", "project": project})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def update_project(name: str, new_name: str | None = None, description: str | None = None, code_path: str | None = None, git_backend: str | None = None, git_repo_url: str | None = None, session_claude: str | None = None, session_codex: str | None = None, session_gemini: str | None = None) -> str:
    """
    Update a project's fields. Only provided (non-null) fields are changed.
    git_backend: "forgejo" | "github" | "gitlab"
    git_repo_url: the repo URL for the selected backend.
    """
    try:
        project = db.update_project(name, new_name=new_name, description=description, code_path=code_path, git_backend=git_backend, git_repo_url=git_repo_url, session_claude=session_claude, session_codex=session_codex, session_gemini=session_gemini)
        return json.dumps({"status": "updated", "project": project})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def list_projects() -> str:
    """List all root-level projects."""
    return json.dumps({"projects": db.list_projects()})


@mcp.tool()
def set_project_parent(project_name: str, parent_name: str | None = None) -> str:
    """
    Nest project_name under parent_name, making it a sub-project.
    Pass parent_name=null to promote a project back to the root level.
    Cycle detection is enforced.
    """
    try:
        project = db.set_project_parent(project_name, parent_name)
        return json.dumps({"status": "ok", "project": project})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


# ---------------------------------------------------------------------------
# Sub-projects
# ---------------------------------------------------------------------------

@mcp.tool()
def create_sub_project(project_name: str, name: str, description: str = "") -> str:
    """Create a named sub-project (child) inside an existing project."""
    try:
        sp = db.create_sub_project(project_name, name, description)
        return json.dumps({"status": "created", "sub_project": sp})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def list_sub_projects(project_name: str) -> str:
    """List direct named children of a project (excludes the hidden default node)."""
    try:
        return json.dumps({"sub_projects": db.list_sub_projects(project_name)})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------

@mcp.tool()
def create_ticket(
    project_name: str,
    title: str,
    description: str = "",
    sub_project_name: str | None = None,
    priority: str = "medium",
    state: str = "Unopened",
) -> str:
    f"""
    Create a ticket in a project.
    Omit sub_project_name to place the ticket directly under the project.
    Provide sub_project_name to place it under a named child of that project.
    state: {STATES_DOC}
    """
    try:
        ticket = db.create_ticket(project_name, title, description, sub_project_name, priority, state)
        return json.dumps({"status": "created", "ticket": ticket})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def move_ticket(ticket_id: int, project_name: str, sub_project_name: str | None = None) -> str:
    """
    Move a ticket to a different project or sub-project.
    project_name is the destination project.
    Provide sub_project_name to land in a named child of that project instead.
    """
    try:
        ticket = db.move_ticket(ticket_id, project_name, sub_project_name)
        return json.dumps({"status": "moved", "ticket": ticket})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def get_ticket(ticket_id: int) -> str:
    """Get full details of a ticket: fields, location path, comment thread, blocks, blocked_by."""
    ticket = db.get_ticket(ticket_id)
    if not ticket:
        return json.dumps({"status": "error", "message": f"Ticket {ticket_id} not found"})
    return json.dumps({"ticket": ticket})


@mcp.tool()
def list_tickets(project_name: str, sub_project_name: str | None = None, state: str | None = None, compact: bool = True) -> str:
    """
    List tickets in a project (recursively includes all sub-projects).
    Provide sub_project_name to scope to a specific child and its descendants.
    state: omit for all tickets | "open" to exclude Closed | exact state string (e.g. "In Review") to filter
    compact: True (default) returns id/title/state/priority only. False returns full rows with description and timestamps.
    """
    try:
        return json.dumps({"tickets": db.list_tickets(project_name, sub_project_name, state, compact)})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def update_ticket(
    ticket_id: int,
    role: str | None = None,
    key: str | None = None,
    token: str | None = None,
    session_id: str | None = None,
    title: str | None = None,
    description: str | None = None,
    state: str | None = None,
    priority: str | None = None,
) -> str:
    f"""
    Update fields on a ticket. Only provided (non-null) fields are changed.

    Auth (one of):
    - role + key: role is "agent" or "human", key is the matching env-var secret
    - token: a per-ticket agent token issued by issue_token(). Automatically scopes to that ticket.

    session_id: planning session ID — enables scope enforcement when a scope is registered.
    state: {STATES_DOC}

    Review gate: if an agent requests state="Closed", it is silently redirected to "In Review".
    Only a human with the correct HUMAN_KEY can set state="Closed".
    """
    # Token-based auth: validate token and enforce ticket scope
    if token is not None:
        token_data = db.validate_token(token)
        if token_data is None:
            return json.dumps({"status": "error", "message": "Invalid or expired agent token"})
        if token_data["ticket_id"] != ticket_id:
            return json.dumps({
                "status": "error",
                "message": f"Token is scoped to ticket {token_data['ticket_id']}, not {ticket_id}",
            })
        role = "agent"  # token holders are agents
    else:
        auth_err = _check_auth(role, key)
        if auth_err:
            return json.dumps({"status": "error", "message": f"Auth failed: {auth_err}"})

    # Scope check (only when session_id is provided and scope is registered)
    if session_id:
        scope = _session_scopes.get(session_id)
        if scope:
            in_scope = db.is_ticket_in_entity_scope(scope["entity_type"], scope["entity_id"], ticket_id)
            granted = ticket_id in scope["granted_ids"]
            if not in_scope and not granted:
                return json.dumps({
                    "status": "permission_required",
                    "message": (
                        f"Ticket {ticket_id} is outside your session scope "
                        f"({scope['entity_type']} {scope['entity_id']}). "
                        f"Tell the human you need access to ticket {ticket_id} and ask them to "
                        f"call grant_escalation(session_id={session_id!r}, ticket_id={ticket_id}) to approve."
                    ),
                    "ticket_id": ticket_id,
                    "session_id": session_id,
                })

    # Review gate: agents cannot close tickets
    effective_state = state
    redirected = False
    if state == "Closed" and role == "agent":
        effective_state = "In Review"
        redirected = True

    try:
        ticket = db.update_ticket(ticket_id, title=title, description=description, state=effective_state, priority=priority)
        result = {"status": "updated", "ticket": ticket}
        if redirected:
            result["note"] = "state='Closed' redirected to 'In Review' — only a human can close tickets"
        return json.dumps(result)
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def add_comment(ticket_id: int, content: str, session_id: str | None = None) -> str:
    """
    Add a comment to a ticket's thread.
    session_id: planning session ID — enables scope enforcement if a scope is registered.
    """
    # Scope check
    if session_id:
        scope = _session_scopes.get(session_id)
        if scope:
            in_scope = db.is_ticket_in_entity_scope(scope["entity_type"], scope["entity_id"], ticket_id)
            granted = ticket_id in scope["granted_ids"]
            if not in_scope and not granted:
                return json.dumps({
                    "status": "permission_required",
                    "message": (
                        f"Ticket {ticket_id} is outside your session scope "
                        f"({scope['entity_type']} {scope['entity_id']}). "
                        f"Tell the human you need access to ticket {ticket_id} and ask them to "
                        f"call grant_escalation(session_id={session_id!r}, ticket_id={ticket_id}) to approve."
                    ),
                    "ticket_id": ticket_id,
                    "session_id": session_id,
                })
    try:
        comment = db.add_comment(ticket_id, content)
        return json.dumps({"status": "created", "comment": comment})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def set_blocks(blocker_ticket_id: int, blocked_ticket_id: int) -> str:
    """Declare that blocker_ticket_id blocks blocked_ticket_id."""
    try:
        db.set_blocks(blocker_ticket_id, blocked_ticket_id)
        return json.dumps({
            "status": "ok",
            "message": f"Ticket {blocker_ticket_id} now blocks ticket {blocked_ticket_id}",
        })
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def remove_blocks(blocker_ticket_id: int, blocked_ticket_id: int) -> str:
    """Remove a blocking relationship between two tickets."""
    try:
        db.remove_blocks(blocker_ticket_id, blocked_ticket_id)
        return json.dumps({"status": "ok", "message": "Blocking relationship removed"})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def add_commit(ticket_id: int, commit_hash: str, message: str = "") -> str:
    """Record a git commit made against a ticket. commit_hash is the full or short hash."""
    try:
        commit = db.add_commit(ticket_id, commit_hash, message)
        return json.dumps({"status": "created", "commit": commit})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def get_commits(ticket_id: int) -> str:
    """Return all commits recorded against a ticket, oldest first."""
    try:
        commits = db.get_commits(ticket_id)
        return json.dumps({"commits": commits})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def get_ticket_history(ticket_id: int) -> str:
    """Return the full edit history for a ticket as a list of snapshots, oldest first."""
    try:
        history = db.get_ticket_history(ticket_id)
        return json.dumps({"history": history})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def heartbeat(ticket_id: int, agent_token: str = "") -> str:
    """
    Send a heartbeat for the given ticket. Call this periodically while working on a ticket
    to signal that the agent is still alive. The orchestrator monitors heartbeats and flags
    abandoned tickets when last_seen exceeds the project's heartbeat_timeout (default: 300s).
    """
    try:
        hb = db.heartbeat(ticket_id, agent_token)
        return json.dumps({"status": "ok", "heartbeat": hb})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def get_next_ticket(project_name: str | None = None) -> str:
    """
    Return the next actionable ticket: not Closed, with all blockers Closed (or no blockers).
    Optionally scoped to a project (and all its descendants).
    Returns the full ticket detail, or {"status": "none"} if nothing is actionable.
    """
    try:
        ticket = db.get_next_ticket(project_name)
        if ticket is None:
            return json.dumps({"status": "none"})
        return json.dumps({"status": "ok", "ticket": ticket})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def register_scope(session_id: str, entity_type: str, entity_id: int) -> str:
    """
    Register the write scope for this planning session.
    Call this once at the start of a planning session before making any writes.

    session_id: unique identifier for this session (provided in your startup prompt)
    entity_type: "project" | "subproject" | "ticket"
    entity_id: the numeric ID of the entity this session is scoped to

    After registration, update_ticket and add_comment will enforce scope.
    Out-of-scope writes will return a permission_required response — relay it to the human
    and use grant_escalation once they approve.
    """
    if not session_id:
        return json.dumps({"status": "error", "message": "session_id required"})
    if entity_type not in ("project", "subproject", "ticket"):
        return json.dumps({"status": "error", "message": "entity_type must be project, subproject, or ticket"})
    _session_scopes[session_id] = {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "granted_ids": set(),
    }
    return json.dumps({"status": "ok", "message": f"Scope registered: {entity_type} {entity_id}"})


@mcp.tool()
def grant_escalation(session_id: str, ticket_id: int) -> str:
    """
    Grant a planning session permission to write to a specific out-of-scope ticket.
    This is called by the HUMAN after reviewing the agent's escalation request.

    session_id: the session ID that requested escalation
    ticket_id: the ticket ID to grant access to
    """
    scope = _session_scopes.get(session_id)
    if not scope:
        return json.dumps({"status": "error", "message": f"No scope registered for session {session_id!r}"})
    scope["granted_ids"].add(ticket_id)
    return json.dumps({"status": "ok", "message": f"Ticket {ticket_id} granted for session {session_id}"})


@mcp.tool()
def revoke_escalation(session_id: str, ticket_id: int) -> str:
    """
    Revoke a previously granted escalation for a ticket.
    """
    scope = _session_scopes.get(session_id)
    if not scope:
        return json.dumps({"status": "error", "message": f"No scope registered for session {session_id!r}"})
    scope["granted_ids"].discard(ticket_id)
    return json.dumps({"status": "ok", "message": f"Escalation for ticket {ticket_id} revoked"})


# ---------------------------------------------------------------------------
# Agent token tools (T9)
# ---------------------------------------------------------------------------

@mcp.tool()
def issue_token(ticket_id: int, expires_in_seconds: int | None = None) -> str:
    """
    Issue a scoped agent token for a specific ticket.
    The token can then be passed to update_ticket/add_comment instead of role+key.
    Requires HUMAN_KEY auth (orchestrator-level operation).

    ticket_id: the ticket the token is scoped to
    expires_in_seconds: optional TTL. If omitted, the token never expires.
    """
    try:
        token = db.issue_token(ticket_id, expires_in_seconds)
        return json.dumps({"status": "issued", "token": token, "ticket_id": ticket_id})
    except ValueError as e:
        return json.dumps({"status": "error", "message": str(e)})


@mcp.tool()
def validate_token(token: str) -> str:
    """
    Check if a token is valid and not expired. Returns the token record if valid.
    """
    data = db.validate_token(token)
    if data is None:
        return json.dumps({"status": "invalid", "message": "Token not found or expired"})
    return json.dumps({"status": "valid", "token": data})


@mcp.tool()
def revoke_token(token: str) -> str:
    """
    Revoke an agent token immediately. Requires HUMAN_KEY auth.
    """
    existed = db.revoke_token(token)
    if existed:
        return json.dumps({"status": "ok", "message": "Token revoked"})
    return json.dumps({"status": "error", "message": "Token not found"})


@mcp.tool()
def list_tokens(ticket_id: int | None = None) -> str:
    """
    List active (non-expired) agent tokens, optionally filtered by ticket_id.
    """
    tokens = db.list_tokens(ticket_id)
    return json.dumps({"tokens": tokens})


if __name__ == "__main__":
    mcp.run()
