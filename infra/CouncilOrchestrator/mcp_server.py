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

def _get_debate(debate_id: int) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM council_debates WHERE id = ?", (debate_id,)
        ).fetchone()
        return dict(row) if row else None


def _get_active_members(debate_id: int) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT cm.*, p.name as persona_name
               FROM council_members cm
               JOIN personas p ON p.id = cm.persona_id
               WHERE cm.debate_id = ? AND cm.state = 'active'
               ORDER BY cm.seat_order""",
            (debate_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def _turns_this_round(debate_id: int, round_num: int) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM council_turns WHERE debate_id = ? AND round = ?",
            (debate_id, round_num)
        ).fetchall()
        return [dict(r) for r in rows]


def _check_convergence(debate_id: int, round_num: int) -> bool:
    """Return True if all active members passed (did_comment=0) this round."""
    members = _get_active_members(debate_id)
    turns   = _turns_this_round(debate_id, round_num)
    completed_member_ids = {t["member_id"] for t in turns if t["completed_at"]}
    active_member_ids    = {m["id"] for m in members}
    if active_member_ids != completed_member_ids:
        return False
    return all(t["did_comment"] == 0 for t in turns if t["member_id"] in active_member_ids)


def _detect_action_conflicts(debate_id: int) -> None:
    """Mark conflicting actions: same ticket, contradictory types (e.g. close vs reopen)."""
    with _get_conn() as conn:
        actions = conn.execute(
            "SELECT * FROM council_actions WHERE debate_id = ? AND status = 'pending'",
            (debate_id,)
        ).fetchall()

        # Group by ticket_id
        by_ticket: dict[int, list] = {}
        for a in actions:
            if a["ticket_id"]:
                by_ticket.setdefault(a["ticket_id"], []).append(dict(a))

        for tid, acts in by_ticket.items():
            types = [a["action_type"] for a in acts]
            if len(set(types)) > 1:
                # Multiple different action types on same ticket → conflict
                for i, a in enumerate(acts):
                    for b in acts[i + 1:]:
                        if a["action_type"] != b["action_type"]:
                            conn.execute(
                                "UPDATE council_actions SET conflicts_with = ? WHERE id = ?",
                                (b["id"], a["id"])
                            )
                            conn.execute(
                                "UPDATE council_actions SET conflicts_with = ? WHERE id = ?",
                                (a["id"], b["id"])
                            )


# ── Tools ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def start_debate(entity_type: str, entity_id: str) -> str:
    """
    Create or resume a Council Debate for an entity.
    entity_type: 'project' | 'subproject' | 'ticket'
    entity_id: name (for project) or numeric id (for others)
    Returns debate id and current state.
    """
    now = _now()
    with _get_conn() as conn:
        existing = conn.execute(
            "SELECT * FROM council_debates WHERE entity_type = ? AND entity_id = ?",
            (entity_type, entity_id)
        ).fetchone()
        if existing:
            return json.dumps({"status": "resumed", "debate": dict(existing)})
        cur = conn.execute(
            "INSERT INTO council_debates (entity_type, entity_id, state, round, created_at, updated_at) "
            "VALUES (?, ?, 'active', 1, ?, ?)",
            (entity_type, entity_id, now, now)
        )
        debate_id = cur.lastrowid
        row = conn.execute("SELECT * FROM council_debates WHERE id = ?", (debate_id,)).fetchone()
        return json.dumps({"status": "created", "debate": dict(row)})


@mcp.tool()
def get_debate_state(debate_id: int) -> str:
    """
    Get current state of a debate: round, state, active members, turns this round.
    """
    debate = _get_debate(debate_id)
    if not debate:
        return json.dumps({"error": f"Debate {debate_id} not found"})
    members = _get_active_members(debate_id)
    turns   = _turns_this_round(debate_id, debate["round"])
    with _get_conn() as conn:
        comment_count = conn.execute(
            "SELECT COUNT(*) FROM council_comments WHERE debate_id = ?", (debate_id,)
        ).fetchone()[0]
    return json.dumps({
        "debate":        debate,
        "members":       members,
        "turns":         turns,
        "comment_count": comment_count,
        "converged":     _check_convergence(debate_id, debate["round"]),
    })


@mcp.tool()
def add_member(debate_id: int, persona_id: int, provider: str = "claude",
               model: str = "claude-sonnet-4-6", seat_order: int = 0) -> str:
    """Add a persona to a debate's council."""
    now = _now()
    with _get_conn() as conn:
        persona = conn.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not persona:
            return json.dumps({"error": f"Persona {persona_id} not found"})
        cur = conn.execute(
            "INSERT INTO council_members (debate_id, persona_id, seat_order, provider, model, state, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'active', ?)",
            (debate_id, persona_id, seat_order, provider, model, now)
        )
        return json.dumps({"status": "added", "member_id": cur.lastrowid})


@mcp.tool()
def remove_member(debate_id: int, member_id: int) -> str:
    """Remove (deactivate) a persona from a debate."""
    with _get_conn() as conn:
        conn.execute(
            "UPDATE council_members SET state = 'removed' WHERE id = ? AND debate_id = ?",
            (member_id, debate_id)
        )
    return json.dumps({"status": "removed"})


@mcp.tool()
def grant_turn(debate_id: int, member_id: int | None = None) -> str:
    """
    Orchestrator grants the floor to a member (or to the human if member_id is None).
    Creates a pending turn record. Returns whose turn it is and what they should do.
    """
    debate = _get_debate(debate_id)
    if not debate:
        return json.dumps({"error": f"Debate {debate_id} not found"})

    now = _now()
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO council_turns (debate_id, member_id, round, did_comment, completed_at) "
            "VALUES (?, ?, ?, 0, NULL)",
            (debate_id, member_id, debate["round"])
        )
        turn_id = cur.lastrowid

    if member_id is None:
        return json.dumps({
            "status": "turn_granted",
            "turn_id": turn_id,
            "speaker": "human",
            "round": debate["round"],
            "instruction": "It is the human's turn to speak. Awaiting raise_hand or skip.",
        })

    members = _get_active_members(debate_id)
    member  = next((m for m in members if m["id"] == member_id), None)
    persona_name = member["persona_name"] if member else f"member_{member_id}"

    with _get_conn() as conn:
        comments = conn.execute(
            "SELECT * FROM council_comments WHERE debate_id = ? ORDER BY created_at",
            (debate_id,)
        ).fetchall()

    return json.dumps({
        "status":       "turn_granted",
        "turn_id":      turn_id,
        "speaker":      persona_name,
        "member_id":    member_id,
        "round":        debate["round"],
        "comment_history": [dict(c) for c in comments],
        "instruction":  (
            f"You are {persona_name}. Read the comment history above carefully. "
            f"Write your analysis as a council comment, then call submit_turn with did_comment=true. "
            f"If you have nothing to add, call submit_turn with did_comment=false."
        ),
    })


@mcp.tool()
def submit_turn(debate_id: int, member_id: int | None, did_comment: bool,
                turn_id: int | None = None) -> str:
    """
    Persona (or human) signals they are done speaking.
    did_comment=true means they added a comment; false means they passed.
    Convergence is checked after all members have submitted in the current round.
    """
    now = _now()
    with _get_conn() as conn:
        debate = conn.execute(
            "SELECT * FROM council_debates WHERE id = ?", (debate_id,)
        ).fetchone()
        if not debate:
            return json.dumps({"error": f"Debate {debate_id} not found"})

        # Mark the turn complete
        if turn_id:
            conn.execute(
                "UPDATE council_turns SET did_comment = ?, completed_at = ? WHERE id = ?",
                (1 if did_comment else 0, now, turn_id)
            )
        else:
            conn.execute(
                "INSERT INTO council_turns (debate_id, member_id, round, did_comment, completed_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (debate_id, member_id, debate["round"], 1 if did_comment else 0, now)
            )

        round_num = debate["round"]

    converged = _check_convergence(debate_id, round_num)

    if converged:
        with _get_conn() as conn:
            conn.execute(
                "UPDATE council_debates SET state = 'action_round', updated_at = ? WHERE id = ?",
                (now, debate_id)
            )
        return json.dumps({
            "status":    "converged",
            "message":   "All members passed. Moving to action proposal round.",
            "debate_id": debate_id,
        })

    return json.dumps({
        "status":     "turn_submitted",
        "did_comment": did_comment,
        "debate_id":   debate_id,
        "round":       round_num,
    })


@mcp.tool()
def raise_hand(debate_id: int) -> str:
    """
    Human signals they want to speak next.
    Orchestrator will inject a human turn before the next persona.
    """
    now = _now()
    with _get_conn() as conn:
        conn.execute(
            "INSERT INTO council_comments (debate_id, member_id, author, round, content, created_at) "
            "VALUES (?, NULL, 'human_pending', "
            "(SELECT round FROM council_debates WHERE id = ?), '', ?)",
            (debate_id, debate_id, now)
        )
    return json.dumps({
        "status":  "hand_raised",
        "message": "Human turn queued. Orchestrator will grant the floor before the next persona.",
    })


@mcp.tool()
def add_council_comment(debate_id: int, member_id: int | None, content: str,
                        author: str = "persona") -> str:
    """
    Add a comment to the debate thread.
    Called by personas after receiving grant_turn.
    member_id is None for human comments.
    """
    now = _now()
    with _get_conn() as conn:
        debate = conn.execute(
            "SELECT round FROM council_debates WHERE id = ?", (debate_id,)
        ).fetchone()
        if not debate:
            return json.dumps({"error": f"Debate {debate_id} not found"})
        cur = conn.execute(
            "INSERT INTO council_comments (debate_id, member_id, author, round, content, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (debate_id, member_id, author, debate["round"], content, now)
        )
        conn.execute(
            "UPDATE council_debates SET updated_at = ? WHERE id = ?", (now, debate_id)
        )
        return json.dumps({"status": "commented", "comment_id": cur.lastrowid})


@mcp.tool()
def propose_action(debate_id: int, member_id: int | None,
                   action_type: str, content: str,
                   ticket_id: int | None = None) -> str:
    """
    Propose a ticket action during the action proposal round.
    action_type: 'create' | 'comment' | 'reopen'
    """
    valid_types = {"create", "comment", "reopen"}
    if action_type not in valid_types:
        return json.dumps({"error": f"action_type must be one of {valid_types}"})
    now = _now()
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO council_actions (debate_id, member_id, action_type, ticket_id, content, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'pending', ?)",
            (debate_id, member_id, action_type, ticket_id, content, now)
        )
        return json.dumps({"status": "proposed", "action_id": cur.lastrowid})


@mcp.tool()
def get_action_proposals(debate_id: int) -> str:
    """
    Retrieve all proposed actions for a debate, with conflict detection applied.
    Returns agreed actions (multiple supporters) and conflicted pairs.
    """
    _detect_action_conflicts(debate_id)

    with _get_conn() as conn:
        actions = conn.execute(
            """SELECT ca.*, p.name as persona_name
               FROM council_actions ca
               LEFT JOIN council_members cm ON cm.id = ca.member_id
               LEFT JOIN personas p ON p.id = cm.persona_id
               WHERE ca.debate_id = ?
               ORDER BY ca.created_at""",
            (debate_id,)
        ).fetchall()

    all_actions  = [dict(a) for a in actions]
    conflicted   = [a for a in all_actions if a["conflicts_with"]]
    unconflicted = [a for a in all_actions if not a["conflicts_with"]]

    # Group unconflicted by (action_type, ticket_id, content) to detect agreement
    from collections import defaultdict
    groups: dict[str, list] = defaultdict(list)
    for a in unconflicted:
        key = f"{a['action_type']}|{a['ticket_id']}|{a['content'][:100]}"
        groups[key].append(a)

    agreed = []
    for key, grp in groups.items():
        agreed.append({**grp[0], "supporters": [g.get("persona_name", "human") for g in grp]})

    return json.dumps({
        "agreed":     agreed,
        "conflicted": conflicted,
        "all":        all_actions,
    })


@mcp.tool()
def resolve_action(action_id: int, resolution: str) -> str:
    """
    Human resolves a proposed action.
    resolution: 'accepted' | 'rejected'
    """
    if resolution not in ("accepted", "rejected"):
        return json.dumps({"error": "resolution must be 'accepted' or 'rejected'"})
    with _get_conn() as conn:
        conn.execute(
            "UPDATE council_actions SET status = ? WHERE id = ?",
            (resolution, action_id)
        )
    return json.dumps({"status": "resolved", "action_id": action_id, "resolution": resolution})


@mcp.tool()
def advance_round(debate_id: int) -> str:
    """Advance to the next debate round (called by orchestrator after convergence check)."""
    now = _now()
    with _get_conn() as conn:
        debate = conn.execute(
            "SELECT * FROM council_debates WHERE id = ?", (debate_id,)
        ).fetchone()
        if not debate:
            return json.dumps({"error": f"Debate {debate_id} not found"})
        new_round = debate["round"] + 1
        conn.execute(
            "UPDATE council_debates SET round = ?, state = 'active', updated_at = ? WHERE id = ?",
            (new_round, now, debate_id)
        )
    return json.dumps({"status": "advanced", "round": new_round})


@mcp.tool()
def close_debate(debate_id: int) -> str:
    """Mark a debate as archived after action review is complete."""
    now = _now()
    with _get_conn() as conn:
        conn.execute(
            "UPDATE council_debates SET state = 'archived', updated_at = ? WHERE id = ?",
            (now, debate_id)
        )
    return json.dumps({"status": "archived", "debate_id": debate_id})


@mcp.tool()
def list_debates(entity_type: str | None = None, entity_id: str | None = None) -> str:
    """List all debates, optionally filtered by entity."""
    with _get_conn() as conn:
        if entity_type and entity_id:
            rows = conn.execute(
                "SELECT * FROM council_debates WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC",
                (entity_type, entity_id)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM council_debates ORDER BY created_at DESC"
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
