import sqlite3
import os
import json
import secrets
from datetime import datetime, timezone, timedelta
from pathlib import Path
import fs as _fs

DB_PATH = Path(os.environ.get("PM_DB_PATH", Path(__file__).parent / "data" / "pm.db"))

VALID_STATES = ["Unopened", "In Progress", "Agent Finished", "In Review", "Needs Tests", "Needs Input", "Closed"]
DEFAULT_NAME = "default"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def _create_schema(conn) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id           INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            name                TEXT NOT NULL,
            description         TEXT NOT NULL DEFAULT '',
            code_path           TEXT NOT NULL DEFAULT '',
            git_backend         TEXT NOT NULL DEFAULT '',
            git_repo_url        TEXT NOT NULL DEFAULT '',
            session_claude      TEXT NOT NULL DEFAULT '',
            session_codex       TEXT NOT NULL DEFAULT '',
            session_gemini      TEXT NOT NULL DEFAULT '',
            heartbeat_timeout   INTEGER DEFAULT 300,
            is_default          INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tickets (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            state       TEXT NOT NULL DEFAULT 'Unopened',
            priority    TEXT NOT NULL DEFAULT 'medium',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ticket_blocks (
            blocker_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            blocked_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            PRIMARY KEY (blocker_id, blocked_id)
        );

        CREATE TABLE IF NOT EXISTS comments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            parent_id   INTEGER REFERENCES comments(id),
            content     TEXT NOT NULL DEFAULT '',
            is_root     INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            action      TEXT NOT NULL,
            message     TEXT NOT NULL,
            details     TEXT NOT NULL DEFAULT '{}',
            ticket_id   INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ticket_commits (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            commit_hash TEXT NOT NULL,
            message     TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ticket_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            snapshot    TEXT NOT NULL,
            changed_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_heartbeats (
            ticket_id   INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
            last_seen   TEXT NOT NULL,
            agent_token TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS agent_tokens (
            token       TEXT PRIMARY KEY,
            ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            created_at  TEXT NOT NULL,
            expires_at  TEXT
        );
    """)


def _migrate_v1_to_v2(conn) -> None:
    """Migrate from old 2-table schema (projects + sub_projects) to unified project tree."""
    conn.executescript("""
        ALTER TABLE projects     RENAME TO _v1_projects;
        ALTER TABLE sub_projects RENAME TO _v1_sub_projects;
        ALTER TABLE tickets      RENAME TO _v1_tickets;
    """)

    _create_schema(conn)

    old_projects = conn.execute("SELECT * FROM _v1_projects ORDER BY id").fetchall()
    old_sps      = conn.execute("SELECT * FROM _v1_sub_projects ORDER BY id").fetchall()
    old_tickets  = conn.execute("SELECT * FROM _v1_tickets ORDER BY id").fetchall()

    # Insert old root projects
    project_id_map: dict[int, int] = {}
    for op in old_projects:
        cur = conn.execute(
            "INSERT INTO projects (parent_id, name, description, is_default, created_at) VALUES (NULL, ?, ?, 0, ?)",
            (op["name"], op["description"], op["created_at"]),
        )
        project_id_map[op["id"]] = cur.lastrowid

    # Insert old sub_projects as child project nodes
    sp_id_map: dict[int, int] = {}
    for sp in old_sps:
        new_parent = project_id_map[sp["project_id"]]
        is_def = 1 if sp["name"] == DEFAULT_NAME else 0
        cur = conn.execute(
            "INSERT INTO projects (parent_id, name, description, is_default, created_at) VALUES (?, ?, ?, ?, ?)",
            (new_parent, sp["name"], sp["description"], is_def, sp["created_at"]),
        )
        sp_id_map[sp["id"]] = cur.lastrowid

    # Migrate tickets, preserving IDs so ticket_blocks + comments stay intact
    for t in old_tickets:
        conn.execute(
            "INSERT INTO tickets (id, project_id, title, description, state, priority, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (t["id"], sp_id_map[t["sub_project_id"]], t["title"], t["description"],
             t["state"], t["priority"], t["created_at"], t["updated_at"]),
        )

    # Rebuild comment chains: insert root sentinel per ticket, chain old comments in order
    _existing_tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    old_comments = conn.execute(
        "SELECT * FROM comments ORDER BY ticket_id, created_at"
    ).fetchall() if "comments" in _existing_tables else []

    from collections import defaultdict
    comments_by_ticket: dict[int, list] = defaultdict(list)
    for c in old_comments:
        comments_by_ticket[c["ticket_id"]].append(c)

    all_ticket_ids = [t["id"] for t in old_tickets]
    for tid in all_ticket_ids:
        existing = comments_by_ticket.get(tid, [])
        ts = existing[0]["created_at"] if existing else _now()
        root = conn.execute(
            "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, NULL, '', 1, ?)",
            (tid, ts),
        )
        prev_id = root.lastrowid
        for c in existing:
            cur = conn.execute(
                "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, ?, ?, 0, ?)",
                (tid, prev_id, c["content"], c["created_at"]),
            )
            prev_id = cur.lastrowid

    conn.executescript("""
        DROP TABLE _v1_projects;
        DROP TABLE _v1_sub_projects;
        DROP TABLE _v1_tickets;
    """)


def _migrate_comments_add_threading(conn) -> None:
    """
    Upgrade flat comments (no parent_id/is_root) to the linked-list threading schema.
    Preserves existing comment IDs so nothing external breaks.
    """
    old_comments = conn.execute(
        "SELECT * FROM comments ORDER BY ticket_id, created_at"
    ).fetchall()

    conn.executescript("""
        ALTER TABLE comments RENAME TO _v1_comments;
        CREATE TABLE comments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            parent_id   INTEGER REFERENCES comments(id),
            content     TEXT NOT NULL DEFAULT '',
            is_root     INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        );
    """)

    from collections import defaultdict
    comments_by_ticket: dict[int, list] = defaultdict(list)
    for c in old_comments:
        comments_by_ticket[c["ticket_id"]].append(c)

    # Tickets that already have comments: build root + chain
    for tid, existing in comments_by_ticket.items():
        root = conn.execute(
            "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, NULL, '', 1, ?)",
            (tid, existing[0]["created_at"]),
        )
        prev_id = root.lastrowid
        for c in existing:
            cur = conn.execute(
                "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, ?, ?, 0, ?)",
                (tid, prev_id, c["content"], c["created_at"]),
            )
            prev_id = cur.lastrowid

    # Tickets with no comments yet: just insert their root sentinel
    tickets_with_comments = set(comments_by_ticket.keys())
    all_tickets = conn.execute("SELECT id, created_at FROM tickets").fetchall()
    for t in all_tickets:
        if t["id"] not in tickets_with_comments:
            conn.execute(
                "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, NULL, '', 1, ?)",
                (t["id"], t["created_at"]),
            )

    conn.execute("DROP TABLE _v1_comments")


def reset_db() -> None:
    """Drop all tables and reinitialise from scratch. Development use only."""
    with get_conn() as conn:
        conn.executescript("""
            PRAGMA foreign_keys = OFF;
            DROP TABLE IF EXISTS comments;
            DROP TABLE IF EXISTS ticket_blocks;
            DROP TABLE IF EXISTS tickets;
            DROP TABLE IF EXISTS projects;
            PRAGMA foreign_keys = ON;
        """)
        _create_schema(conn)


def init_db() -> None:
    with get_conn() as conn:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        if "sub_projects" in tables:
            _migrate_v1_to_v2(conn)
        else:
            _create_schema(conn)

        # Comments threading migration (for DBs created before this schema version)
        if "comments" in tables:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(comments)").fetchall()}
            if "parent_id" not in cols:
                _migrate_comments_add_threading(conn)

        # Ensure logs table exists (may be absent in older DBs)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                action      TEXT NOT NULL,
                message     TEXT NOT NULL,
                details     TEXT NOT NULL DEFAULT '{}',
                ticket_id   INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
                created_at  TEXT NOT NULL
            )
        """)
        log_cols = {r[1] for r in conn.execute("PRAGMA table_info(logs)").fetchall()}
        if "ticket_id" not in log_cols:
            conn.execute("ALTER TABLE logs ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL")

        # Add columns to projects if absent (older DBs)
        proj_cols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
        if "code_path" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN code_path TEXT NOT NULL DEFAULT ''")
        if "git_backend" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN git_backend TEXT NOT NULL DEFAULT ''")
        if "git_repo_url" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN git_repo_url TEXT NOT NULL DEFAULT ''")
        if "session_claude" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN session_claude TEXT NOT NULL DEFAULT ''")
        if "session_codex" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN session_codex TEXT NOT NULL DEFAULT ''")
        if "session_gemini" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN session_gemini TEXT NOT NULL DEFAULT ''")
        if "heartbeat_timeout" not in proj_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN heartbeat_timeout INTEGER DEFAULT 300")

        # scryer_config — shared with Express ui/server
        conn.execute("""
            CREATE TABLE IF NOT EXISTS scryer_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
        """)

        # New tables (may be absent in older DBs)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ticket_commits (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
                commit_hash TEXT NOT NULL,
                message     TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ticket_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
                snapshot    TEXT NOT NULL,
                changed_at  TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_heartbeats (
                ticket_id   INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
                last_seen   TEXT NOT NULL,
                agent_token TEXT NOT NULL DEFAULT ''
            )
        """)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_project_by_name(name: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM projects WHERE name = ? AND is_default = 0", (name,)
        ).fetchone()
        return dict(row) if row else None


def _get_default_child(parent_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM projects WHERE parent_id = ? AND is_default = 1", (parent_id,)
        ).fetchone()
        return dict(row) if row else None


def _resolve_ticket_target(project_name: str, sub_project_name: str | None) -> int:
    """Return the project_id (always a 'default' node) where a ticket should land."""
    project = _get_project_by_name(project_name)
    if not project:
        raise ValueError(f"Project '{project_name}' not found")

    if sub_project_name:
        with get_conn() as conn:
            child = conn.execute(
                "SELECT * FROM projects WHERE parent_id = ? AND name = ? AND is_default = 0",
                (project["id"], sub_project_name),
            ).fetchone()
        if not child:
            raise ValueError(f"Sub-project '{sub_project_name}' not found under '{project_name}'")
        parent_id = child["id"]
    else:
        parent_id = project["id"]

    default_child = _get_default_child(parent_id)
    if not default_child:
        raise ValueError(f"Internal: no default node found for project id {parent_id}")
    return default_child["id"]


def _project_path(project_id: int) -> str:
    """Human-readable breadcrumb path, skipping hidden 'default' nodes."""
    with get_conn() as conn:
        parts: list[str] = []
        current = project_id
        while current is not None:
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (current,)).fetchone()
            if not row:
                break
            if not row["is_default"]:
                parts.append(row["name"])
            current = row["parent_id"]
        parts.reverse()
        return " > ".join(parts)


def _all_descendant_ids(project_id: int) -> list[int]:
    """All descendant project IDs including the node itself."""
    with get_conn() as conn:
        result: list[int] = []
        stack = [project_id]
        while stack:
            cur = stack.pop()
            result.append(cur)
            children = conn.execute(
                "SELECT id FROM projects WHERE parent_id = ?", (cur,)
            ).fetchall()
            for ch in children:
                stack.append(ch["id"])
        return result


def _insert_root_comment(ticket_id: int, conn, created_at: str) -> int:
    """Insert the root sentinel comment for a ticket. Returns its ID."""
    cur = conn.execute(
        "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, NULL, '', 1, ?)",
        (ticket_id, created_at),
    )
    return cur.lastrowid


def _comment_leaf(ticket_id: int, conn) -> int:
    """
    Return the ID of the current leaf comment for a ticket — the comment that has
    no child pointing to it. This is where the next comment in the chain attaches.
    For a linear chain this is always unique. When threading is added, callers can
    pass an explicit parent_id instead of using this.
    """
    row = conn.execute(
        """
        SELECT c.id FROM comments c
        WHERE c.ticket_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM comments c2
              WHERE c2.parent_id = c.id AND c2.ticket_id = ?
          )
        ORDER BY c.created_at DESC
        LIMIT 1
        """,
        (ticket_id, ticket_id),
    ).fetchone()
    if not row:
        raise ValueError(f"No root comment found for ticket {ticket_id}")
    return row["id"]


def _is_ancestor(ancestor_id: int, candidate_id: int) -> bool:
    """Return True if ancestor_id is an ancestor of candidate_id."""
    with get_conn() as conn:
        current = candidate_id
        seen: set[int] = set()
        while current is not None:
            if current in seen:
                return False
            seen.add(current)
            row = conn.execute("SELECT parent_id FROM projects WHERE id = ?", (current,)).fetchone()
            if not row:
                break
            if row["parent_id"] == ancestor_id:
                return True
            current = row["parent_id"]
        return False


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

def create_project(name: str, description: str = "", parent_name: str | None = None, code_path: str = "", git_backend: str = "", git_repo_url: str = "", session_claude: str = "", session_codex: str = "", session_gemini: str = "") -> dict:
    if name == DEFAULT_NAME:
        raise ValueError(f"'{DEFAULT_NAME}' is a reserved name")
    if _get_project_by_name(name):
        raise ValueError(f"Project '{name}' already exists")

    parent_id = None
    if parent_name:
        parent = _get_project_by_name(parent_name)
        if not parent:
            raise ValueError(f"Parent project '{parent_name}' not found")
        parent_id = parent["id"]

    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO projects (parent_id, name, description, code_path, git_backend, git_repo_url, session_claude, session_codex, session_gemini, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (parent_id, name, description, code_path, git_backend, git_repo_url, session_claude, session_codex, session_gemini, _now()),
        )
        project_id = cur.lastrowid
        conn.execute(
            "INSERT INTO projects (parent_id, name, description, code_path, git_backend, git_repo_url, session_claude, session_codex, session_gemini, is_default, created_at) VALUES (?, ?, '', '', '', '', '', '', '', 1, ?)",
            (project_id, DEFAULT_NAME, _now()),
        )
        result = dict(conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())
    log_action("project_created", f"Project '{name}' created", {"name": name, "description": description, "parent": parent_name})
    try:
        root = _fs.get_scryer_root()
        if root:
            path = Path(root) / name
            _fs.ensure_planning_folder(path)
            _fs.ensure_git_repo(Path(root))
    except Exception:
        pass
    return result


def list_projects() -> list[dict]:
    """List root-level (top of tree) projects."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM projects WHERE parent_id IS NULL AND is_default = 0 ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]


def set_project_parent(project_name: str, parent_name: str | None) -> dict:
    """
    Make project_name a child of parent_name.
    Pass parent_name=None to promote a project back to the root level.
    """
    project = _get_project_by_name(project_name)
    if not project:
        raise ValueError(f"Project '{project_name}' not found")

    new_parent_id = None
    if parent_name is not None:
        parent = _get_project_by_name(parent_name)
        if not parent:
            raise ValueError(f"Project '{parent_name}' not found")
        if parent["id"] == project["id"]:
            raise ValueError("A project cannot be its own parent")
        if _is_ancestor(project["id"], parent["id"]):
            raise ValueError(
                f"Cannot set '{parent_name}' as parent of '{project_name}': would create a cycle"
            )
        new_parent_id = parent["id"]

    with get_conn() as conn:
        conn.execute(
            "UPDATE projects SET parent_id = ? WHERE id = ?",
            (new_parent_id, project["id"]),
        )
    log_action("project_moved", f"Project '{project_name}' moved", {"project": project_name, "to_parent": parent_name})
    return _get_project_by_name(project_name)


# ---------------------------------------------------------------------------
# Sub-projects (named children)
# ---------------------------------------------------------------------------

def create_sub_project(project_name: str, name: str, description: str = "") -> dict:
    if name == DEFAULT_NAME:
        raise ValueError(f"'{DEFAULT_NAME}' is a reserved name")
    if _get_project_by_name(name):
        raise ValueError(f"A project named '{name}' already exists")
    project = _get_project_by_name(project_name)
    if not project:
        raise ValueError(f"Project '{project_name}' not found")

    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO projects (parent_id, name, description, is_default, created_at) VALUES (?, ?, ?, 0, ?)",
            (project["id"], name, description, _now()),
        )
        sp_id = cur.lastrowid
        conn.execute(
            "INSERT INTO projects (parent_id, name, description, is_default, created_at) VALUES (?, ?, '', 1, ?)",
            (sp_id, DEFAULT_NAME, _now()),
        )
        result = dict(conn.execute("SELECT * FROM projects WHERE id = ?", (sp_id,)).fetchone())
    log_action("sub_project_created", f"Sub-project '{name}' created under '{project_name}'", {"name": name, "parent": project_name, "description": description})
    try:
        root = _fs.get_scryer_root()
        if root:
            location = _project_path(sp_id)  # e.g. "Scryer > UI"
            path = _fs.location_to_path(root, location)
            _fs.ensure_planning_folder(path)
    except Exception:
        pass
    return result


def list_sub_projects(project_name: str) -> list[dict]:
    """List direct named children of a project (excludes the hidden default node)."""
    project = _get_project_by_name(project_name)
    if not project:
        raise ValueError(f"Project '{project_name}' not found")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM projects WHERE parent_id = ? AND is_default = 0 ORDER BY created_at",
            (project["id"],),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------

def create_ticket(
    project_name: str,
    title: str,
    description: str = "",
    sub_project_name: str | None = None,
    priority: str = "medium",
    state: str = "Unopened",
) -> dict:
    if state not in VALID_STATES:
        raise ValueError(f"Invalid state. Must be one of: {', '.join(VALID_STATES)}")
    target_id = _resolve_ticket_target(project_name, sub_project_name)
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO tickets (project_id, title, description, state, priority, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (target_id, title, description, state, priority, now, now),
        )
        ticket_id = cur.lastrowid
        _insert_root_comment(ticket_id, conn, now)
    log_action("ticket_created", f"T{ticket_id} created: {title}", {"title": title, "project": project_name, "sub_project": sub_project_name, "priority": priority, "state": state}, ticket_id=ticket_id)
    try:
        root = _fs.get_scryer_root()
        if root:
            location = _project_path(target_id)  # e.g. "Scryer > UI"
            parent_path = _fs.location_to_path(root, location)
            ticket_path = parent_path / _fs.ticket_folder_name(ticket_id, title)
            _fs.ensure_planning_folder(ticket_path)
    except Exception:
        pass
    return get_ticket(ticket_id)


def move_ticket(ticket_id: int, project_name: str, sub_project_name: str | None = None) -> dict:
    """Move a ticket to a different project (or sub-project)."""
    old = get_ticket(ticket_id)
    if not old:
        raise ValueError(f"Ticket {ticket_id} not found")
    target_id = _resolve_ticket_target(project_name, sub_project_name)
    with get_conn() as conn:
        affected = conn.execute(
            "UPDATE tickets SET project_id = ?, updated_at = ? WHERE id = ?",
            (target_id, _now(), ticket_id),
        ).rowcount
        if affected == 0:
            raise ValueError(f"Ticket {ticket_id} not found")
    destination = project_name + (f" > {sub_project_name}" if sub_project_name else "")
    log_action("ticket_moved", f"T{ticket_id} moved to {destination}", {"from": old["location"], "to": destination}, ticket_id=ticket_id)
    try:
        root = _fs.get_scryer_root()
        if root:
            root_path = Path(root)
            old_folder = _fs.find_ticket_folder(root_path, ticket_id)
            new_ticket = get_ticket(ticket_id)
            new_parent = _fs.location_to_path(root, new_ticket["location"])
            new_folder = new_parent / _fs.ticket_folder_name(ticket_id, old["title"])
            if old_folder and old_folder.exists() and old_folder != new_folder:
                new_folder.parent.mkdir(parents=True, exist_ok=True)
                old_folder.rename(new_folder)
    except Exception:
        pass
    return get_ticket(ticket_id)


def get_ticket(ticket_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            return None
        ticket = dict(row)
        ticket["location"] = _project_path(ticket["project_id"])
        ticket["comments"] = [
            dict(c) for c in conn.execute(
                "SELECT * FROM comments WHERE ticket_id = ? AND is_root = 0 ORDER BY created_at",
                (ticket_id,),
            ).fetchall()
        ]
        ticket["blocks"] = [
            dict(t) for t in conn.execute(
                "SELECT t.id, t.title, t.state FROM tickets t "
                "JOIN ticket_blocks tb ON t.id = tb.blocked_id WHERE tb.blocker_id = ?",
                (ticket_id,),
            ).fetchall()
        ]
        ticket["blocked_by"] = [
            dict(t) for t in conn.execute(
                "SELECT t.id, t.title, t.state FROM tickets t "
                "JOIN ticket_blocks tb ON t.id = tb.blocker_id WHERE tb.blocked_id = ?",
                (ticket_id,),
            ).fetchall()
        ]
        return ticket


_COMPACT_FIELDS = {"id", "title", "state", "priority", "project_id"}


def list_tickets(project_name: str, sub_project_name: str | None = None, state: str | None = None, compact: bool = True) -> list[dict]:
    """
    List all tickets under a project (recursively across all descendants).
    If sub_project_name is given, scope to that child and its descendants.
    If state is "open", excludes Closed tickets.
    If state is any other string, returns only tickets with that exact state.
    compact=True (default): returns id, title, state, priority, project_id only.
    compact=False: returns full ticket rows including description and timestamps.
    """
    project = _get_project_by_name(project_name)
    if not project:
        raise ValueError(f"Project '{project_name}' not found")

    if sub_project_name:
        with get_conn() as conn:
            child = conn.execute(
                "SELECT * FROM projects WHERE parent_id = ? AND name = ? AND is_default = 0",
                (project["id"], sub_project_name),
            ).fetchone()
        if not child:
            raise ValueError(f"Sub-project '{sub_project_name}' not found under '{project_name}'")
        root_id = child["id"]
    else:
        root_id = project["id"]

    ids = _all_descendant_ids(root_id)
    placeholders = ",".join("?" * len(ids))
    params = list(ids)

    if state == "open":
        where_state = " AND state != 'Closed'"
    elif state:
        where_state = " AND state = ?"
        params.append(state)
    else:
        where_state = ""

    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM tickets WHERE project_id IN ({placeholders}){where_state} ORDER BY created_at",
            params,
        ).fetchall()
    if compact:
        return [{k: v for k, v in dict(r).items() if k in _COMPACT_FIELDS} for r in rows]
    return [dict(r) for r in rows]


def is_ticket_in_entity_scope(entity_type: str, entity_id: int, ticket_id: int) -> bool:
    """
    Returns True if ticket_id is within the scope of the given entity.
    - entity_type='project' or 'subproject': ticket must be under a descendant of entity_id
    - entity_type='ticket': ticket must match entity_id exactly
    """
    if entity_type == "ticket":
        return ticket_id == entity_id

    with get_conn() as conn:
        ticket = conn.execute("SELECT project_id FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
    if not ticket:
        return False

    # Expand all descendant project IDs from the scope root
    scope_ids = _all_descendant_ids(entity_id)
    return ticket["project_id"] in scope_ids


def update_ticket(ticket_id: int, **kwargs) -> dict:
    allowed = {"title", "description", "state", "priority"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}

    if "state" in updates and updates["state"] not in VALID_STATES:
        raise ValueError(f"Invalid state. Must be one of: {', '.join(VALID_STATES)}")
    if not updates:
        raise ValueError("No valid fields to update")

    now = _now()
    updates["updated_at"] = now
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with get_conn() as conn:
        # Snapshot the current state before applying changes (T18)
        current = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not current:
            raise ValueError(f"Ticket {ticket_id} not found")
        conn.execute(
            "INSERT INTO ticket_history (ticket_id, snapshot, changed_at) VALUES (?, ?, ?)",
            (ticket_id, json.dumps(dict(current)), now),
        )
        conn.execute(
            f"UPDATE tickets SET {set_clause} WHERE id = ?",
            list(updates.values()) + [ticket_id],
        )

    # Log state changes to the activity feed (T41)
    if "state" in updates:
        log_action(
            "state_change",
            f"T{ticket_id} moved to {updates['state']}",
            {"from": dict(current)["state"], "to": updates["state"]},
            ticket_id=ticket_id,
        )
    other_fields = {k: v for k, v in updates.items() if k not in ("state", "updated_at")}
    if other_fields:
        log_action(
            "ticket_updated",
            f"T{ticket_id} updated: {', '.join(other_fields.keys())}",
            {"fields": {k: str(v)[:200] for k, v in other_fields.items()}},
            ticket_id=ticket_id,
        )
    if "title" in other_fields:
        try:
            root = _fs.get_scryer_root()
            if root:
                old_folder = _fs.find_ticket_folder(Path(root), ticket_id)
                if old_folder and old_folder.exists():
                    new_name = _fs.ticket_folder_name(ticket_id, other_fields["title"])
                    new_folder = old_folder.parent / new_name
                    if old_folder != new_folder:
                        old_folder.rename(new_folder)
        except Exception:
            pass

    return get_ticket(ticket_id)


def add_comment(ticket_id: int, content: str) -> dict:
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone():
            raise ValueError(f"Ticket {ticket_id} not found")
        leaf_id = _comment_leaf(ticket_id, conn)
        cur = conn.execute(
            "INSERT INTO comments (ticket_id, parent_id, content, is_root, created_at) VALUES (?, ?, ?, 0, ?)",
            (ticket_id, leaf_id, content, _now()),
        )
        comment = dict(conn.execute("SELECT * FROM comments WHERE id = ?", (cur.lastrowid,)).fetchone())
    log_action(
        "comment",
        f"Comment on T{ticket_id}",
        {"content": content[:200]},
        ticket_id=ticket_id,
    )
    return comment


def set_blocks(blocker_id: int, blocked_id: int) -> None:
    if blocker_id == blocked_id:
        raise ValueError("A ticket cannot block itself")
    with get_conn() as conn:
        for tid in (blocker_id, blocked_id):
            if not conn.execute("SELECT id FROM tickets WHERE id = ?", (tid,)).fetchone():
                raise ValueError(f"Ticket {tid} not found")
        try:
            conn.execute(
                "INSERT INTO ticket_blocks (blocker_id, blocked_id) VALUES (?, ?)",
                (blocker_id, blocked_id),
            )
        except sqlite3.IntegrityError:
            return  # already set, nothing to log
    log_action("dependency_added", f"T{blocker_id} now blocks T{blocked_id}", {"blocker_id": blocker_id, "blocked_id": blocked_id})


def remove_blocks(blocker_id: int, blocked_id: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM ticket_blocks WHERE blocker_id = ? AND blocked_id = ?",
            (blocker_id, blocked_id),
        )
    log_action("dependency_removed", f"T{blocker_id} no longer blocks T{blocked_id}", {"blocker_id": blocker_id, "blocked_id": blocked_id})


# ---------------------------------------------------------------------------
# Commit history (T5)
# ---------------------------------------------------------------------------

def add_commit(ticket_id: int, commit_hash: str, message: str = "") -> dict:
    """Record a commit made against a ticket."""
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone():
            raise ValueError(f"Ticket {ticket_id} not found")
        cur = conn.execute(
            "INSERT INTO ticket_commits (ticket_id, commit_hash, message, created_at) VALUES (?, ?, ?, ?)",
            (ticket_id, commit_hash, message, _now()),
        )
        commit = dict(conn.execute("SELECT * FROM ticket_commits WHERE id = ?", (cur.lastrowid,)).fetchone())
    log_action(
        "commit",
        f"Commit {commit_hash[:8]} on T{ticket_id}",
        {"commit_hash": commit_hash, "message": message},
        ticket_id=ticket_id,
    )
    return commit


def get_commits(ticket_id: int) -> list[dict]:
    """Return all commits for a ticket, oldest first."""
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone():
            raise ValueError(f"Ticket {ticket_id} not found")
        rows = conn.execute(
            "SELECT * FROM ticket_commits WHERE ticket_id = ? ORDER BY created_at",
            (ticket_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Ticket edit history (T18)
# ---------------------------------------------------------------------------

def get_ticket_history(ticket_id: int) -> list[dict]:
    """Return all historical snapshots for a ticket, oldest first."""
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone():
            raise ValueError(f"Ticket {ticket_id} not found")
        rows = conn.execute(
            "SELECT id, ticket_id, snapshot, changed_at FROM ticket_history WHERE ticket_id = ? ORDER BY changed_at",
            (ticket_id,),
        ).fetchall()
        result = []
        for r in rows:
            entry = dict(r)
            entry["snapshot"] = json.loads(entry["snapshot"])
            result.append(entry)
        return result


# ---------------------------------------------------------------------------
# Heartbeats (T8)
# ---------------------------------------------------------------------------

def heartbeat(ticket_id: int, agent_token: str = "") -> dict:
    """Upsert a heartbeat for the given ticket. Returns the heartbeat row."""
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone():
            raise ValueError(f"Ticket {ticket_id} not found")
        now = _now()
        conn.execute(
            """
            INSERT INTO agent_heartbeats (ticket_id, last_seen, agent_token)
            VALUES (?, ?, ?)
            ON CONFLICT(ticket_id) DO UPDATE SET last_seen = excluded.last_seen, agent_token = excluded.agent_token
            """,
            (ticket_id, now, agent_token),
        )
        return dict(conn.execute(
            "SELECT * FROM agent_heartbeats WHERE ticket_id = ?", (ticket_id,)
        ).fetchone())


def get_heartbeats() -> list[dict]:
    """Return all active heartbeat rows, newest last_seen first."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM agent_heartbeats ORDER BY last_seen DESC"
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Agent tokens
# ---------------------------------------------------------------------------

def issue_token(ticket_id: int, expires_in_seconds: int | None = None) -> str:
    """Issue a scoped token for the given ticket. Returns the token string."""
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM tickets WHERE id = ?", (ticket_id,)).fetchone():
            raise ValueError(f"Ticket {ticket_id} not found")
    token = secrets.token_hex(32)
    now = _now()
    expires_at = None
    if expires_in_seconds is not None:
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)).isoformat()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO agent_tokens (token, ticket_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, ticket_id, now, expires_at),
        )
    return token


def validate_token(token: str) -> dict | None:
    """Return the token row if valid and not expired, else None."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM agent_tokens WHERE token = ?", (token,)).fetchone()
    if not row:
        return None
    row = dict(row)
    if row["expires_at"] and _now() > row["expires_at"]:
        return None
    return row


def revoke_token(token: str) -> bool:
    """Delete a token. Returns True if it existed."""
    with get_conn() as conn:
        n = conn.execute("DELETE FROM agent_tokens WHERE token = ?", (token,)).rowcount
    return n > 0


def list_tokens(ticket_id: int | None = None) -> list[dict]:
    """List active (non-expired) tokens, optionally filtered by ticket."""
    now = _now()
    with get_conn() as conn:
        if ticket_id is not None:
            rows = conn.execute(
                "SELECT * FROM agent_tokens WHERE ticket_id = ? AND (expires_at IS NULL OR expires_at > ?)",
                (ticket_id, now),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM agent_tokens WHERE expires_at IS NULL OR expires_at > ?", (now,)
            ).fetchall()
    return [dict(r) for r in rows]


def get_next_ticket(project_name: str | None = None) -> dict | None:
    """
    Return the first actionable ticket: not Closed, and every blocker is Closed.
    Optionally scoped to a project (and all its descendants).
    """
    with get_conn() as conn:
        if project_name is not None:
            project = _get_project_by_name(project_name)
            if not project:
                raise ValueError(f"Project '{project_name}' not found")
            ids = _all_descendant_ids(project["id"])
            placeholders = ",".join("?" * len(ids))
            row = conn.execute(
                f"""
                SELECT t.* FROM tickets t
                WHERE t.state != 'Closed'
                  AND t.project_id IN ({placeholders})
                  AND NOT EXISTS (
                      SELECT 1 FROM ticket_blocks tb
                      JOIN tickets blocker ON blocker.id = tb.blocker_id
                      WHERE tb.blocked_id = t.id
                        AND blocker.state != 'Closed'
                  )
                ORDER BY t.created_at
                LIMIT 1
                """,
                ids,
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT t.* FROM tickets t
                WHERE t.state != 'Closed'
                  AND NOT EXISTS (
                      SELECT 1 FROM ticket_blocks tb
                      JOIN tickets blocker ON blocker.id = tb.blocker_id
                      WHERE tb.blocked_id = t.id
                        AND blocker.state != 'Closed'
                  )
                ORDER BY t.created_at
                LIMIT 1
                """
            ).fetchone()
    return get_ticket(row["id"]) if row else None


# ---------------------------------------------------------------------------
# Admin CRUD helpers
# ---------------------------------------------------------------------------

def get_project(name: str) -> dict | None:
    return _get_project_by_name(name)


def get_project_by_id(project_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM projects WHERE id = ? AND is_default = 0", (project_id,)
        ).fetchone()
        return dict(row) if row else None


def get_all_projects() -> list[dict]:
    """All non-default projects at any level, with breadcrumb path — for dropdowns."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM projects WHERE is_default = 0 ORDER BY name"
        ).fetchall()
    result = []
    for r in rows:
        p = dict(r)
        p["path"] = _project_path(p["id"])
        result.append(p)
    return result


def update_project(name: str, new_name: str | None = None, description: str | None = None, code_path: str | None = None, git_backend: str | None = None, git_repo_url: str | None = None, session_claude: str | None = None, session_codex: str | None = None, session_gemini: str | None = None) -> dict:
    project = _get_project_by_name(name)
    if not project:
        raise ValueError(f"Project '{name}' not found")
    updates: dict = {}
    if new_name is not None and new_name != name:
        if new_name == DEFAULT_NAME:
            raise ValueError(f"'{DEFAULT_NAME}' is reserved")
        if _get_project_by_name(new_name):
            raise ValueError(f"Project '{new_name}' already exists")
        updates["name"] = new_name
    if description is not None:
        updates["description"] = description
    if code_path is not None:
        updates["code_path"] = code_path
    if git_backend is not None:
        updates["git_backend"] = git_backend
    if git_repo_url is not None:
        updates["git_repo_url"] = git_repo_url
    if session_claude is not None:
        updates["session_claude"] = session_claude
    if session_codex is not None:
        updates["session_codex"] = session_codex
    if session_gemini is not None:
        updates["session_gemini"] = session_gemini
    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        with get_conn() as conn:
            conn.execute(
                f"UPDATE projects SET {set_clause} WHERE id = ?",
                list(updates.values()) + [project["id"]],
            )
        log_action("project_updated", f"Project '{name}' updated", {"project": name, "fields": list(updates.keys())})
        if "name" in updates:
            try:
                root = _fs.get_scryer_root()
                if root:
                    old_folder = Path(root) / name
                    new_folder = Path(root) / updates["name"]
                    if old_folder.exists() and old_folder != new_folder:
                        old_folder.rename(new_folder)
            except Exception:
                pass
    return _get_project_by_name(updates.get("name", name))


def delete_project(name: str) -> None:
    project = _get_project_by_name(name)
    if not project:
        raise ValueError(f"Project '{name}' not found")
    with get_conn() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project["id"],))
    log_action("project_deleted", f"Project '{name}' deleted", {"name": name})


def delete_ticket(ticket_id: int) -> None:
    with get_conn() as conn:
        row = conn.execute("SELECT title FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        if not row:
            raise ValueError(f"Ticket {ticket_id} not found")
        title = row["title"]
        conn.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,))
    log_action("ticket_deleted", f"T{ticket_id} deleted: {title}", {"ticket_id": ticket_id, "title": title})


def update_comment(comment_id: int, content: str) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not row:
            raise ValueError(f"Comment {comment_id} not found")
        if row["is_root"]:
            raise ValueError("Cannot edit the root comment sentinel")
        ticket_id = row["ticket_id"]
        conn.execute("UPDATE comments SET content = ? WHERE id = ?", (content, comment_id))
        result = dict(conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone())
    log_action("comment_edited", f"Comment edited on T{ticket_id}", {"comment_id": comment_id, "content": content[:200]}, ticket_id=ticket_id)
    return result


def delete_comment(comment_id: int) -> None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not row:
            raise ValueError(f"Comment {comment_id} not found")
        if row["is_root"]:
            raise ValueError("Cannot delete the root comment sentinel")
        ticket_id = row["ticket_id"]
        # BFS to collect subtree, reversed so leaves are deleted before parents
        ids: list[int] = []
        queue = [comment_id]
        while queue:
            cur = queue.pop(0)
            ids.append(cur)
            children = conn.execute(
                "SELECT id FROM comments WHERE parent_id = ?", (cur,)
            ).fetchall()
            queue.extend(ch["id"] for ch in children)
        for cid in reversed(ids):
            conn.execute("DELETE FROM comments WHERE id = ?", (cid,))
    log_action("comment_deleted", f"Comment deleted on T{ticket_id}", {"comment_id": comment_id}, ticket_id=ticket_id)


# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

def log_action(action: str, message: str, details: dict | None = None, ticket_id: int | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO logs (action, message, details, ticket_id, created_at) VALUES (?, ?, ?, ?, ?)",
            (action, message, json.dumps(details or {}), ticket_id, _now()),
        )


def get_logs(limit: int = 500) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM logs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]
