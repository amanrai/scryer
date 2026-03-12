#!/usr/bin/env python3
"""
Council Orchestrator Launcher.

Starts an Agent Council session for an entity. Launches one tmux window per persona,
then drives the daisy chain: grant_turn → wait for submit_turn → grant_turn to next.

Usage:
  python council/launch.py --type ticket --id 42
  python council/launch.py --type project --id Scryer
  python council/launch.py --type ticket --id 42 --debate 7  # resume existing debate

Prerequisites:
  claude mcp add council-local -- python3 /path/to/infra/CouncilOrchestrator/mcp_server.py
"""

import argparse
import json
import os
import shlex
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────

REPO_ROOT   = Path(__file__).parent.parent
PM_PATH     = REPO_ROOT / "infra" / "ProjectManagement"
COUNCIL_DIR = Path(__file__).parent

sys.path.insert(0, str(PM_PATH))
import db as pm_db

pm_db.init_db()

TMUX           = os.environ.get("TMUX_BIN", "tmux")
POLL_INTERVAL  = 5   # seconds between debate state polls
TURN_TIMEOUT   = 600 # seconds before a turn is considered stuck


# ── DB helpers (direct SQLite — same db as pm_db) ─────────────────────────────

def _conn():
    c = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
    c.row_factory = sqlite3.Row
    return c


def _ticket_row(ticket_id: int) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        return dict(r) if r else None


def _read_template(template_path: str) -> str:
    p = REPO_ROOT / template_path
    return p.read_text() if p.exists() else f"# {template_path}\n(template file not found)"


def _slug_to_name(slug: str) -> str:
    return slug.replace("-", " ").title()


def _active_members(ticket_id: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM council_members WHERE ticket_id = ? AND state = 'active' ORDER BY seat_order",
            (ticket_id,)
        ).fetchall()
    members = [dict(r) for r in rows]
    for m in members:
        slug = m.get("persona_slug", "")
        m["persona_name"] = _slug_to_name(slug)
        m["template_content"] = _read_template(f"council/personas/{slug}.md")
    return members


def _turns_this_round(ticket_id: int, round_num: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM council_turns WHERE ticket_id = ? AND round = ?",
            (ticket_id, round_num)
        ).fetchall()
    return [dict(r) for r in rows]


def _latest_turn_for_member(ticket_id: int, member_id: int, round_num: int) -> dict | None:
    with _conn() as c:
        r = c.execute(
            "SELECT * FROM council_turns WHERE ticket_id = ? AND member_id = ? AND round = ? "
            "ORDER BY id DESC LIMIT 1",
            (ticket_id, member_id, round_num)
        ).fetchone()
    return dict(r) if r else None


def _grant_turn_db(ticket_id: int, member_id: int | None, round_num: int) -> int:
    """Insert a turn record and return its id."""
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO council_turns (ticket_id, member_id, round, did_comment, completed_at) "
            "VALUES (?, ?, ?, 0, NULL)",
            (ticket_id, member_id, round_num)
        )
    return cur.lastrowid


def _check_convergence(ticket_id: int, round_num: int) -> bool:
    members = _active_members(ticket_id)
    turns   = _turns_this_round(ticket_id, round_num)
    completed = {t["member_id"] for t in turns if t["completed_at"]}
    active    = {m["id"] for m in members}
    if active != completed:
        return False
    return all(t["did_comment"] == 0 for t in turns if t["member_id"] in active)


def _default_node_for_entity(entity_type: str, entity_id: str, c) -> int:
    """Return the project_id (default node) where the council ticket should be stored."""
    if entity_type == "project":
        proj = c.execute(
            "SELECT id FROM projects WHERE name = ? AND is_default = 0", (entity_id,)
        ).fetchone()
        if not proj:
            raise ValueError(f"Project '{entity_id}' not found")
        default = c.execute(
            "SELECT id FROM projects WHERE parent_id = ? AND is_default = 1", (proj["id"],)
        ).fetchone()
        return default["id"]
    elif entity_type == "subproject":
        default = c.execute(
            "SELECT id FROM projects WHERE parent_id = ? AND is_default = 1", (int(entity_id),)
        ).fetchone()
        if not default:
            raise ValueError(f"Sub-project {entity_id} has no default node")
        return default["id"]
    elif entity_type == "ticket":
        t = c.execute("SELECT project_id FROM tickets WHERE id = ?", (int(entity_id),)).fetchone()
        if not t:
            raise ValueError(f"Ticket {entity_id} not found")
        return t["project_id"]
    raise ValueError(f"Unknown entity_type: {entity_type}")


def _get_or_create_ticket(entity_type: str, entity_id: str) -> dict:
    """Find the council ticket for this entity, or create one."""
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        existing = c.execute(
            "SELECT * FROM tickets WHERE spl_ticket_type = 1 AND entity_type = ? AND entity_id = ?",
            (entity_type, entity_id)
        ).fetchone()
        if existing:
            print(f"Resuming council ticket id={existing['id']}")
            return dict(existing)
        project_id = _default_node_for_entity(entity_type, entity_id, c)
        title = f"Council — {entity_type}:{entity_id}"
        cur = c.execute(
            "INSERT INTO tickets "
            "(project_id, title, description, state, priority, spl_ticket_type, entity_type, entity_id, created_at, updated_at) "
            "VALUES (?, ?, '', 'In Progress', 'medium', 1, ?, ?, ?, ?)",
            (project_id, title, entity_type, entity_id, now, now)
        )
        ticket_id = cur.lastrowid
        # Root comment sentinel (required by PM comment chain)
        c.execute(
            "INSERT INTO comments (ticket_id, parent_id, author, content, is_root, created_at) "
            "VALUES (?, NULL, 'system', '', 1, ?)",
            (ticket_id, now)
        )
        row = c.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        print(f"Created council ticket id={ticket_id}")
        return dict(row)


def _add_members_from_seat_list(ticket_id: int, seats: list[dict]) -> list[dict]:
    """
    seats: list of {persona_slug, provider, model, seat_order}
    Inserts council_member rows, returns them with persona_name attached.
    Skips if members already exist for this ticket.
    """
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        existing = c.execute(
            "SELECT id FROM council_members WHERE ticket_id = ?", (ticket_id,)
        ).fetchall()
        if existing:
            print(f"Council ticket already has {len(existing)} members — skipping member setup.")
        else:
            for seat in seats:
                c.execute(
                    "INSERT INTO council_members "
                    "(ticket_id, persona_slug, seat_order, provider, model, state, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 'active', ?)",
                    (ticket_id, seat["persona_slug"], seat["seat_order"],
                     seat.get("provider", "claude"), seat.get("model", "claude-sonnet-4-6"), now)
                )
    return _active_members(ticket_id)


def _entity_summary(entity_type: str, entity_id: str) -> str:
    """Return a brief summary of the entity for injection into persona CLAUDE.md."""
    if entity_type == "project":
        p = pm_db.get_project(entity_id)
        if not p:
            return f"Project: {entity_id}"
        return f"Project: {p['name']}\nDescription: {p.get('description', '(none)')}"
    elif entity_type == "ticket":
        t = pm_db.get_ticket(int(entity_id))
        if not t:
            return f"Ticket #{entity_id}"
        comments_text = "\n".join(
            f"  [{c['created_at'][:10]}] {c['content']}"
            for c in (t.get("comments") or [])
            if c.get("content")
        )
        return (
            f"Ticket T{entity_id}: {t['title']}\n"
            f"State: {t['state']} | Priority: {t['priority']}\n"
            f"Location: {t.get('location', '')}\n"
            f"Description:\n{t.get('description', '(none)')}\n"
            + (f"\nComments:\n{comments_text}" if comments_text else "")
        )
    elif entity_type == "subproject":
        with _conn() as c:
            r = c.execute("SELECT * FROM projects WHERE id = ?", (int(entity_id),)).fetchone()
        if not r:
            return f"Sub-project #{entity_id}"
        return f"Sub-project: {r['name']}\nDescription: {r['description'] or '(none)'}"
    return f"{entity_type}: {entity_id}"


# ── CLAUDE.md builder ─────────────────────────────────────────────────────────

_SESSION_TEMPLATE = (COUNCIL_DIR / "session.md").read_text()


def _build_persona_claude_md(member: dict, ticket: dict, entity_summary: str) -> str:
    session = _SESSION_TEMPLATE.format(
        ticket_id=ticket['id'],
        member_id=member['id'],
        entity_summary=entity_summary,
    )
    return f"{member['template_content']}\n{session}"


# ── tmux helpers ──────────────────────────────────────────────────────────────

def _tmux(*args) -> None:
    import subprocess
    subprocess.run([TMUX, *args], check=False, capture_output=True)


def _tmux_send(target: str, text: str) -> None:
    import subprocess
    subprocess.run([TMUX, "send-keys", "-t", target, text, "Enter"], check=False)


def _session_exists(session: str) -> bool:
    import subprocess
    r = subprocess.run([TMUX, "has-session", "-t", session], capture_output=True)
    return r.returncode == 0


def _agent_command(provider: str) -> str:
    NVM_INIT = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
    return {
        "claude": "unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT "
                  "CLAUDE_CODE_IS_NESTED 2>/dev/null; claude",
        "codex":  f"{NVM_INIT} && nvm use 22 && codex",
        "gemini": f"{NVM_INIT} && nvm use 22 && gemini",
    }.get(provider, provider)


# ── Session management ────────────────────────────────────────────────────────

def _session_name(ticket_id: int) -> str:
    return f"council-{ticket_id}"


def _window_name(persona_name: str) -> str:
    return persona_name.lower().replace(" ", "-")[:20]


def launch_persona_windows(ticket_id: int, members: list[dict], work_dir: str,
                            warmup: int = 15) -> None:
    """
    Create one tmux window per persona in the council-{ticket_id} session.
    Each window runs the persona's agent with its CLAUDE.md injected.
    """
    session = _session_name(ticket_id)
    if not _session_exists(session):
        _tmux("new-session", "-d", "-s", session, "-c", work_dir, "-x", "220", "-y", "50")
        # Rename the default window to 'orchestrator'
        _tmux("rename-window", "-t", f"{session}:0", "orchestrator")

    for i, member in enumerate(members):
        win = _window_name(member["persona_name"])

        # Each persona gets its own subdirectory with a CLAUDE.md.
        # Claude Code reads it automatically on startup — no file-read prompt needed.
        persona_dir = Path(work_dir) / win
        persona_dir.mkdir(exist_ok=True)
        (persona_dir / "CLAUDE.md").write_text(member["_claude_md"])

        # Write helper scripts — agents run these instead of curl
        tid = ticket_id
        mid = member["id"]
        (persona_dir / "state.py").write_text(
            f"import urllib.request, json\n"
            f"r = urllib.request.urlopen('http://127.0.0.1:7656/debates/{tid}')\n"
            f"print(json.dumps(json.loads(r.read()), indent=2))\n"
        )
        (persona_dir / "comment.py").write_text(
            f"import sys, json, urllib.request\n"
            f"content = ' '.join(sys.argv[1:])\n"
            f"data = json.dumps({{'member_id': {mid}, 'content': content}}).encode()\n"
            f"req = urllib.request.Request('http://127.0.0.1:7656/debates/{tid}/comments',\n"
            f"    data=data, headers={{'Content-Type': 'application/json'}})\n"
            f"print(urllib.request.urlopen(req).read().decode())\n"
        )
        (persona_dir / "submit.py").write_text(
            f"import sys, json, urllib.request\n"
            f"turn_id = int(sys.argv[1])\n"
            f"did_comment = sys.argv[2].lower() == 'true'\n"
            f"data = json.dumps({{'member_id': {mid}, 'did_comment': did_comment}}).encode()\n"
            f"req = urllib.request.Request(\n"
            f"    f'http://127.0.0.1:7656/debates/{tid}/turns/{{turn_id}}/submit',\n"
            f"    data=data, headers={{'Content-Type': 'application/json'}})\n"
            f"print(urllib.request.urlopen(req).read().decode())\n"
        )

        # Copy session-level settings into persona dir
        for fname in [".claude/settings.json"]:
            src = Path(work_dir) / fname
            dst = persona_dir / fname
            if src.exists():
                dst.parent.mkdir(exist_ok=True)
                dst.write_text(src.read_text())

        _tmux("new-window", "-t", session, "-n", win, "-c", str(persona_dir))

        import subprocess
        agent_cmd = _agent_command(member["provider"])
        subprocess.run([TMUX, "send-keys", "-t", f"{session}:{win}", agent_cmd, "Enter"],
                       check=False)

    print(f"Launched {len(members)} persona windows in session '{session}'.")


# ── Orchestration loop ────────────────────────────────────────────────────────

def orchestrate(ticket_id: int, work_dir: str) -> None:
    """
    Drive the daisy chain until convergence.
    Runs synchronously — attach to 'orchestrator' window to watch.
    """
    print(f"\n[Orchestrator] Starting daisy chain for council ticket {ticket_id}…\n")
    session = _session_name(ticket_id)
    round_num = 1

    while True:
        if not _ticket_row(ticket_id):
            print("[Orchestrator] Ticket not found. Exiting.")
            return

        members = _active_members(ticket_id)
        if not members:
            print("[Orchestrator] No active members. Exiting.")
            return

        print(f"\n[Orchestrator] Round {round_num} — {len(members)} members")

        for member in members:
            persona_name = member["persona_name"]
            member_id    = member["id"]
            win          = _window_name(persona_name)

            turn_id = _grant_turn_db(ticket_id, member_id, round_num)
            print(f"  → {persona_name} (member {member_id}, turn {turn_id})")

            grant_msg = (
                f"COUNCIL TURN GRANTED — Turn ID {turn_id}, Round {round_num}. "
                f"Run: python3 state.py — then python3 comment.py \"...\" if you have something new — "
                f"then python3 submit.py {turn_id} true/false. No other actions."
            )
            _tmux_send(f"{session}:{win}", grant_msg)

            elapsed = 0
            while elapsed < TURN_TIMEOUT:
                time.sleep(POLL_INTERVAL)
                elapsed += POLL_INTERVAL
                turn = _latest_turn_for_member(ticket_id, member_id, round_num)
                if turn and turn.get("completed_at"):
                    action = "commented" if turn["did_comment"] else "passed"
                    print(f"     ✓ {persona_name} {action}")
                    break
            else:
                print(f"     ⚠ {persona_name} timed out after {TURN_TIMEOUT}s — treating as pass")
                now = datetime.now(timezone.utc).isoformat()
                with _conn() as c:
                    c.execute(
                        "UPDATE council_turns SET did_comment = 0, completed_at = ? WHERE id = ?",
                        (now, turn_id)
                    )

        converged = _check_convergence(ticket_id, round_num)
        if converged:
            print(f"\n[Orchestrator] Round {round_num}: all members passed — CONVERGED. Discussion complete.")
            return
        else:
            print(f"[Orchestrator] Round {round_num}: still active — advancing to round {round_num + 1}")
            round_num += 1


# ── Default persona setup ─────────────────────────────────────────────────────

def _get_default_seats() -> list[dict]:
    """Return all personas from council/personas/*.md as default seats, ordered alphabetically."""
    personas_dir = REPO_ROOT / "council" / "personas"
    if not personas_dir.exists():
        return []
    files = sorted(personas_dir.glob("*.md"))
    return [
        {
            "persona_slug": p.stem,
            "provider":     "claude",
            "model":        "claude-sonnet-4-6",
            "seat_order":   i,
        }
        for i, p in enumerate(files)
    ]


# ── Main entry point ──────────────────────────────────────────────────────────

def launch(entity_type: str, entity_id: str,
           seats: list[dict] | None = None,
           ticket_id: int | None = None,
           warmup: int = 15,
           no_attach: bool = False):

    # Resolve work dir (scryer_root / entity dir — fall back to /tmp)
    with _conn() as c:
        r = c.execute("SELECT value FROM scryer_config WHERE key = 'scryer_root'").fetchone()
    scryer_root = r["value"] if r else ""
    work_dir = str(Path(scryer_root).expanduser() / "council" / f"{entity_type}-{entity_id}") \
        if scryer_root else f"/tmp/council-{entity_type}-{entity_id}"
    Path(work_dir).mkdir(parents=True, exist_ok=True)

    # Write session-level settings (copied into each persona subdir by launch_persona_windows)
    import json as _json
    settings_dir = Path(work_dir) / ".claude"
    settings_dir.mkdir(exist_ok=True)
    settings_file = settings_dir / "settings.json"
    settings_file.write_text(_json.dumps({
        "permissions": {
            "allow": [
                "Read",
                "Bash(python3 *)",
            ],
            "deny": []
        }
    }, indent=2))

    # Find or create council ticket
    if ticket_id:
        ticket = _ticket_row(ticket_id)
        if not ticket:
            print(f"ERROR: Ticket {ticket_id} not found.")
            sys.exit(1)
        print(f"Resuming council ticket {ticket_id}")
    else:
        ticket = _get_or_create_ticket(entity_type, entity_id)
        ticket_id = ticket["id"]

    # Add members
    if not seats:
        seats = _get_default_seats()
    if not seats:
        print("ERROR: No personas found. Seed defaults or create personas first.")
        sys.exit(1)

    members = _add_members_from_seat_list(ticket_id, seats)
    if not members:
        print("ERROR: No active members after setup.")
        sys.exit(1)

    # Build entity summary and CLAUDE.md per persona
    entity_sum = _entity_summary(entity_type, entity_id)
    for m in members:
        m["_claude_md"] = _build_persona_claude_md(m, ticket, entity_sum)

    print(f"\nCouncil ticket {ticket_id} — {entity_type}:{entity_id}")
    print(f"Members: {', '.join(m['persona_name'] for m in members)}")
    print(f"Work dir: {work_dir}")

    # Launch tmux windows
    launch_persona_windows(ticket_id, members, work_dir, warmup=warmup)

    session = _session_name(ticket_id)
    if no_attach:
        print(f"\nSession '{session}' ready. Attach with: tmux attach -t {session}")
        print("Running orchestrator in orchestrator window…")
        orch_cmd = (
            f"cd {shlex.quote(str(REPO_ROOT))} && "
            f"python3 council/launch.py --type {shlex.quote(entity_type)} --id {shlex.quote(str(entity_id))} "
            f"--ticket {ticket_id} --orchestrate-only"
        )
        _tmux_send(f"{session}:orchestrator", orch_cmd)
        return

    # Attach and orchestrate
    import subprocess
    subprocess.Popen(
        [TMUX, "attach-session", "-t", f"{session}:orchestrator"],
        close_fds=True
    )
    time.sleep(1)
    orchestrate(ticket_id, work_dir)


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch a Scryer Agent Council session.")
    parser.add_argument("--type",             default=None, choices=["project", "subproject", "ticket"])
    parser.add_argument("--id",               default=None)
    parser.add_argument("--ticket",           type=int, default=None)
    parser.add_argument("--warmup",           type=int, default=15)
    parser.add_argument("--no-attach",        action="store_true")
    parser.add_argument("--orchestrate-only", action="store_true")
    parser.add_argument("--from-stdin",       action="store_true",
                        help="Read JSON payload from stdin (API mode)")
    args = parser.parse_args()

    if args.from_stdin:
        import json as _json
        payload = _json.loads(sys.stdin.read())
        launch(
            entity_type=payload["entity_type"],
            entity_id=str(payload["entity_id"]),
            seats=payload.get("seats") or None,
            warmup=payload.get("warmup", 15),
            no_attach=True,
        )
        sys.exit(0)

    if args.orchestrate_only:
        if not args.ticket:
            print("ERROR: --orchestrate-only requires --ticket")
            sys.exit(1)
        ticket = _ticket_row(args.ticket)
        if not ticket:
            print(f"ERROR: Ticket {args.ticket} not found.")
            sys.exit(1)
        with _conn() as c:
            r = c.execute("SELECT value FROM scryer_config WHERE key = 'scryer_root'").fetchone()
        scryer_root = r["value"] if r else ""
        work_dir = str(Path(scryer_root).expanduser() / "council" / f"{args.type}-{args.id}") \
            if scryer_root else f"/tmp/council-{args.type}-{args.id}"
        orchestrate(args.ticket, work_dir)
    else:
        if not args.type or not args.id:
            print("ERROR: --type and --id are required unless using --from-stdin")
            sys.exit(1)
        launch(
            entity_type=args.type,
            entity_id=args.id,
            ticket_id=args.ticket,
            warmup=args.warmup,
            no_attach=args.no_attach,
        )
