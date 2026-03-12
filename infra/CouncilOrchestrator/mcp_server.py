#!/usr/bin/env python3
"""
Council Orchestrator MCP Server.

Neutral queue manager for Agent Council sessions. No opinion on content —
purely mechanical: track whose turn it is, drive convergence, collect actions.

Register with Claude Code:
    claude mcp add council-local -- python3 /path/to/infra/CouncilOrchestrator/mcp_server.py
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Resolve DB path from pm-local's location
_HERE      = Path(__file__).parent
_PM_PATH   = _HERE.parent / "ProjectManagement"
sys.path.insert(0, str(_PM_PATH))
import db as pm_db

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("council-local")

DB_PATH = pm_db.DB_PATH


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_conn():
    return pm_db.get_conn()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_active_members(ticket_id: int) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT cm.*, p.name as persona_name
               FROM council_members cm
               JOIN personas p ON p.id = cm.persona_id
               WHERE cm.ticket_id = ? AND cm.state = 'active'
               ORDER BY cm.seat_order""",
            (ticket_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def _turns_this_round(ticket_id: int, round_num: int) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM council_turns WHERE ticket_id = ? AND round = ?",
            (ticket_id, round_num)
        ).fetchall()
        return [dict(r) for r in rows]


def _check_convergence(ticket_id: int, round_num: int) -> bool:
    """Return True if all active members passed (did_comment=0) this round."""
    members = _get_active_members(ticket_id)
    turns   = _turns_this_round(ticket_id, round_num)
    completed_member_ids = {t["member_id"] for t in turns if t["completed_at"]}
    active_member_ids    = {m["id"] for m in members}
    if active_member_ids != completed_member_ids:
        return False
    return all(t["did_comment"] == 0 for t in turns if t["member_id"] in active_member_ids)



# ── Tools ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def start_debate(entity_type: str, entity_id: str) -> str:
    """
    Find the active council ticket for an entity, or report that none exists.
    entity_type: 'project' | 'subproject' | 'ticket'
    entity_id: name (for project) or numeric id (for others)
    Returns the ticket_id to use for all subsequent council calls.
    """
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT id, title FROM tickets WHERE spl_ticket_type = 1 AND entity_type = ? AND entity_id = ?",
            (entity_type, entity_id)
        ).fetchone()
        if row:
            return json.dumps({"status": "found", "ticket_id": row["id"], "title": row["title"]})
    return json.dumps({"status": "not_found", "entity_type": entity_type, "entity_id": entity_id})


@mcp.tool()
def get_debate_state(ticket_id: int) -> str:
    """
    Get current state of a council discussion: active members, turns this round, comment history.
    ticket_id is the PM ticket that represents this council session.
    """
    with _get_conn() as conn:
        ticket = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not ticket:
            return json.dumps({"error": f"Ticket {ticket_id} not found"})
        members = conn.execute(
            """SELECT cm.*, p.name AS persona_name
               FROM council_members cm JOIN personas p ON p.id = cm.persona_id
               WHERE cm.ticket_id = ? AND cm.state = 'active'
               ORDER BY cm.seat_order""",
            (ticket_id,)
        ).fetchall()
        round_num = conn.execute(
            "SELECT COALESCE(MAX(round), 1) FROM council_turns WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()[0]
        turns = conn.execute(
            "SELECT * FROM council_turns WHERE ticket_id = ? AND round = ?",
            (ticket_id, round_num)
        ).fetchall()
        comments = conn.execute(
            "SELECT id, author, content, created_at FROM comments WHERE ticket_id = ? AND is_root = 0 ORDER BY created_at",
            (ticket_id,)
        ).fetchall()
    return json.dumps({
        "ticket_id":    ticket_id,
        "round":        round_num,
        "members":      [dict(m) for m in members],
        "turns":        [dict(t) for t in turns],
        "comments":     [dict(c) for c in comments],
        "converged":    _check_convergence(ticket_id, round_num),
    })


@mcp.tool()
def add_member(ticket_id: int, persona_id: int, provider: str = "claude",
               model: str = "claude-sonnet-4-6", seat_order: int = 0) -> str:
    """Add a persona to a council session."""
    now = _now()
    with _get_conn() as conn:
        persona = conn.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not persona:
            return json.dumps({"error": f"Persona {persona_id} not found"})
        cur = conn.execute(
            "INSERT INTO council_members (ticket_id, persona_id, seat_order, provider, model, state, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'active', ?)",
            (ticket_id, persona_id, seat_order, provider, model, now)
        )
        return json.dumps({"status": "added", "member_id": cur.lastrowid})


@mcp.tool()
def remove_member(ticket_id: int, member_id: int) -> str:
    """Remove (deactivate) a persona from a council session."""
    with _get_conn() as conn:
        conn.execute(
            "UPDATE council_members SET state = 'removed' WHERE id = ? AND ticket_id = ?",
            (member_id, ticket_id)
        )
    return json.dumps({"status": "removed"})


@mcp.tool()
def grant_turn(ticket_id: int, member_id: int | None = None) -> str:
    """
    Orchestrator grants the floor to a member (or to the human if member_id is None).
    Creates a pending turn record.
    """
    with _get_conn() as conn:
        round_num = conn.execute(
            "SELECT COALESCE(MAX(round), 1) FROM council_turns WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO council_turns (ticket_id, member_id, round, did_comment, completed_at) "
            "VALUES (?, ?, ?, 0, NULL)",
            (ticket_id, member_id, round_num)
        )
        turn_id = cur.lastrowid

    if member_id is None:
        return json.dumps({
            "status":  "turn_granted",
            "turn_id": turn_id,
            "speaker": "human",
            "round":   round_num,
        })

    members = _get_active_members(ticket_id)
    member  = next((m for m in members if m["id"] == member_id), None)
    persona_name = member["persona_name"] if member else f"member_{member_id}"

    return json.dumps({
        "status":      "turn_granted",
        "turn_id":     turn_id,
        "speaker":     persona_name,
        "member_id":   member_id,
        "round":       round_num,
        "ticket_id":   ticket_id,
    })


@mcp.tool()
def submit_turn(ticket_id: int, member_id: int | None, did_comment: bool,
                turn_id: int | None = None) -> str:
    """
    Persona (or human) signals they are done speaking.
    did_comment=true means they added a comment; false means they passed.
    """
    now = _now()
    with _get_conn() as conn:
        round_num = conn.execute(
            "SELECT COALESCE(MAX(round), 1) FROM council_turns WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()[0]
        if turn_id:
            conn.execute(
                "UPDATE council_turns SET did_comment = ?, completed_at = ? WHERE id = ?",
                (1 if did_comment else 0, now, turn_id)
            )
        else:
            conn.execute(
                "INSERT INTO council_turns (ticket_id, member_id, round, did_comment, completed_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (ticket_id, member_id, round_num, 1 if did_comment else 0, now)
            )

    converged = _check_convergence(ticket_id, round_num)
    return json.dumps({
        "status":      "converged" if converged else "turn_submitted",
        "did_comment": did_comment,
        "ticket_id":   ticket_id,
        "round":       round_num,
        "converged":   converged,
    })


@mcp.tool()
def advance_round(ticket_id: int) -> str:
    """Advance to the next debate round (called by orchestrator after convergence check)."""
    with _get_conn() as conn:
        current = conn.execute(
            "SELECT COALESCE(MAX(round), 1) FROM council_turns WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()[0]
    return json.dumps({"status": "advanced", "round": current + 1, "ticket_id": ticket_id})


@mcp.tool()
def add_council_comment(ticket_id: int, member_id: int | None, content: str) -> str:
    """
    Add a comment to the council ticket thread.
    Called by personas after receiving grant_turn.
    member_id is None for human comments.
    """
    with _get_conn() as conn:
        if member_id is not None:
            row = conn.execute(
                "SELECT p.name FROM council_members cm JOIN personas p ON p.id = cm.persona_id WHERE cm.id = ?",
                (member_id,)
            ).fetchone()
            author = row["name"] if row else f"member_{member_id}"
        else:
            author = "human"
    try:
        comment = pm_db.add_comment(ticket_id, content, actor="agent", author=author)
        return json.dumps({"status": "commented", "comment_id": comment["id"]})
    except ValueError as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def list_debates(entity_type: str | None = None, entity_id: str | None = None) -> str:
    """List all council tickets, optionally filtered by entity."""
    with _get_conn() as conn:
        if entity_type and entity_id:
            rows = conn.execute(
                "SELECT * FROM tickets WHERE spl_ticket_type = 1 AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC",
                (entity_type, entity_id)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tickets WHERE spl_ticket_type = 1 ORDER BY created_at DESC"
            ).fetchall()
    return json.dumps({"debates": [dict(r) for r in rows]})


@mcp.tool()
def list_personas(project_id: int | None = None) -> str:
    """List personas — global ones always included, plus project-specific if project_id given."""
    with _get_conn() as conn:
        if project_id:
            rows = conn.execute(
                "SELECT * FROM personas WHERE is_global = 1 OR project_id = ? ORDER BY name",
                (project_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM personas WHERE is_global = 1 ORDER BY name"
            ).fetchall()
    return json.dumps({"personas": [dict(r) for r in rows]})


@mcp.tool()
def create_persona(name: str, description: str, template_content: str,
                   is_global: bool = True, project_id: int | None = None) -> str:
    """Create a new persona in the library."""
    now = _now()
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO personas (name, description, template_content, is_global, project_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, description, template_content, 1 if is_global else 0, project_id, now)
        )
        return json.dumps({"status": "created", "persona_id": cur.lastrowid})


@mcp.tool()
def update_persona(persona_id: int, name: str | None = None,
                   description: str | None = None,
                   template_content: str | None = None) -> str:
    """Update a persona's name, description, or template."""
    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not row:
            return json.dumps({"error": f"Persona {persona_id} not found"})
        conn.execute(
            "UPDATE personas SET name = ?, description = ?, template_content = ? WHERE id = ?",
            (name or row["name"], description or row["description"],
             template_content or row["template_content"], persona_id)
        )
    return json.dumps({"status": "updated"})


@mcp.tool()
def delete_persona(persona_id: int) -> str:
    """Delete a persona from the library."""
    with _get_conn() as conn:
        conn.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
    return json.dumps({"status": "deleted"})


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    pm_db.init_db()
    mcp.run()
