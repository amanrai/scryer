import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import MindMap from '../components/MindMap.jsx'
import MindMapV2 from '../components/MindMapV2.jsx'
import TerminalPanel from '../components/TerminalPanel.jsx'
import PlanningPanel from '../components/PlanningPanel.jsx'
import ArchitectDialog from '../components/ArchitectDialog.jsx'
import ProjectSettingsPanel from '../components/ProjectSettingsPanel.jsx'
import ReviewDialog from '../components/ReviewDialog.jsx'

const TYPE_META = {
  state_change: { color: 'var(--blue)',   icon: '⟳' },
  comment:      { color: 'var(--yellow)', icon: '✎' },
  commit:       { color: 'var(--green)',  icon: '⎇' },
}

function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return `${Math.floor(diff)}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function entryBody({ action, details, message }) {
  if (action === 'state_change') return `${details.from ?? '?'} → ${details.to ?? '?'}`
  if (action === 'comment') {
    const t = details.content || message
    return t.length > 90 ? t.slice(0, 90) + '…' : t
  }
  if (action === 'commit') {
    const h = (details.commit_hash || '').slice(0, 8)
    return h ? `${h}  ${details.message || message}` : (details.message || message)
  }
  return message
}

function ActivityDialog({ project, onClose }) {
  const [entries, setEntries]   = useState([])
  const [freshIds, setFreshIds] = useState(new Set())
  const [live, setLive]         = useState(false)
  const lastSeenRef             = useRef(null)
  const [, tick]                = useState(0)

  useEffect(() => {
    fetch(`/api/activity?project=${encodeURIComponent(project.name)}&limit=60`)
      .then(r => r.json())
      .then(d => {
        setEntries(d.entries || [])
        if (d.entries?.length) lastSeenRef.current = d.entries[0].created_at
      })
  }, [project.name])

  useEffect(() => {
    const poll = () => {
      const url = lastSeenRef.current
        ? `/api/activity?project=${encodeURIComponent(project.name)}&since=${encodeURIComponent(lastSeenRef.current)}&limit=30`
        : `/api/activity?project=${encodeURIComponent(project.name)}&limit=30`
      fetch(url).then(r => r.json()).then(d => {
        const fresh = d.entries || []
        if (!fresh.length) return
        lastSeenRef.current = fresh[0].created_at
        const ids = new Set(fresh.map(e => e.id))
        setFreshIds(ids)
        setLive(true)
        setEntries(prev => {
          const existing = new Set(prev.map(e => e.id))
          const newOnes = fresh.filter(e => !existing.has(e.id))
          return newOnes.length ? [...newOnes, ...prev] : prev
        })
        setTimeout(() => setFreshIds(new Set()), 2000)
      })
    }
    const id = setInterval(poll, 3000)
    return () => clearInterval(id)
  }, [project.name])

  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => setLive(false), 4000)
    return () => clearTimeout(t)
  }, [live, entries])

  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 30000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="float-dialog">
      <div className="float-dialog-header">
        <span>Work Log</span>
        <span className={`activity-live${live ? ' activity-live--on' : ''}`}>LIVE</span>
        <button className="float-dialog-close" onClick={onClose}>✕</button>
      </div>
      <div className="activity-list">
        {entries.length === 0 && <div className="activity-empty">No activity yet.</div>}
        {entries.map(e => {
          const meta = TYPE_META[e.action] || { color: 'var(--text-muted)', icon: '•' }
          return (
            <div key={e.id} className={`activity-entry${freshIds.has(e.id) ? ' activity-entry--fresh' : ''}`}>
              <span className="activity-icon" style={{ color: meta.color }}>{meta.icon}</span>
              <div className="activity-body">
                {e.ticket_title && (
                  <div className="activity-ticket">T{e.ticket_id} — {e.ticket_title}</div>
                )}
                <div className="activity-detail">{entryBody(e)}</div>
              </div>
              <span className="activity-time">{relTime(e.created_at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function ProjectView() {
  const { name }        = useParams()
  const navigate        = useNavigate()
  const [searchParams]  = useSearchParams()
  const [project, setProject] = useState(null)
  const [debates, setDebates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [filter, setFilter]           = useState('')
  const [mapVersion, setMapVersion]   = useState(() => localStorage.getItem(`mindMapVersion_${name}`) || 'v2')
  const [logOpen, setLogOpen]         = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reviewOpen, setReviewOpen]   = useState(false)
  const [launchError, setLaunchError]     = useState(null)
  const [launchBanner, setLaunchBanner]   = useState(null)
  // Minimized session persistence — keyed by project name
  function lsKey() { return `scryer_minimized_${name}` }
  function loadMinimized() {
    try { return JSON.parse(localStorage.getItem(lsKey())) || {} } catch { return {} }
  }
  function saveMinimized(patch) {
    try {
      const current = loadMinimized()
      localStorage.setItem(lsKey(), JSON.stringify({ ...current, ...patch }))
    } catch {}
  }
  function clearMinimized(keys) {
    try {
      const current = loadMinimized()
      keys.forEach(k => delete current[k])
      if (Object.keys(current).length) localStorage.setItem(lsKey(), JSON.stringify(current))
      else localStorage.removeItem(lsKey())
    } catch {}
  }

  const _saved = loadMinimized()
  const [planningSession, setPlanningSession]     = useState(_saved.planningSession || null)
  const [planningOpen, setPlanningOpen]           = useState(false)
  const [planningMinimized, setPlanningMinimized] = useState(!!_saved.planningSession)
  const [architectSession, setArchitectSession]   = useState(_saved.architectSession || null)
  const [architectOpen, setArchitectOpen]         = useState(false)
  const [architectMinimized, setArchitectMinimized] = useState(!!_saved.architectSession)
  const [minimizeOrder, setMinimizeOrder]         = useState(_saved.minimizeOrder || [])

  // Terminal panel state
  const [sessions, setSessions]   = useState([])
  const [activeId, setActiveId]   = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [dock, setDock]           = useState(() => localStorage.getItem('termDock') || 'bottom')
  const [size, setSize]           = useState(() => parseInt(localStorage.getItem('termSize') || '35'))
  const dragging                  = useRef(false)

  // Launch a new terminal session (or switch to existing tab for non-plan modes)
  async function handleLaunch(mode, agent, entity) {
    if (mode === 'plan') {
      const apiType = entity.type === 'root' ? 'project' : entity.type
      // Project type uses name as ID; subproject/ticket use numeric ID
      const entityId = entity.type === 'root' ? entity.label : (entity.ticketId ?? entity.entityId)
      const effectiveAgent = agent ?? project.planning_agent ?? 'claude'
      setLaunchBanner({ state: 'loading', msg: 'Setting up planning session…' })
      try {
        const res = await fetch('/api/planning/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_type: apiType, entity_id: entityId, agent: effectiveAgent }),
        })
        const data = await res.json()
        if (data.ok) {
          setLaunchBanner(null)
          const ps = { session: data.session, entityType: apiType, entityId, entity, agent, launchedAt: Date.now(), warmup: data.warmup_ms ?? 10000 }
          setPlanningSession(ps)
          setPlanningOpen(true)
          setPlanningMinimized(false)
          clearMinimized(['planningSession'])
        } else {
          setLaunchBanner({ state: 'error', msg: data.error || 'Launch failed' })
        }
      } catch (e) {
        setLaunchBanner({ state: 'error', msg: e.message })
      }
      return
    }

    if (mode === 'architect') {
      const apiType = entity.type === 'root' ? 'project' : entity.type
      const entityId = entity.type === 'root' ? entity.label : (entity.ticketId ?? entity.entityId)
      const effectiveAgent = agent ?? project.architect_agent ?? 'claude'
      await launchArchitect(apiType, entityId, entity, effectiveAgent)
      return
    }

    const id = `${agent}-${agent}-${entity.type}-${entity.ticketId ?? entity.entityId}`

    setSessions(prev => {
      if (prev.find(s => s.id === id)) return prev
      return [...prev, { id, mode, agent, entity }]
    })
    setActiveId(id)
    setPanelOpen(true)
  }

  async function launchArchitect(apiType, entityId, entity, effectiveAgent) {
    setLaunchBanner({ state: 'loading', msg: 'Setting up architect session…' })
    try {
      const res = await fetch('/api/architect/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: apiType, entity_id: entityId, agent: effectiveAgent }),
      })
      const data = await res.json()
      if (data.ok) {
        setLaunchBanner(null)
        setArchitectSession({ session: data.session, entityType: apiType, entityId, entity, agent: effectiveAgent, launchedAt: Date.now(), warmup: data.warmup_ms ?? 10000 })
        setArchitectOpen(true)
        setArchitectMinimized(false)
        clearMinimized(['architectSession'])
      } else {
        setLaunchBanner({ state: 'error', msg: data.error || 'Architect launch failed' })
      }
    } catch (e) {
      setLaunchBanner({ state: 'error', msg: e.message })
    }
  }

  function handlePlanningMinimize() {
    setPlanningOpen(false); setPlanningMinimized(true)
    setMinimizeOrder(o => { const n = [...o.filter(x => x !== 'planning'), 'planning']; saveMinimized({ planningSession, minimizeOrder: n }); return n })
  }
  function handlePlanningRestore() {
    setPlanningOpen(true); setPlanningMinimized(false)
    setMinimizeOrder(o => { const n = o.filter(x => x !== 'planning'); saveMinimized({ minimizeOrder: n }); clearMinimized(['planningSession']); return n })
  }
  function handlePlanningClose() {
    if (planningSession?.session) {
      fetch('/api/tmux/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: planningSession.session }),
      }).catch(() => {})
    }
    setPlanningOpen(false); setPlanningMinimized(false); setPlanningSession(null)
    setMinimizeOrder(o => { const n = o.filter(x => x !== 'planning'); clearMinimized(['planningSession', 'minimizeOrder']); saveMinimized({ minimizeOrder: n }); return n })
  }

  function handleArchitectMinimize() {
    setArchitectOpen(false); setArchitectMinimized(true)
    setMinimizeOrder(o => { const n = [...o.filter(x => x !== 'architect'), 'architect']; saveMinimized({ architectSession, minimizeOrder: n }); return n })
  }
  function handleArchitectRestore() {
    setArchitectOpen(true); setArchitectMinimized(false)
    setMinimizeOrder(o => { const n = o.filter(x => x !== 'architect'); saveMinimized({ minimizeOrder: n }); clearMinimized(['architectSession']); return n })
  }
  async function handleArchitectClose() {
    if (architectSession?.session) {
      fetch('/api/tmux/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: architectSession.session }),
      }).catch(() => {})
    }
    setArchitectOpen(false); setArchitectMinimized(false); setArchitectSession(null)
    setMinimizeOrder(o => { const n = o.filter(x => x !== 'architect'); clearMinimized(['architectSession', 'minimizeOrder']); saveMinimized({ minimizeOrder: n }); return n })
  }

  async function handleArchitectReopen() {
    if (!architectSession) return
    const { entityType, entityId, entity, agent } = architectSession
    await launchArchitect(entityType, entityId, entity, agent)
  }

  function handleCloseSession(id) {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (activeId === id) {
        setActiveId(next.length ? next[next.length - 1].id : null)
        if (!next.length) setPanelOpen(false)
      }
      return next
    })
  }

  function handleDockChange(newDock) {
    setDock(newDock)
    localStorage.setItem('termDock', newDock)
  }

  function handleSizeChange(newSize) {
    const clamped = Math.round(Math.min(50, Math.max(15, newSize)))
    setSize(clamped)
    localStorage.setItem('termSize', String(clamped))
  }

  function startResize(e) {
    e.preventDefault()
    dragging.current = true

    function onMove(e) {
      if (!dragging.current) return
      let s
      if (dock === 'bottom')     s = ((window.innerHeight - e.clientY) / window.innerHeight) * 100
      else if (dock === 'right') s = ((window.innerWidth  - e.clientX) / window.innerWidth)  * 100
      else                       s = (e.clientX / window.innerWidth) * 100
      handleSizeChange(s)
    }

    function onUp() {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Poll project data every 5 s
  useEffect(() => {
    function fetchProject() {
      fetch(`/api/projects/${name}`)
        .then(r => r.json())
        .then(data => {
          if (data.error) throw new Error(data.error)
          setProject(data.project)
        })
        .catch(() => setError('Could not load project.'))
        .finally(() => setLoading(false))
    }
    function fetchDebates() {
      fetch(`/api/projects/${name}/debates`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.debates) setDebates(d.debates) })
        .catch(() => {})
    }
    fetchProject()
    fetchDebates()
    const interval = setInterval(() => { fetchProject(); fetchDebates() }, 5000)
    return () => clearInterval(interval)
  }, [name])

  // Auto-action on first visit (from new project form)
  const [autoOpenEditor, setAutoOpenEditor] = useState(false)
  useEffect(() => {
    if (!project) return
    const firstRun = searchParams.get('firstRun')
    if (!firstRun) return
    const agent = searchParams.get('agent') || 'claude'
    const entity = { type: 'root', entityId: project.id, label: project.name }
    // Clear query params so a refresh doesn't re-trigger
    navigate(`/projects/${name}`, { replace: true })
    if (firstRun === '1' || firstRun === 'plan') {
      handleLaunch('plan', agent, entity)
    } else if (firstRun === 'editor') {
      setAutoOpenEditor(true)
    } else if (firstRun === 'architect') {
      handleLaunch('architect', agent, entity)
    }
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="state-msg">Loading…</div>
  if (error)   return <div className="state-msg error">{error}</div>

  const panelVisible = panelOpen && sessions.length > 0
  const isColumn     = dock === 'bottom'
  const panelStyle   = isColumn ? { height: `${size}%` } : { width: `${size}%` }
  const handleClass  = `term-resize-handle ${isColumn ? 'term-resize-handle--h' : 'term-resize-handle--v'}`

  const panel = panelVisible && (
    <>
      {dock !== 'left' && <div className={handleClass} onMouseDown={startResize} />}
      <div className="term-panel-wrap" style={panelStyle}>
        <TerminalPanel
          sessions={sessions}
          activeId={activeId}
          onActivate={setActiveId}
          onClose={handleCloseSession}
          dock={dock}
          onDockChange={handleDockChange}
          onCollapse={() => setPanelOpen(false)}
        />
      </div>
      {dock === 'left' && <div className={handleClass} onMouseDown={startResize} />}
    </>
  )

  return (
    <>
    <div className="project-view" style={{ flexDirection: isColumn ? 'column' : 'row' }}>
      {dock === 'left' && panel}

      <div className="project-view-main" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <header className="project-view-header">
          <button className="back-btn" onClick={() => navigate('/')}>←</button>
          <h1>{project.name}</h1>
          <div className="pv-filter-wrap">
            <input
              className="pv-filter-input"
              placeholder="Filter tasks…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filter && (
              <button className="pv-filter-clear" onClick={() => setFilter('')}>×</button>
            )}
          </div>
          <button className="pv-log-btn" onClick={() => setReviewOpen(o => !o)}>Review</button>
          <button className="pv-log-btn" onClick={() => setLogOpen(o => !o)}>
            {logOpen ? 'Log ▾' : 'Log ▸'}
          </button>
          {sessions.length > 0 && !panelOpen && (
            <button className="term-reopen-btn" onClick={() => setPanelOpen(true)}>
              ▲ {sessions.length} session{sessions.length !== 1 ? 's' : ''}
            </button>
          )}
        </header>
        {launchError && (
          <div className="launch-error-banner">
            {launchError}
            <button onClick={() => setLaunchError(null)}>×</button>
          </div>
        )}
        {launchBanner && (
          <div className={`launch-banner launch-banner--${launchBanner.state}`}>
            {launchBanner.state === 'loading' && <span>{launchBanner.msg}</span>}
            {launchBanner.state === 'error'   && <span>Planning launch failed: {launchBanner.msg}</span>}
            {launchBanner.state === 'ready'   && (
              <span>
                Planning session ready —{' '}
                <code>tmux attach -t {launchBanner.session}</code>
              </span>
            )}
            <button onClick={() => setLaunchBanner(null)}>×</button>
          </div>
        )}
        {mapVersion === 'v1'
          ? <MindMap project={project} onLaunch={handleLaunch} onSettings={() => setSettingsOpen(true)} filter={filter} />
          : <MindMapV2 project={project} onLaunch={handleLaunch} onSettings={() => setSettingsOpen(true)} filter={filter} autoOpenEditor={autoOpenEditor} onAutoOpenEditorDone={() => setAutoOpenEditor(false)} debates={debates} />
        }
        {logOpen && <ActivityDialog project={project} onClose={() => setLogOpen(false)} />}
        {reviewOpen && <ReviewDialog project={project} onClose={() => setReviewOpen(false)} />}
        {settingsOpen && (
          <div className="mm-modal-backdrop" onClick={() => setSettingsOpen(false)}>
            <div className="mm-modal mm-modal--settings" onClick={e => e.stopPropagation()}>
              <ProjectSettingsPanel
                project={project}
                onClose={() => setSettingsOpen(false)}
                onSave={(updated) => { setProject(prev => ({ ...prev, ...updated })); setSettingsOpen(false) }}
                onDelete={() => navigate('/')}
                mapVersion={mapVersion}
                onMapVersionChange={v => { setMapVersion(v); localStorage.setItem(`mindMapVersion_${name}`, v) }}
              />
            </div>
          </div>
        )}
      </div>

      {dock !== 'left' && panel}
    </div>

    {planningSession && planningOpen && (
      <PlanningPanel
        key={planningSession.session}
        session={planningSession.session}
        entityType={planningSession.entityType}
        entityId={planningSession.entityId}
        entity={planningSession.entity}
        agent={planningSession.agent}
        launchedAt={planningSession.launchedAt}
        warmup={planningSession.warmup}
        onMinimize={handlePlanningMinimize}
        onClose={handlePlanningClose}
      />
    )}
    {architectSession && architectOpen && (
      <ArchitectDialog
        key={architectSession.session}
        session={architectSession.session}
        entityType={architectSession.entityType}
        entityId={architectSession.entityId}
        entity={architectSession.entity}
        agent={architectSession.agent}
        launchedAt={architectSession.launchedAt}
        warmup={architectSession.warmup}
        projectName={project?.name}
        onMinimize={handleArchitectMinimize}
        onClose={handleArchitectClose}
      />
    )}

    {/* Minimized session bar */}
    {minimizeOrder.length > 0 && (
      <div className="minimized-bar">
        {minimizeOrder.map(key => {
          if (key === 'planning' && planningMinimized && planningSession) {
            const lbl = planningSession.entity?.ticketId
              ? `T${planningSession.entity.ticketId} — ${planningSession.entity.label}`
              : planningSession.entity?.label
            return (
              <div key="planning" className="minimized-chip">
                <span className="minimized-chip-type">Plan</span>
                <span className="minimized-chip-label">{lbl}</span>
                <button className="minimized-chip-restore" onClick={handlePlanningRestore} title="Restore">▲</button>
                <button className="minimized-chip-close"   onClick={handlePlanningClose}   title="Close">✕</button>
              </div>
            )
          }
          if (key === 'architect' && architectMinimized && architectSession) {
            const lbl = architectSession.entity?.ticketId
              ? `T${architectSession.entity.ticketId} — ${architectSession.entity.label}`
              : architectSession.entity?.label
            return (
              <div key="architect" className="minimized-chip">
                <span className="minimized-chip-type">Architect</span>
                <span className="minimized-chip-label">{lbl}</span>
                <button className="minimized-chip-restore" onClick={handleArchitectRestore} title="Restore">▲</button>
                <button className="minimized-chip-close"   onClick={handleArchitectClose}   title="Close">✕</button>
              </div>
            )
          }
          return null
        })}
      </div>
    )}
    </>
  )
}
