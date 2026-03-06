import { useEffect, useState } from 'react'

function entityParams(node) {
  if (node.type === 'root')       return { type: 'project',    id: node.entityId }
  if (node.type === 'subproject') return { type: 'subproject', id: node.entityId }
  return                                 { type: 'ticket',     id: node.ticketId }
}

export default function PlanEditor({ node, onClose }) {
  const [content, setContent] = useState('')
  const [path, setPath]       = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState(null)

  const { type, id } = entityParams(node)

  useEffect(() => {
    fetch(`/api/planning?type=${type}&id=${id}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setContent(data.content)
        setPath(data.path)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [type, id])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/planning?type=${type}&id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div className="plan-editor" onClick={e => e.stopPropagation()}>
        <div className="plan-editor-header">
          <div className="plan-editor-title">
            <span className="plan-editor-label">plan.md</span>
            {path && <span className="plan-editor-path">{path}</span>}
          </div>
          <div className="plan-editor-actions">
            <button className="btn-cancel" onClick={onClose}>Cancel</button>
            <button className="btn-save" onClick={handleSave} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="plan-editor-body plan-editor-loading">Loading…</div>
        ) : error ? (
          <div className="plan-editor-body plan-editor-error">{error}</div>
        ) : (
          <textarea
            className="plan-editor-body"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        )}
      </div>
    </div>
  )
}
