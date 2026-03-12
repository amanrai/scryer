#!/usr/bin/env python3
"""
Council Orchestrator REST API.

Replaces the MCP server. Agents call these endpoints via curl during council sessions.
Orchestrator (launch.py) still writes to DB directly for setup/teardown.

Run:
    python3 infra/CouncilOrchestrator/api.py
    # or via restart.sh (scryer-council session, port 7656)
"""

import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

_HERE         = Path(__file__).parent
_REPO_ROOT    = _HERE.parent.parent
_PM_PATH      = _HERE.parent / "ProjectManagement"
_PERSONAS_DIR = _REPO_ROOT / "council" / "personas"
sys.path.insert(0, str(_PM_PATH))
import db as pm_db

app = FastAPI(title="Council API", version="1.0")

PORT = 7656


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conn():
    return pm_db.get_conn()


def _get_active_members(ticket_id: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM council_members WHERE ticket_id = ? AND state = 'active' ORDER BY seat_order",
            (ticket_id,)
        ).fetchall()
    members = [dict(r) for r in rows]
    for m in members:
        m["persona_name"] = _slug_to_name(m.get("persona_slug", ""))
    return members


def _turns_this_round(ticket_id: int, round_num: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM council_turns WHERE ticket_id = ? AND round = ?",
            (ticket_id, round_num)
        ).fetchall()
    return [dict(r) for r in rows]


def _check_convergence(ticket_id: int, round_num: int) -> bool:
    members = _get_active_members(ticket_id)
    turns   = _turns_this_round(ticket_id, round_num)
    completed = {t["member_id"] for t in turns if t["completed_at"]}
    active    = {m["id"] for m in members}
    if active != completed:
        return False
    return all(t["did_comment"] == 0 for t in turns if t["member_id"] in active)


# ── Agent-facing endpoints ─────────────────────────────────────────────────────

@app.get("/debates/{ticket_id}")
def get_debate_state(ticket_id: int):
    """Get current state of a council discussion."""
    with _conn() as c:
        ticket = c.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not ticket:
            raise HTTPException(status_code=404, detail=f"Ticket {ticket_id} not found")
        members_rows = c.execute(
            "SELECT * FROM council_members WHERE ticket_id = ? AND state = 'active' ORDER BY seat_order",
            (ticket_id,)
        ).fetchall()
        members_with_names = []
        for m in members_rows:
            md = dict(m)
            md["persona_name"] = _slug_to_name(md.get("persona_slug", ""))
            members_with_names.append(md)
        round_num = c.execute(
            "SELECT COALESCE(MAX(round), 1) FROM council_turns WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()[0]
        turns = c.execute(
            "SELECT * FROM council_turns WHERE ticket_id = ? AND round = ?",
            (ticket_id, round_num)
        ).fetchall()
        comments = c.execute(
            "SELECT id, author, content, created_at FROM comments "
            "WHERE ticket_id = ? AND is_root = 0 ORDER BY created_at",
            (ticket_id,)
        ).fetchall()
    return {
        "ticket_id":  ticket_id,
        "round":      round_num,
        "members":    members_with_names,
        "turns":      [dict(t) for t in turns],
        "comments":   [dict(c) for c in comments],
        "converged":  _check_convergence(ticket_id, round_num),
    }


class CommentBody(BaseModel):
    member_id: Optional[int] = None
    content: str


@app.post("/debates/{ticket_id}/comments")
def add_comment(ticket_id: int, body: CommentBody):
    """Add a comment to a council discussion thread."""
    with _conn() as c:
        if body.member_id is not None:
            row = c.execute(
                "SELECT persona_slug FROM council_members WHERE id = ?",
                (body.member_id,)
            ).fetchone()
            author = _slug_to_name(row["persona_slug"]) if row else f"member_{body.member_id}"
        else:
            author = "human"
    try:
        comment = pm_db.add_comment(ticket_id, body.content, actor="agent", author=author)
        return {"status": "commented", "comment_id": comment["id"]}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class SubmitTurnBody(BaseModel):
    member_id: Optional[int] = None
    did_comment: bool


@app.post("/debates/{ticket_id}/turns/{turn_id}/submit")
def submit_turn(ticket_id: int, turn_id: int, body: SubmitTurnBody):
    """Signal a turn is complete."""
    now = _now()
    with _conn() as c:
        round_num = c.execute(
            "SELECT COALESCE(MAX(round), 1) FROM council_turns WHERE ticket_id = ?", (ticket_id,)
        ).fetchone()[0]
        c.execute(
            "UPDATE council_turns SET did_comment = ?, completed_at = ? WHERE id = ?",
            (1 if body.did_comment else 0, now, turn_id)
        )
    converged = _check_convergence(ticket_id, round_num)
    return {
        "status":      "converged" if converged else "turn_submitted",
        "did_comment": body.did_comment,
        "ticket_id":   ticket_id,
        "round":       round_num,
        "converged":   converged,
    }


# ── Management endpoints (used by UI / launch.py if needed) ───────────────────

@app.get("/debates")
def list_debates(entity_type: Optional[str] = None, entity_id: Optional[str] = None):
    with _conn() as c:
        if entity_type and entity_id:
            rows = c.execute(
                "SELECT * FROM tickets WHERE spl_ticket_type = 1 "
                "AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC",
                (entity_type, entity_id)
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM tickets WHERE spl_ticket_type = 1 ORDER BY created_at DESC"
            ).fetchall()
    return {"debates": [dict(r) for r in rows]}


def _read_template(template_path: str) -> str:
    """Read persona template from file. Path is relative to repo root."""
    p = _REPO_ROOT / template_path
    return p.read_text() if p.exists() else ""


def _persona_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _slug_to_name(slug: str) -> str:
    return slug.replace("-", " ").title()


def _list_persona_files() -> list[dict]:
    """Return all personas derived from council/personas/*.md files."""
    if not _PERSONAS_DIR.exists():
        return []
    results = []
    for p in sorted(_PERSONAS_DIR.glob("*.md")):
        slug = p.stem
        template_path = f"council/personas/{p.name}"
        results.append({
            "slug":             slug,
            "name":             _slug_to_name(slug),
            "template_path":    template_path,
            "template_content": p.read_text(),
        })
    return results


def _dict_persona(slug: str) -> dict:
    """Build a persona dict from a slug by reading the file."""
    p = _PERSONAS_DIR / f"{slug}.md"
    template_path = f"council/personas/{slug}.md"
    return {
        "slug":             slug,
        "name":             _slug_to_name(slug),
        "template_path":    template_path,
        "template_content": p.read_text() if p.exists() else "",
    }


@app.get("/personas")
def list_personas():
    return {"personas": _list_persona_files()}


class PersonaBody(BaseModel):
    name: str
    content: str


@app.post("/personas")
def create_persona(body: PersonaBody):
    slug = _persona_slug(body.name)
    _PERSONAS_DIR.mkdir(parents=True, exist_ok=True)
    (_PERSONAS_DIR / f"{slug}.md").write_text(body.content)
    return {"status": "created", "slug": slug, "template_path": f"council/personas/{slug}.md"}


class PersonaUpdate(BaseModel):
    content: Optional[str] = None


@app.patch("/personas/{slug}")
def update_persona(slug: str, body: PersonaUpdate):
    p = _PERSONAS_DIR / f"{slug}.md"
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Persona '{slug}' not found")
    if body.content is not None:
        p.write_text(body.content)
    return {"status": "updated"}


@app.delete("/personas/{slug}")
def delete_persona(slug: str):
    p = _PERSONAS_DIR / f"{slug}.md"
    if p.exists():
        p.unlink()
    return {"status": "deleted"}


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    pm_db.init_db()
    uvicorn.run(app, host="127.0.0.1", port=PORT)
