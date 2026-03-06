import { Router } from 'express'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join, basename } from 'path'
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'fs'
import { homedir } from 'os'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.PM_DB_PATH ||
  join(__dirname, '..', '..', 'infra', 'ProjectManagement', 'data', 'pm.db')

const db = new Database(DB_PATH)

// Ensure config table exists and seed defaults
db.exec(`CREATE TABLE IF NOT EXISTS scryer_config (key TEXT PRIMARY KEY, value TEXT)`)
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('scryer_root', ?)`)
  .run(join(homedir(), 'Scryer'))
db.prepare(`INSERT OR IGNORE INTO scryer_config (key, value) VALUES ('code_root', ?)`)
  .run(join(homedir(), 'Code'))

function getScryerRoot() {
  const row = db.prepare(`SELECT value FROM scryer_config WHERE key = 'scryer_root'`).get()
  return row?.value ?? join(homedir(), 'Scryer')
}

function getCodeRoot() {
  const row = db.prepare(`SELECT value FROM scryer_config WHERE key = 'code_root'`).get()
  return row?.value ?? ''
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

// Resolve the .planning/plan.md path for any entity (hierarchical structure), creating it if missing
function resolvePlanPath(type, id) {
  const root = getScryerRoot()
  let entityDir

  if (type === 'project') {
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ? AND is_default = 0`).get(id)
    if (!proj) throw new Error('Project not found')
    const parts = projectPathParts(id)
    entityDir = join(root, ...parts)

  } else if (type === 'subproject') {
    const sp = db.prepare(`SELECT id FROM projects WHERE id = ? AND is_default = 0`).get(id)
    if (!sp) throw new Error('Subproject not found')
    const parts = projectPathParts(id)
    entityDir = join(root, ...parts)

  } else if (type === 'ticket') {
    const ticket = db.prepare(`SELECT id, title, project_id FROM tickets WHERE id = ?`).get(id)
    if (!ticket) throw new Error('Ticket not found')
    // project_id points to the default node — walk up to find the real container
    const defaultNode = db.prepare(`SELECT parent_id FROM projects WHERE id = ?`).get(ticket.project_id)
    const parts = projectPathParts(defaultNode.parent_id)
    const folderName = `T${id}-${slugify(ticket.title)}`
    entityDir = join(root, ...parts, folderName)

  } else {
    throw new Error('Unknown entity type')
  }

  const planPath = join(entityDir, '.planning', 'plan.md')
  if (!existsSync(planPath)) {
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, '')
  }
  return planPath
}

const router = Router()

// GET /api/projects — root-level projects only (no parent)
router.get('/projects', (_req, res) => {
  const projects = db.prepare(`
    SELECT id, name, description, code_path, git_backend, git_repo_url,
           session_claude, session_codex, session_gemini
    FROM projects
    WHERE parent_id IS NULL AND is_default = 0
    ORDER BY name
  `).all()
  res.json({ projects })
})

// POST /api/projects — create a new root project
router.post('/projects', (req, res) => {
  const { name, description = '', code_path = '', git_backend = '', git_repo_url = '' } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  const existing = db.prepare(`SELECT id FROM projects WHERE name = ?`).get(name.trim())
  if (existing) return res.status(409).json({ error: 'A project with that name already exists' })

  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO projects (name, description, code_path, git_backend, git_repo_url, parent_id, is_default, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, 0, ?)
  `).run(name.trim(), description.trim(), code_path.trim(), git_backend.trim(), git_repo_url.trim(), now)

  const projectId = result.lastInsertRowid
  db.prepare(`
    INSERT INTO projects (name, description, parent_id, is_default, created_at)
    VALUES (?, '', ?, 1, ?)
  `).run(name.trim(), projectId, now)

  const project = db.prepare(`
    SELECT id, name, description, code_path, git_backend, git_repo_url,
           session_claude, session_codex, session_gemini
    FROM projects WHERE id = ?
  `).get(projectId)

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

// GET /api/config — return scryer_root, code_root, and home dir for path normalization
router.get('/config', (_req, res) => {
  res.json({ scryer_root: getScryerRoot(), code_root: getCodeRoot(), home: homedir() })
})

// PATCH /api/config — update scryer_root and/or code_root
router.patch('/config', (req, res) => {
  const { scryer_root, code_root } = req.body
  if (!scryer_root && code_root === undefined)
    return res.status(400).json({ error: 'scryer_root or code_root required' })
  if (scryer_root)
    db.prepare(`INSERT OR REPLACE INTO scryer_config (key, value) VALUES ('scryer_root', ?)`).run(scryer_root)
  if (code_root !== undefined)
    db.prepare(`INSERT OR REPLACE INTO scryer_config (key, value) VALUES ('code_root', ?)`).run(code_root)
  res.json({ scryer_root: getScryerRoot(), code_root: getCodeRoot() })
})

// GET /api/planning?type=project|subproject|ticket&id=N — resolve plan.md, create if missing, return content
router.get('/planning', (req, res) => {
  const { type, id } = req.query
  if (!type || !id) return res.status(400).json({ error: 'type and id required' })
  try {
    const planPath = resolvePlanPath(type, parseInt(id, 10))
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
    const planPath = resolvePlanPath(type, parseInt(id, 10))
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
      const parts = projectPathParts(numId)
      planningFolder = join(getScryerRoot(), ...parts, '.planning')

    } else if (type === 'subproject') {
      const sp = db.prepare(
        `SELECT name, description FROM projects WHERE id = ? AND is_default = 0`
      ).get(numId)
      if (!sp) throw new Error('Sub-project not found')
      const parts = projectPathParts(numId)
      const parent = db.prepare(
        `SELECT p.code_path FROM projects p WHERE p.id = ? AND p.is_default = 0`
      ).get(db.prepare(`SELECT parent_id FROM projects WHERE id = ?`).get(numId)?.parent_id)
      name = sp.name
      description = sp.description || ''
      codePath = parent?.code_path || '(not set)'
      planningFolder = join(getScryerRoot(), ...parts, '.planning')

    } else if (type === 'ticket') {
      const ticket = db.prepare(`SELECT id, title, description, project_id FROM tickets WHERE id = ?`).get(numId)
      if (!ticket) throw new Error('Ticket not found')
      const defaultNode = db.prepare(`SELECT parent_id FROM projects WHERE id = ?`).get(ticket.project_id)
      const parts = projectPathParts(defaultNode.parent_id)
      const folderName = `T${numId}-${slugify(ticket.title)}`
      name = ticket.title
      description = ticket.description || ''
      codePath = '(not set)'
      planningFolder = join(getScryerRoot(), ...parts, folderName, '.planning')

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
           session_claude, session_codex, session_gemini
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
      SELECT id, title, description, state, priority
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
                   'session_claude', 'session_codex', 'session_gemini']
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
            session_claude, session_codex, session_gemini FROM projects WHERE id = ?`
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

  // Remove DB record (cascade deletes tickets, sub-projects, comments)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id)

  // Always delete the planning folder
  const planningFolder = join(expandPath(getScryerRoot()), project.name)
  try {
    if (existsSync(planningFolder)) rmSync(planningFolder, { recursive: true, force: true })
  } catch (e) {
    console.error('Failed to delete planning folder:', planningFolder, e.message)
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

export default router
