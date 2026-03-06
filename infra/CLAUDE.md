# infra — Project Management Backend

This folder contains the full self-hosted project management backend: a SQLite data layer, an MCP server for agent use, a human admin UI (user server), and a danger console (admin server).

---

## Folder Structure

```
infra/
├── Dockerfile                     # debian:bookworm-slim + forego binary
├── docker-compose.yml             # Forego service; bind-mounts ./app as /app
├── app/
│   └── Procfile                   # Process list read by forego
├── ProjectManagement/
│   ├── db.py                      # All database logic — the single source of truth
│   ├── mcp_server.py              # MCP server for agent use (FastMCP)
│   ├── requirements.txt           # mcp[cli]
│   └── data/
│       └── pm.db                  # SQLite database (auto-created on first run)
├── admin/                         # User server — human CRUD UI
│   ├── app.py                     # Flask app, port 5050
│   ├── config.json                # Bind config: {"host": "...", "port": 5050}
│   ├── server.pid                 # PID of running user server process
│   ├── requirements.txt           # flask
│   └── templates/
│       ├── base.html              # Bootstrap 5.3.0, navbar, flash messages, comment JS
│       ├── index.html             # Root project list + create form
│       ├── project.html           # Project detail: edit, sub-projects, tickets
│       ├── ticket.html            # Ticket detail: edit, move, comments, dependencies
│       ├── logs.html              # Activity log table
│       └── restarting.html        # Spinner + JS polling for post-rebind redirect
└── danger/                        # Admin server — dangerous operations
    ├── app.py                     # Flask app, port 5001
    ├── requirements.txt           # flask
    └── templates/
        ├── index.html             # Dark UI: user server status, bind settings, DB reset
        └── restarting.html        # Spinner + JS polling
```

---

## Data Layer — `ProjectManagement/db.py`

### Database location

Defaults to `ProjectManagement/data/pm.db`. Override with the `PM_DB_PATH` environment variable.

### Schema

Five tables:

```sql
projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,   -- 1 = hidden ticket-holder node
    created_at  TEXT NOT NULL
)

tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'Unopened',
    priority    TEXT NOT NULL DEFAULT 'medium',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
)

ticket_blocks (
    blocker_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    blocked_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id)
)

comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES comments(id),
    content     TEXT NOT NULL DEFAULT '',
    is_root     INTEGER NOT NULL DEFAULT 0,   -- 1 = invisible sentinel
    created_at  TEXT NOT NULL
)

logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    message     TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}',   -- JSON blob
    created_at  TEXT NOT NULL
)
```

### Project hierarchy

Projects form a self-referencing tree via `parent_id`. Every visible project automatically gets a hidden child node (`is_default = 1, name = 'default'`). **Tickets are always stored on a default node**, never directly on a visible project. This means:

- A ticket "in project Foo" is stored on the `default` child of Foo.
- A ticket "in sub-project Bar under Foo" is stored on the `default` child of Bar.
- `_resolve_ticket_target(project_name, sub_project_name)` resolves the correct default-node ID.
- `_project_path(project_id)` walks up the tree and builds a human-readable path like `Foo > Bar`, skipping default nodes.

Cycle detection is enforced in `set_project_parent` via `_is_ancestor`.

### Ticket states

```
VALID_STATES = ["Unopened", "In Progress", "Agent Finished", "In Review", "Needs Tests", "Closed"]
```

New tickets always start as `Unopened`. Priority is stored (`low`/`medium`/`high`) but not shown in the UI.

### Comment threading

Each ticket gets a root sentinel comment (`is_root=1, parent_id=NULL`) created automatically at ticket-creation time. User comments chain off the current **leaf** — the comment that has no child pointing to it — found by `_comment_leaf`. This is a linear linked list today but the schema supports full threading: callers can pass an explicit `parent_id` to branch off any node. `delete_comment` does a BFS to delete the subtree.

### Schema migrations

`init_db()` runs on every startup and handles three upgrade paths:

| Condition | Migration |
|---|---|
| `sub_projects` table exists | `_migrate_v1_to_v2`: renames v1 tables, recreates unified schema, migrates data |
| `comments` table exists but has no `parent_id` column | `_migrate_comments_add_threading`: upgrades to linked-list schema |
| `logs` table missing | Creates it inline (idempotent `CREATE TABLE IF NOT EXISTS`) |

### `reset_db()`

Drops all tables and recreates the schema. **Development use only. Never expose to agents.** The admin server (danger) is the only caller.

### Public API summary

**Projects**
- `create_project(name, description, parent_name)` — creates project + its default child
- `list_projects()` — root-level projects only
- `get_project(name)` → `dict | None`
- `get_project_by_id(id)` → `dict | None`
- `get_all_projects()` → list with `path` breadcrumb field, for dropdowns
- `update_project(name, new_name, description)`
- `delete_project(name)` — cascades to all children and tickets
- `set_project_parent(name, parent_name)` — promotes or nests; cycle-safe
- `create_sub_project(project_name, name, description)` — named child + its default node
- `list_sub_projects(project_name)` — direct named children only

**Tickets**
- `create_ticket(project_name, title, description, sub_project_name, priority, state)` — always resolves to a default node; creates root comment sentinel
- `get_ticket(ticket_id)` → full dict with `location`, `comments`, `blocks`, `blocked_by`
- `list_tickets(project_name, sub_project_name)` — recursive across all descendants
- `update_ticket(ticket_id, **kwargs)` — allowed fields: `title`, `description`, `state`, `priority`
- `delete_ticket(ticket_id)`
- `move_ticket(ticket_id, project_name, sub_project_name)`

**Comments**
- `add_comment(ticket_id, content)` — attaches to current leaf
- `update_comment(comment_id, content)` — refuses to edit root sentinel
- `delete_comment(comment_id)` — deletes entire subtree

**Dependencies**
- `set_blocks(blocker_id, blocked_id)` — idempotent; self-block rejected
- `remove_blocks(blocker_id, blocked_id)`

**Logs**
- `log_action(action, message, details)` — `details` is a dict, stored as JSON
- `get_logs(limit=500)` — newest first

---

## MCP Server — `ProjectManagement/mcp_server.py`

Built with FastMCP (`mcp[cli]`). Calls `db.init_db()` on startup.

### Running

```bash
cd infra/ProjectManagement
python3 mcp_server.py
```

### Registering with Claude Code

```bash
claude mcp add pm-local -- python3 /path/to/infra/ProjectManagement/mcp_server.py
```

### Exposed tools

| Tool | Notes |
|---|---|
| `create_project` | |
| `list_projects` | Root level only |
| `set_project_parent` | Nest or promote |
| `create_sub_project` | |
| `list_sub_projects` | |
| `create_ticket` | |
| `move_ticket` | |
| `get_ticket` | Returns full detail incl. comments, blocks |
| `list_tickets` | Recursive |
| `update_ticket` | |
| `add_comment` | |
| `set_blocks` | |
| `remove_blocks` | |

**`reset_db` is deliberately not exposed.** Agents must never wipe the database.

All tools return JSON strings with a `status` field (`"created"`, `"ok"`, `"moved"`, `"updated"`, or `"error"`).

---

## User Server — `admin/app.py`

Human CRUD interface. Flask, Bootstrap 5.3.0 (CDN).

### Running

```bash
cd infra/admin
python3 app.py
```

Reads `config.json` for bind settings. Writes its PID to `server.pid` on startup (`use_reloader=False` ensures one process).

### Default bind

`0.0.0.0:5050` — access at `http://127.0.0.1:5050`

### Routes

| Route | Method | Description |
|---|---|---|
| `/` | GET | Project list + create form |
| `/projects/create` | POST | Create project (name, description, optional parent) |
| `/projects/<name>` | GET | Project detail: info, sub-projects, tickets |
| `/projects/<name>/update` | POST | Rename / change description |
| `/projects/<name>/delete` | POST | Delete project and all contents |
| `/projects/<name>/set-parent` | POST | Nest under or detach from parent |
| `/projects/<name>/sub-projects/create` | POST | Create named child project |
| `/tickets/create` | POST | Create ticket (title + optional sub-project); state always Unopened |
| `/tickets/<id>` | GET | Ticket detail: edit, move, comments, dependencies |
| `/tickets/<id>/update` | POST | Edit title, description, state |
| `/tickets/<id>/delete` | POST | Delete ticket |
| `/tickets/<id>/move` | POST | Move to different project |
| `/tickets/<id>/comments/create` | POST | Add comment |
| `/comments/<id>/update` | POST | Edit comment |
| `/comments/<id>/delete` | POST | Delete comment + subtree |
| `/tickets/<id>/blocks/add` | POST | Add blocks or blocked-by relationship |
| `/tickets/<id>/blocks/remove` | POST | Remove dependency |
| `/logs` | GET | Activity log |

### UI conventions

- Priority is **not shown** anywhere in the UI (kept in DB for agent use).
- State is **not shown on ticket creation** — new tickets are always `Unopened` via a hidden form field.
- State is editable on the ticket detail page.
- Every successful write calls `db.log_action()`.
- Flash messages (Bootstrap alerts) surface errors and confirmations.
- Comment editing is toggled in-place with vanilla JS (no page reload).

### State badge colours

| State | Badge |
|---|---|
| Unopened | secondary |
| In Progress | primary |
| Agent Finished | info |
| In Review | warning |
| Needs Tests | dark |
| Closed | success |

---

## Admin Server — `danger/app.py`

Dangerous operations console. Flask, dark theme.

### Running

```bash
cd infra/danger
python3 app.py
```

Always binds to `0.0.0.0:5001`. Access at `http://127.0.0.1:5001`

### Routes

| Route | Method | Description |
|---|---|---|
| `/` | GET | User server status + bind settings + DB reset form |
| `/bind` | POST | Kill user server, save new config, restart user server; shows spinner |
| `/reset` | POST | Wipe and reinitialise database; requires typing "RESET" exactly |

### User server process management

- **Status**: reads `admin/server.pid`, calls `os.kill(pid, 0)` to check liveness.
- **Kill**: sends `SIGTERM` to the PID.
- **Start**: `subprocess.Popen([sys.executable, "admin/app.py"], start_new_session=True)`.
- **Rebind**: kill → write `config.json` → start → return `restarting.html` which polls the new URL with `fetch` in `no-cors` mode and redirects when the server responds.

### Bind options presented in UI

- `127.0.0.1` — loopback only
- `0.0.0.0` — all interfaces
- Local network IP (auto-detected via UDP trick against 8.8.8.8)

---

## Docker / Forego

`docker-compose.yml` runs a forego server using the `./app` directory as the working volume (bind-mounted, so it is accessible on the host at `infra/app/`). The Dockerfile installs forego from equinox.io into a `debian:bookworm-slim` image.

The forego `Procfile` at `infra/app/Procfile` defines the processes forego manages.

---

## Key Design Decisions

### Why a unified project tree instead of project + sub_project tables?

The original two-table design (projects + sub_projects) was replaced with a single self-referencing `projects` table so any project can be nested under any other without a hard two-level cap. This also made "promote sub-project to top-level" and "move project under another" trivial operations.

### Why a hidden `default` node per project?

Tickets must belong to a leaf-level container. Rather than special-casing whether a project has sub-projects, every project always has a hidden default child that holds tickets for that level. This means the data model never needs to check "is this a leaf?" — tickets always go on a default node, found by `_resolve_ticket_target`.

### Why linked-list comments?

The root sentinel + leaf-pointer model keeps comments linear for today while leaving the door open for full tree threading later. Any comment's `id` can become a `parent_id` for a reply branch. `_comment_leaf` finds the end of the current chain without knowing its length.

### Why `use_reloader=False` on Flask?

The user server writes its PID to `server.pid` so the admin server can kill and restart it. Flask's reloader spawns a child process, making the PID unreliable. `use_reloader=False` ensures one process, one PID.

### Why is `reset_db` not in the MCP server?

Agents must never wipe the database. The function exists in `db.py` for development, but the MCP server deliberately omits it. The admin server (port 5001) is the only interface that calls it, and it requires typing "RESET" as confirmation.

---

## Known Issues / History

- **v1 → v2 schema migration**: The old schema had separate `projects` and `sub_projects` tables. `_migrate_v1_to_v2` handles upgrading existing databases transparently on startup.
- **macOS `localhost` → IPv6**: macOS resolves `localhost` to `::1` (IPv6) but Flask binds IPv4 only. Bind to `0.0.0.0` or `127.0.0.1` explicitly.
- **`create_ticket` transaction bug (fixed)**: `get_ticket` was previously called inside the `with get_conn() as conn:` block before the INSERT committed. Since `get_ticket` opens a new connection, it returned `None`. Fixed by moving `return get_ticket(ticket_id)` outside the `with` block.
