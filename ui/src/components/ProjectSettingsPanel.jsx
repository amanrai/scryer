import { useEffect, useState } from 'react'

const GIT_BACKENDS = ['', 'forgejo', 'github', 'gitlab']
const GIT_LABELS   = { '': '— none —', forgejo: 'Internal Forgejo', github: 'GitHub', gitlab: 'GitLab' }

function expandHome(p, home) {
  if (!p) return p
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p === '~') return home
  return p
}

export default function ProjectSettingsPanel({ project, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({
    name:         project.name,
    description:  project.description || '',
    code_path:    project.code_path || '',
    git_backend:  project.git_backend || '',
    git_repo_url: project.git_repo_url || '',
  })
  const [config, setConfig]               = useState({ scryer_root: '', code_root: '', home: '' })
  const [saving, setSaving]               = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteCode, setDeleteCode]       = useState(false)
  const [deleting, setDeleting]           = useState(false)
  const [detecting, setDetecting]         = useState(false)
  const [detectError, setDetectError]     = useState(null)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => setConfig({ scryer_root: d.scryer_root || '', code_root: d.code_root || '', home: d.home || '' }))
      .catch(() => {})
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleDetect = async () => {
    if (!form.code_path.trim()) return
    setDetecting(true)
    setDetectError(null)
    try {
      const res = await fetch(`/api/detect-git-remote?path=${encodeURIComponent(form.code_path.trim())}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Detection failed')
      setForm(f => ({ ...f, git_repo_url: data.url }))
    } catch (e) {
      setDetectError(e.message)
    } finally {
      setDetecting(false)
    }
  }

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
      <label>Git repo URL
        <div className="settings-detect-row">
          <input value={form.git_repo_url} onChange={set('git_repo_url')} placeholder="https://..." />
          <button
            type="button"
            className="btn-detect"
            onClick={handleDetect}
            disabled={detecting || !form.code_path.trim()}
            title={form.code_path.trim() ? 'Detect remote URL from code path' : 'Set a code path first'}
          >{detecting ? '…' : 'Detect'}</button>
        </div>
        {detectError && <span className="settings-detect-error">{detectError}</span>}
      </label>

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
