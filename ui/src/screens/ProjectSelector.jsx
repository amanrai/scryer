import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const GIT_BACKENDS = ['', 'forgejo', 'github', 'gitlab']
const GIT_LABELS   = { '': '— none —', forgejo: 'Internal Forgejo', github: 'GitHub', gitlab: 'GitLab' }
const AGENTS       = ['claude', 'codex', 'gemini']

function GlobalConfigPanel({ onClose }) {
  const [form, setForm]   = useState({ scryer_root: '', code_root: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => { setForm({ scryer_root: d.scryer_root || '', code_root: d.code_root || '' }); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    } finally {
      setSaving(false)
      onClose()
    }
  }

  return (
    <div className="settings-panel global-config-panel">
      <div className="settings-header">
        <span>Global Config</span>
        <button className="settings-close" onClick={onClose}>✕</button>
      </div>
      {loading ? <div style={{ padding: '8px 0', color: 'var(--text-muted)' }}>Loading…</div> : (
        <>
          <label>Scryer root
            <input value={form.scryer_root} onChange={e => setForm(f => ({ ...f, scryer_root: e.target.value }))} placeholder="~/Scryer" />
          </label>
          <label>Default code root
            <input value={form.code_root} onChange={e => setForm(f => ({ ...f, code_root: e.target.value }))} placeholder="~/Code" />
          </label>
          <div className="settings-actions">
            <button className="btn-cancel" onClick={onClose}>Cancel</button>
            <button className="btn-save" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </div>
  )
}

// Inline panel inside NewProjectForm for attaching to a codebase
function AttachPanel({ onAttach }) {
  const [tab, setTab]         = useState('local')
  const [localPath, setLocalPath] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [scanning, setScanning]   = useState(false)
  const [cloning, setCloning]     = useState(false)
  const [err, setErr]             = useState(null)

  const doScan = async (path) => {
    setScanning(true)
    setErr(null)
    try {
      const res  = await fetch(`/api/scan-codebase?path=${encodeURIComponent(path)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Scan failed')
      onAttach({ name: data.name, description: data.description, sub_projects: data.sub_projects, codePath: path })
    } catch (e) {
      setErr(e.message)
    } finally {
      setScanning(false)
    }
  }

  const doClone = async () => {
    setCloning(true)
    setErr(null)
    try {
      const repoName = remoteUrl.replace(/\.git$/, '').split('/').pop() || 'repo'
      const cfg      = await fetch('/api/config').then(r => r.json())
      const dest     = cfg.code_root ? `${cfg.code_root}/${repoName}` : `~/Code/${repoName}`
      const res      = await fetch('/api/clone-codebase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: remoteUrl, dest }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Clone failed')
      await doScan(data.path)
    } catch (e) {
      setErr(e.message)
      setCloning(false)
    }
  }

  return (
    <div className="attach-panel">
      <div className="attach-tabs">
        <button className={`attach-tab${tab === 'local' ? ' active' : ''}`} onClick={() => setTab('local')}>Local folder</button>
        <button className={`attach-tab${tab === 'remote' ? ' active' : ''}`} onClick={() => setTab('remote')}>Remote repo</button>
      </div>
      {tab === 'local' ? (
        <div className="attach-row">
          <input
            className="attach-input"
            placeholder="~/Code/my-app"
            value={localPath}
            onChange={e => setLocalPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && localPath.trim() && doScan(localPath.trim())}
          />
          <button className="btn-attach-action" onClick={() => doScan(localPath.trim())} disabled={!localPath.trim() || scanning}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      ) : (
        <div className="attach-row">
          <input
            className="attach-input"
            placeholder="https://github.com/user/repo"
            value={remoteUrl}
            onChange={e => setRemoteUrl(e.target.value)}
          />
          <button className="btn-attach-action" onClick={doClone} disabled={!remoteUrl.trim() || cloning}>
            {cloning ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      )}
      {err && <div className="attach-error">{err}</div>}
    </div>
  )
}

function NewProjectForm({ onCancel, onCreate }) {
  const [config, setConfig]   = useState({ scryer_root: '', code_root: '' })
  const [name, setName]       = useState('')
  const [desc, setDesc]       = useState('')
  const [gitBackend, setGitBackend] = useState('forgejo')
  const [gitRepoUrl, setGitRepoUrl] = useState('')
  const [agent, setAgent]     = useState('claude')
  const [attachOpen, setAttachOpen] = useState(false)
  const [codePathOverride, setCodePathOverride] = useState(null)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState(null)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => setConfig({ scryer_root: d.scryer_root || '', code_root: d.code_root || '' }))
      .catch(() => {})
  }, [])

  const derivedCodePath    = config.code_root && name.trim() ? `${config.code_root}/${name.trim()}` : ''
  const codePath           = codePathOverride ?? derivedCodePath
  const planningFolder     = config.scryer_root && name.trim() ? `${config.scryer_root}/${name.trim()}/` : ''

  const handleAttach = ({ name: n, description: d, codePath: cp }) => {
    if (n)  setName(n)
    if (d)  setDesc(d)
    setCodePathOverride(cp || null)
    setAttachOpen(false)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!name.trim()) { setErr('Name is required'); return }
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim(),
          code_path: codePath,
          git_backend: gitBackend,
          git_repo_url: gitRepoUrl.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')

      onCreate(data.project, agent)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const codeRootMissing = !config.code_root

  return (
    <form className="new-project-form npf-expanded" onSubmit={handleSubmit}>
      <div className="npf-header">
        <span className="npf-title">{name.trim() || 'New Project'}</span>
        <button type="button" className="btn-cancel" onClick={onCancel}>Cancel</button>
      </div>

      <label>Name
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="my-project" />
      </label>

      <label>Description
        <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="(optional)" />
      </label>

      <div className="npf-readonly-row">
        <span className="npf-readonly-label">Code path</span>
        <span className={`npf-readonly-value${!codePath ? ' npf-readonly-muted' : ''}`}>
          {codePath || (codeRootMissing ? 'Set a default code root in ⚙ Global Config first' : '—')}
        </span>
      </div>

      <div className="npf-readonly-row">
        <span className="npf-readonly-label">Planning folder</span>
        <span className={`npf-readonly-value${!planningFolder ? ' npf-readonly-muted' : ''}`}>
          {planningFolder || '—'}
        </span>
      </div>

      <label>Git backend
        <select value={gitBackend} onChange={e => setGitBackend(e.target.value)}>
          {GIT_BACKENDS.map(b => <option key={b} value={b}>{GIT_LABELS[b]}</option>)}
        </select>
      </label>

      {gitBackend && (
        <label>Git repo URL
          <input value={gitRepoUrl} onChange={e => setGitRepoUrl(e.target.value)} placeholder="https://..." />
        </label>
      )}

      <div className="npf-field-label">Planning agent</div>
      <div className="npf-agent-seg">
        {AGENTS.map(a => (
          <button key={a} type="button" className={`npf-agent-btn${agent === a ? ' active' : ''}`} onClick={() => setAgent(a)}>
            {a}
          </button>
        ))}
      </div>

      <button type="button" className="npf-attach-toggle" onClick={() => setAttachOpen(o => !o)}>
        {attachOpen ? '▾' : '▸'} Attach to existing codebase
      </button>
      {attachOpen && <AttachPanel onAttach={handleAttach} />}

      {err && <span className="new-project-err">{err}</span>}

      <div className="new-project-actions">
        <button type="submit" className="btn-save" disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
      </div>

      <p className="npf-footer-note">These settings can be changed at any time from the project card.</p>
    </form>
  )
}

// ——— Existing project card + settings ———

function expandHome(p, home) {
  if (!p) return p
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p === '~') return home
  return p
}

function SettingsPanel({ project, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({
    name:         project.name,
    description:  project.description || '',
    code_path:    project.code_path || '',
    git_backend:  project.git_backend || '',
    git_repo_url: project.git_repo_url || '',
  })
  const [config, setConfig]             = useState({ scryer_root: '', code_root: '', home: '' })
  const [saving, setSaving]             = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteCode, setDeleteCode]     = useState(false)
  const [deleting, setDeleting]         = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => setConfig({ scryer_root: d.scryer_root || '', code_root: d.code_root || '', home: d.home || '' }))
      .catch(() => {})
  }, [])

  // A code path is "internal" if it lives under code_root
  const expandedCodeRoot = expandHome(config.code_root, config.home)
  const expandedCodePath = expandHome(project.code_path, config.home)
  const isCodeInternal   = !!(
    expandedCodeRoot && expandedCodePath &&
    (expandedCodePath === expandedCodeRoot || expandedCodePath.startsWith(expandedCodeRoot + '/'))
  )

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${project.name}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteCode: isCodeInternal && deleteCode }),
      })
      if (!res.ok) throw new Error('Delete failed')
      onDelete()
    } catch (e) {
      console.error('Delete failed:', e)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${project.name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error('Save failed')
      const data = await res.json()
      onSave(data.project)
    } catch (e) {
      console.error('Save failed:', e)
    } finally {
      setSaving(false)
      onClose()
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span>Settings</span>
        <button className="settings-close" onClick={onClose}>✕</button>
      </div>

      <label>Name<input value={form.name} onChange={set('name')} /></label>
      <label>Description<input value={form.description} onChange={set('description')} /></label>
      <label>Code path<input value={form.code_path} onChange={set('code_path')} placeholder="/path/to/repo or URL" /></label>
      <label>Git backend
        <select value={form.git_backend} onChange={set('git_backend')}>
          {GIT_BACKENDS.map(b => <option key={b} value={b}>{GIT_LABELS[b]}</option>)}
        </select>
      </label>
      <label>Git repo URL<input value={form.git_repo_url} onChange={set('git_repo_url')} placeholder="https://..." /></label>

      <div className="settings-actions">
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        <button className="btn-save" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      <div className="settings-delete-zone">
        {!confirmDelete ? (
          <button className="btn-delete" onClick={() => setConfirmDelete(true)}>Delete project</button>
        ) : (
          <div className="delete-dialog">
            <p className="delete-dialog-title">Delete <strong>{project.name}</strong>?</p>
            <p className="delete-dialog-body">This will permanently delete all internal project work and records:</p>
            <ul className="delete-dialog-list">
              <li>All tickets, comments, and sub-projects</li>
              <li>Planning files{config.scryer_root ? ` (${config.scryer_root}/${project.name}/)` : ''}</li>
            </ul>
            {project.code_path && (
              isCodeInternal ? (
                <label className="delete-dialog-code-check">
                  <input
                    type="checkbox"
                    checked={deleteCode}
                    onChange={e => setDeleteCode(e.target.checked)}
                  />
                  <span>Also delete code at <code>{project.code_path}</code></span>
                </label>
              ) : (
                <p className="delete-dialog-no-code">No code will be deleted — <code>{project.code_path}</code> is external.</p>
              )
            )}
            <div className="delete-dialog-actions">
              <button className="btn-cancel" onClick={() => { setConfirmDelete(false); setDeleteCode(false) }}>Cancel</button>
              <button className="btn-delete-confirm" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ProjectCard({ project: initialProject, onDelete }) {
  const [project, setProject]       = useState(initialProject)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <li className="project-card-wrap">
      <div
        className="project-card"
        onClick={() => !settingsOpen && navigate(`/projects/${project.name}`)}
      >
        <div className="project-card-body">
          <span className="project-name">{project.name}</span>
          {project.description && <span className="project-desc">{project.description}</span>}
        </div>
        <button
          className="settings-btn"
          title="Settings"
          onClick={(e) => { e.stopPropagation(); setSettingsOpen(o => !o) }}
        >⚙</button>
      </div>

      {settingsOpen && (
        <SettingsPanel
          project={project}
          onClose={() => setSettingsOpen(false)}
          onSave={(updated) => setProject(updated)}
          onDelete={onDelete}
        />
      )}
    </li>
  )
}

export default function ProjectSelector() {
  const navigate = useNavigate()
  const [projects, setProjects]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [creating, setCreating]   = useState(false)
  const [configOpen, setConfigOpen] = useState(false)

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects))
      .catch(() => setError('Could not load projects.'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="state-msg">Loading…</div>
  if (error)   return <div className="state-msg error">{error}</div>

  return (
    <div className="selector-page">
      <header className="selector-header">
        <h1>🔮 Scryer</h1>
        <div className="selector-header-actions">
          <button className="btn-new-project" onClick={() => navigate('/log')}>Log</button>
          <button className="btn-new-project" onClick={() => setCreating(true)}>+ New Project</button>
          <button className="settings-btn" title="Global config" onClick={() => setConfigOpen(o => !o)}>⚙</button>
        </div>
      </header>

      {configOpen && <GlobalConfigPanel onClose={() => setConfigOpen(false)} />}

      {creating && (
        <NewProjectForm
          onCancel={() => setCreating(false)}
          onCreate={(p, agent) => {
            setProjects(ps => [...ps, p])
            setCreating(false)
            navigate(`/projects/${p.name}?firstRun=1&agent=${agent}`)
          }}
        />
      )}

      {projects.length === 0 && !creating ? (
        <div className="state-msg">No projects yet.</div>
      ) : (
        <ul className="project-list">
          {projects.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              onDelete={() => setProjects(ps => ps.filter(x => x.id !== p.id))}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
