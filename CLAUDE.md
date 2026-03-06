# Scryer — Project Overview

Scryer is a single-human, multi-agent software development system. The human designs dependency graphs of tickets. Agents execute them autonomously in parallel. Human oversight is a first-class constraint.

## Repo layout

```
plane.so/
├── infra/                        # Self-hosted PM backend
│   ├── ProjectManagement/
│   │   ├── mcp_server.py         # FastMCP server — primary PM interface
│   │   ├── db.py                 # SQLite abstraction layer
│   │   └── data/pm.db            # SQLite database
│   ├── admin/app.py              # Legacy Flask admin UI (port 5050)
│   └── danger/app.py             # Danger console (port 5001)
├── tmux_test/
│   └── server.py                 # Flask-SocketIO terminal server (port 5055)
├── ui/                           # Primary human-facing UI
│   ├── server/
│   │   ├── index.js              # Express API (port 7654)
│   │   └── api.js                # Route handlers (better-sqlite3)
│   ├── src/
│   │   ├── screens/
│   │   │   ├── ProjectSelector.jsx
│   │   │   └── ProjectView.jsx
│   │   └── components/
│   │       └── AgentTerminal.jsx
│   └── vite.config.js            # Port 3000, proxies /api→7654, /socket.io→5055
├── targets.md                    # Full system design
└── CLAUDE.md                     # This file
```

## Starting services

```bash
# Primary UI (run from ui/)
npm run dev              # Starts Express (7654) + Vite (3000) together

# Terminal streaming server (run from tmux_test/)
python server.py         # Port 5055

# PM MCP server — started automatically by Claude Code (pm-local)
python3 infra/ProjectManagement/mcp_server.py
```

## Project management (MCP — pm-local)

All ticket and project management goes through the `pm-local` MCP server. Never query pm.db directly.

### Key MCP tools

| Tool | Description |
|---|---|
| `list_tickets(project_name)` | List all tickets in a project |
| `get_ticket(ticket_id)` | Full ticket detail including comments |
| `create_ticket(project_name, title, description, priority)` | Create a ticket |
| `update_ticket(ticket_id, state?, title?, description?, priority?)` | Update a ticket |
| `create_project(name, description)` | Create a root project |
| `create_sub_project(project_name, name, description)` | Create a sub-project |
| `set_blocks(blocker_ticket_id, blocked_ticket_id)` | Set blocking dependency |
| `get_next_ticket(project_name?)` | Get next actionable (unblocked) ticket |

### Valid ticket states

`Unopened` → `In Progress` → `In Review` → `Closed`

Also: `Agent Finished`, `Needs Tests`, `Needs Input`

### Ticket workflow (CRITICAL)

Agents must NEVER set a ticket to `Closed`. The correct flow:
1. Start work → set state to `In Progress`
2. Finish work → set state to `In Review` with a summary comment
3. Human reviews and sets to `Closed`

## DB schema — key project fields

Projects have these fields beyond name/description:
- `code_path` — filesystem path or URL to the codebase
- `git_backend` — `forgejo`, `github`, or `gitlab`
- `git_repo_url` — repo URL for the selected backend
- `session_claude/codex/gemini` — planning session IDs (for browser resume)

## UI — what's built

The UI at `ui/` is the human's primary interface. It has two screens:
- **Project selector** (`/`) — lists root projects, inline settings panel per card
- **Project view** (`/projects/:name`) — shows sub-projects, Resume buttons for stored agent sessions

The Resume Claude/Codex/Gemini buttons open an embedded xterm.js terminal that connects to `tmux_test` on port 5055 and runs `claude --continue` from `~/Code/plane.so`. No session ID tracking needed.

## Architecture context

```
Human
  └─► Scryer UI (browser) ──────────────────────► pm-local MCP
           │                                            │
           │ Resume button                              │ SQLite (pm.db)
           ▼                                            │
      tmux_test (5055) ◄──────── tmux sessions ◄───────┘
           │
           ▼
      Agent (claude / codex / gemini)
           │
           └─► pm-local MCP (tickets, heartbeats, git ops)
```

## Planned (not yet built)

- **T17** — Review gate enforcement in MCP (AGENT_KEY / HUMAN_KEY)
- **T18** — Ticket edit history
- **T5** — Commit history table
- **T6** — Add Forgejo to infra
- **T7** — git MCP adapter (ForgejAdapter)
- **T8** — Heartbeat tool
- **T9** — Scoped agent token system
- **T10** — Shell command sandbox
- **T11** — Minimal orchestrator
- **T12** — agents.md generation
