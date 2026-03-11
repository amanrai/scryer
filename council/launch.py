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


def _debate_row(debate_id: int) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM council_debates WHERE id = ?", (debate_id,)).fetchone()
        return dict(r) if r else None


def _active_members(debate_id: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            """SELECT cm.*, p.name AS persona_name, p.template_content
               FROM council_members cm
               JOIN personas p ON p.id = cm.persona_id
               WHERE cm.debate_id = ? AND cm.state = 'active'
               ORDER BY cm.seat_order""",
            (debate_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def _turns_this_round(debate_id: int, round_num: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM council_turns WHERE debate_id = ? AND round = ?",
            (debate_id, round_num)
        ).fetchall()
    return [dict(r) for r in rows]


def _latest_turn_for_member(debate_id: int, member_id: int, round_num: int) -> dict | None:
    with _conn() as c:
        r = c.execute(
            "SELECT * FROM council_turns WHERE debate_id = ? AND member_id = ? AND round = ? "
            "ORDER BY id DESC LIMIT 1",
            (debate_id, member_id, round_num)
        ).fetchone()
    return dict(r) if r else None


def _pending_human_turn(debate_id: int) -> bool:
    """True if a human_pending comment exists (raise_hand was called)."""
    with _conn() as c:
        r = c.execute(
            "SELECT id FROM council_comments WHERE debate_id = ? AND author = 'human_pending' LIMIT 1",
            (debate_id,)
        ).fetchone()
    return r is not None


def _clear_human_pending(debate_id: int) -> None:
    with _conn() as c:
        c.execute(
            "DELETE FROM council_comments WHERE debate_id = ? AND author = 'human_pending'",
            (debate_id,)
        )


def _grant_turn_db(debate_id: int, member_id: int | None, round_num: int) -> int:
    """Insert a turn record and return its id."""
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO council_turns (debate_id, member_id, round, did_comment, completed_at) "
            "VALUES (?, ?, ?, 0, NULL)",
            (debate_id, member_id, round_num)
        )
    return cur.lastrowid


def _advance_round_db(debate_id: int, new_round: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        c.execute(
            "UPDATE council_debates SET round = ?, state = 'active', updated_at = ? WHERE id = ?",
            (new_round, now, debate_id)
        )


def _set_debate_state(debate_id: int, state: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        c.execute(
            "UPDATE council_debates SET state = ?, updated_at = ? WHERE id = ?",
            (state, now, debate_id)
        )


def _check_convergence(debate_id: int, round_num: int) -> bool:
    members = _active_members(debate_id)
    turns   = _turns_this_round(debate_id, round_num)
    completed = {t["member_id"] for t in turns if t["completed_at"]}
    active    = {m["id"] for m in members}
    if active != completed:
        return False
    return all(t["did_comment"] == 0 for t in turns if t["member_id"] in active)


def _get_or_create_debate(entity_type: str, entity_id: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        existing = c.execute(
            "SELECT * FROM council_debates WHERE entity_type = ? AND entity_id = ?",
            (entity_type, entity_id)
        ).fetchone()
        if existing:
            print(f"Resuming existing debate id={existing['id']} (state={existing['state']})")
            return dict(existing)
        cur = c.execute(
            "INSERT INTO council_debates (entity_type, entity_id, state, round, created_at, updated_at) "
            "VALUES (?, ?, 'active', 1, ?, ?)",
            (entity_type, entity_id, now, now)
        )
        debate_id = cur.lastrowid
        row = c.execute("SELECT * FROM council_debates WHERE id = ?", (debate_id,)).fetchone()
        print(f"Created new debate id={debate_id}")
        return dict(row)


def _add_members_from_seat_list(debate_id: int, seats: list[dict]) -> list[dict]:
    """
    seats: list of {persona_id, provider, model, seat_order}
    Inserts council_member rows, returns them with persona_name attached.
    Skips if members already exist for this debate.
    """
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        existing = c.execute(
            "SELECT id FROM council_members WHERE debate_id = ?", (debate_id,)
        ).fetchall()
        if existing:
            print(f"Debate already has {len(existing)} members — skipping member setup.")
        else:
            for seat in seats:
                c.execute(
                    "INSERT INTO council_members "
                    "(debate_id, persona_id, seat_order, provider, model, state, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 'active', ?)",
                    (debate_id, seat["persona_id"], seat["seat_order"],
                     seat.get("provider", "claude"), seat.get("model", "claude-sonnet-4-6"), now)
                )
    return _active_members(debate_id)


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

def _build_persona_claude_md(member: dict, debate: dict, entity_summary: str) -> str:
    return f"""{member['template_content']}

---

## Council session context

**Debate ID:** {debate['id']}
**Your Member ID:** {member['id']}
**Entity under review:**

{entity_summary}

---

## Council MCP tools (council-local)

You have access to the `council-local` MCP server. The tools you will use:

- `get_debate_state(debate_id)` — read the full discussion history and turn status
- `add_council_comment(debate_id, member_id, content, author)` — write your analysis
- `submit_turn(debate_id, member_id, did_comment, turn_id)` — signal you are done

**member_id for all your calls: {member['id']}**

## Waiting for your turn

You will receive a message: **COUNCIL TURN GRANTED: ...** when it is your turn to speak.
Do not act until you receive this message. Stay idle and wait.

When your turn is granted:
1. Call `get_debate_state({debate['id']})` to read the full discussion.
2. If you have something new to add: call `add_council_comment`, then `submit_turn` with `did_comment=true`.
3. If you have nothing new to add: call `submit_turn` with `did_comment=false`.
4. Do not take any other action. Read and comment only.
"""


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

def _session_name(debate_id: int) -> str:
    return f"council-{debate_id}"


def _window_name(persona_name: str) -> str:
    return persona_name.lower().replace(" ", "-")[:20]


def launch_persona_windows(debate_id: int, members: list[dict], work_dir: str,
                            warmup: int = 15) -> None:
    """
    Create one tmux window per persona in the council-{debate_id} session.
    Each window runs the persona's agent with its CLAUDE.md injected.
    """
    session = _session_name(debate_id)
    if not _session_exists(session):
        _tmux("new-session", "-d", "-s", session, "-c", work_dir, "-x", "220", "-y", "50")
        # Rename the default window to 'orchestrator'
        _tmux("rename-window", "-t", f"{session}:0", "orchestrator")

    for i, member in enumerate(members):
        win = _window_name(member["persona_name"])
        # Create a new window for this persona
        _tmux("new-window", "-t", session, "-n", win, "-c", work_dir)

        # Write persona's CLAUDE.md to the work_dir (unique per persona)
        persona_slug = win
        claude_md_path = Path(work_dir) / f"COUNCIL-{persona_slug}.md"
        # Entity summary is embedded in the CLAUDE.md already; write file for reference
        claude_md_path.write_text(member["_claude_md"])

        agent_cmd = _agent_command(member["provider"])
        import subprocess
        subprocess.run([TMUX, "send-keys", "-t", f"{session}:{win}", agent_cmd, "Enter"],
                       check=False)

        # After warmup, send startup message
        startup_msg = (
            f"Please read COUNCIL-{persona_slug}.md carefully. "
            f"This defines your role and the council session context. "
            f"Once you have read it, confirm you are ready and wait for your turn to be granted."
        )
        import subprocess as sp
        script = (
            f"sleep {warmup + i * 3} && "
            f"{TMUX} send-keys -t {shlex.quote(f'{session}:{win}')} "
            f"{shlex.quote(startup_msg)} Enter"
        )
        sp.Popen(["bash", "-c", script], close_fds=True, start_new_session=True,
                 stdout=sp.DEVNULL, stderr=sp.DEVNULL)

    print(f"Launched {len(members)} persona windows in session '{session}'.")


# ── Orchestration loop ────────────────────────────────────────────────────────

def orchestrate(debate_id: int, work_dir: str) -> None:
    """
    Drive the daisy chain until convergence, then move to action round.
    Runs synchronously — attach to 'orchestrator' window to watch.
    """
    print(f"\n[Orchestrator] Starting daisy chain for debate {debate_id}…\n")
    session = _session_name(debate_id)

    while True:
        debate = _debate_row(debate_id)
        if not debate:
            print("[Orchestrator] Debate not found. Exiting.")
            return

        state = debate["state"]
        if state == "archived":
            print("[Orchestrator] Debate archived. Done.")
            return
        if state == "action_round":
            print("[Orchestrator] Debate reached action round. Human review required.")
            print(f"  Open the Scryer UI → Council tab → Debate {debate_id} to review action proposals.")
            return

        round_num = debate["round"]
        members   = _active_members(debate_id)
        if not members:
            print("[Orchestrator] No active members. Exiting.")
            return

        print(f"\n[Orchestrator] Round {round_num} — {len(members)} members")

        # One full pass through all members
        round_complete = False
        for member in members:

            # Check for human pending turn before each persona
            if _pending_human_turn(debate_id):
                print(f"[Orchestrator] Human raised hand — pausing for human input.")
                _clear_human_pending(debate_id)
                print("[Orchestrator] Waiting for human to press Enter to continue…")
                try:
                    input()
                except EOFError:
                    pass

            persona_name = member["persona_name"]
            member_id    = member["id"]
            win          = _window_name(persona_name)

            # Grant turn in DB
            turn_id = _grant_turn_db(debate_id, member_id, round_num)
            print(f"  → {persona_name} (member {member_id}, turn {turn_id})")

            # Send turn notification to persona's tmux window
            grant_msg = (
                f"COUNCIL TURN GRANTED — Debate ID: {debate_id}, "
                f"Round: {round_num}, Turn ID: {turn_id}, Member ID: {member_id}. "
                f"Call get_debate_state({debate_id}) to read the full discussion, "
                f"add your analysis with add_council_comment if you have something new, "
                f"then call submit_turn(debate_id={debate_id}, member_id={member_id}, "
                f"did_comment=<true|false>, turn_id={turn_id})."
            )
            _tmux_send(f"{session}:{win}", grant_msg)

            # Poll until turn is complete or timeout
            elapsed = 0
            while elapsed < TURN_TIMEOUT:
                time.sleep(POLL_INTERVAL)
                elapsed += POLL_INTERVAL
                turn = _latest_turn_for_member(debate_id, member_id, round_num)
                if turn and turn.get("completed_at"):
                    action = "commented" if turn["did_comment"] else "passed"
                    print(f"     ✓ {persona_name} {action}")
                    break
            else:
                print(f"     ⚠ {persona_name} timed out after {TURN_TIMEOUT}s — treating as pass")
                # Mark as complete with did_comment=0
                now = datetime.now(timezone.utc).isoformat()
                with _conn() as c:
                    c.execute(
                        "UPDATE council_turns SET did_comment = 0, completed_at = ? WHERE id = ?",
                        (now, turn_id)
                    )

        # End of round — check convergence
        converged = _check_convergence(debate_id, round_num)
        if converged:
            print(f"\n[Orchestrator] Round {round_num}: all members passed — CONVERGED.")
            print("[Orchestrator] Beginning action proposal round…")
            _set_debate_state(debate_id, "action_round")

            # Notify all personas for action round
            for member in members:
                win = _window_name(member["persona_name"])
                action_msg = (
                    f"ACTION ROUND — The debate has converged. "
                    f"You now have one final turn to propose actions. "
                    f"Call propose_action(debate_id={debate_id}, member_id={member['id']}, "
                    f"action_type=<'create'|'comment'|'reopen'>, content=<your proposal>, "
                    f"ticket_id=<optional>) for each action you recommend. "
                    f"When done, call submit_turn(debate_id={debate_id}, "
                    f"member_id={member['id']}, did_comment=false, turn_id=None)."
                )
                _tmux_send(f"{session}:{win}", action_msg)
                # Wait for action turn completion (reuse polling loop)
                turn_id = _grant_turn_db(debate_id, member["id"], round_num)
                elapsed = 0
                while elapsed < TURN_TIMEOUT:
                    time.sleep(POLL_INTERVAL)
                    elapsed += POLL_INTERVAL
                    turn = _latest_turn_for_member(debate_id, member["id"], round_num)
                    if turn and turn["id"] == turn_id and turn.get("completed_at"):
                        break
                print(f"  ✓ {member['persona_name']} action proposals submitted")

            print("\n[Orchestrator] Action round complete. Human review required in the UI.")
            return

        else:
            print(f"[Orchestrator] Round {round_num}: debate still active — advancing to round {round_num + 1}")
            _advance_round_db(debate_id, round_num + 1)


# ── Default persona setup ─────────────────────────────────────────────────────

def _get_default_seats() -> list[dict]:
    """Return all global personas as default seats, ordered alphabetically."""
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM personas WHERE is_global = 1 ORDER BY name"
        ).fetchall()
    return [
        {
            "persona_id":  r["id"],
            "provider":    "claude",
            "model":       "claude-sonnet-4-6",
            "seat_order":  i,
        }
        for i, r in enumerate(rows)
    ]


# ── Main entry point ──────────────────────────────────────────────────────────

def launch(entity_type: str, entity_id: str,
           seats: list[dict] | None = None,
           debate_id: int | None = None,
           warmup: int = 15,
           no_attach: bool = False):

    # Resolve work dir (scryer_root / entity dir — fall back to /tmp)
    with _conn() as c:
        r = c.execute("SELECT value FROM scryer_config WHERE key = 'scryer_root'").fetchone()
    scryer_root = r["value"] if r else ""
    work_dir = str(Path(scryer_root).expanduser() / "council" / f"{entity_type}-{entity_id}") \
        if scryer_root else f"/tmp/council-{entity_type}-{entity_id}"
    Path(work_dir).mkdir(parents=True, exist_ok=True)

    # Create or resume debate
    if debate_id:
        debate = _debate_row(debate_id)
        if not debate:
            print(f"ERROR: Debate {debate_id} not found.")
            sys.exit(1)
        print(f"Resuming debate {debate_id}")
    else:
        debate = _get_or_create_debate(entity_type, entity_id)
        debate_id = debate["id"]

    # Add members
    if not seats:
        seats = _get_default_seats()
    if not seats:
        print("ERROR: No personas found. Seed defaults or create personas first.")
        sys.exit(1)

    members = _add_members_from_seat_list(debate_id, seats)
    if not members:
        print("ERROR: No active members after setup.")
        sys.exit(1)

    # Build entity summary and CLAUDE.md per persona
    entity_sum = _entity_summary(entity_type, entity_id)
    for m in members:
        m["_claude_md"] = _build_persona_claude_md(m, debate, entity_sum)

    print(f"\nCouncil debate {debate_id} — {entity_type}:{entity_id}")
    print(f"Members: {', '.join(m['persona_name'] for m in members)}")
    print(f"Work dir: {work_dir}")

    # Launch tmux windows
    launch_persona_windows(debate_id, members, work_dir, warmup=warmup)

    session = _session_name(debate_id)
    if no_attach:
        print(f"\nSession '{session}' ready. Attach with: tmux attach -t {session}")
        print("Running orchestrator in background…")
        import subprocess
        script = (
            f"cd {shlex.quote(str(REPO_ROOT))} && "
            f"python3 council/launch.py --type {entity_type} --id {entity_id} "
            f"--debate {debate_id} --orchestrate-only"
        )
        subprocess.Popen(["bash", "-c", script], close_fds=True, start_new_session=True,
                         stdout=open(f"{work_dir}/orchestrator.log", "a"),
                         stderr=subprocess.STDOUT)
        return

    # Attach and orchestrate
    import subprocess
    subprocess.Popen(
        [TMUX, "attach-session", "-t", f"{session}:orchestrator"],
        close_fds=True
    )
    time.sleep(1)
    orchestrate(debate_id, work_dir)


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch a Scryer Agent Council session.")
    parser.add_argument("--type",    required=True, choices=["project", "subproject", "ticket"],
                        help="Entity type")
    parser.add_argument("--id",      required=True, help="Entity id (name for project, numeric id otherwise)")
    parser.add_argument("--debate",  type=int, default=None,
                        help="Resume a specific debate by id")
    parser.add_argument("--warmup",  type=int, default=15,
                        help="Seconds to wait before sending first message to each persona (default: 15)")
    parser.add_argument("--no-attach", action="store_true",
                        help="Set up sessions but do not attach (for API / background use)")
    parser.add_argument("--orchestrate-only", action="store_true",
                        help="Skip setup and run orchestration loop only (used by --no-attach)")
    args = parser.parse_args()

    if args.orchestrate_only:
        if not args.debate:
            print("ERROR: --orchestrate-only requires --debate")
            sys.exit(1)
        debate = _debate_row(args.debate)
        if not debate:
            print(f"ERROR: Debate {args.debate} not found.")
            sys.exit(1)
        with _conn() as c:
            r = c.execute("SELECT value FROM scryer_config WHERE key = 'scryer_root'").fetchone()
        scryer_root = r["value"] if r else ""
        work_dir = str(Path(scryer_root).expanduser() / "council" / f"{args.type}-{args.id}") \
            if scryer_root else f"/tmp/council-{args.type}-{args.id}"
        orchestrate(args.debate, work_dir)
    else:
        launch(
            entity_type=args.type,
            entity_id=args.id,
            debate_id=args.debate,
            warmup=args.warmup,
            no_attach=args.no_attach,
        )
