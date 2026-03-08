#!/usr/bin/env python3
"""
Architect agent launcher.

Usage:
  python architect/launch.py --type subproject --id 26 --mode architect
  python architect/launch.py --type project    --id Scryer --mode auto-architect
  python architect/launch.py --type subproject --id 26 --mode re-architect
"""

import argparse
import os
import re
import shlex
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT   = Path(__file__).parent.parent
PM_PATH     = REPO_ROOT / "infra" / "ProjectManagement"
ORACLE_PATH = REPO_ROOT / "oracle"

sys.path.insert(0, str(PM_PATH))
sys.path.insert(0, str(ORACLE_PATH))

import db as pm_db
import oracle as oracle_mod

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

def resolve_entity(entity_type: str, entity_id: str) -> dict:
    conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
    conn.row_factory = sqlite3.Row

    if entity_type == "project":
        p = conn.execute(
            "SELECT * FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL",
            (entity_id,),
        ).fetchone()
        if not p:
            raise ValueError(f"Project {entity_id!r} not found")
        conn.close()
        return {
            "type": "project", "id": entity_id,
            "numeric_id": p["id"], "name": p["name"],
            "description": p["description"] or "",
            "location": p["name"],
        }

    elif entity_type == "subproject":
        pid = int(entity_id)
        p = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        if not p:
            raise ValueError(f"Sub-project {pid} not found")
        parts = []
        parent_id = p["parent_id"]
        while parent_id:
            par = conn.execute(
                "SELECT id, name, parent_id, is_default FROM projects WHERE id = ?", (parent_id,)
            ).fetchone()
            if not par:
                break
            if not par["is_default"]:
                parts.insert(0, par["name"])
            parent_id = par["parent_id"]
        parts.append(p["name"])
        conn.close()
        return {
            "type": "subproject", "id": entity_id,
            "numeric_id": pid, "name": p["name"],
            "description": p["description"] or "",
            "location": " > ".join(parts),
        }

    elif entity_type == "ticket":
        tid = int(entity_id)
        t = conn.execute("SELECT * FROM tickets WHERE id = ?", (tid,)).fetchone()
        if not t:
            raise ValueError(f"Ticket {tid} not found")
        slug = re.sub(r"[^a-z0-9-]", "", t["title"].lower().replace(" ", "-"))[:40]
        parts = []
        pid = t["project_id"]
        while pid:
            par = conn.execute(
                "SELECT name, parent_id, is_default FROM projects WHERE id = ?", (pid,)
            ).fetchone()
            if not par:
                break
            if not par["is_default"]:
                parts.insert(0, par["name"])
            pid = par["parent_id"]
        conn.close()
        return {
            "type": "ticket", "id": entity_id,
            "numeric_id": tid, "name": t["title"],
            "description": t["description"] or "",
            "location": " > ".join(parts), "slug": slug,
        }

    else:
        raise ValueError(f"Unknown entity type: {entity_type!r}")


def _plan_path(entity: dict, scryer_root: str) -> Path:
    root = Path(scryer_root).expanduser()
    parts = [p.strip() for p in entity["location"].split(">")]
    if entity["type"] == "ticket":
        slug = entity.get("slug", f"T{entity['numeric_id']}")
        parts.append(f"T{entity['numeric_id']}-{slug}")
    return root.joinpath(*parts) / "plan.md"


def _root_project_name(entity: dict) -> str:
    return entity["location"].split(">")[0].strip()


# ── CLAUDE.md templates ───────────────────────────────────────────────────────

PROPOSAL_SCHEMA = """\
{{
  "id": "prop-<uuid4>",
  "generated_at": "<ISO timestamp>",
  "mode": "architect|re-architect",
  "reasoning": "brief explanation of your decomposition decisions",
  "items": [
    {{
      "id": "item-<uuid4>",
      "kind": "subproject",
      "name": "...",
      "description": "..."
    }},
    {{
      "id": "item-<uuid4>",
      "kind": "ticket",
      "title": "...",
      "description": "...",
      "priority": "high|medium|low",
      "plan_md": "2-4 paragraphs: what to build, how, definition of done",
      "sub_project": "subproject name or null",
      "blocks": ["title of another ticket in this proposal that this one must precede"],
      "status": "pending",
      "human_feedback": null,
      "rejection_reason": null,
      "revisions": []
    }}
  ]
}}

For re-architect, also support:
  {{"id": "item-<uuid4>", "kind": "modify", "ticket_id": 42, "title": "...", "description": "...", "priority": "...", "status": "pending", "human_feedback": null, "rejection_reason": null, "revisions": []}}
  {{"id": "item-<uuid4>", "kind": "close",  "ticket_id": 42, "reason": "...", "status": "pending", "human_feedback": null, "rejection_reason": null, "revisions": []}}

Item UUID rules:
- Generate fresh uuid4s by calling the MCP tool: `generate_uuids(count=N)` — returns `{"uuids": [...]}`
- For re-architect: if revising a concept from a prior proposal, reuse the original item UUID
  (look up via `get_proposal_history` — match by ticket_id for modify/close, by concept for new tickets)
- Never reuse UUIDs across unrelated items"""

_ARCHITECT_WORKFLOW = """\
## Workflow

**Step 1 — Check proposal.json**
If `proposal.json` exists in this directory:
- `_status === "applied"` → ask the human: "Previous proposal was applied. Generate a new one? (yes/no)"
  If yes: delete `proposal.json` and continue. If no: stop.
- `_status` not set (pending review) → say "Proposal already submitted — waiting for human review." and stop.
If it does not exist → continue.

**Step 2 — Gather context**
a. Call `get_proposal_history("{entity_type}", "{entity_id}")` — review all past proposals for this entity.
   Note: what was accepted (and the resulting ticket state), rejected (and why), ignored.
b. Read `plan.md` carefully.
c. If `code_path` is set (`{code_path}`), inspect the codebase to understand what already exists.
d. Call `{list_tickets_call}` to get the current ticket state.

**Step 3 — Determine mode**
- If history has no accepted items AND there are no open tickets → **architect** (propose everything fresh)
- Otherwise → **re-architect** (reconcile: never touch Closed / In Progress / In Review / Agent Finished tickets)

**Step 4 — Write proposal.json**
- Call `generate_uuids(count=N)` via MCP to get all UUIDs you need at once (one call for the proposal + all items)
- Assign a uuid4 to the proposal itself (`"id": "prop-<uuid>"`)
- Assign uuid4s to each item (`"id": "item-<uuid>"`)
  - Re-architect: reuse UUIDs from prior proposals for revised versions of the same concept
- Set `"status": "pending"` on every item
- Write to `{work_dir}/proposal.json` — valid JSON only, no markdown fences
- Do NOT create any tickets, sub-projects, or other PM state yet

**Step 5 — Stay alive and watch for revision requests**
After writing `proposal.json`, do NOT exit. Poll `proposal.json` every 10 seconds.
When you find any item with `"status": "needs_revision"`:
1. Read `human_feedback` on that item
2. Push the current item fields (`title`, `description`, `priority`, `plan_md`) to `revisions[]`
   with a `revised_at` timestamp
3. Revise the item based on the feedback
4. Clear `human_feedback` (set to null)
5. Reset `status` to `"pending"`
6. Write the updated `proposal.json`
Repeat until the human applies or clears the proposal."""

_MODE_INSTRUCTIONS = {
    "architect": _ARCHITECT_WORKFLOW,
    "re-architect": _ARCHITECT_WORKFLOW,
}


def _fetch_existing_tickets(entity: dict) -> str:
    """Return a formatted list of existing tickets for this entity to embed in CLAUDE.md."""
    try:
        root_project = _root_project_name(entity)
        sp_name = entity["name"] if entity["type"] == "subproject" else None
        tickets = pm_db.list_tickets(root_project, sub_project_name=sp_name)
        if not tickets:
            return "_None yet._"
        lines = []
        for t in tickets:
            lines.append(f"- T{t['id']} [{t['state']}] ({t['priority']}) — {t['title']}")
        return "\n".join(lines)
    except Exception as e:
        return f"_(could not load: {e})_"


def _get_code_path(entity: dict) -> str:
    """Return the code_path for the root project of this entity."""
    try:
        root_name = _root_project_name(entity)
        p = pm_db.get_project(root_name)
        return p.get("code_path", "") if p else ""
    except Exception:
        return ""


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


def build_claude_md(entity: dict, plan_content: str, mode: str, scryer_root: str,
                    work_dir: str) -> str:
    entity_label = f"{entity['type'].capitalize()}: {entity['name']}"
    if entity["type"] == "ticket":
        entity_label = f"Ticket T{entity['numeric_id']}: {entity['name']}"

    root_project = _root_project_name(entity)
    sp_name = entity["name"] if entity["type"] == "subproject" else None

    if sp_name:
        list_tickets_call = f'list_tickets(project_name="{root_project}", sub_project_name="{sp_name}")'
    else:
        list_tickets_call = f'list_tickets(project_name="{root_project}")'

    code_path = _get_code_path(entity)
    existing_tickets = _fetch_existing_tickets(entity)

    mode_instr = _MODE_INSTRUCTIONS[mode].format(
        entity_type=entity["type"],
        entity_id=str(entity["numeric_id"]),
        code_path=code_path or "(not set)",
        list_tickets_call=list_tickets_call,
        work_dir=work_dir,
    )

    if sp_name:
        sp_note = f"\nRoot project for MCP calls: **`{root_project}`**, sub-project: **`{sp_name}`**"
    else:
        sp_note = f"\nRoot project for MCP calls: **`{root_project}`**"

    template = load_template("architect.md", scryer_root, entity)
    return render_template(template, {
        "ENTITY_LABEL":       entity_label,
        "ENTITY_NAME":        entity["name"],
        "MODE_INSTRUCTIONS":  mode_instr,
        "WORK_DIR":           work_dir,
        "SP_NOTE":            sp_note,
        "PROPOSAL_SCHEMA":    PROPOSAL_SCHEMA,
        "ENTITY_LOCATION":    entity["location"],
        "ENTITY_DESCRIPTION": entity.get("description") or "(none)",
        "CODE_PATH":          code_path or "(not set)",
        "EXISTING_TICKETS":   existing_tickets,
        "PLAN_CONTENT":       plan_content.strip() if plan_content.strip() else "_(empty — ask the human to run a planning session first)_",
    })


# ── Launcher ──────────────────────────────────────────────────────────────────

def launch(entity_type: str, entity_id: str, mode: str = "architect",
           agent: str = "claude", warmup: int = 10, no_attach: bool = False):
    config      = oracle_mod._get_config()
    scryer_root = config.get("scryer_root", "")
    if not scryer_root:
        print("ERROR: scryer_root not set. Configure it in Global Config first.")
        sys.exit(1)

    print(f"Resolving entity {entity_type}:{entity_id}…")
    entity = resolve_entity(entity_type, entity_id)

    plan_file    = _plan_path(entity, scryer_root)
    plan_content = plan_file.read_text(errors="ignore") if plan_file.exists() else ""

    # Snapshot plan.md before the session can overwrite it
    if plan_file.exists() and plan_content.strip():
        from datetime import datetime, timezone
        versions_dir = plan_file.parent / "versions"
        versions_dir.mkdir(exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (versions_dir / f"{ts}.md").write_text(plan_content)
        print(f"Snapshotted plan.md → versions/{ts}.md")

    # Write CLAUDE.md into a working directory alongside plan.md
    work_dir = str(plan_file.parent)
    Path(work_dir).mkdir(parents=True, exist_ok=True)

    claude_md = build_claude_md(entity, plan_content, mode, scryer_root, work_dir)
    claude_md_path = Path(work_dir) / "CLAUDE.md"
    claude_md_path.write_text(claude_md)

    session = f"architect-{entity_type}-{entity['numeric_id']}-{mode}"

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

    subprocess.run([TMUX, "kill-session", "-t", session], capture_output=True)
    subprocess.run([
        TMUX, "new-session", "-d", "-s", session,
        "-c", work_dir, "-x", "220", "-y", "50",
    ])
    subprocess.run([TMUX, "send-keys", "-t", f"{session}:0", agent_cmd, "Enter"])

    # Startup prompt after agent loads
    startup_msg = "Please read CLAUDE.md, then begin."
    if agent == "claude":
        startup_script = (
            f"sleep {warmup} && {TMUX} send-keys -t {shlex.quote(session)} "
            f"{shlex.quote(startup_msg)} Enter"
        )
    else:
        startup_script = (
            f"sleep {warmup} && {TMUX} send-keys -t {shlex.quote(session)} "
            f"{shlex.quote(startup_msg)} Enter && "
            f"sleep 0.5 && {TMUX} send-keys -t {shlex.quote(session)} '' Enter"
        )
    subprocess.Popen(
        ["bash", "-c", startup_script],
        close_fds=True, start_new_session=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    print(f"\nSession '{session}' ready.")

    if no_attach:
        print(f"Attach with: tmux attach -t {session}")
    else:
        print(f"Attaching… (detach with Ctrl+B D)\n")
        subprocess.run([TMUX, "attach-session", "-t", session])



# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch a Scryer architect session.")
    parser.add_argument("--type",  required=True, choices=["project", "subproject", "ticket"])
    parser.add_argument("--id",    required=True, help="Entity id (name for project, numeric for others)")
    parser.add_argument("--mode",  default="architect",
                        choices=["architect", "re-architect"])
    parser.add_argument("--agent", default="claude", choices=["claude", "codex", "gemini"])
    parser.add_argument("--warmup", type=int, default=10,
                        help="Seconds to wait before sending startup message (default: 10)")
    parser.add_argument("--no-attach", action="store_true",
                        help="Set up session but do not attach")
    args = parser.parse_args()
    launch(args.type, args.id, args.mode, args.agent, warmup=args.warmup, no_attach=args.no_attach)
