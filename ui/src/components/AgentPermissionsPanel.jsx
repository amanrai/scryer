import { useEffect, useState } from 'react'

const AGENT_ICONS = {
  claude: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      {/* Anthropic mark — simplified */}
      <path d="M13.66 3h-3.32L3 21h3.16l1.58-4.16h8.52L17.84 21H21L13.66 3zm-5.9 11.13L12 5.7l4.24 8.43H7.76z"/>
    </svg>
  ),
  codex: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      {/* OpenAI mark — simplified hexagonal swirl */}
      <path d="M20.49 9.27a5.26 5.26 0 0 0-.46-4.32 5.31 5.31 0 0 0-5.7-2.54 5.27 5.27 0 0 0-3.97-1.77A5.31 5.31 0 0 0 5.3 4.12a5.26 5.26 0 0 0-3.51 2.55 5.31 5.31 0 0 0 .65 6.22 5.26 5.26 0 0 0 .45 4.32 5.31 5.31 0 0 0 5.71 2.55 5.27 5.27 0 0 0 3.97 1.76 5.31 5.31 0 0 0 5.06-3.68 5.26 5.26 0 0 0 3.51-2.54 5.31 5.31 0 0 0-.65-6.03zm-7.92 11.07a3.93 3.93 0 0 1-2.52-.91l.12-.07 4.19-2.42a.69.69 0 0 0 .35-.6V9.77l1.77 1.02a.06.06 0 0 1 .03.05v4.89a3.95 3.95 0 0 1-3.94 3.61zm-8.47-3.62a3.93 3.93 0 0 1-.47-2.64l.12.07 4.19 2.42a.68.68 0 0 0 .69 0l5.12-2.96v2.05a.07.07 0 0 1-.03.05l-4.24 2.45a3.95 3.95 0 0 1-5.38-1.44zM3.2 8.37a3.93 3.93 0 0 1 2.07-1.73v4.99a.68.68 0 0 0 .34.59l5.1 2.95-1.77 1.02a.07.07 0 0 1-.06 0L4.64 13.8A3.95 3.95 0 0 1 3.2 8.37zm14.52 3.39-5.12-2.96 1.77-1.02a.07.07 0 0 1 .06 0l4.24 2.45a3.95 3.95 0 0 1-.6 7.11v-4.99a.68.68 0 0 0-.35-.59zm1.76-2.66-.12-.07-4.19-2.42a.68.68 0 0 0-.69 0L9.36 9.57V7.52a.07.07 0 0 1 .03-.05l4.24-2.44a3.95 3.95 0 0 1 5.85 4.09zM8.45 12.86l-1.77-1.02a.06.06 0 0 1-.03-.05V6.89a3.95 3.95 0 0 1 6.48-3.03l-.12.07-4.19 2.42a.69.69 0 0 0-.35.6l-.02 5.91zm.96-2.08 2.28-1.32 2.28 1.31v2.63l-2.28 1.32-2.28-1.32V10.78z"/>
    </svg>
  ),
  gemini: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      {/* Gemini — 4-pointed star */}
      <path d="M12 2C12 7.52 16.48 12 22 12 16.48 12 12 16.48 12 22 12 16.48 7.52 12 2 12 7.52 12 12 7.52 12 2Z"/>
    </svg>
  ),
}

const AGENTS = ['claude', 'codex', 'gemini']

export default function AgentPermissionsPanel({ onClose }) {
  const [sections, setSections]       = useState([])
  const [permissions, setPermissions] = useState({})
  const [activeAgent, setActiveAgent] = useState('claude')
  const [loading, setLoading]         = useState(true)
  const [resetting, setResetting]     = useState(false)

  useEffect(() => {
    fetch('/api/agent-permissions')
      .then(r => r.json())
      .then(d => {
        setSections(d.sections || [])
        setPermissions(d.permissions || {})
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = async (itemId, currentState) => {
    const newState = currentState === 'allow' ? 'deny' : 'allow'
    // Optimistic update
    setPermissions(prev => ({
      ...prev,
      [activeAgent]: { ...prev[activeAgent], [itemId]: newState },
    }))
    await fetch('/api/agent-permissions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: activeAgent, item_id: itemId, state: newState }),
    })
  }

  const handleReset = async () => {
    if (!confirm('Reset all agent permissions to factory defaults?')) return
    setResetting(true)
    try {
      await fetch('/api/agent-permissions/reset', { method: 'POST' })
      const d = await fetch('/api/agent-permissions').then(r => r.json())
      setSections(d.sections || [])
      setPermissions(d.permissions || {})
    } finally {
      setResetting(false)
    }
  }

  const agentPerms = permissions[activeAgent] || {}

  return (
    <div className="agent-perms-overlay">
      <div className="agent-perms-dialog">
        <div className="settings-header">
          <span>Agent Permissions</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

      <div className="agent-perms-tabs">
        {AGENTS.map(a => (
          <button
            key={a}
            className={`agent-perms-tab${activeAgent === a ? ' active' : ''}`}
            onClick={() => setActiveAgent(a)}
          >
            <span className="agent-perms-tab-icon">{AGENT_ICONS[a]}</span>
            {a}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="agent-perms-loading">Loading…</div>
      ) : (
        <div className="agent-perms-body">
          {sections.map(section => (
            <div key={section.id} className="agent-perms-section">
              <div className="agent-perms-section-title">{section.label}</div>
              {section.items.map(item => {
                const state = agentPerms[item.id] ?? item.default
                return (
                  <div key={item.id} className="agent-perms-item">
                    <span className="agent-perms-label">{item.label}</span>
                    <button
                      className={`agent-perms-toggle ${state}`}
                      onClick={() => toggle(item.id, state)}
                    >
                      {state === 'allow' ? 'Allow' : 'Deny'}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      <div className="settings-actions">
        <button className="btn-cancel" onClick={handleReset} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset to defaults'}
        </button>
        <button className="btn-save" onClick={onClose}>Done</button>
      </div>
      </div>
    </div>
  )
}
