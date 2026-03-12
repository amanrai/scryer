import { useState, useEffect } from 'react'

export default function PersonaLibraryPanel({ onClose }) {
  const [personas, setPersonas]         = useState([])
  const [selected, setSelected]         = useState(null)   // persona object being edited
  const [editing, setEditing]           = useState(false)
  const [draft, setDraft]               = useState({ name: '', description: '', template_content: '' })
  const [creating, setCreating]         = useState(false)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState(null)

  async function load() {
    const r = await fetch('/api/personas')
    const d = await r.json()
    setPersonas(d.personas ?? [])
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { if (editing || creating) cancelEdit(); else onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, creating, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(persona) {
    setSelected(persona)
    setDraft({ name: persona.name, description: persona.description, template_content: persona.template_content })
    setEditing(true)
    setCreating(false)
    setError(null)
  }

  function startCreate() {
    setSelected(null)
    setDraft({ name: '', description: '', template_content: '' })
    setCreating(true)
    setEditing(false)
    setError(null)
  }

  function cancelEdit() {
    setEditing(false)
    setCreating(false)
    setSelected(null)
    setError(null)
  }

  async function save() {
    if (!draft.name.trim()) { setError('Name is required.'); return }
    setSaving(true)
    setError(null)
    try {
      if (creating) {
        const res = await fetch('/api/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error)
      } else {
        const res = await fetch(`/api/personas/${selected.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error)
      }
      await load()
      cancelEdit()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function deletePersona(persona) {
    if (!confirm(`Delete persona "${persona.name}"? This cannot be undone.`)) return
    await fetch(`/api/personas/${persona.id}`, { method: 'DELETE' })
    if (selected?.id === persona.id) cancelEdit()
    await load()
  }

  async function resetToDefault(persona) {
    if (!confirm(`Reset "${persona.name}" to factory template? Your edits will be lost.`)) return
    const res = await fetch(`/api/personas/${persona.id}/reset`, { method: 'POST' })
    if (res.ok) {
      await load()
      if (selected?.id === persona.id) {
        const updated = await fetch(`/api/personas/${persona.id}`).then(r => r.json())
        setDraft(prev => ({ ...prev, template_content: updated.persona?.template_content ?? prev.template_content }))
      }
    }
  }

  const showForm = editing || creating

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div className="persona-library-dialog" onClick={e => e.stopPropagation()}>
        <div className="persona-library-header">
          <h2 className="persona-library-title">Persona Library</h2>
          <button className="mm-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="persona-library-body">
          {/* Left: persona list */}
          <div className="persona-library-list">
            <button className="persona-new-btn" onClick={startCreate}>+ New Persona</button>
            {personas.map(p => (
              <div
                key={p.id}
                className={`persona-list-item ${selected?.id === p.id ? 'active' : ''}`}
                onClick={() => startEdit(p)}
              >
                <span className="persona-list-name">{p.name}</span>
                <span className="persona-list-scope">{p.is_global ? 'global' : 'project'}</span>
              </div>
            ))}
            {personas.length === 0 && (
              <p className="mm-modal-desc mm-modal-empty" style={{ padding: '12px 8px' }}>No personas yet.</p>
            )}
          </div>

          {/* Right: editor */}
          <div className="persona-library-editor">
            {!showForm && (
              <div className="persona-editor-empty">
                <p>Select a persona to edit, or create a new one.</p>
              </div>
            )}

            {showForm && (
              <>
                <div className="persona-editor-fields">
                  <label className="persona-field-label">Name</label>
                  <input
                    className="persona-field-input"
                    value={draft.name}
                    onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g. Security Auditor"
                  />
                  <label className="persona-field-label">Description</label>
                  <input
                    className="persona-field-input"
                    value={draft.description}
                    onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="One-line summary of this persona's lens"
                  />
                  <label className="persona-field-label">
                    Template
                    <span className="persona-field-hint">Supports Markdown. This is the system prompt injected at session start.</span>
                  </label>
                  <textarea
                    className="persona-field-textarea"
                    value={draft.template_content}
                    onChange={e => setDraft(prev => ({ ...prev, template_content: e.target.value }))}
                    placeholder="# Persona Name&#10;&#10;You are a ... participating in an Agent Council review.&#10;&#10;## Your lens&#10;..."
                    spellCheck={false}
                  />
                </div>

                {error && <p className="council-launch-error">{error}</p>}

                <div className="persona-editor-actions">
                  {!creating && selected && (
                    <>
                      <button className="btn-cancel" onClick={() => resetToDefault(selected)} title="Revert to factory template">
                        Reset to default
                      </button>
                      <button className="persona-delete-btn" onClick={() => deletePersona(selected)}>
                        Delete
                      </button>
                    </>
                  )}
                  <button className="btn-cancel" onClick={cancelEdit}>Cancel</button>
                  <button className="btn-save" onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : creating ? 'Create' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
