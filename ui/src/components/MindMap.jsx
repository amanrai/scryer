import { useMemo, useState, useRef, useEffect } from 'react'
import PlanEditor from './PlanEditor.jsx'

const AGENTS = ['claude', 'codex', 'gemini']

// Minimal hover toolbar for project and sub-project nodes — Plan + Edit plan only.
function NodeToolbar({ node, onLaunch, onEdit, onSettings, onEnter, onLeave }) {
  return (
    <div className="mm-entity-toolbar" onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={e => e.stopPropagation()}>
      <button className="mm-tb-btn" data-tip="Plan" onClick={e => { e.stopPropagation(); onLaunch('plan', 'claude', node) }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      </button>
      <button className="mm-tb-btn" data-tip="Edit plan" onClick={e => { e.stopPropagation(); onEdit(node) }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      {node.type === 'root' && onSettings && (
        <button className="mm-tb-btn" data-tip="Settings" onClick={e => { e.stopPropagation(); onSettings(node) }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      )}
    </div>
  )
}

// Toolbar rendered inside the task info modal (top, above title).
// Also used for sub-project and root nodes if they ever get modals.
function EntityToolbar({ node, onLaunch, onEdit }) {
  const [openDrop, setOpenDrop] = useState(null)

  const toggleDrop = (name, e) => {
    e.stopPropagation()
    setOpenDrop(d => d === name ? null : name)
  }

  const launch = (mode, agent, e) => {
    e.stopPropagation()
    setOpenDrop(null)
    onLaunch(mode, agent, node)
  }

  return (
    <div className="mm-entity-toolbar-modal" onClick={e => e.stopPropagation()}>
      {/* Plan */}
      <div className="mm-tb-group">
        <button className="mm-tb-btn" data-tip="Plan" onClick={e => toggleDrop('plan', e)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </button>
        {openDrop === 'plan' && (
          <div className="mm-tb-dropdown">
            {AGENTS.map(a => <button key={a} onClick={e => launch('plan', a, e)}>{a}</button>)}
          </div>
        )}
      </div>

      {/* Edit plan */}
      <button className="mm-tb-btn" data-tip="Edit plan" onClick={e => { e.stopPropagation(); onEdit(node) }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>

      {/* Build Interactively */}
      <div className="mm-tb-group">
        <button className="mm-tb-btn" data-tip="Build interactively" onClick={e => toggleDrop('build', e)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        </button>
        {openDrop === 'build' && (
          <div className="mm-tb-dropdown">
            {AGENTS.map(a => <button key={a} onClick={e => launch('build-interactive', a, e)}>{a}</button>)}
          </div>
        )}
      </div>

      {/* Auto-build */}
      <div className="mm-tb-group">
        <button className="mm-tb-btn" data-tip="Auto-build" onClick={e => toggleDrop('auto', e)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </button>
        {openDrop === 'auto' && (
          <div className="mm-tb-dropdown">
            {AGENTS.map(a => <button key={a} onClick={e => launch('auto', a, e)}>{a}</button>)}
          </div>
        )}
      </div>

      {/* Watch — attach to an existing auto/build session for this entity */}
      <div className="mm-tb-group">
        <button className="mm-tb-btn" data-tip="Watch" onClick={e => toggleDrop('watch', e)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        {openDrop === 'watch' && (
          <div className="mm-tb-dropdown">
            {AGENTS.map(a => <button key={a} onClick={e => launch('watch', a, e)}>{a}</button>)}
          </div>
        )}
      </div>
    </div>
  )
}

const MIN_SCALE = 0.4
const MAX_SCALE = 2.5
const STEP      = 0.15

const STATE_COLOR = {
  'Closed':         '#4a5060',
  'In Review':      '#61afef',
  'In Progress':    '#e5c07b',
  'Unopened':       '#abb2bf',
  'Needs Input':    '#c678dd',
  'Agent Finished': '#c678dd',
  'Needs Tests':    '#e5c07b',
}

const LEGEND = [
  { label: 'Unopened',    color: '#abb2bf' },
  { label: 'In Progress', color: '#e5c07b' },
  { label: 'In Review',   color: '#61afef' },
  { label: 'Needs Input', color: '#c678dd' },
  { label: 'Closed',      color: '#4a5060' },
]

const X_ROOT     = 90
const X_SP       = 285
const X_TK       = 490
const COL_W      = 230   // x step per dependency depth level
const TICKET_W   = 200   // fixed ticket width
const TICKET_GAP = 12    // vertical gap between tickets
const GROUP_GAP  = 28    // vertical gap between groups
const PAD_V      = 28
const PAD_H      = 20

const SIZES = {
  root:       { w: 155, h: 38 },
  subproject: { w: 165, h: 30 },
}

// Estimate ticket node height from title length
const CHARS_PER_LINE = Math.floor((TICKET_W - 20) / 7)
const LINE_H         = 17   // px per line
const TICKET_PAD_V   = 26   // top+bottom padding + task ID block height

function ticketHeight(label) {
  const lines = Math.ceil(label.length / CHARS_PER_LINE)
  return Math.max(30, lines * LINE_H + TICKET_PAD_V)
}

function bezier(src, dst) {
  const x1 = src.cx + src.w / 2
  const y1 = src.cy
  const x2 = dst.cx - dst.w / 2
  const y2 = dst.cy
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
}

// BFS backward from open tickets: a ticket is visible if it's open
// or transitively blocks (leads to) any open ticket.
function computeVisibleTicketIds(allTickets) {
  const ticketById = Object.fromEntries(allTickets.map(t => [t.id, t]))
  const visible = new Set()
  const queue = []
  for (const t of allTickets) {
    if (t.state !== 'Closed') {
      visible.add(t.id)
      queue.push(t.id)
    }
  }
  while (queue.length) {
    const id = queue.shift()
    const t = ticketById[id]
    if (!t) continue
    for (const b of (t.blocked_by ?? [])) {
      if (!visible.has(b.id) && ticketById[b.id]) {
        visible.add(b.id)
        queue.push(b.id)
      }
    }
  }
  return visible
}

// BFS topological depth — only counts open (non-Closed) local blockers
function computeDepths(allTickets) {
  const ids = new Set(allTickets.map(t => t.id))
  const inDeg = {}
  const blocks = {}  // blocker_id → ids it blocks

  for (const t of allTickets) {
    const localBlockers = (t.blocked_by ?? [])
      .filter(b => ids.has(b.id) && b.state !== 'Closed')
      .map(b => b.id)
    inDeg[t.id] = localBlockers.length
    for (const bid of localBlockers) {
      if (!blocks[bid]) blocks[bid] = []
      blocks[bid].push(t.id)
    }
  }

  const depths = Object.fromEntries(allTickets.map(t => [t.id, 0]))
  const queue = allTickets.filter(t => inDeg[t.id] === 0).map(t => t.id)

  while (queue.length) {
    const id = queue.shift()
    for (const depId of (blocks[id] ?? [])) {
      depths[depId] = Math.max(depths[depId], depths[id] + 1)
      if (--inDeg[depId] === 0) queue.push(depId)
    }
  }

  return depths
}

function buildLayout(project, collapsedSps = new Set(), showClosedPaths = false) {
  const rawTickets = []
  for (const sp of project.sub_projects) {
    for (const t of (sp.tickets || [])) rawTickets.push(t)
  }
  for (const t of (project.tickets || [])) rawTickets.push(t)

  const visibleIds = showClosedPaths ? null : computeVisibleTicketIds(rawTickets)
  const allTickets = visibleIds ? rawTickets.filter(t => visibleIds.has(t.id)) : rawTickets

  const depths = computeDepths(allTickets)
  const maxDepth = allTickets.length
    ? Math.max(...allTickets.map(t => depths[t.id] ?? 0))
    : 0

  const nodeMap = {}
  const edgePaths = []
  const nodeList = []
  const ticketSpMap = {} // ticketId → spNodeId — for rerouting edges through collapsed sp nodes

  const groups = []
  for (const sp of project.sub_projects) {
    const spRaw = sp.tickets || []
    const allSpTickets = spRaw.filter(t => !visibleIds || visibleIds.has(t.id))
    const openCount = spRaw.filter(t => t.state !== 'Closed').length
    const totalCount = spRaw.length
    const collapsed = collapsedSps.has(sp.id)
    const sorted = collapsed
      ? []
      : [...allSpTickets].sort((a, b) => (depths[a.id] ?? 0) - (depths[b.id] ?? 0))
    groups.push({ type: 'sp', sp, tickets: sorted, parentId: `sp-${sp.id}`, collapsed, ticketCount: allSpTickets.length, openCount, totalCount })
  }
  if (project.tickets?.length) {
    const filtered = visibleIds
      ? project.tickets.filter(t => visibleIds.has(t.id))
      : project.tickets
    const sorted = [...filtered].sort((a, b) => (depths[a.id] ?? 0) - (depths[b.id] ?? 0))
    groups.push({ type: 'direct', tickets: sorted, parentId: 'root' })
  }

  const r = SIZES.root
  if (!groups.length) {
    const root = { id: 'root', cx: X_ROOT, cy: PAD_V + r.h / 2, ...r, label: project.name, type: 'root', entityId: project.id }
    nodeMap.root = root
    nodeList.push(root)
    return { nodeList, edgePaths, totalH: PAD_V * 2 + r.h, totalW: X_ROOT + r.w / 2 + PAD_H, nodeMap }
  }

  // Assign vertical ranges per group — heights are adaptive per ticket
  let y = PAD_V
  const positioned = []
  for (const g of groups) {
    let groupH
    if (g.tickets.length === 0) {
      groupH = SIZES.subproject.h
    } else {
      groupH = g.tickets.reduce((sum, t, i) =>
        sum + ticketHeight(t.title) + (i < g.tickets.length - 1 ? TICKET_GAP : 0), 0)
    }
    positioned.push({ ...g, startY: y, groupH })
    y += groupH + GROUP_GAP
  }
  const totalH = y - GROUP_GAP + PAD_V
  const totalW = X_TK + maxDepth * COL_W + TICKET_W / 2 + PAD_H

  // Root node
  const rootNode = { id: 'root', cx: X_ROOT, cy: totalH / 2, ...r, label: project.name, type: 'root', entityId: project.id }
  nodeMap.root = rootNode
  nodeList.push(rootNode)

  // First pass: place all nodes
  for (const g of positioned) {
    if (g.type === 'sp') {
      const s = SIZES.subproject
      const spId = `sp-${g.sp.id}`
      const spNode = {
        id: spId, cx: X_SP, cy: g.startY + g.groupH / 2, ...s,
        label: g.sp.name, type: 'subproject', entityId: g.sp.id,
        collapsed: g.collapsed, ticketCount: g.ticketCount, openCount: g.openCount, totalCount: g.totalCount,
      }
      nodeMap[spId] = spNode
      nodeList.push(spNode)
      edgePaths.push({ d: bezier(rootNode, spNode), fromId: rootNode.id, toId: spId })
    }

    // Register hidden (collapsed) tickets so edges reroute through the sp node
    if (g.collapsed) {
      for (const t of (g.sp.tickets || [])) {
        if (!visibleIds || visibleIds.has(t.id)) ticketSpMap[t.id] = `sp-${g.sp.id}`
      }
    }

    let ticketY = g.startY
    g.tickets.forEach(t => {
      const h = ticketHeight(t.title)
      const depth = depths[t.id] ?? 0
      const tId = `t-${t.id}`
      const tNode = {
        id: tId,
        cx: X_TK + depth * COL_W,
        cy: ticketY + h / 2,
        w: TICKET_W, h,
        label: t.title, ticketId: t.id, type: 'ticket', state: t.state,
        description: t.description ?? '',
        comments: t.comments ?? [],
        blocked_by: t.blocked_by ?? [],
        blocked: (t.blocked_by ?? []).some(b => b.state !== 'Closed'),
        blockerIds: (t.blocked_by ?? [])
          .filter(b => b.state !== 'Closed')
          .map(b => b.id),
        parentId: g.parentId,
      }
      nodeMap[tId] = tNode
      nodeList.push(tNode)
      ticketY += h + TICKET_GAP
    })
  }

  // Second pass: edges
  for (const n of nodeList) {
    if (n.type !== 'ticket') continue
    const visibleBlockers = n.blockerIds.filter(bid => nodeMap[`t-${bid}`])
    const collapsedSpSources = n.blockerIds
      .filter(bid => !nodeMap[`t-${bid}`] && ticketSpMap[bid] && nodeMap[ticketSpMap[bid]])
      .map(bid => ticketSpMap[bid])
      .filter((spId, i, arr) => arr.indexOf(spId) === i) // dedupe

    if (visibleBlockers.length > 0 || collapsedSpSources.length > 0) {
      for (const bid of visibleBlockers) {
        const fromId = `t-${bid}`
        edgePaths.push({ d: bezier(nodeMap[fromId], n), fromId, toId: n.id })
      }
      for (const spId of collapsedSpSources) {
        edgePaths.push({ d: bezier(nodeMap[spId], n), fromId: spId, toId: n.id })
      }
    } else {
      const parent = nodeMap[n.parentId]
      if (parent) edgePaths.push({ d: bezier(parent, n), fromId: parent.id, toId: n.id })
    }
  }

  return { nodeList, edgePaths, totalH, totalW, nodeMap }
}

function matchesFilter(node, q) {
  if (!q || node.type !== 'ticket') return true
  // "5", "T5", "t5" → ID-only match, no text fallthrough
  const idMatch = q.match(/^t?(\d+)$/i)
  if (idMatch) return node.ticketId === parseInt(idMatch[1], 10)
  // Free-text: title and description
  if (node.label.toLowerCase().includes(q)) return true
  if (node.description && node.description.toLowerCase().includes(q)) return true
  return false
}

export default function MindMap({ project, onLaunch, onSettings, filter = '' }) {
  const [collapsedSps, setCollapsedSps] = useState(new Set())
  const [showClosedPaths, setShowClosedPaths] = useState(false)
  const layout = useMemo(() => buildLayout(project, collapsedSps, showClosedPaths), [project, collapsedSps, showClosedPaths])
  const [scale, setScale]               = useState(1)
  const [hoveredId, setHover]           = useState(null)
  const [selectedTask, setSelectedTask]     = useState(null)
  const [editingNode, setEditingNode]       = useState(null)
  const [commentDraft, setCommentDraft]     = useState('')
  const [commentSaving, setCommentSaving]   = useState(false)
  const [localComments, setLocalComments]   = useState([])
  const leaveTimer                      = useRef(null)

  function openTask(node) {
    setSelectedTask(node)
    setLocalComments([])
    setCommentDraft('')
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        if (selectedTask) setSelectedTask(null)
        else if (editingNode) setEditingNode(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedTask, editingNode])

  async function submitComment() {
    if (!commentDraft.trim() || commentSaving) return
    setCommentSaving(true)
    try {
      const res = await fetch(`/api/tickets/${selectedTask.ticketId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentDraft.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setLocalComments(prev => [...prev, data.comment])
      setCommentDraft('')
    } catch (e) {
      // leave draft in place so user can retry
    } finally {
      setCommentSaving(false)
    }
  }

  // Launch from within the task modal — close modal first, then hand off to ProjectView
  function handleLaunchFromModal(mode, agent, node) {
    setSelectedTask(null)
    onLaunch(mode, agent, node)
  }

  function handleEditFromModal(node) {
    setSelectedTask(null)
    setEditingNode(node)
  }

  function toggleCollapse(spId) {
    const numId = parseInt(spId.replace('sp-', ''), 10)
    setCollapsedSps(prev => {
      const next = new Set(prev)
      next.has(numId) ? next.delete(numId) : next.add(numId)
      return next
    })
  }

  // Highlighted set: hovered node + all its blocker ancestors recursively
  const highlightedSet = useMemo(() => {
    if (!hoveredId) return null
    const set = new Set([hoveredId])
    const queue = [hoveredId]
    while (queue.length) {
      const id = queue.shift()
      const node = layout.nodeMap[id]
      if (!node || node.type !== 'ticket') continue
      for (const blockerId of (node.blockerIds ?? [])) {
        const bId = `t-${blockerId}`
        if (!set.has(bId) && layout.nodeMap[bId]) {
          set.add(bId)
          queue.push(bId)
        }
      }
    }
    return set
  }, [hoveredId, layout.nodeMap])

  function zoom(delta) {
    setScale(s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s + delta).toFixed(2))))
  }

  function handleEnter(id) {
    clearTimeout(leaveTimer.current)
    setHover(id)
  }

  function handleLeave() {
    leaveTimer.current = setTimeout(() => setHover(null), 20)
  }

  return (
    <div className="mindmap-wrap">
      <div className="mindmap-toolbar">
        <div className="mindmap-legend">
          {LEGEND.map(({ label, color }) => (
            <span key={label} className="mm-legend-item">
              <span className="mm-dot" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
        <label className="mindmap-toggle">
          <input type="checkbox" checked={showClosedPaths} onChange={e => setShowClosedPaths(e.target.checked)} />
          Show closed paths
        </label>
        <div className="mindmap-zoom">
          <button onClick={() => zoom(-STEP)} disabled={scale <= MIN_SCALE}>−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(+STEP)} disabled={scale >= MAX_SCALE}>+</button>
        </div>
      </div>

      <div className="mindmap-scroll">
        <div style={{ width: layout.totalW * scale, height: layout.totalH * scale, position: 'relative' }}>
          <div
            className="mindmap-canvas"
            onMouseLeave={handleLeave}
            style={{
              width: layout.totalW,
              height: layout.totalH,
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
          >
            <svg
              width={layout.totalW}
              height={layout.totalH}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            >
              {layout.edgePaths.map((edge, i) => {
                const highlighted = !highlightedSet || (highlightedSet.has(edge.fromId) && highlightedSet.has(edge.toId))
                return (
                  <path
                    key={i}
                    d={edge.d}
                    fill="none"
                    stroke={highlighted && highlightedSet ? '#4a7090' : highlighted ? '#3d5060' : '#3a3f4b'}
                    strokeWidth={highlighted && highlightedSet ? 0.5 : 1.5}
                    opacity={highlighted ? 1 : 0.08}
                    style={{ transition: 'opacity 0.2s, stroke 0.2s' }}
                  />
                )
              })}
            </svg>

            {layout.nodeList.map(n => {
              const filterQ      = filter.trim().toLowerCase()
              const filterActive = filterQ.length > 0
              const filterMatch  = matchesFilter(n, filterQ)
              const dimByFilter  = filterActive && n.type === 'ticket' && !filterMatch
              const dimByHover   = !dimByFilter && highlightedSet && !highlightedSet.has(n.id)
              return (
              <div
                key={n.id}
                className={`mm-node mm-${n.type}${n.state === 'Closed' ? ' mm-closed' : ''}${n.collapsed ? ' mm-collapsed' : ''}${hoveredId === n.id ? ' mm-hovered' : ''}${dimByHover ? ' mm-dimmed' : ''}${dimByFilter ? ' mm-filter-dim' : ''}${filterActive && filterMatch && n.type === 'ticket' ? ' mm-filter-match' : ''}`}
                style={{ left: n.cx - n.w / 2, top: n.cy - n.h / 2, width: n.w, ...(n.type === 'ticket' ? { height: n.h } : { minHeight: n.h }), cursor: n.type === 'subproject' ? 'pointer' : n.type === 'ticket' ? 'pointer' : 'default' }}
                onMouseEnter={() => handleEnter(n.id)}
                onMouseLeave={handleLeave}
                onClick={() => {
                  if (n.type === 'subproject') toggleCollapse(n.id)
                  else if (n.type === 'ticket') openTask(n)
                }}
              >
                {n.type === 'ticket' && (
                  <span
                    className="mm-dot"
                    style={{ background: STATE_COLOR[n.state] ?? STATE_COLOR['Unopened'] }}
                  />
                )}
                <span className="mm-label">
                  {n.type === 'ticket' && <span className="mm-ticket-id">T{n.ticketId}</span>}
                  {n.label}
                </span>
                {n.type === 'subproject' && n.totalCount > 0 && (
                  <span className="mm-sp-badge">{n.collapsed ? '+' : ''}{n.openCount} <span className="mm-sp-badge-sep">/</span> {n.totalCount}</span>
                )}
                {(n.type === 'root' || n.type === 'subproject') && (
                  <NodeToolbar
                    node={n}
                    onLaunch={onLaunch}
                    onEdit={setEditingNode}
                    onSettings={onSettings}
                    onEnter={() => handleEnter(n.id)}
                    onLeave={handleLeave}
                  />
                )}
              </div>
            )})}

          </div>
        </div>
      </div>

      {/* Task info modal — toolbar at top, above title */}
      {selectedTask && (
        <div className="mm-modal-backdrop" onClick={() => setSelectedTask(null)}>
          <div className="mm-modal" onClick={e => e.stopPropagation()}>
            <button className="mm-modal-close" onClick={() => setSelectedTask(null)}>✕</button>
            <EntityToolbar
              node={selectedTask}
              onLaunch={handleLaunchFromModal}
              onEdit={handleEditFromModal}
            />

            <div className="mm-modal-header">
              <span className="mm-modal-state" style={{ background: STATE_COLOR[selectedTask.state] ?? STATE_COLOR['Unopened'] }} />
              <h2 className="mm-modal-title"><span className="mm-modal-id">T{selectedTask.ticketId}</span>{selectedTask.label}</h2>
            </div>

            {selectedTask.description ? (
              <p className="mm-modal-desc">{selectedTask.description}</p>
            ) : (
              <p className="mm-modal-desc mm-modal-empty">No description.</p>
            )}

            {selectedTask.blocked_by?.length > 0 && (
              <div className="mm-modal-blockers">
                <div className="mm-modal-section-label">Blocked by</div>
                <ul>
                  {selectedTask.blocked_by.map(b => (
                    <li key={b.id} className="mm-modal-blocker">
                      <span className="mm-dot" style={{ background: STATE_COLOR[b.state] ?? STATE_COLOR['Unopened'] }} />
                      <span>{b.title}</span>
                      <span className="mm-modal-blocker-state">{b.state}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(selectedTask.comments?.length > 0 || localComments.length > 0) && (
              <div className="mm-modal-comments">
                <div className="mm-modal-section-label">Comments</div>
                <ul>
                  {[...(selectedTask.comments ?? []), ...localComments].map(c => (
                    <li key={c.id} className="mm-modal-comment">
                      <span className="mm-modal-comment-ts">{new Date(c.created_at).toLocaleString()}</span>
                      <p>{c.content}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mm-modal-add-comment">
              <textarea
                className="mm-modal-comment-input"
                placeholder="Add a comment…"
                value={commentDraft}
                onChange={e => setCommentDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitComment() }}
                rows={2}
              />
              <div className="mm-modal-comment-actions">
                <button
                  className="btn-save"
                  onClick={submitComment}
                  disabled={!commentDraft.trim() || commentSaving}
                >
                  {commentSaving ? 'Saving…' : 'Comment'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingNode && (
        <PlanEditor node={editingNode} onClose={() => setEditingNode(null)} />
      )}
    </div>
  )
}
