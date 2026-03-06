"""
Oracle — stateless context broker for executing agents.

Reconstructs just enough context to answer a question from the three-layer
state model (log → plan.md → code), calls the configured LLM, and returns
a typed response: answer | caution | block.

If the response is a block, the ticket is moved to Needs Input and a comment
is posted explaining what the human must resolve.
"""

import json
import os
import sqlite3
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

# ── Paths ─────────────────────────────────────────────────────────────────────

DB_PATH = Path(__file__).parent.parent / "infra" / "ProjectManagement" / "data" / "pm.db"
PM_PATH = Path(__file__).parent.parent / "infra" / "ProjectManagement"

# ── System prompt ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are the Oracle — a stateless context broker for the Scryer multi-agent development system.

Your role: answer questions from executing agents by reasoning over project context.
You are read-only and advisory only. You never execute, modify, or suggest direct actions — only advise.

You have been provided with:
- Full project overview: every project, sub-project, and ticket with their current states
- The focal ticket in detail (id, title, description, state, comments, blockers) — if one was specified
- Recent activity log entries (most recent first)
- Plan.md summaries from the project hierarchy (when available)

You can reason across the entire project — not just the focal ticket. If a question is about
the system as a whole, answer from the project overview. If it's about a specific ticket, use
the detailed ticket context.

Response format — respond with exactly one of these prefixes on the first line:

ANSWER: <concise answer with citations>
Use when you can answer confidently. Cite the source (T42, plan.md section, log entry timestamp).

CAUTION: <answer with a caveat>
Use when you can answer but the agent should be aware of a risk or conflict.

BLOCK: <reason written for a human reading on a phone>
Use when:
- The question cannot be answered from the available context (no relevant tickets, plan, or logs exist)
- The agent cannot safely proceed without a human decision
- There is a genuine conflict or ambiguity that could cause irreversible harm
Be specific: what does the human need to decide? Write for a human reading on a phone.

Rules:
- Never hallucinate state. If you don't know, say so explicitly.
- Be concise. Agents have limited context windows.
- Cite sources. Don't say "the plan says" — say "plan.md > UI > T16 says".
- BLOCK sparingly. Only block when there is a genuine ambiguity or conflict that could cause irreversible harm."""


# ── DB helpers ────────────────────────────────────────────────────────────────

def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _get_config() -> dict:
    conn = _db()
    rows = conn.execute(
        "SELECT key, value FROM scryer_config WHERE key IN "
        "('oracle_provider', 'oracle_model', 'scryer_root')"
    ).fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}



def _project_overview() -> str:
    """Build a compact overview of all projects, sub-projects, and tickets."""
    conn = _db()

    # Get all visible projects (not default nodes) with parent info
    projects = conn.execute(
        "SELECT id, name, parent_id, description FROM projects WHERE is_default = 0 ORDER BY id"
    ).fetchall()

    # Get all tickets (compact)
    tickets = conn.execute(
        "SELECT t.id, t.title, t.state, t.priority, t.project_id, "
        "p.name as proj_name, p.parent_id as proj_parent "
        "FROM tickets t JOIN projects p ON t.project_id = p.id "
        "ORDER BY t.id"
    ).fetchall()

    conn.close()

    # Build project id → path map
    proj_map = {p["id"]: p for p in projects}
    def proj_path(pid):
        parts = []
        while pid:
            p = proj_map.get(pid)
            if not p:
                break
            parts.insert(0, p["name"])
            pid = p["parent_id"]
        return " > ".join(parts)

    # Group tickets by their resolved project path
    from collections import defaultdict
    by_proj = defaultdict(list)
    for t in tickets:
        # Walk up from ticket's project_id to find the visible parent
        path = proj_path(t["proj_parent"] if t["proj_parent"] else t["project_id"])
        by_proj[path or t["proj_name"]].append(t)

    lines = ["## Full project overview"]
    for path in sorted(by_proj.keys()):
        lines.append(f"\n### {path}")
        for t in by_proj[path]:
            lines.append(f"  T{t['id']} [{t['state']}] {t['title']}")

    return "\n".join(lines)


# ── Context builders ──────────────────────────────────────────────────────────

def _ticket_context(ticket_id: int) -> str:
    conn = _db()

    # Walk project tree to build location path
    ticket = conn.execute(
        "SELECT id, title, description, state, priority, project_id FROM tickets WHERE id = ?",
        (ticket_id,),
    ).fetchone()
    if not ticket:
        conn.close()
        return f"Ticket {ticket_id} not found."

    parts = []
    pid = ticket["project_id"]
    while pid:
        p = conn.execute(
            "SELECT name, parent_id, is_default FROM projects WHERE id = ?", (pid,)
        ).fetchone()
        if not p:
            break
        if not p["is_default"]:
            parts.insert(0, p["name"])
        pid = p["parent_id"]
    location = " > ".join(parts)

    comments = conn.execute(
        "SELECT content, created_at, is_root FROM comments "
        "WHERE ticket_id = ? AND is_root = 0 ORDER BY created_at ASC",
        (ticket_id,),
    ).fetchall()

    blockers = conn.execute(
        "SELECT t.id, t.title, t.state FROM tickets t "
        "JOIN ticket_blocks b ON b.blocker_id = t.id WHERE b.blocked_id = ?",
        (ticket_id,),
    ).fetchall()

    blocking = conn.execute(
        "SELECT t.id, t.title, t.state FROM tickets t "
        "JOIN ticket_blocks b ON b.blocked_id = t.id WHERE b.blocker_id = ?",
        (ticket_id,),
    ).fetchall()

    conn.close()

    lines = [
        f"## Ticket T{ticket['id']}: {ticket['title']}",
        f"State: {ticket['state']} | Priority: {ticket['priority']}",
        f"Location: {location}",
    ]
    if ticket["description"]:
        lines += ["", "### Description", ticket["description"]]
    if blockers:
        lines += ["", "### Blocked by (must be Closed before this starts)"]
        for b in blockers:
            lines.append(f"- T{b['id']} [{b['state']}]: {b['title']}")
    if blocking:
        lines += ["", "### This ticket blocks"]
        for b in blocking:
            lines.append(f"- T{b['id']} [{b['state']}]: {b['title']}")
    if comments:
        lines += ["", "### Comment thread"]
        for c in comments:
            lines.append(f"[{c['created_at'][:19]}] {c['content']}")

    return "\n".join(lines)


def _log_context(ticket_id: int, limit: int = 25) -> str:
    conn = _db()
    ticket_rows = conn.execute(
        "SELECT action, message, details, actor, created_at FROM logs "
        "WHERE ticket_id = ? ORDER BY created_at DESC LIMIT ?",
        (ticket_id, limit),
    ).fetchall()
    global_rows = conn.execute(
        "SELECT action, message, details, actor, created_at FROM logs "
        "WHERE (ticket_id IS NULL OR ticket_id != ?) ORDER BY created_at DESC LIMIT 10",
        (ticket_id,),
    ).fetchall()
    conn.close()

    lines = ["## Activity log — this ticket (newest first)"]
    for r in ticket_rows:
        actor = r["actor"] or "human"
        lines.append(f"[{r['created_at'][:19]}] [{actor}] {r['action']}: {r['message']}")

    if global_rows:
        lines += ["", "## Recent global activity"]
        for r in global_rows:
            actor = r["actor"] or "human"
            lines.append(f"[{r['created_at'][:19]}] [{actor}] {r['action']}: {r['message']}")

    return "\n".join(lines)


def _plan_context(scryer_root: str) -> str:
    if not scryer_root:
        return ""
    root = Path(scryer_root).expanduser()
    if not root.exists():
        return ""

    plan_files = sorted(root.rglob("plan.md"))[:20]
    if not plan_files:
        return ""

    summaries = []
    for pf in plan_files:
        try:
            text = pf.read_text(errors="ignore")
            # First non-empty paragraph as summary
            first_para = next(
                (p.strip() for p in text.split("\n\n") if p.strip()), ""
            )[:400]
            rel = pf.relative_to(root)
            summaries.append(f"### {rel}\n{first_para}")
        except Exception:
            pass

    if not summaries:
        return ""
    return "## Plan files (summaries — oracle decides which to read in full)\n\n" + "\n\n".join(summaries)



def _log_context_global(limit: int = 30) -> str:
    conn = _db()
    rows = conn.execute(
        "SELECT action, message, details, actor, created_at FROM logs "
        "ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    lines = ["## Recent global activity (newest first)"]
    for r in rows:
        actor = r["actor"] or "human"
        lines.append(f"[{r['created_at'][:19]}] [{actor}] {r['action']}: {r['message']}")
    return "\n".join(lines)


# ── LLM clients ───────────────────────────────────────────────────────────────

def _call_claude(model: str, system: str, user: str) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    msg = client.messages.create(
        model=model,
        max_tokens=1024,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return msg.content[0].text


def _call_gemini(model: str, system: str, user: str) -> str:
    import google.generativeai as genai
    genai.configure(api_key=os.environ["GOOGLE_API_KEY"])
    m = genai.GenerativeModel(model, system_instruction=system)
    return m.generate_content(user).text


def _call_openai(model: str, system: str, user: str) -> str:
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=1024,
    )
    return resp.choices[0].message.content


def _call_llm(provider: str, model: str, system: str, user: str) -> str:
    if provider == "claude":
        return _call_claude(model, system, user)
    elif provider == "gemini":
        return _call_gemini(model, system, user)
    elif provider in ("codex", "openai"):
        return _call_openai(model, system, user)
    else:
        raise ValueError(f"Unknown oracle provider: {provider!r}")


# ── Response parsing ──────────────────────────────────────────────────────────

def _parse(text: str) -> dict:
    text = text.strip()
    for prefix, rtype in [("BLOCK:", "block"), ("CAUTION:", "caution"), ("ANSWER:", "answer")]:
        if text.upper().startswith(prefix):
            return {"type": rtype, "content": text[len(prefix):].strip()}
    return {"type": "answer", "content": text}


# ── Block handling ────────────────────────────────────────────────────────────

def _handle_block(ticket_id: int | None, question: str, reason: str) -> None:
    sys.path.insert(0, str(PM_PATH))
    import db as pm_db
    pm_db.init_db()

    comment = (
        f"🛑 **Oracle blocked execution**\n\n"
        f"**Agent asked:** {question}\n\n"
        f"**Oracle says:** {reason}\n\n"
        f"_Human must resolve this before the agent can continue. "
        f"Reply to this comment with your decision._"
    )
    if ticket_id is not None:
        pm_db.add_comment(ticket_id, comment, actor="oracle")
        try:
            pm_db.update_ticket(ticket_id, actor="oracle", state="Needs Input")
        except Exception:
            pass


# ── Public API ────────────────────────────────────────────────────────────────

def ask(ticket_id: int | None, question: str, calling_agent: str = "agent") -> dict:
    """
    Ask the oracle a question about a ticket's context.

    Returns:
        {"type": "answer" | "caution" | "block", "content": str}

    Side effects on block:
        - Ticket moved to Needs Input
        - Block comment posted on ticket
    """
    config      = _get_config()
    provider    = config.get("oracle_provider", "claude")
    model       = config.get("oracle_model", "claude-haiku-4-5-20251001")
    scryer_root = config.get("scryer_root", "")

    overview   = _project_overview()
    ticket_ctx = _ticket_context(ticket_id) if ticket_id else ""
    log_ctx    = _log_context(ticket_id) if ticket_id else _log_context_global()
    plan_ctx   = _plan_context(scryer_root)

    sections = [overview]
    if ticket_ctx:
        sections.append(ticket_ctx)
    sections.append(log_ctx)
    if plan_ctx:
        sections.append(plan_ctx)

    user_msg = "\n\n---\n\n".join(sections)
    user_msg += (
        f"\n\n---\n\n"
        f"## Question from executing agent ({calling_agent})\n\n"
        f"{question}"
    )

    raw    = _call_llm(provider, model, SYSTEM_PROMPT, user_msg)
    result = _parse(raw)

    resulting_state = None
    if result["type"] == "block":
        _handle_block(ticket_id, question, result["content"])
        if ticket_id is not None:
            resulting_state = "Needs Input"

    result["ticket_state"] = resulting_state
    return result


def build_startup_context(ticket_id: int) -> str:
    """
    Called by the orchestrator at agent instantiation.
    Returns a context string the agent can include in its starting prompt.
    """
    config      = _get_config()
    scryer_root = config.get("scryer_root", "")

    overview   = _project_overview()
    ticket_ctx = _ticket_context(ticket_id)
    log_ctx    = _log_context(ticket_id, limit=15)
    plan_ctx   = _plan_context(scryer_root)

    sections = [overview, ticket_ctx, log_ctx]
    if plan_ctx:
        sections.append(plan_ctx)

    return "\n\n---\n\n".join(sections)
