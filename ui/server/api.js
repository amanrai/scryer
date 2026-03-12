import { Router } from 'express'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join, basename } from 'path'
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'fs'
import { homedir } from 'os'
import { spawnSync, spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const AGENT_PERMS_DEFAULTS_PATH = join(__dirname, 'config', 'agent-permissions.defaults.json')
const GLOBAL_TEMPLATES_DIR   = join(REPO_ROOT, 'templates')
const PERSONAS_DIR           = join(REPO_ROOT, 'council', 'personas')
const DB_PATH = process.env.PM_DB_PATH ||
  join(__dirname, '..', '..', 'infra', 'ProjectManagement', 'data', 'pm.db')

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

// Ensure config table exists and seed defaults
db.exec(`CREATE TABLE IF NOT EXISTS scryer_config (key TEXT PRIMARY KEY, value TEXT)`)
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('scryer_root', ?)`)
  .run(join(homedir(), 'Scryer'))
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('code_root', ?)`)
  .run(join(homedir(), 'Code'))
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('theme', 'dark')`).run()
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('discord_token', '')`).run()
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('discord_server_id', '')`).run()
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('oracle_provider', 'claude')`).run()
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('oracle_model', 'claude-haiku-4-5-20251001')`).run()

// Agent permissions table
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_permissions (
    agent   TEXT NOT NULL,
    item_id TEXT NOT NULL,
    state   TEXT NOT NULL CHECK(state IN ('allow', 'deny')),
    PRIMARY KEY (agent, item_id)
  )
`)

// Seed agent_permissions from defaults.json (INSERT OR IGNORE — never overwrite user config)
;(function seedAgentPermissions() {
  try {
    const defaults = JSON.parse(readFileSync(AGENT_PERMS_DEFAULTS_PATH, 'utf8'))
    const agents   = ['claude', 'codex', 'gemini']
    const insert   = db.prepare(`INSERT OR IGNORE INTO agent_permissions (agent, item_id, state) VALUES (?, ?, ?)`)
    for (const section of defaults.sections) {
      for (const item of section.items) {
        for (const agent of agents) {
          insert.run(agent, item.id, item.default)
        }
      }
    }
  } catch (e) {
    console.warn('seedAgentPermissions: could not seed from defaults.json:', e.message)
  }
})()


// Add agent preference columns if they don't exist yet
;['planning_agent', 'architect_agent'].forEach(col => {
  try { db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT NOT NULL DEFAULT 'claude'`) } catch {}
})
// Add agent warmup column if it doesn't exist yet (seconds to hold off input after session opens)
try { db.exec(`ALTER TABLE projects ADD COLUMN agent_warmup INTEGER NOT NULL DEFAULT 10`) } catch {}

function getScryerRoot() {
  const row = db.prepare(`SELECT value FROM scryer_config WHERE key = 'scryer_root'`).get()
  return row?.value ?? join(homedir(), 'Scryer')
}

function getCodeRoot() {
  const row = db.prepare(`SELECT value FROM scryer_config WHERE key = 'code_root'`).get()
  return row?.value ?? ''
}

// Copy global templates to per-project location (no-op if already present or scryer_root missing)
function initProjectTemplates(projectName) {
  const scryerRoot = getScryerRoot()
  if (!scryerRoot) return
  if (!existsSync(GLOBAL_TEMPLATES_DIR)) return
  const destDir = join(scryerRoot, projectName, 'templates')
  try {
    const files = readdirSync(GLOBAL_TEMPLATES_DIR)
    for (const file of files) {
      const src = join(GLOBAL_TEMPLATES_DIR, file)
      const dest = join(destDir, file)
      if (statSync(src).isFile() && !existsSync(dest)) {
        mkdirSync(destDir, { recursive: true })
        writeFileSync(dest, readFileSync(src))
      }
    }
  } catch (e) {
    console.warn('initProjectTemplates: could not copy templates:', e.message)
  }
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
}

// Walk up the project tree (skipping default nodes), return name parts root→leaf
function projectPathParts(projectId) {
  const parts = []
  let current = projectId
  while (current != null) {
    const row = db.prepare(`SELECT name, parent_id, is_default FROM projects WHERE id = ?`).get(current)
    if (!row) break
    if (!row.is_default) parts.unshift(row.name)
    current = row.parent_id
  }
  return parts
}

// Walk up to root project, return { rootCodePath, subParts }
// rootCodePath = root project's code_path (the base path)
// subParts     = non-default project names below root (for nested planning dirs)
function resolveEntityBasePath(projectId) {
  const subParts = []
  let current = projectId
  let rootCodePath = ''
  while (current != null) {
    const row = db.prepare(`SELECT name, parent_id, is_default, code_path FROM projects WHERE id = ?`).get(current)
    if (!row) break
    if (!row.is_default) {
      if (row.parent_id == null) {
        rootCodePath = row.code_path || ''
      } else {
        subParts.unshift(row.name)
      }
    }
    current = row.parent_id
  }
  return { rootCodePath, subParts }
}

// Resolve the plan.md path for any entity — lives at {base_path}/.scryer/{sub_path}/plan.md
function resolvePlanPath(type, id) {
  let entityDir

  if (type === 'project') {
    const proj = db.prepare(`SELECT id, code_path FROM projects WHERE (id = ? OR name = ?) AND is_default = 0 AND parent_id IS NULL`).get(id, id)
    if (!proj) throw new Error('Project not found')
    entityDir = join(expandPath(proj.code_path), '.scryer')

  } else if (type === 'subproject') {
    const sp = db.prepare(`SELECT id FROM projects WHERE id = ? AND is_default = 0`).get(id)
    if (!sp) throw new Error('Subproject not found')
    const { rootCodePath, subParts } = resolveEntityBasePath(id)
    entityDir = join(expandPath(rootCodePath), '.scryer', ...subParts)

  } else if (type === 'ticket') {
    const ticket = db.prepare(`SELECT id, title, project_id FROM tickets WHERE id = ?`).get(id)
    if (!ticket) throw new Error('Ticket not found')
    const defaultNode = db.prepare(`SELECT parent_id FROM projects WHERE id = ?`).get(ticket.project_id)
    const { rootCodePath, subParts } = resolveEntityBasePath(defaultNode.parent_id)
    const folderName = `T${id}-${slugify(ticket.title)}`
    entityDir = join(expandPath(rootCodePath), '.scryer', ...subParts, folderName)

  } else {
    throw new Error('Unknown entity type')
  }

  const planPath = join(entityDir, 'plan.md')
  if (!existsSync(planPath)) {
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, '')
  }
  return planPath
}

// Walk up the project tree to find the root project's agent_warmup for any entity
function getRootWarmup(entityType, entityId) {
  try {
    let projectId
    if (entityType === 'project') {
      const row = db.prepare(`SELECT id, agent_warmup FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`).get(String(entityId))
      return row?.agent_warmup ?? 10
    } else if (entityType === 'subproject') {
      projectId = parseInt(entityId)
    } else if (entityType === 'ticket') {
      const ticket = db.prepare(`SELECT project_id FROM tickets WHERE id = ?`).get(parseInt(entityId))
      if (!ticket) return 10
      projectId = ticket.project_id
    } else {
      return 10
    }
    // Walk up to root
    let proj = db.prepare(`SELECT parent_id, agent_warmup FROM projects WHERE id = ?`).get(projectId)
    while (proj?.parent_id) {
      proj = db.prepare(`SELECT parent_id, agent_warmup FROM projects WHERE id = ?`).get(proj.parent_id)
    }
    return proj?.agent_warmup ?? 10
  } catch {
    return 10
  }
}

const router = Router()

// GET /api/projects — root-level projects only (no parent)
router.get('/projects', (_req, res) => {
  const projects = db.prepare(`
    SELECT id, name, description, code_path, git_backend, git_repo_url,
           session_claude, session_codex, session_gemini, planning_agent, architect_agent, agent_warmup
    FROM projects
    WHERE parent_id IS NULL AND is_default = 0
    ORDER BY name
  `).all()
  res.json({ projects })
})

// POST /api/projects — create a new root project
router.post('/projects', (req, res) => {
  const { name, description = '', code_path = '', git_backend = '', git_repo_url = '',
          planning_agent = 'claude', architect_agent = 'claude' } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  const existing = db.prepare(`SELECT id FROM projects WHERE name = ?`).get(name.trim())
  if (existing) return res.status(409).json({ error: 'A project with that name already exists' })

  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO projects (name, description, code_path, git_backend, git_repo_url, planning_agent, architect_agent, parent_id, is_default, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)
  `).run(name.trim(), description.trim(), code_path.trim(), git_backend.trim(), git_repo_url.trim(),
         planning_agent, architect_agent, now)

  const projectId = result.lastInsertRowid
  db.prepare(`
    INSERT INTO projects (name, description, parent_id, is_default, created_at)
    VALUES (?, '', ?, 1, ?)
  `).run(name.trim(), projectId, now)

  const project = db.prepare(`
    SELECT id, name, description, code_path, git_backend, git_repo_url,
           session_claude, session_codex, session_gemini, planning_agent, architect_agent, agent_warmup
    FROM projects WHERE id = ?
  `).get(projectId)

  initProjectTemplates(name.trim())

  res.status(201).json({ project })
})

// POST /api/projects/:name/sub-projects — create a sub-project under a root project
router.post('/projects/:name/sub-projects', (req, res) => {
  const parent = db.prepare(
    `SELECT id FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!parent) return res.status(404).json({ error: 'Project not found' })

  const { name, description = '' } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO projects (name, description, parent_id, is_default, created_at)
    VALUES (?, ?, ?, 0, ?)
  `).run(name.trim(), description.trim(), parent.id, now)

  const spId = result.lastInsertRowid
  db.prepare(`
    INSERT INTO projects (name, description, parent_id, is_default, created_at)
    VALUES (?, '', ?, 1, ?)
  `).run(name.trim(), spId, now)

  const sp = db.prepare(
    `SELECT id, name, description FROM projects WHERE id = ?`
  ).get(spId)

  res.status(201).json({ sub_project: sp })
})

function getTheme() {
  const row = db.prepare(`SELECT value FROM scryer_config WHERE key = 'theme'`).get()
  return row?.value ?? 'dark'
}

function getConfigVal(key) {
  const row = db.prepare(`SELECT value FROM scryer_config WHERE key = ?`).get(key)
  return row?.value ?? ''
}

// GET /api/config
router.get('/config', (_req, res) => {
  res.json({
    scryer_root: getScryerRoot(),
    code_root: getCodeRoot(),
    theme: getTheme(),
    discord_token: getConfigVal('discord_token'),
    discord_server_id: getConfigVal('discord_server_id'),
    oracle_provider: getConfigVal('oracle_provider'),
    oracle_model: getConfigVal('oracle_model'),
    home: homedir(),
  })
})

// PATCH /api/config
router.patch('/config', (req, res) => {
  const allowed = ['scryer_root', 'code_root', 'theme', 'discord_token', 'discord_server_id', 'oracle_provider', 'oracle_model']
  let updated = 0
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      db.prepare(`INSERT OR REPLACE INTO scryer_config (key, value) VALUES (?, ?)`).run(key, req.body[key])
      updated++
    }
  }
  if (!updated) return res.status(400).json({ error: 'No valid fields provided' })
  res.json({
    scryer_root: getScryerRoot(),
    code_root: getCodeRoot(),
    theme: getTheme(),
    discord_token: getConfigVal('discord_token'),
    discord_server_id: getConfigVal('discord_server_id'),
    oracle_provider: getConfigVal('oracle_provider'),
    oracle_model: getConfigVal('oracle_model'),
  })
})

// GET /api/planning?type=project|subproject|ticket&id=N — resolve plan.md, create if missing, return content
router.get('/planning', (req, res) => {
  const { type, id } = req.query
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, id)
    const content = readFileSync(planPath, 'utf8')
    res.json({ content, path: planPath })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// PATCH /api/planning?type=project|subproject|ticket&id=N — write content to plan.md
router.patch('/planning', (req, res) => {
  const { type, id } = req.query
  const { content } = req.body
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  if (content === undefined) return res.status(400).json({ error: 'content required' })
  try {
    const planPath = resolvePlanPath(type, id)
    writeFileSync(planPath, content, 'utf8')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/planning-prompt?type=project|subproject|ticket&id=N — generate startup prompt for agent
router.get('/planning-prompt', (req, res) => {
  const { type, id } = req.query
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const numId = parseInt(id, 10)
    let name, description, codePath, planningFolder

    if (type === 'project') {
      const proj = db.prepare(
        `SELECT name, description, code_path FROM projects WHERE id = ? AND is_default = 0`
      ).get(numId)
      if (!proj) throw new Error('Project not found')
      name = proj.name
      description = proj.description || ''
      codePath = proj.code_path || '(not set)'
      planningFolder = join(expandPath(proj.code_path || ''), '.scryer')

    } else if (type === 'subproject') {
      const sp = db.prepare(
        `SELECT name, description FROM projects WHERE id = ? AND is_default = 0`
      ).get(numId)
      if (!sp) throw new Error('Sub-project not found')
      const { rootCodePath, subParts } = resolveEntityBasePath(numId)
      name = sp.name
      description = sp.description || ''
      codePath = rootCodePath || '(not set)'
      planningFolder = join(expandPath(rootCodePath), '.scryer', ...subParts)

    } else if (type === 'ticket') {
      const ticket = db.prepare(`SELECT id, title, description, project_id FROM tickets WHERE id = ?`).get(numId)
      if (!ticket) throw new Error('Ticket not found')
      const defaultNode = db.prepare(`SELECT parent_id FROM projects WHERE id = ?`).get(ticket.project_id)
      const { rootCodePath, subParts } = resolveEntityBasePath(defaultNode.parent_id)
      const folderName = `T${numId}-${slugify(ticket.title)}`
      name = ticket.title
      description = ticket.description || ''
      codePath = rootCodePath || '(not set)'
      planningFolder = join(expandPath(rootCodePath), '.scryer', ...subParts, folderName)

    } else {
      throw new Error('Unknown entity type')
    }

    const prompt = `You are the planning agent for the "${name}" ${type} in Scryer.

Your mission is to help plan this ${type} by:
1. Breaking it down into logical sub-projects (if a project) or tasks
2. Creating well-described tickets with clear acceptance criteria
3. Setting blocking dependencies between tickets where needed
4. Writing a plan.md in the .planning/ folder summarising the plan

You have full access to the pm-local MCP server. Key tools:
- create_sub_project(project_name, name, description)
- create_ticket(project_name, title, description, sub_project_name, priority)
- set_blocks(blocker_ticket_id, blocked_ticket_id)
- add_comment(ticket_id, content)
- update_ticket(ticket_id, state, description)

${type.charAt(0).toUpperCase() + type.slice(1)} details:
- Name: ${name}
- Description: ${description || '(none)'}
- Code path: ${codePath}
- Planning folder: ${planningFolder}

Confirmation mode: ON — before creating tickets, updating state, or adding comments, briefly describe what you're about to do and wait for the human to say "go ahead" or similar before executing the MCP call. This is the default — the human can turn it off at any time by clicking the toggle in the terminal panel header.

Start by asking any clarifying questions you need, then propose and create the breakdown.`

    res.json({ prompt })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// GET /api/projects/:name — project detail with sub-projects and tickets
router.get('/projects/:name', (req, res) => {
  const project = db.prepare(`
    SELECT id, name, description, code_path, git_backend, git_repo_url,
           session_claude, session_codex, session_gemini, planning_agent, architect_agent, agent_warmup
    FROM projects
    WHERE name = ? AND is_default = 0
  `).get(req.params.name)

  if (!project) return res.status(404).json({ error: 'Project not found' })

  const subProjects = db.prepare(`
    SELECT id, name, description
    FROM projects
    WHERE parent_id = ? AND is_default = 0
    ORDER BY name
  `).all(project.id)

  const getTickets = (projectNodeId) => {
    const defaultNode = db.prepare(`
      SELECT id FROM projects WHERE parent_id = ? AND is_default = 1
    `).get(projectNodeId)
    if (!defaultNode) return []

    const tickets = db.prepare(`
      SELECT id, title, description, state, priority, spl_ticket_type
      FROM tickets
      WHERE project_id = ?
      ORDER BY created_at
    `).all(defaultNode.id)

    return tickets.map(t => ({
      ...t,
      blocked_by: db.prepare(`
        SELECT t2.id, t2.title, t2.state
        FROM tickets t2
        JOIN ticket_blocks tb ON t2.id = tb.blocker_id
        WHERE tb.blocked_id = ?
      `).all(t.id),
      comments: db.prepare(`
        SELECT id, content, created_at
        FROM comments
        WHERE ticket_id = ? AND is_root = 0
        ORDER BY created_at
      `).all(t.id),
      tags: db.prepare(`
        SELECT tg.name FROM tags tg
        JOIN ticket_tags tt ON tg.id = tt.tag_id
        WHERE tt.ticket_id = ? ORDER BY tg.name
      `).all(t.id).map(r => r.name),
    }))
  }

  res.json({
    project: {
      ...project,
      tickets: getTickets(project.id),
      sub_projects: subProjects.map(sp => ({ ...sp, tickets: getTickets(sp.id) })),
    }
  })
})

// PATCH /api/projects/:name — update project settings
router.patch('/projects/:name', (req, res) => {
  const current = db.prepare(
    `SELECT id, name FROM projects WHERE name = ? AND is_default = 0`
  ).get(req.params.name)
  if (!current) return res.status(404).json({ error: 'Project not found' })

  const allowed = ['name', 'description', 'code_path', 'git_backend', 'git_repo_url',
                   'session_claude', 'session_codex', 'session_gemini',
                   'planning_agent', 'architect_agent', 'agent_warmup']
  const updates = {}
  for (const field of allowed) {
    if (req.body[field] !== undefined) updates[field] = req.body[field]
  }

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'No fields to update' })

  const set = Object.keys(updates).map(k => `${k} = ?`).join(', ')
  db.prepare(`UPDATE projects SET ${set} WHERE id = ?`)
    .run(...Object.values(updates), current.id)

  const updated = db.prepare(
    `SELECT id, name, description, code_path, git_backend, git_repo_url,
            session_claude, session_codex, session_gemini,
            planning_agent, architect_agent, agent_warmup FROM projects WHERE id = ?`
  ).get(current.id)
  res.json({ project: updated })
})

// DELETE /api/projects/:name — delete a project, its planning folder, and optionally its code folder
router.delete('/projects/:name', (req, res) => {
  const project = db.prepare(
    `SELECT id, name, code_path FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const deleteCode = req.body?.deleteCode === true

  // Collect all project IDs in the subtree (root + all descendants)
  const allProjectIds = [project.id]
  const queue = [project.id]
  while (queue.length) {
    const pid = queue.shift()
    const children = db.prepare(`SELECT id FROM projects WHERE parent_id = ?`).all(pid)
    for (const c of children) { allProjectIds.push(c.id); queue.push(c.id) }
  }
  const subProjectIds = allProjectIds.filter(id => id !== project.id)

  // Collect all ticket IDs in the subtree
  const phAll = allProjectIds.map(() => '?').join(',')
  const allTicketIds = db.prepare(`SELECT id FROM tickets WHERE project_id IN (${phAll})`).all(...allProjectIds).map(r => r.id)

  // Delete proposals (and their items, which cascade) for every entity in this tree
  db.prepare(`DELETE FROM proposals WHERE entity_type = 'project' AND entity_id = ?`).run(project.name)
  if (subProjectIds.length) {
    const ph = subProjectIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM proposals WHERE entity_type = 'subproject' AND entity_id IN (${ph})`).run(...subProjectIds.map(String))
  }
  if (allTicketIds.length) {
    const ph = allTicketIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM proposals WHERE entity_type = 'ticket' AND entity_id IN (${ph})`).run(...allTicketIds.map(String))
    // Also null any proposal_items referencing these tickets directly (pre-migration safety)
    db.prepare(`UPDATE proposal_items SET ticket_id = NULL WHERE ticket_id IN (${ph})`).run(...allTicketIds)
  }

  // Remove DB record — foreign_keys ON cascades to sub-projects, tickets, comments, etc.
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id)

  // Always delete the .scryer planning folder (lives inside the project's base_path)
  if (project.code_path) {
    const planningFolder = join(expandPath(project.code_path), '.scryer')
    try {
      if (existsSync(planningFolder)) rmSync(planningFolder, { recursive: true, force: true })
    } catch (e) {
      console.error('Failed to delete .scryer folder:', planningFolder, e.message)
    }
  }

  // Delete code folder only if requested AND it's confirmed to be inside code_root
  if (deleteCode && project.code_path) {
    const codeRoot = expandPath(getCodeRoot())
    const codePath = expandPath(project.code_path)
    const isInternal = codeRoot && codePath &&
      (codePath === codeRoot || codePath.startsWith(codeRoot + '/'))
    if (isInternal) {
      try {
        if (existsSync(codePath)) rmSync(codePath, { recursive: true, force: true })
      } catch (e) {
        console.error('Failed to delete code folder:', codePath, e.message)
      }
    }
  }

  res.json({ ok: true })
})

// DELETE /api/tickets/:id — permanently delete a ticket
router.delete('/tickets/:id', (req, res) => {
  const ticketId = parseInt(req.params.id, 10)
  if (isNaN(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' })

  const ticket = db.prepare(`SELECT id, title FROM tickets WHERE id = ?`).get(ticketId)
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

  db.prepare(`DELETE FROM tickets WHERE id = ?`).run(ticketId)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO logs (action, message, details, ticket_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('ticket_deleted', `T${ticketId} deleted: ${ticket.title}`, JSON.stringify({ ticket_id: ticketId, title: ticket.title }), ticketId, now)

  res.json({ ok: true })
})

// POST /api/tickets/:id/comments — add a comment to a ticket
router.post('/tickets/:id/comments', (req, res) => {
  const ticketId = parseInt(req.params.id, 10)
  const { content } = req.body
  if (!content?.trim()) return res.status(400).json({ error: 'content required' })

  const ticket = db.prepare(`SELECT id FROM tickets WHERE id = ?`).get(ticketId)
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO comments (ticket_id, content, is_root, created_at)
    VALUES (?, ?, 0, ?)
  `).run(ticketId, content.trim(), now)

  const comment = db.prepare(`SELECT id, content, created_at FROM comments WHERE id = ?`)
    .get(result.lastInsertRowid)

  // Write to activity log
  const truncated = content.trim().length > 200 ? content.trim().slice(0, 200) + '…' : content.trim()
  db.prepare(`INSERT INTO logs (action, message, details, ticket_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('comment', truncated, JSON.stringify({ content: content.trim() }), ticketId, now)

  res.status(201).json({ comment })
})

// ── Tag API ───────────────────────────────────────────────────────────────────

function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\s+/g, '-')
}

// GET /api/tags — list all tags with usage counts
router.get('/tags', (_req, res) => {
  const tags = db.prepare(
    `SELECT tg.name, COUNT(tt.ticket_id) AS count
     FROM tags tg LEFT JOIN ticket_tags tt ON tg.id = tt.tag_id
     GROUP BY tg.id ORDER BY tg.name`
  ).all()
  res.json({ tags })
})

// GET /api/tags/:tag/tickets — all tickets with this tag across all projects
router.get('/tags/:tag/tickets', (req, res) => {
  const name = normalizeTag(req.params.tag)
  const tickets = db.prepare(
    `SELECT t.id, t.title, t.state, t.priority, t.project_id
     FROM tickets t
     JOIN ticket_tags tt ON t.id = tt.ticket_id
     JOIN tags tg ON tg.id = tt.tag_id
     WHERE tg.name = ? ORDER BY t.created_at`
  ).all(name)
  res.json({ tickets })
})

// POST /api/tickets/:id/tags — add a tag to a ticket
router.post('/tickets/:id/tags', (req, res) => {
  const ticketId = parseInt(req.params.id, 10)
  const ticket = db.prepare(`SELECT id FROM tickets WHERE id = ?`).get(ticketId)
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

  const raw = req.body?.tag
  if (!raw?.trim()) return res.status(400).json({ error: 'tag required' })
  const name = normalizeTag(raw)
  if (!name) return res.status(400).json({ error: 'Invalid tag name' })

  const now = new Date().toISOString()
  db.prepare(`INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)`).run(name, now)
  const tagRow = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name)
  db.prepare(`INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)`).run(ticketId, tagRow.id)
  res.status(201).json({ ticket_id: ticketId, tag: name })
})

// DELETE /api/tickets/:id/tags/:tag — remove a tag from a ticket
router.delete('/tickets/:id/tags/:tag', (req, res) => {
  const ticketId = parseInt(req.params.id, 10)
  const name = normalizeTag(req.params.tag)
  const tagRow = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name)
  if (tagRow) {
    db.prepare(`DELETE FROM ticket_tags WHERE ticket_id = ? AND tag_id = ?`).run(ticketId, tagRow.id)
  }
  res.json({ ok: true })
})

// GET /api/drops — list all saved screenshots, newest first
router.get('/drops', (_req, res) => {
  const dropsDir = join(homedir(), 'Code', 'plane.so', 'drops')
  mkdirSync(dropsDir, { recursive: true })
  const files = readdirSync(dropsDir)
    .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
    .sort()
    .reverse()
  res.json({ files })
})

// POST /api/drop — save dropped screenshot to ~/Code/plane.so/drops/
router.post('/drop', (req, res) => {
  const { data, filename } = req.body
  if (!data || !filename) return res.status(400).json({ error: 'Missing data or filename' })

  const dropsDir = join(homedir(), 'Code', 'plane.so', 'drops')
  mkdirSync(dropsDir, { recursive: true })

  const base64 = data.replace(/^data:image\/\w+;base64,/, '')
  const buf = Buffer.from(base64, 'base64')
  const ext = filename.split('.').pop() || 'png'
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const stamped = `${ts}.${ext}`

  writeFileSync(join(dropsDir, stamped), buf)

  res.json({ saved: stamped })
})

// Walk up the project tree to find the root project name (for activity feed links)
function getRootProjectName(projectId) {
  let id = projectId
  const seen = new Set()
  while (id != null && !seen.has(id)) {
    seen.add(id)
    const p = db.prepare(`SELECT id, name, parent_id, is_default FROM projects WHERE id = ?`).get(id)
    if (!p) return null
    if (p.parent_id == null && !p.is_default) return p.name
    id = p.parent_id
  }
  return null
}

// GET /api/activity — unified activity feed from the logs table
router.get('/activity', (req, res) => {
  const limit  = Math.min(500, parseInt(req.query.limit || '100', 10))
  const since  = req.query.since || null
  const project = req.query.project || null

  // Build a helper that resolves all descendant project IDs for a project name
  let projectIds = null
  if (project) {
    const root = db.prepare(`SELECT id FROM projects WHERE name = ? AND is_default = 0`).get(project)
    if (root) {
      const ids = []
      const stack = [root.id]
      while (stack.length) {
        const cur = stack.pop()
        ids.push(cur)
        db.prepare(`SELECT id FROM projects WHERE parent_id = ?`).all(cur)
          .forEach(r => stack.push(r.id))
      }
      projectIds = ids
    }
  }

  let query, params
  if (since && projectIds) {
    const ph = projectIds.map(() => '?').join(',')
    query = `
      SELECT l.id, l.action, l.message, l.details, l.ticket_id, l.created_at,
             t.title AS ticket_title
      FROM logs l
      LEFT JOIN tickets t ON t.id = l.ticket_id
      WHERE l.created_at > ?
        AND (l.ticket_id IS NULL OR t.project_id IN (${ph}))
      ORDER BY l.created_at DESC
      LIMIT ?
    `
    params = [since, ...projectIds, limit]
  } else if (since) {
    query = `
      SELECT l.id, l.action, l.message, l.details, l.ticket_id, l.created_at,
             t.title AS ticket_title
      FROM logs l
      LEFT JOIN tickets t ON t.id = l.ticket_id
      WHERE l.created_at > ?
      ORDER BY l.created_at DESC
      LIMIT ?
    `
    params = [since, limit]
  } else if (projectIds) {
    const ph = projectIds.map(() => '?').join(',')
    query = `
      SELECT l.id, l.action, l.message, l.details, l.ticket_id, l.created_at,
             t.title AS ticket_title
      FROM logs l
      LEFT JOIN tickets t ON t.id = l.ticket_id
      WHERE (l.ticket_id IS NULL OR t.project_id IN (${ph}))
      ORDER BY l.created_at DESC
      LIMIT ?
    `
    params = [...projectIds, limit]
  } else {
    query = `
      SELECT l.id, l.action, l.message, l.details, l.ticket_id, l.created_at,
             t.title AS ticket_title
      FROM logs l
      LEFT JOIN tickets t ON t.id = l.ticket_id
      ORDER BY l.created_at DESC
      LIMIT ?
    `
    params = [limit]
  }

  const rows = db.prepare(query).all(...params)
  const entries = rows.map(r => {
    let project_name = null
    if (r.ticket_id) {
      // ticket's project_id is a default node — walk up to find root project name
      const ticket = db.prepare(`SELECT project_id FROM tickets WHERE id = ?`).get(r.ticket_id)
      if (ticket) project_name = getRootProjectName(ticket.project_id)
    }
    return {
      ...r,
      details: (() => { try { return JSON.parse(r.details) } catch { return {} } })(),
      project_name,
    }
  })
  res.json({ entries })
})

// Dirs to skip when listing sub-project candidates
const SCAN_EXCLUDE = new Set([
  '.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', '.cache', 'coverage', 'target', '.gradle', '.mvn',
  '.idea', '.vscode', 'vendor', 'public', 'static', 'assets', 'tmp', 'temp',
  'logs', '.DS_Store', '.turbo', 'out', '.output',
])

function expandPath(p) {
  if (p.startsWith('~')) return join(homedir(), p.slice(1))
  return p
}

function readReadmeDescription(dir) {
  const candidates = ['README.md', 'readme.md', 'README', 'README.txt']
  for (const name of candidates) {
    const full = join(dir, name)
    if (!existsSync(full)) continue
    try {
      const text = readFileSync(full, 'utf8')
      // Split by blank lines, skip headings and empty chunks, take first real paragraph
      for (const chunk of text.split(/\n{2,}/)) {
        const trimmed = chunk.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('#')) continue
        // Strip inline markdown (bold, italic, backticks, links)
        const clean = trimmed
          .replace(/!\[.*?\]\(.*?\)/g, '')  // images
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links
          .replace(/[*_`]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        if (!clean) continue
        return clean.length > 300 ? clean.slice(0, 297) + '…' : clean
      }
    } catch { /* ignore */ }
  }
  return ''
}

function readProjectName(dir) {
  // package.json
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, '')
  } catch { /* ignore */ }
  // pyproject.toml — simple regex, no full TOML parser
  try {
    const text = readFileSync(join(dir, 'pyproject.toml'), 'utf8')
    const m = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
    if (m) return m[1]
  } catch { /* ignore */ }
  // Cargo.toml
  try {
    const text = readFileSync(join(dir, 'Cargo.toml'), 'utf8')
    const m = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
    if (m) return m[1]
  } catch { /* ignore */ }
  return basename(dir)
}

// GET /api/scan-codebase?path=... — scan local folder and return name/description/sub_projects
router.get('/scan-codebase', (req, res) => {
  const raw = req.query.path
  if (!raw) return res.status(400).json({ error: 'path required' })

  const dir = expandPath(raw)
  if (!existsSync(dir)) return res.status(404).json({ error: 'Path does not exist' })
  try {
    if (!statSync(dir).isDirectory()) return res.status(400).json({ error: 'Path is not a directory' })
  } catch {
    return res.status(400).json({ error: 'Cannot stat path' })
  }

  const name = readProjectName(dir)
  const description = readReadmeDescription(dir)

  let sub_projects = []
  try {
    sub_projects = readdirSync(dir)
      .filter(f => {
        if (SCAN_EXCLUDE.has(f)) return false
        if (f.startsWith('.')) return false
        try { return statSync(join(dir, f)).isDirectory() } catch { return false }
      })
      .sort()
  } catch { /* ignore */ }

  res.json({ name, description, sub_projects })
})

// GET /api/planning-conversations?type=...&id=N — list conversation log files for an entity
router.get('/planning-conversations', (req, res) => {
  const { type, id } = req.query
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, parseInt(id, 10))
    const convDir = join(dirname(planPath), 'conversations')
    if (!existsSync(convDir)) return res.json({ conversations: [] })
    const files = readdirSync(convDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .map(f => ({
        filename: f,
        timestamp: f.replace('.md', ''),
      }))
    res.json({ conversations: files })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// GET /api/planning-conversations/:filename?type=...&id=N — read a conversation log
router.get('/planning-conversations/:filename', (req, res) => {
  const { type, id } = req.query
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, parseInt(id, 10))
    const convDir = join(dirname(planPath), 'conversations')
    const filename = basename(req.params.filename)
    if (!filename.endsWith('.md')) return res.status(400).json({ error: 'Invalid filename' })
    const filePath = join(convDir, filename)
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' })
    const content = readFileSync(filePath, 'utf8')
    res.json({ content, filename })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// ── Template API ──────────────────────────────────────────────────────────────

const VALID_TEMPLATES = new Set(['planning', 'architect'])

function templatePaths(projectName, templateName) {
  const scryerRoot = getScryerRoot()
  const perProject = join(scryerRoot, projectName, 'templates', `${templateName}.md`)
  const global_    = join(GLOBAL_TEMPLATES_DIR, `${templateName}.md`)
  return { perProject, global: global_ }
}

// GET /api/projects/:name/templates/:template
router.get('/projects/:name/templates/:template', (req, res) => {
  const { name, template } = req.params
  if (!VALID_TEMPLATES.has(template)) return res.status(400).json({ error: 'Unknown template' })
  const proj = db.prepare(`SELECT id FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`).get(name)
  if (!proj) return res.status(404).json({ error: 'Project not found' })

  const { perProject, global: globalPath } = templatePaths(name, template)
  if (existsSync(perProject)) {
    return res.json({ content: readFileSync(perProject, 'utf8'), source: 'project' })
  }
  if (existsSync(globalPath)) {
    return res.json({ content: readFileSync(globalPath, 'utf8'), source: 'global' })
  }
  res.status(404).json({ error: 'Template file not found' })
})

// PATCH /api/projects/:name/templates/:template — save per-project template
router.patch('/projects/:name/templates/:template', (req, res) => {
  const { name, template } = req.params
  if (!VALID_TEMPLATES.has(template)) return res.status(400).json({ error: 'Unknown template' })
  const proj = db.prepare(`SELECT id FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`).get(name)
  if (!proj) return res.status(404).json({ error: 'Project not found' })

  const { content } = req.body
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' })

  const { perProject } = templatePaths(name, template)
  mkdirSync(dirname(perProject), { recursive: true })
  writeFileSync(perProject, content, 'utf8')
  res.json({ ok: true, source: 'project' })
})

// POST /api/projects/:name/templates/:template/reset — revert to global default
router.post('/projects/:name/templates/:template/reset', (req, res) => {
  const { name, template } = req.params
  if (!VALID_TEMPLATES.has(template)) return res.status(400).json({ error: 'Unknown template' })
  const proj = db.prepare(`SELECT id FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`).get(name)
  if (!proj) return res.status(404).json({ error: 'Project not found' })

  const { perProject, global: globalPath } = templatePaths(name, template)
  if (!existsSync(globalPath)) return res.status(404).json({ error: 'Global template not found' })

  mkdirSync(dirname(perProject), { recursive: true })
  writeFileSync(perProject, readFileSync(globalPath, 'utf8'), 'utf8')
  res.json({ ok: true })
})

// GET /api/projects/:name/review — list changed files in the project's code_path
router.get('/projects/:name/review', (req, res) => {
  const project = db.prepare(
    `SELECT code_path FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  if (!project.code_path) return res.status(422).json({ error: 'No code_path set for this project' })

  const dir = expandPath(project.code_path)
  if (!existsSync(dir)) return res.status(404).json({ error: 'code_path does not exist' })

  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
  })
  if (result.status !== 0) {
    return res.status(422).json({ error: result.stderr?.trim() || 'git status failed' })
  }

  const files = result.stdout.trim().split('\n')
    .filter(Boolean)
    .map(line => {
      const xy = line.slice(0, 2)
      const path = line.slice(3)
      // Normalise to a single display code
      let status = xy.trim()
      if (xy === '??') status = '??'
      else if (xy[0] === 'R' || xy[1] === 'R') status = 'R'
      else if (xy[0] === 'D' || xy[1] === 'D') status = 'D'
      else if (xy[0] === 'A' || xy[1] === 'A') status = 'A'
      else status = 'M'
      return { status, path }
    })

  res.json({ files })
})

// GET /api/projects/:name/review/diff?file=... — unified diff for one file
router.get('/projects/:name/review/diff', (req, res) => {
  const project = db.prepare(
    `SELECT code_path FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  if (!project.code_path) return res.status(422).json({ error: 'No code_path set' })

  const file = req.query.file
  if (!file) return res.status(400).json({ error: 'file required' })

  const dir = expandPath(project.code_path)

  // Check if HEAD exists (may not in a brand new repo)
  const hasHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
  }).status === 0

  const statusResult = spawnSync('git', ['status', '--porcelain', '--', file], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
  })
  const statusLine = statusResult.stdout.trim()
  const xy = statusLine.slice(0, 2)
  const isUntracked = xy === '??'

  let diff = ''

  if (isUntracked) {
    // Show entire file as added
    diff = spawnSync('git', ['diff', '--no-index', '/dev/null', file], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
    }).stdout
  } else if (!hasHead) {
    // New repo, no commits — all changes are in the index
    diff = spawnSync('git', ['diff', '--cached', '--', file], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
    }).stdout
    // If not staged, diff the working tree file against /dev/null
    if (!diff.trim()) {
      diff = spawnSync('git', ['diff', '--no-index', '/dev/null', file], {
        cwd: dir, encoding: 'utf8', timeout: 10000,
      }).stdout
    }
  } else {
    // Has commits — compare working tree + index against HEAD
    diff = spawnSync('git', ['diff', 'HEAD', '--', file], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
    }).stdout
  }

  res.json({ diff: diff || '' })
})

// POST /api/projects/:name/review/discard — discard changes to a single file
router.post('/projects/:name/review/discard', (req, res) => {
  const project = db.prepare(
    `SELECT code_path FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!project?.code_path) return res.status(422).json({ error: 'No code_path set' })

  const file = req.body?.file
  if (!file) return res.status(400).json({ error: 'file required' })

  const dir = expandPath(project.code_path)
  if (!existsSync(dir)) return res.status(404).json({ error: 'code_path does not exist' })

  const hasHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
  }).status === 0

  // Check if file is untracked
  const statusResult = spawnSync('git', ['status', '--porcelain', '--', file], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
  })
  const isUntracked = statusResult.stdout.trim().startsWith('??')

  if (isUntracked) {
    try { rmSync(join(dir, file), { force: true }) } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  } else if (hasHead) {
    const r = spawnSync('git', ['restore', '--', file], { cwd: dir, encoding: 'utf8', timeout: 10000 })
    if (r.status !== 0) return res.status(500).json({ error: r.stderr?.trim() || 'restore failed' })
  } else {
    // No HEAD — unstage the file then delete it
    spawnSync('git', ['rm', '--cached', '--quiet', '--', file], { cwd: dir, encoding: 'utf8', timeout: 10000 })
    try { rmSync(join(dir, file), { force: true }) } catch { /* ignore */ }
  }

  res.json({ ok: true })
})

// POST /api/projects/:name/review/commit — stage a single file and commit
router.post('/projects/:name/review/commit', (req, res) => {
  const project = db.prepare(
    `SELECT code_path FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!project?.code_path) return res.status(422).json({ error: 'No code_path set' })

  const { file, message } = req.body ?? {}
  if (!file) return res.status(400).json({ error: 'file required' })
  if (!message?.trim()) return res.status(400).json({ error: 'message required' })

  const dir = expandPath(project.code_path)
  if (!existsSync(dir)) return res.status(404).json({ error: 'code_path does not exist' })

  const add = spawnSync('git', ['add', '--', file], { cwd: dir, encoding: 'utf8', timeout: 10000 })
  if (add.status !== 0) return res.status(500).json({ error: add.stderr?.trim() || 'git add failed' })

  const commit = spawnSync('git', ['commit', '-m', message.trim()], { cwd: dir, encoding: 'utf8', timeout: 10000 })
  if (commit.status !== 0) return res.status(500).json({ error: commit.stderr?.trim() || 'git commit failed' })

  res.json({ ok: true })
})

// GET /api/detect-git-remote?path=... — detect git remote URL from a local repo
router.get('/detect-git-remote', (req, res) => {
  const raw = req.query.path
  if (!raw) return res.status(400).json({ error: 'path required' })

  const dir = expandPath(raw)
  if (!existsSync(dir)) return res.status(404).json({ error: 'Path does not exist' })

  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 5000,
  })

  if (result.status !== 0) {
    return res.status(422).json({ error: result.stderr?.trim() || 'No git remote found' })
  }

  res.json({ url: result.stdout.trim() })
})



// POST /api/planning/launch — launch a planning session for an entity
router.post('/planning/launch', (req, res) => {
  const { entity_type, entity_id, agent = 'claude' } = req.body
  if (!entity_type || !entity_id) {
    return res.status(400).json({ error: 'entity_type and entity_id required' })
  }
  const scryer_root = db.prepare(`SELECT value FROM scryer_config WHERE key = 'scryer_root'`).get()?.value
  if (!scryer_root) {
    return res.status(400).json({ error: 'scryer_root not configured. Set it in Global Config.' })
  }

  // Resolve numeric ID so we can build the session name (launch.py uses numeric_id, not entity name)
  let numericId
  if (entity_type === 'project') {
    const row = db.prepare(`SELECT id FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`).get(entity_id)
    if (!row) return res.status(404).json({ error: `Project '${entity_id}' not found` })
    numericId = row.id
  } else {
    numericId = parseInt(entity_id, 10)
  }

  const warmup = getRootWarmup(entity_type, entity_id)
  const launcher = join(__dirname, '..', '..', 'planning', 'launch.py')
  // Block until session is ready so the browser can attach immediately
  const result = spawnSync('python3', [launcher, '--type', entity_type, '--id', String(entity_id), '--agent', agent, '--warmup', String(warmup), '--no-attach'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.status !== 0) {
    return res.status(500).json({ error: result.stderr?.trim() || 'Launch failed' })
  }
  res.json({ ok: true, session: `planning-${entity_type}-${numericId}`, warmup_ms: warmup * 1000 })
})

// GET /api/architect/proposal?type=...&id=N — read proposal.json written by architect agent
router.get('/architect/proposal', (req, res) => {
  const { type, id } = req.query
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, id)  // returns entityDir/plan.md
    const proposalPath = join(dirname(planPath), 'proposal.json')
    if (!existsSync(proposalPath)) return res.json({ ready: false })
    const raw = readFileSync(proposalPath, 'utf8')
    const proposal = JSON.parse(raw)
    res.json({ ready: true, proposal })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/architect/apply — create approved items from a proposal
router.post('/architect/apply', (req, res) => {
  const { entity_type, entity_id, items } = req.body
  if (!entity_type || !entity_id || !items) {
    return res.status(400).json({ error: 'entity_type, entity_id, items required' })
  }

  // Read proposal metadata for history tracking
  let proposalMeta = {}
  try {
    const planPath = resolvePlanPath(entity_type, entity_id)
    const proposalPath = join(dirname(planPath), 'proposal.json')
    if (existsSync(proposalPath)) {
      const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'))
      proposalMeta = {
        proposal_id:   proposal.id || '',
        proposal_path: proposalPath,
        generated_at:  proposal.generated_at || '',
        mode:          proposal.mode || 'architect',
      }
    }
  } catch (_) {}

  const applyScript = join(__dirname, '..', '..', 'architect', 'apply.py')
  const result = spawnSync('python3', [applyScript], {
    input: JSON.stringify({ entity_type, entity_id, items, ...proposalMeta }),
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.status !== 0) {
    console.error('[architect/apply] stderr:', result.stderr)
    console.error('[architect/apply] stdout:', result.stdout)
    return res.status(500).json({ error: result.stderr?.trim() || 'Apply failed' })
  }
  try {
    res.json(JSON.parse(result.stdout))
  } catch {
    res.status(500).json({ error: 'Invalid response from apply script' })
  }
})

// PATCH /api/architect/proposal/items/:itemId — update a single item in proposal.json
router.patch('/architect/proposal/items/:itemId', (req, res) => {
  const { itemId } = req.params
  const { type, id, status, human_feedback, rejection_reason } = req.body
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, id)
    const proposalPath = join(dirname(planPath), 'proposal.json')
    if (!existsSync(proposalPath)) return res.status(404).json({ error: 'No proposal found' })
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'))
    const item = (proposal.items || []).find(i => i.id === itemId)
    if (!item) return res.status(404).json({ error: `Item ${itemId} not found` })
    if (status !== undefined)           item.status = status
    if (human_feedback !== undefined)   item.human_feedback = human_feedback
    if (rejection_reason !== undefined) item.rejection_reason = rejection_reason
    writeFileSync(proposalPath, JSON.stringify(proposal, null, 2))
    res.json({ ok: true, item })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/architect/proposal/clear — archive then delete proposal.json
router.post('/architect/proposal/clear', (req, res) => {
  const { type, id } = req.body
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, id)
    const proposalPath = join(dirname(planPath), 'proposal.json')
    if (existsSync(proposalPath)) {
      // Archive before deleting so history is preserved
      try {
        const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'))
        const clearScript = join(__dirname, '..', '..', 'architect', 'apply.py')
        const { spawnSync: _s } = require('child_process')
        _s('python3', [clearScript], {
          input: JSON.stringify({
            entity_type:   type,
            entity_id:     id,
            items:         (proposal.items || []).map(i => ({ ...i, status: 'ignored' })),
            proposal_id:   proposal.id || '',
            proposal_path: proposalPath,
            generated_at:  proposal.generated_at || '',
            mode:          proposal.mode || 'architect',
          }),
          encoding: 'utf8',
          timeout: 10000,
        })
      } catch (_) {}
      rmSync(proposalPath)
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/architect/launch — launch an architect session for an entity
router.post('/architect/launch', (req, res) => {
  const { entity_type, entity_id, mode = 'architect', agent = 'claude' } = req.body
  if (!entity_type || !entity_id) {
    return res.status(400).json({ error: 'entity_type and entity_id required' })
  }
  const scryer_root = db.prepare(`SELECT value FROM scryer_config WHERE key = 'scryer_root'`).get()?.value
  if (!scryer_root) {
    return res.status(400).json({ error: 'scryer_root not configured. Set it in Global Config.' })
  }

  let numericId
  if (entity_type === 'project') {
    const row = db.prepare(`SELECT id FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`).get(entity_id)
    if (!row) return res.status(404).json({ error: `Project '${entity_id}' not found` })
    numericId = row.id
  } else {
    numericId = parseInt(entity_id, 10)
  }

  const warmup = getRootWarmup(entity_type, entity_id)
  const launcher = join(__dirname, '..', '..', 'architect', 'launch.py')
  const result = spawnSync('python3', [launcher, '--type', entity_type, '--id', String(entity_id), '--mode', mode, '--agent', agent, '--warmup', String(warmup), '--no-attach'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.status !== 0) {
    return res.status(500).json({ error: result.stderr?.trim() || 'Launch failed' })
  }
  res.json({ ok: true, session: `architect-${entity_type}-${numericId}-${mode}`, warmup_ms: warmup * 1000 })
})

// POST /api/tmux/kill — kill a named tmux session
router.post('/tmux/kill', (req, res) => {
  const { session } = req.body
  if (!session) return res.status(400).json({ error: 'session required' })
  spawnSync('/opt/homebrew/bin/tmux', ['kill-session', '-t', session])
  res.json({ ok: true })
})

// GET /api/projects/:name/tmux-sessions — list running tmux sessions for this project
router.get('/projects/:name/tmux-sessions', (req, res) => {
  const projectName = req.params.name

  // Collect entity IDs that belong to this project
  const rootProject = db.prepare(`SELECT id FROM projects WHERE name = ? AND parent_id IS NULL`).get(projectName)
  const spIds    = new Set()
  const ticketIds = new Set()
  const debateIds = new Set()

  if (rootProject) {
    const subprojects = db.prepare(`SELECT id FROM projects WHERE parent_id = ?`).all(rootProject.id)
    for (const sp of subprojects) spIds.add(String(sp.id))

    // Tickets across root + all sub-projects
    const projectIds = [rootProject.id, ...subprojects.map(s => s.id)]
    for (const pid of projectIds) {
      const tickets = db.prepare(`SELECT id FROM tickets WHERE project_id = ?`).all(pid)
      for (const t of tickets) ticketIds.add(String(t.id))
    }

    // Council tickets for this project's entities
    try {
      const spPlaceholders = spIds.size > 0 ? [...spIds].map(() => '?').join(',') : 'NULL'
      const tPlaceholders  = ticketIds.size > 0 ? [...ticketIds].map(() => '?').join(',') : 'NULL'
      const councilTickets = db.prepare(`
        SELECT id FROM tickets
        WHERE spl_ticket_type = 1
          AND ((entity_type = 'project' AND entity_id = ?)
            OR (entity_type = 'subproject' AND entity_id IN (${spPlaceholders}))
            OR (entity_type = 'ticket'     AND entity_id IN (${tPlaceholders})))
      `).all(projectName, ...[...spIds], ...[...ticketIds])
      for (const d of councilTickets) debateIds.add(String(d.id))
    } catch {
      // fallback — debateIds stays empty
    }
  }

  const tmux = spawnSync('/opt/homebrew/bin/tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
  const names = (tmux.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)

  const sessions = []
  for (const name of names) {
    let type = null, label = null

    if (name.startsWith('planning-project-')) {
      const rest = name.slice('planning-project-'.length) // e.g. "Scryer"
      if (rest === projectName) { type = 'planning'; label = `Plan — ${rest}` }

    } else if (name.startsWith('planning-subproject-')) {
      const id = name.slice('planning-subproject-'.length)
      if (spIds.has(id)) { type = 'planning'; label = `Plan — SP ${id}` }

    } else if (name.startsWith('planning-ticket-')) {
      const id = name.slice('planning-ticket-'.length)
      if (ticketIds.has(id)) { type = 'planning'; label = `Plan — T${id}` }

    } else if (name.startsWith('architect-project-')) {
      // format: architect-project-{name}-{mode}
      const rest = name.slice('architect-project-'.length)
      const modeIdx = rest.lastIndexOf('-')
      const projPart = modeIdx > 0 ? rest.slice(0, modeIdx) : rest
      const mode     = modeIdx > 0 ? rest.slice(modeIdx + 1) : ''
      if (projPart === projectName) { type = 'architect'; label = `Arch — ${projPart} (${mode})` }

    } else if (name.startsWith('architect-subproject-')) {
      const rest = name.slice('architect-subproject-'.length)
      const modeIdx = rest.lastIndexOf('-')
      const id = modeIdx > 0 ? rest.slice(0, modeIdx) : rest
      const mode = modeIdx > 0 ? rest.slice(modeIdx + 1) : ''
      if (spIds.has(id)) { type = 'architect'; label = `Arch — SP ${id} (${mode})` }

    } else if (name.startsWith('architect-ticket-')) {
      const rest = name.slice('architect-ticket-'.length)
      const modeIdx = rest.lastIndexOf('-')
      const id = modeIdx > 0 ? rest.slice(0, modeIdx) : rest
      const mode = modeIdx > 0 ? rest.slice(modeIdx + 1) : ''
      if (ticketIds.has(id)) { type = 'architect'; label = `Arch — T${id} (${mode})` }

    } else if (name.startsWith('council-')) {
      const id = name.slice('council-'.length)
      // Show if debate belongs to this project, or as fallback show all council sessions
      if (debateIds.has(id) || debateIds.size === 0) { type = 'council'; label = `Council ${id}` }
    }

    if (type) sessions.push({ name, type, label })
  }

  res.json({ sessions })
})

// POST /api/clone-codebase — clone a remote git repo to dest
router.post('/clone-codebase', (req, res) => {
  const { url, dest } = req.body
  if (!url || !dest) return res.status(400).json({ error: 'url and dest required' })

  const expandedDest = expandPath(dest)

  // Ensure parent dir exists
  try {
    mkdirSync(dirname(expandedDest), { recursive: true })
  } catch { /* ignore */ }

  const result = spawnSync('git', ['clone', url, expandedDest], {
    encoding: 'utf8',
    timeout: 120_000,
  })

  if (result.status !== 0) {
    const errMsg = result.stderr?.trim() || result.error?.message || 'git clone failed'
    return res.status(500).json({ error: errMsg })
  }

  res.json({ ok: true, path: expandedDest })
})

// ── Agent permissions ──────────────────────────────────────────────────────────

// GET /api/agent-permissions — returns sections + current state per agent
router.get('/agent-permissions', (_req, res) => {
  try {
    const defaults = JSON.parse(readFileSync(AGENT_PERMS_DEFAULTS_PATH, 'utf8'))
    const agents   = ['claude', 'codex', 'gemini']
    const permissions = {}
    for (const agent of agents) {
      const rows = db.prepare(`SELECT item_id, state FROM agent_permissions WHERE agent = ?`).all(agent)
      permissions[agent] = Object.fromEntries(rows.map(r => [r.item_id, r.state]))
    }
    res.json({ sections: defaults.sections, permissions })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/agent-permissions — update a single item's state
router.patch('/agent-permissions', (req, res) => {
  const { agent, item_id, state } = req.body
  if (!agent || !item_id || !state) return res.status(400).json({ error: 'agent, item_id, state required' })
  if (!['allow', 'deny'].includes(state)) return res.status(400).json({ error: 'state must be allow or deny' })
  try {
    db.prepare(`INSERT OR REPLACE INTO agent_permissions (agent, item_id, state) VALUES (?, ?, ?)`).run(agent, item_id, state)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/agent-permissions/reset — reset all to factory defaults
router.post('/agent-permissions/reset', (_req, res) => {
  try {
    const defaults = JSON.parse(readFileSync(AGENT_PERMS_DEFAULTS_PATH, 'utf8'))
    const agents   = ['claude', 'codex', 'gemini']
    const insert   = db.prepare(`INSERT OR REPLACE INTO agent_permissions (agent, item_id, state) VALUES (?, ?, ?)`)
    for (const section of defaults.sections) {
      for (const item of section.items) {
        for (const agent of agents) {
          insert.run(agent, item.id, item.default)
        }
      }
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Council ─────────────────────────────────────────────────────────────────────

function dict_debate(row) {
  const roundRow = db.prepare(
    `SELECT COALESCE(MAX(round), 1) AS round FROM council_turns WHERE ticket_id = ?`
  ).get(row.id)
  return {
    id:          row.id,
    entity_type: row.entity_type,
    entity_id:   row.entity_id,
    state:       'active',
    round:       roundRow ? roundRow.round : 1,
    created_at:  row.created_at,
    updated_at:  row.updated_at,
  }
}

// GET /api/projects/:name/debates — all council tickets for entities within this project
router.get('/projects/:name/debates', (req, res) => {
  const project = db.prepare(
    `SELECT id, name FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL`
  ).get(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    const spIds = db.prepare(
      `SELECT id FROM projects WHERE parent_id = ? AND is_default = 0`
    ).all(project.id).map(r => r.id)

    const defaultNodes = db.prepare(
      `SELECT id FROM projects WHERE (parent_id = ? OR parent_id IN (${spIds.map(() => '?').join(',')})) AND is_default = 1`
    ).all(project.id, ...spIds)
    const defaultIds = defaultNodes.map(r => r.id)
    const ticketIds = defaultIds.length
      ? db.prepare(`SELECT id FROM tickets WHERE project_id IN (${defaultIds.map(() => '?').join(',')}) AND spl_ticket_type = 0`).all(...defaultIds).map(r => r.id)
      : []

    const spPlaceholders = spIds.length ? spIds.map(() => '?').join(',') : 'NULL'
    const tPlaceholders  = ticketIds.length ? ticketIds.map(() => '?').join(',') : 'NULL'
    const rows = db.prepare(`
      SELECT * FROM tickets
      WHERE spl_ticket_type = 1
        AND ((entity_type = 'project' AND entity_id = ?)
          OR (entity_type = 'subproject' AND entity_id IN (${spPlaceholders}))
          OR (entity_type = 'ticket'     AND entity_id IN (${tPlaceholders})))
      ORDER BY created_at DESC
    `).all(project.name, ...spIds, ...ticketIds)

    res.json({ debates: rows.map(dict_debate) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/debates?entity_type=X&entity_id=Y — find a council ticket by entity
router.get('/debates', (req, res) => {
  const { entity_type, entity_id } = req.query
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id required' })
  const row = db.prepare(
    `SELECT * FROM tickets WHERE spl_ticket_type = 1 AND entity_type = ? AND entity_id = ?`
  ).get(entity_type, entity_id)
  if (!row) return res.json({ debate: null })
  res.json({ debate: dict_debate(row) })
})

// GET /api/debates/:id — full council ticket with members and comments
router.get('/debates/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ? AND spl_ticket_type = 1`).get(id)
  if (!ticket) return res.status(404).json({ error: 'Council ticket not found' })

  const members = db.prepare(
    `SELECT cm.*, p.name AS persona_name
     FROM council_members cm JOIN personas p ON p.id = cm.persona_id
     WHERE cm.ticket_id = ? ORDER BY cm.seat_order`
  ).all(id)

  const comments = db.prepare(
    `SELECT id, author, content, created_at
     FROM comments WHERE ticket_id = ? AND is_root = 0
     ORDER BY created_at`
  ).all(id)

  res.json({ debate: dict_debate(ticket), members, comments })
})

// POST /api/debates/:id/end — end a council session (clears members/turns; ticket + comments persist)
router.post('/debates/:id/end', (req, res) => {
  const id = parseInt(req.params.id)
  const row = db.prepare(`SELECT id FROM tickets WHERE id = ? AND spl_ticket_type = 1`).get(id)
  if (!row) return res.status(404).json({ error: 'Council ticket not found' })
  db.prepare(`DELETE FROM council_members WHERE ticket_id = ?`).run(id)
  db.prepare(`DELETE FROM council_turns   WHERE ticket_id = ?`).run(id)
  res.json({ ok: true })
})

// POST /api/council/launch — launch a council session for an entity
router.post('/council/launch', (req, res) => {
  const { entity_type, entity_id, warmup = 15, seats } = req.body
  if (!entity_type || !entity_id) {
    return res.status(400).json({ error: 'entity_type and entity_id required' })
  }
  const launcher = join(__dirname, '..', '..', 'council', 'launch.py')
  const payload = JSON.stringify({ entity_type, entity_id, warmup, seats: seats ?? null })
  const result = spawnSync('python3', [launcher, '--from-stdin', '--no-attach'], {
    input: payload, encoding: 'utf8', timeout: 30000,
  })
  if (result.status !== 0) {
    const errMsg = result.stderr?.trim() || result.stdout?.trim() || 'Council launch failed'
    return res.status(500).json({ error: errMsg })
  }
  res.json({ ok: true })
})

// ── Personas ────────────────────────────────────────────────────────────────────

// GET /api/personas — list all personas from council/personas/*.md (no DB)
router.get('/personas', (req, res) => {
  try {
    if (!existsSync(PERSONAS_DIR)) return res.json({ personas: [] })
    const files = readdirSync(PERSONAS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
    const personas = files.map(file => {
      const slug = basename(file, '.md')
      const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      const template_path = `council/personas/${file}`
      const template_content = readFileSync(join(PERSONAS_DIR, file), 'utf8')
      return { id: slug, name, template_path, template_content }
    })
    res.json({ personas })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/personas/:id — full persona detail
router.get('/personas/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const row = db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id)
  if (!row) return res.status(404).json({ error: 'Persona not found' })
  res.json({ persona: row })
})

// POST /api/personas — create a new persona
router.post('/personas', (req, res) => {
  const { name, description = '', template_content = '', is_global = true, project_id = null } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'name required' })
  try {
    const result = db.prepare(
      `INSERT INTO personas (name, description, template_content, is_global, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(name.trim(), description.trim(), template_content, is_global ? 1 : 0, project_id, new Date().toISOString())
    const row = db.prepare(`SELECT * FROM personas WHERE id = ?`).get(result.lastInsertRowid)
    res.status(201).json({ persona: row })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/personas/:id — update name, description, or template_content
router.patch('/personas/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const row = db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id)
  if (!row) return res.status(404).json({ error: 'Persona not found' })
  const { name, description, template_content } = req.body
  db.prepare(
    `UPDATE personas SET name = ?, description = ?, template_content = ? WHERE id = ?`
  ).run(
    name ?? row.name,
    description ?? row.description,
    template_content ?? row.template_content,
    id
  )
  res.json({ persona: db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id) })
})

// DELETE /api/personas/:id — delete a persona
router.delete('/personas/:id', (req, res) => {
  const id = parseInt(req.params.id)
  db.prepare(`DELETE FROM personas WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// POST /api/personas/:id/reset — revert template_content to global template file (by matching name)
router.post('/personas/:id/reset', (req, res) => {
  const id = parseInt(req.params.id)
  const row = db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id)
  if (!row) return res.status(404).json({ error: 'Persona not found' })
  // Derive filename from persona name (lowercase, spaces→hyphens)
  const filename = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '') + '.md'
  const templatePath = join(PERSONAS_TEMPLATES_DIR, filename)
  if (!existsSync(templatePath)) return res.status(404).json({ error: 'No default template found for this persona' })
  const content = readFileSync(templatePath, 'utf8')
  db.prepare(`UPDATE personas SET template_content = ? WHERE id = ?`).run(content, id)
  res.json({ persona: db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id) })
})

export default router
