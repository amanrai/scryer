import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ProjectSettingsPanel from '../components/ProjectSettingsPanel.jsx'
import AgentPermissionsPanel from '../components/AgentPermissionsPanel.jsx'
import PersonaLibraryPanel from '../components/PersonaLibraryPanel.jsx'
import { useTheme } from '../App.jsx'

const GIT_BACKENDS = ['', 'forgejo', 'github', 'gitlab']
const ORACLE_PROVIDERS = ['claude', 'gemini', 'codex']
const ORACLE_MODELS = {
  claude: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'],
  gemini: ['gemini-2.0-flash', 'gemini-2.0-pro'],
  codex: ['o4-mini', 'gpt-4o'],
}
const GIT_LABELS   = { '': '— none —', forgejo: 'Internal Forgejo', github: 'GitHub', gitlab: 'GitLab' }
const AGENTS       = ['claude', 'codex', 'gemini']

function GlobalConfigPanel({ onClose }) {
  const [form, setForm]   = useState({ scryer_root: '', code_root: '', discord_token: '', discord_server_id: '', oracle_provider: 'claude', oracle_model: 'claude-haiku-4-5-20251001' })
  const [loading, setLoading]           = useState(true)
  const [saving, setSaving]             = useState(false)
  const [agentPermsOpen, setAgentPermsOpen]   = useState(false)
  const [personaLibOpen, setPersonaLibOpen]   = useState(false)
  const { theme, setTheme }             = useTheme()

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => {
        setForm({
          scryer_root: d.scryer_root || '',
          code_root: d.code_root || '',
          discord_token: d.discord_token || '',
          discord_server_id: d.discord_server_id || '',
          oracle_provider: d.oracle_provider || 'claude',
          oracle_model: d.oracle_model || 'claude-haiku-4-5-20251001',
        })
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, theme }),
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
          <label>Theme
            <select value={theme} onChange={e => setTheme(e.target.value)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>Discord bot token
            <input
              type="password"
              value={form.discord_token}
              onChange={e => setForm(f => ({ ...f, discord_token: e.target.value }))}
              placeholder="Bot token from Discord developer portal"
            />
          </label>
          <label>Discord server ID
            <input
              value={form.discord_server_id}
              onChange={e => setForm(f => ({ ...f, discord_server_id: e.target.value }))}
              placeholder="Right-click server → Copy Server ID"
            />
          </label>
          <label>Oracle provider
            <select value={form.oracle_provider} onChange={e => setForm(f => ({ ...f, oracle_provider: e.target.value, oracle_model: ORACLE_MODELS[e.target.value]?.[0] || '' }))}>
              {ORACLE_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>Oracle model
            <select value={form.oracle_model} onChange={e => setForm(f => ({ ...f, oracle_model: e.target.value }))}>
              {(ORACLE_MODELS[form.oracle_provider] || []).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <div className="settings-actions">
            <button className="btn-cancel" onClick={onClose}>Cancel</button>
            <button className="btn-save" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
          <button className="btn-agent-perms" onClick={() => setAgentPermsOpen(true)}>
            Configure Default Allowed Actions For Agents
          </button>
          <button className="btn-agent-perms" onClick={() => setPersonaLibOpen(true)}>
            Manage Council Personas
          </button>
        </>
      )}
      {agentPermsOpen && <AgentPermissionsPanel onClose={() => setAgentPermsOpen(false)} />}
      {personaLibOpen && <PersonaLibraryPanel onClose={() => setPersonaLibOpen(false)} />}
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
  const [agent, setAgent]           = useState('claude')
  const [architectAgent, setArchitectAgent] = useState('claude')
  const [attachOpen, setAttachOpen] = useState(false)
  const [codePathOverride, setCodePathOverride] = useState(null)
  const [onCreation, setOnCreation] = useState('nothing')
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
  const planningFolder     = codePath ? `${codePath}/.scryer/` : ''

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
          planning_agent: agent,
          architect_agent: architectAgent,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')

      onCreate(data.project, agent, onCreation)
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

      <label>Base path
        <input
          value={codePathOverride ?? derivedCodePath}
          onChange={e => setCodePathOverride(e.target.value || null)}
          placeholder={codeRootMissing ? 'Set a default code root in ⚙ Global Config first' : derivedCodePath || '~/Code/my-project'}
        />
      </label>

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

      <div className="npf-field-label">Architect agent</div>
      <div className="npf-agent-seg">
        {AGENTS.map(a => (
          <button key={a} type="button" className={`npf-agent-btn${architectAgent === a ? ' active' : ''}`} onClick={() => setArchitectAgent(a)}>
            {a}
          </button>
        ))}
      </div>

      <button type="button" className="npf-attach-toggle" onClick={() => setAttachOpen(o => !o)}>
        {attachOpen ? '▾' : '▸'} Attach to existing codebase
      </button>
      {attachOpen && <AttachPanel onAttach={handleAttach} />}

      <label>On project creation
        <select value={onCreation} onChange={e => setOnCreation(e.target.value)}>
          <option value="plan">Launch the planning agent</option>
          <option value="editor">Launch the plan editor</option>
          <option value="architect">Analyse existing code</option>
          <option value="nothing">Do nothing</option>
        </select>
      </label>

      {err && <span className="new-project-err">{err}</span>}

      <div className="new-project-actions">
        <button type="submit" className="btn-save" disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
      </div>

      <p className="npf-footer-note">These settings can be changed at any time from the project card.</p>
    </form>
  )
}

// ——— Existing project card + settings ———

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
        <ProjectSettingsPanel
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
          onCreate={(p, agent, onCreation) => {
            setProjects(ps => [...ps, p])
            setCreating(false)
            navigate(onCreation !== 'nothing'
              ? `/projects/${p.name}?firstRun=${onCreation}&agent=${agent}`
              : `/projects/${p.name}`)
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
