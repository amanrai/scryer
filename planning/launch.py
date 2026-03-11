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
sys.path.insert(0, str(REPO_ROOT / "infra"))
import agent_config as agentcfg

pm_db.init_db()

TMUX = "/opt/homebrew/bin/tmux"
CODEX_CONFIG     = Path.home() / ".codex" / "config.toml"
GEMINI_TRUST     = Path.home() / ".gemini" / "trustedFolders.json"
GLOBAL_TEMPLATES = REPO_ROOT / "templates"


def _trust_codex_dir(directory: str) -> None:
    """Add directory to ~/.codex/config.toml as trusted if not already present."""
    key = f'[projects."{directory}"]'
    CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    content = CODEX_CONFIG.read_text() if CODEX_CONFIG.exists() else ""
    if key not in content:
        sep = "\n" if content and not content.endswith("\n") else ""
        CODEX_CONFIG.write_text(content + f'{sep}\n{key}\ntrust_level = "trusted"\n')


def _trust_gemini_dirs(*directories: str) -> None:
    """Add directories to ~/.gemini/trustedFolders.json as TRUST_FOLDER."""
    import json
    GEMINI_TRUST.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(GEMINI_TRUST.read_text()) if GEMINI_TRUST.exists() else {}
    changed = False
    for d in directories:
        if d and d not in data:
            data[d] = "TRUST_FOLDER"
            changed = True
    if changed:
        GEMINI_TRUST.write_text(json.dumps(data, indent=2) + "\n")

# ── Entity resolution ─────────────────────────────────────────────────────────

def _root_code_path(root_name: str) -> str:
    """Return code_path for the root project named root_name."""
    import sqlite3
    conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT code_path FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL",
        (root_name,)
    ).fetchone()
    conn.close()
    return row["code_path"] if row else ""


def resolve_entity(entity_type: str, entity_id: str) -> dict:
    """Return name, description, location path, and code_path for the entity."""
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
            "code_path":   p.get("code_path", ""),
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
        root_name = parts[0]
        return {
            "type":        "subproject",
            "id":          entity_id,
            "numeric_id":  pid,
            "name":        p["name"],
            "description": p["description"],
            "location":    " > ".join(parts),
            "code_path":   _root_code_path(root_name),
        }
    elif entity_type == "ticket":
        tid = int(entity_id)
        t = pm_db.get_ticket(tid)
        if not t:
            raise ValueError(f"Ticket {tid} not found")
        slug = t["title"].lower().replace(" ", "-")[:40]
        slug = "".join(c for c in slug if c.isalnum() or c == "-")
        root_name = t["location"].split(">")[0].strip()
        return {
            "type":        "ticket",
            "id":          entity_id,
            "numeric_id":  tid,
            "name":        t["title"],
            "description": t.get("description", ""),
            "location":    t["location"],
            "slug":        slug,
            "code_path":   _root_code_path(root_name),
        }
    else:
        raise ValueError(f"Unknown entity type: {entity_type!r}")


# ── Plan path ─────────────────────────────────────────────────────────────────

def plan_path(entity: dict, scryer_root: str) -> Path:
    """Resolve the plan.md path — lives at {base_path}/.scryer/{sub_parts}/plan.md."""
    base = Path(entity.get("code_path", "")).expanduser()
    location = entity["location"]
    parts = [p.strip() for p in location.split(">")]
    sub_parts = parts[1:]  # strip root project name — it's encoded in base_path

    if entity["type"] == "ticket":
        slug = entity.get("slug", f"T{entity['numeric_id']}")
        sub_parts.append(f"T{entity['numeric_id']}-{slug}")

    return (base / ".scryer").joinpath(*sub_parts) / "plan.md" if sub_parts else base / ".scryer" / "plan.md"


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


# ── Template helpers ──────────────────────────────────────────────────────────

def _root_project_name(entity: dict) -> str:
    return entity["location"].split(">")[0].strip()


def load_template(name: str, scryer_root: str, entity: dict) -> str:
    """Load template: per-project copy first, fall back to global (and copy it for future edits)."""
    root_project = _root_project_name(entity)
    per_project = Path(scryer_root).expanduser() / root_project / "templates" / name
    if per_project.exists():
        return per_project.read_text()
    global_path = GLOBAL_TEMPLATES / name
    if not global_path.exists():
        raise FileNotFoundError(f"Template {name!r} not found")
    # Copy to per-project location so the user can customise it
    per_project.parent.mkdir(parents=True, exist_ok=True)
    per_project.write_text(global_path.read_text())
    return per_project.read_text()


def render_template(template: str, substitutions: dict) -> str:
    """Replace {KEY} placeholders using simple str.replace (safe with JSON content)."""
    result = template
    for key, value in substitutions.items():
        result = result.replace(f"{{{key}}}", value)
    return result


# ── CLAUDE.md builder ─────────────────────────────────────────────────────────

def build_claude_md(entity: dict, plan_file: Path, ancestor_context: str,
                    scryer_root: str) -> str:
    current_plan = ""
    if plan_file.exists():
        current_plan = plan_file.read_text(errors="ignore").strip()

    entity_label = f"{entity['type'].capitalize()}: {entity['name']}"
    if entity["type"] == "ticket":
        entity_label = f"Ticket T{entity['numeric_id']}: {entity['name']}"

    template = load_template("planning.md", scryer_root, entity)
    return render_template(template, {
        "ENTITY_LABEL":       entity_label,
        "ENTITY_NAME":        entity["name"],
        "PLAN_FILE":          str(plan_file),
        "ENTITY_LOCATION":    entity["location"],
        "ENTITY_DESCRIPTION": entity.get("description") or "(none)",
        "ANCESTOR_CONTEXT":   ancestor_context,
        "CURRENT_PLAN":       current_plan if current_plan else "_(empty — start fresh)_",
    })


# ── tmux launcher ─────────────────────────────────────────────────────────────

def launch(entity_type: str, entity_id: str, agent: str = "claude", warmup: int = 10, no_attach: bool = False):
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
    elif plan_file.stat().st_size > 0:
        # Snapshot existing plan.md before the session can overwrite it
        versions_dir = plan_file.parent / "versions"
        versions_dir.mkdir(exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        snapshot = versions_dir / f"{ts}.md"
        snapshot.write_text(plan_file.read_text())
        print(f"Snapshotted plan.md → versions/{ts}.md")

    print(f"Plan file: {plan_file}")
    print(f"Fetching ancestor context from oracle…")
    ancestor_ctx = get_ancestor_context(entity)

    claude_md = build_claude_md(entity, plan_file, ancestor_ctx, scryer_root)
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

    if agent == "codex":
        _trust_codex_dir(work_dir)
    if agent == "gemini":
        _trust_gemini_dirs(work_dir, str(Path(scryer_root).expanduser()))

    # Write agent permission config files into code_path
    code_path = entity.get("code_path", "")
    if code_path:
        print(f"Writing agent permission config for {agent}…")
        agentcfg.write_agent_configs(agent, code_path, str(PM_PATH / "data" / "pm.db"))

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
    if agent == "claude":
        startup_script = (
            f"sleep {warmup} && {TMUX} send-keys -t {_shlex.quote(session)} "
            f"{_shlex.quote(startup_msg)} Enter"
        )
    else:
        startup_script = (
            f"sleep {warmup} && {TMUX} send-keys -t {_shlex.quote(session)} "
            f"{_shlex.quote(startup_msg)} Enter && "
            f"sleep 0.5 && {TMUX} send-keys -t {_shlex.quote(session)} '' Enter"
        )
    subprocess.Popen(
        ["bash", "-c", startup_script],
        close_fds=True,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    print(f"\nSession '{session}' ready.")

    if no_attach:
        print(f"Session created. Attach with: tmux attach -t {session}")
    else:
        print(f"Attaching… (detach with Ctrl+B D)\n")
        subprocess.run([TMUX, "attach-session", "-t", session])

        print(f"Session closed. Plan saved at {plan_file}")


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch a Scryer planning session.")
    parser.add_argument("--type",  required=True, choices=["project", "subproject", "ticket"],
                        help="Entity type")
    parser.add_argument("--id",    required=True, help="Entity id (name for project, numeric id for others)")
    parser.add_argument("--agent", default="claude", choices=["claude", "codex", "gemini"],
                        help="Planning agent to use (default: claude)")
    parser.add_argument("--warmup", type=int, default=10,
                        help="Seconds to wait before sending startup message (default: 10)")
    parser.add_argument("--no-attach", action="store_true",
                        help="Set up session but do not attach (for non-interactive / API use)")
    args = parser.parse_args()
    launch(args.type, args.id, args.agent, warmup=args.warmup, no_attach=args.no_attach)
