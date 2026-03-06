# Project Targets

## What This Is

A single-human, multi-agent software development system. The human designs work as a dependency graph of tickets and sets goals. Agents execute autonomously in the correct order, in parallel where possible. Human oversight is a first-class design constraint — not an afterthought.

---

## Core Philosophy

- **The dependency tree is the intelligence**, not the agent
- **Agents are narrow, stateless, and disposable** — spawned for one ticket, do that work, gone
- **Human oversight takes priority over speed** — the system slows down to ask rather than guess
- **No memory across agents** — an agent knows exactly two things: the code and its ticket
- **Ticket quality is critical** — a vague ticket produces a vague agent
- **Inter-agent communication is indirect** — mediated through committed code, PR descriptions, and ticket comments. Git and the ticket system are the message bus.

---

## Execution Model

### Entry Points
- **"Achieve this ticket"** — walk the dependency tree from this ticket downward, execute everything required
- **"Execute Project"** — same, but from the project root; execute everything

There are no special ticket types — any ticket can be a goal.

### Spawn Rules
- All currently unblocked tickets are spawned simultaneously — maximum parallelism
- A ticket is only spawned when ALL its blockers are closed — never before
- When a ticket closes, the orchestrator immediately checks for newly unblocked tickets and spawns them

### Conflict Resolution
- Parallel agents work on separate branches — file conflicts surface naturally at merge time
- The system never resolves conflicts — the human does, always
- The system may suggest a resolution order but never takes the decision

---

## Agent Lifecycle

### Spawn
1. Orchestrator validates the ticket is complete (see Ticket Completeness)
2. Orchestrator prepares the environment: clones the repo, creates the branch, sets up the working directory
3. Orchestrator writes `agents.md` to the working directory — the complete briefing for this agent
4. Orchestrator injects the scoped MCP token as an environment variable
5. Agent is spawned in a named tmux session (tied to ticket ID)
6. Agent's first instruction: read `agents.md`

### Work
- Agent edits files, calls MCP tools for all other actions
- Agent sends heartbeats to MCP at regular intervals
- Agent never runs git commands directly — all git operations go through MCP
- Agent never touches main — ever

### Clarification
- When an agent hits ambiguity it cannot resolve, it posts a comment on the ticket and sets state to "Needs Input"
- Agent polls for new comments and resumes automatically when the human responds
- No manual restart required
- Agents may also proceed with a best-guess and flag assumptions in the PR — but must escalate to "Needs Input" if they genuinely cannot continue

### Submission
- Agent calls `set_task_ready_for_review` with a detailed work report and commit ID
- This is the acceptance gate — currently open, future criteria enforced here
- Agent writes a PR description in Forgejo

### Fault Tolerance
- If heartbeat exceeds a configurable threshold, the ticket is flagged as abandoned
- On abandonment: branch is deleted, fresh branch created from main, new agent starts from scratch
- Partial work is discarded — a half-done ticket is worse than none; the unit-of-work design makes this safe

---

## Review Flow

- Human sees "Ready for Review" tickets in the UI
- Human accepts → ticket closes, branch merges to main, dependents unblock
- Human rejects → ticket returns to "In Progress"; rejection feedback attached as a comment
- Configurable review timeout per project — "Never" is a valid value
- If timeout fires, an auto-reviewer agent takes over: reads the ticket, PR, and diff, judges against acceptance criteria
- Auto-reviewer uses the same accept/reject interface as the human — not an auto-merge

---

## Rollback

- Reopening a closed ticket automatically reverts its merge
- System identifies all downstream tickets unblocked by that merge and surfaces them prominently
- Human must explicitly deal with the cascade — no silent side effects
- This is intentionally a heavy cognitive burden: reopening is a serious action

---

## Git Infrastructure

- The git layer is an **abstraction at the MCP level** — agents never know or care which backend is used
- Supported backends: Forgejo (built-in), GitHub, GitLab — extensible to others
- Per-project git backend configured by the human — point at an existing repo and go
- No migration required — integrates with existing codebases in place
- **Forgejo** is the built-in default for new projects

### The only git operations available to agents (via MCP):
- Create branch
- Commit (with message)
- Push
- Open PR
- Read file / repo state

Nothing outside this set exists from the agent's perspective. Force-push and rebase do not exist.

### Agent Environments
- Each agent gets its own full clone of the repo — no shared clones, no branch contention
- Branch name must match the ticket ID — enforced by MCP at commit time

---

## Commit Tracking

- Every commit is a first-class record: commit ID + agent-provided comment
- Full commit history per ticket — across all attempts including rework after rejection
- Complete audit trail of all commits made against a ticket

### Branch Lifecycle
- Post-merge branch deletion: configurable per project
- On rejection: whether agent continues on the same branch or gets a fresh one is configurable per project

---

## MCP Server

### Role
- The sole interface between agents and everything else: git, tickets, state
- Agents call MCP tools; the MCP server executes the action
- All git commands are hard-blocked at the shell level — MCP is the only path

### Robustness
- All state persisted to DB before any call is acknowledged — no in-memory-only state
- Server restarts cleanly with zero data loss
- Agents retry failed MCP calls with exponential backoff
- All operations are idempotent — safe to retry without duplicating side effects

### Authentication & Scoping
- Every agent is issued a scoped token at spawn time, tied to its ticket ID
- Agent can only perform operations within its own ticket's scope
- Orchestrator holds elevated permissions — only entity that can spawn, close, or reassign tickets
- Human-facing tools (review, override) require a separate human-level token
- Unauthenticated or out-of-scope calls are rejected and logged

---

## Orchestrator

- Separate process from the MCP server — event-driven, always running
- Once the human sets a goal, runs on autopilot
- Human re-enters only when required: review, clarification, conflict resolution
- **AI-embedded**: events trigger AI-generated feedback — summaries, issue flags, suggestions, cascade warnings

### Events it handles:
- Ticket unblocked → prepare environment, spawn agent
- Heartbeat timeout → flag abandoned, respawn
- Ticket closed → check for newly unblocked tickets, spawn them
- Review timeout → hand off to auto-reviewer
- Ticket reopened → revert merge, surface downstream cascade

---

## Agent Briefing

- At spawn time, orchestrator generates `agents.md` fresh per ticket using its AI
- Contains: ticket details, acceptance criteria, rules (no direct git, use MCP, send heartbeats), project context
- `agents.md` is the complete and only briefing — nothing else is injected
- Delivered to the working directory before the agent starts

---

## Memory Model

- **Coding agents**: no memory — stateless and disposable
- **Projects**: persistent memory, accumulated over time
- Orchestrator draws on project memory for feedback, briefings, and suggestions
- When a project is nested under a parent, its memory merges into the parent's
- Memory lives at the highest relevant point in the project tree

---

## Permission Sandbox

### Claude-level (first layer)
- `--allowedTools` / `--disallowedTools` flags control what Claude attempts

### Shell-level (real safety net)
- A wrapper intercepts and hard-blocks commands before execution, regardless of what Claude attempts

### Hard limits — non-negotiable, cannot be overridden at any level:
- No `rm -rf` or equivalent destructive deletes
- No opening servers on ports
- No `DELETE FROM` SQL statements
- No git commands — all git goes through MCP

### Configurable limits:
- Blacklist configurable per task
- Sensible defaults provided
- Per-task config can restrict further but cannot remove hard limits

---

## Credentials

- All credentials injected as environment variables at spawn time
- Zero access to any `.env` file — agents never see credential files
- Forgejo is self-hosted within the infra — its credentials never exposed to agents
- The scoped MCP token is the only credential an agent ever receives

---

## Logging & Observability

- Logging is a first-class citizen
- Some events belong on the ticket: commit comments, clarification threads, rejection feedback
- Some events belong in a system-wide log in the UI: blocked commands, agent spawns, state transitions
- Full tmux session transcripts captured per agent run, stored as log files in Forgejo
- Exact routing decided per feature as built — principle: if it matters, it's logged and visible

---

## Ticket Completeness

- Tickets can be sparse during planning — structure not enforced at creation time
- At execution time, required fields are validated before an agent is spawned
- If required fields are missing, the AI generates them and asks the human to approve
- Work never starts against an incomplete ticket
- Required fields will evolve as the system matures — the principle is fixed, the specifics are not

---

## Acceptance Gate

- `set_task_ready_for_review` is the gate — all submissions must pass through it
- Currently open (no validation enforced)
- Future acceptance criteria (e.g. commit ID required, tests passing) enforced here

---

## Bootstrap Strategy

- The system builds itself using its own ticket system
- First few tickets executed manually — prerequisites for agent execution don't exist yet
- Manual execution calibrates how much control the human is comfortable delegating
- Trust extended progressively as confidence builds
- Minimum viable first build: enough infrastructure for one agent to execute one ticket end-to-end

---

## Future Concerns (not building now)

- **Agent containerisation**: Docker for full filesystem isolation — deferred until system is stable
- **Database scaling**: SQLite is fine until proven otherwise — migrate to Postgres only when concurrency is actually a problem
