import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const TYPE_META = {
  state_change: { color: 'var(--blue)',   icon: '⟳', label: 'State' },
  comment:      { color: 'var(--yellow)', icon: '✎', label: 'Comment' },
  commit:       { color: 'var(--green)',  icon: '⎇', label: 'Commit' },
}

function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)   return `${Math.floor(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function entryBody(entry) {
  const { action, details, message } = entry
  if (action === 'state_change') {
    return `${details.from || '?'} → ${details.to || '?'}`
  }
  if (action === 'comment') {
    const text = details.content || message
    return text.length > 100 ? text.slice(0, 100) + '…' : text
  }
  if (action === 'commit') {
    const hash = (details.commit_hash || '').slice(0, 8)
    const msg  = details.message || message
    return hash ? `${hash}  ${msg}` : msg
  }
  return message
}

function LogEntry({ entry, fresh }) {
  const navigate  = useNavigate()
  const meta      = TYPE_META[entry.action] || { color: 'var(--text-muted)', icon: '•', label: entry.action }

  return (
    <div className={`wl-entry${fresh ? ' wl-entry--fresh' : ''}`}>
      <span className="wl-icon" style={{ color: meta.color }}>{meta.icon}</span>
      <div className="wl-body">
        <div className="wl-header">
          <span className="wl-type" style={{ color: meta.color }}>{meta.label}</span>
          {entry.ticket_title && (
            <button
              className="wl-ticket-link"
              onClick={() => entry.project_name && navigate(`/projects/${entry.project_name}`)}
              title={entry.project_name ? `Open ${entry.project_name}` : undefined}
            >
              T{entry.ticket_id} — {entry.ticket_title}
            </button>
          )}
          <span className="wl-time" title={entry.created_at}>{relTime(entry.created_at)}</span>
        </div>
        <div className="wl-detail">{entryBody(entry)}</div>
      </div>
    </div>
  )
}

export default function WorkLog() {
  const [entries, setEntries]     = useState([])
  const [freshIds, setFreshIds]   = useState(new Set())
  const [live, setLive]           = useState(false)
  const lastSeenRef               = useRef(null)
  const navigate                  = useNavigate()

  // Initial load
  useEffect(() => {
    fetch('/api/activity?limit=100')
      .then(r => r.json())
      .then(data => {
        setEntries(data.entries || [])
        if (data.entries?.length) lastSeenRef.current = data.entries[0].created_at
      })
  }, [])

  // Polling for new entries
  useEffect(() => {
    const tick = () => {
      const url = lastSeenRef.current
        ? `/api/activity?since=${encodeURIComponent(lastSeenRef.current)}&limit=50`
        : '/api/activity?limit=50'
      fetch(url)
        .then(r => r.json())
        .then(data => {
          const fresh = data.entries || []
          if (!fresh.length) return
          lastSeenRef.current = fresh[0].created_at
          const ids = new Set(fresh.map(e => e.id))
          setFreshIds(ids)
          setEntries(prev => {
            const existingIds = new Set(prev.map(e => e.id))
            const newOnes = fresh.filter(e => !existingIds.has(e.id))
            return newOnes.length ? [...newOnes, ...prev] : prev
          })
          setLive(true)
          setTimeout(() => setFreshIds(new Set()), 2000)
        })
    }
    const id = setInterval(tick, 3000)
    return () => clearInterval(id)
  }, [])

  // Fade the "live" badge after 4s of no activity
  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => setLive(false), 4000)
    return () => clearTimeout(t)
  }, [live, entries])

  // Relative timestamps tick every 30s
  const [, forceRender] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceRender(n => n + 1), 30000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="wl-page">
      <header className="wl-header-bar">
        <button className="back-btn" onClick={() => navigate('/')}>←</button>
        <h1>Work Log</h1>
        <span className={`wl-live-badge${live ? ' wl-live-badge--on' : ''}`}>LIVE</span>
      </header>

      {entries.length === 0 ? (
        <div className="state-msg">No activity yet.</div>
      ) : (
        <div className="wl-list">
          {entries.map(e => (
            <LogEntry key={e.id} entry={e} fresh={freshIds.has(e.id)} />
          ))}
        </div>
      )}
    </div>
  )
}
