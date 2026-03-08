#!/usr/bin/env python3
"""
Planning session launcher.

Usage:
  python planning/launch.py --type project --id <name>
  python planning/launch.py --type subproject --id <id>
  python planning/launch.py --type ticket --id <id>
  python planning/launch.py --type project --id <name> --agent codex
"""

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).parent.parent
PM_PATH   = REPO_ROOT / "infra" / "ProjectManagement"
ORACLE_PATH = REPO_ROOT / "oracle"

sys.path.insert(0, str(PM_PATH))
sys.path.insert(0, str(ORACLE_PATH))

import db as pm_db
import oracle as oracle_mod

pm_db.init_db()

TMUX = "/opt/homebrew/bin/tmux"

# ── Entity resolution ─────────────────────────────────────────────────────────

def resolve_entity(entity_type: str, entity_id: str) -> dict:
    """Return name, description, location path for the entity."""
    if entity_type == "project":
        p = pm_db.get_project(entity_id)
        if not p:
            raise ValueError(f"Project {entity_id!r} not found")
        return {
            "type":        "project",
            "id":          entity_id,
            "numeric_id":  p["id"],
            "name":        p["name"],
            "description": p.get("description", ""),
            "location":    p["name"],
        }
    elif entity_type == "subproject":
        pid = int(entity_id)
        import sqlite3
        conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
        conn.row_factory = sqlite3.Row
        p = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        conn.close()
        if not p:
            raise ValueError(f"Sub-project id {pid} not found")
        # Build location path
        parts = []
        parent_id = p["parent_id"]
        import sqlite3 as sq
        conn2 = sq.connect(str(PM_PATH / "data" / "pm.db"))
        conn2.row_factory = sq.Row
        while parent_id:
            par = conn2.execute(
                "SELECT id, name, parent_id, is_default FROM projects WHERE id = ?", (parent_id,)
            ).fetchone()
            if not par: break
            if not par["is_default"]:
                parts.insert(0, par["name"])
            parent_id = par["parent_id"]
        conn2.close()
        parts.append(p["name"])
        return {
            "type":        "subproject",
            "id":          entity_id,
            "numeric_id":  pid,
            "name":        p["name"],
            "description": p["description"],
            "location":    " > ".join(parts),
        }
    elif entity_type == "ticket":
        tid = int(entity_id)
        t = pm_db.get_ticket(tid)
        if not t:
            raise ValueError(f"Ticket {tid} not found")
        slug = t["title"].lower().replace(" ", "-")[:40]
        slug = "".join(c for c in slug if c.isalnum() or c == "-")
        return {
            "type":        "ticket",
            "id":          entity_id,
            "numeric_id":  tid,
            "name":        t["title"],
            "description": t.get("description", ""),
            "location":    t["location"],
            "slug":        slug,
        }
    else:
        raise ValueError(f"Unknown entity type: {entity_type!r}")


# ── Plan path ─────────────────────────────────────────────────────────────────

def plan_path(entity: dict, scryer_root: str) -> Path:
    """Resolve the plan.md path for an entity."""
    root = Path(scryer_root).expanduser()
    location = entity["location"]  # e.g. "Scryer > UI"
    parts = [p.strip() for p in location.split(">")]

    if entity["type"] == "ticket":
        slug = entity.get("slug", f"T{entity['numeric_id']}")
        parts.append(f"T{entity['numeric_id']}-{slug}")

    return root.joinpath(*parts) / "plan.md"


# ── Ancestor context ──────────────────────────────────────────────────────────

def get_ancestor_context(entity: dict) -> str:
    location = entity["location"]
    question = (
        f"Summarize the constraints and context from all ancestor plan.md files "
        f"for {entity['type']} '{entity['name']}' at location '{location}'. "
        f"If no ancestor plans exist, say so."
    )
    result = oracle_mod.ask(None, question, calling_agent="planning-launcher")
    return result["content"]


# ── CLAUDE.md template ────────────────────────────────────────────────────────

def build_claude_md(entity: dict, plan_file: Path, ancestor_context: str) -> str:
    current_plan = ""
    if plan_file.exists():
        current_plan = plan_file.read_text(errors="ignore").strip()

    entity_label = f"{entity['type'].capitalize()}: {entity['name']}"
    if entity["type"] == "ticket":
        entity_label = f"Ticket T{entity['numeric_id']}: {entity['name']}"

    return f"""# Planning Session — {entity_label}

You are the planning agent for **{entity['name']}** in the Scryer project management system.

## Your role

Help the human think through and document the plan for this entity.
Ask questions. Propose structure. Challenge assumptions. Capture decisions.

You are here to force thinking — not to produce documentation for its own sake.
If something is unclear, ask. Don't assume.

## Your only output

`{plan_file}` — edit this file directly as the plan evolves.
Do not create tickets, update PM state, send messages, or do anything other than write this file.

## Behavioral rules

- **Re-read `{plan_file}` at the start of every response** to pick up any edits the human made directly.
- Ask **one question at a time**.
- Write decisions to plan.md as they are made — not at the end.
- When the human says "done" (or closes the session), the current state of plan.md is the plan.
- Use `ask_oracle` (via oracle-local MCP) for ancestor context or system state questions.
  Pass `ticket_id=None` for project-level questions.

## Entity context

**Location:** {entity['location']}
**Description:** {entity.get('description') or '(none)'}

## Ancestor context (from oracle)

{ancestor_context}

## Current plan.md

{current_plan if current_plan else '_(empty — start fresh)_'}
"""


# ── tmux launcher ─────────────────────────────────────────────────────────────

def launch(entity_type: str, entity_id: str, agent: str = "claude", no_attach: bool = False):
    config      = oracle_mod._get_config()
    scryer_root = config.get("scryer_root", "")
    if not scryer_root:
        print("ERROR: scryer_root not set. Configure it in Global Config first.")
        sys.exit(1)

    print(f"Resolving entity {entity_type}:{entity_id}…")
    entity = resolve_entity(entity_type, entity_id)

    plan_file = plan_path(entity, scryer_root)
    plan_file.parent.mkdir(parents=True, exist_ok=True)
    if not plan_file.exists():
        plan_file.write_text("")

    print(f"Plan file: {plan_file}")
    print(f"Fetching ancestor context from oracle…")
    ancestor_ctx = get_ancestor_context(entity)

    claude_md = build_claude_md(entity, plan_file, ancestor_ctx)
    claude_md_path = plan_file.parent / "CLAUDE.md"
    claude_md_path.write_text(claude_md)

    session = f"planning-{entity_type}-{entity['numeric_id']}"
    work_dir = str(plan_file.parent)

    _NVM_INIT = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
    AGENT_COMMANDS = {
        "claude": "unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_IS_NESTED 2>/dev/null; claude",
        "codex":  f"{_NVM_INIT} && nvm use 22 && codex",
        "gemini": f"{_NVM_INIT} && nvm use 22 && gemini",
    }
    agent_cmd = AGENT_COMMANDS.get(agent, agent)

    # Kill existing session if present
    subprocess.run([TMUX, "kill-session", "-t", session], capture_output=True)

    # Create session, start agent
    subprocess.run([
        TMUX, "new-session", "-d", "-s", session,
        "-c", work_dir,
        "-x", "220", "-y", "50",
    ])
    subprocess.run([TMUX, "send-keys", "-t", f"{session}:0", agent_cmd, "Enter"])

    # Schedule startup prompt — fires after agent has loaded (background, non-blocking)
    import shlex as _shlex
    startup_msg = "Please read CLAUDE.md, then begin the planning session."
    startup_script = (
        f"sleep 4 && {TMUX} send-keys -t {_shlex.quote(session)} "
        f"{_shlex.quote(startup_msg)} Enter"
    )
    subprocess.Popen(
        ["bash", "-c", startup_script],
        close_fds=True,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Log session start
    pm_db.log_action(
        "planning_session_started",
        f"Planning session started for {entity_type} '{entity['name']}'",
        {"entity_type": entity_type, "entity_id": str(entity['numeric_id']), "agent": agent, "plan_file": str(plan_file)},
        actor="human",
    )

    print(f"\nSession '{session}' ready.")

    if no_attach:
        print(f"Session created. Attach with: tmux attach -t {session}")
    else:
        print(f"Attaching… (detach with Ctrl+B D)\n")
        subprocess.run([TMUX, "attach-session", "-t", session])

        # After session ends — log it
        pm_db.log_action(
            "planning_session_ended",
            f"Planning session ended for {entity_type} '{entity['name']}'",
            {"entity_type": entity_type, "entity_id": str(entity['numeric_id']), "plan_file": str(plan_file)},
            actor="human",
        )
        print(f"Session closed. Plan saved at {plan_file}")


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch a Scryer planning session.")
    parser.add_argument("--type",  required=True, choices=["project", "subproject", "ticket"],
                        help="Entity type")
    parser.add_argument("--id",    required=True, help="Entity id (name for project, numeric id for others)")
    parser.add_argument("--agent", default="claude", choices=["claude", "codex", "gemini"],
                        help="Planning agent to use (default: claude)")
    parser.add_argument("--no-attach", action="store_true",
                        help="Set up session but do not attach (for non-interactive / API use)")
    args = parser.parse_args()
    launch(args.type, args.id, args.agent, no_attach=args.no_attach)
