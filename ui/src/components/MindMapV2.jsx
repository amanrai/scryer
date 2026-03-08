import { useMemo, useState, useRef, useEffect } from 'react'
import PlanEditor from './PlanEditor.jsx'

// ── Constants ──────────────────────────────────────────────────────────────────

const STATE_COLOR = {
  'Closed':         '#4a5060',
  'In Review':      '#61afef',
  'In Progress':    '#e5c07b',
  'Unopened':       '#abb2bf',
  'Needs Input':    '#c678dd',
  'Agent Finished': '#c678dd',
  'Needs Tests':    '#e5c07b',
}

const ROOT_W = 176, ROOT_H = 40
const SP_H   = 31
const TICKET_W  = 220
const TICKET_PAD_V = 31      // vertical padding inside ticket node
const LINE_H       = 18      // px per title line
const CHARS_PER_LINE = Math.floor((TICKET_W - 20) / 7)

const Y_ROOT   = 22          // top of root node
const Y_SP     = 101         // top of SP nodes
const SP_TICKET_GAP = 57     // gap from bottom of SP row to first ticket row
const LAYER_H  = 15          // extra vertical gap between depth layers
const TICKET_GAP_Y = 13      // vertical gap between rows within same depth
const TICKET_GAP_X = 15      // horizontal gap between tickets
const PAD_H    = 35          // horizontal padding of canvas

function ticketHeight(title) {
  const lines = Math.ceil(title.length / CHARS_PER_LINE)
  return Math.max(38, lines * LINE_H + TICKET_PAD_V)
}

// Vertical bezier: bottom-center of src → top-center of dst
function bezierV(src, dst) {
  const x1 = src.cx, y1 = src.cy + src.h / 2
  const x2 = dst.cx, y2 = dst.cy - dst.h / 2
  const my = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`
}

// BFS topological depth (open blockers only)
function computeDepths(tickets) {
  const ids = new Set(tickets.map(t => t.id))
  const inDeg = {}, blocks = {}
  for (const t of tickets) {
    const local = (t.blocked_by ?? []).filter(b => ids.has(b.id) && b.state !== 'Closed')
    inDeg[t.id] = local.length
    for (const b of local) {
      if (!blocks[b.id]) blocks[b.id] = []
      blocks[b.id].push(t.id)
    }
  }
  const depths = Object.fromEntries(tickets.map(t => [t.id, 0]))
  const queue = tickets.filter(t => inDeg[t.id] === 0).map(t => t.id)
  while (queue.length) {
    const id = queue.shift()
    for (const dep of (blocks[id] ?? [])) {
      depths[dep] = Math.max(depths[dep], depths[id] + 1)
      if (--inDeg[dep] === 0) queue.push(dep)
    }
  }
  return depths
}

// BFS ancestor traversal for dep mode
function getAncestors(ticketId, allTickets) {
  const byId = Object.fromEntries(allTickets.map(t => [t.id, t]))
  const visited = new Set()
  const queue = [ticketId]
  while (queue.length) {
    const id = queue.shift()
    if (visited.has(id)) continue
    visited.add(id)
    byId[id]?.blocked_by?.forEach(b => queue.push(b.id))
  }
  return visited
}

// ── Layout builder ─────────────────────────────────────────────────────────────

function buildLayout(project, expandedSpId, showClosed, filterLower, ancestorIds, containerW) {
  if (containerW < 20) return { nodeList: [], edgePaths: [], totalH: 200 }

  const spList = project.sub_projects ?? []
  const nodeMap = {}, nodeList = [], edgePaths = []

  const avail = containerW - PAD_H * 2

  // Root node
  const rootNode = {
    id: 'root', type: 'root',
    cx: containerW / 2, cy: Y_ROOT + ROOT_H / 2,
    w: ROOT_W, h: ROOT_H,
    label: project.name, entityId: project.id,
  }
  nodeMap.root = rootNode
  nodeList.push(rootNode)

  // Determine which SPs are "active" (have visible tickets)
  // Dep mode: all SPs with ancestor tickets; normal mode: just the one expanded SP
  const activeSpsIds = ancestorIds
    ? new Set(spList.filter(sp => (sp.tickets ?? []).some(t => ancestorIds.has(t.id))).map(sp => sp.id))
    : expandedSpId != null ? new Set([expandedSpId]) : new Set()

  // SP nodes — distribute evenly; in normal expanded mode the active SP moves to center
  const numSps = spList.length
  const spCellW = numSps > 0 ? avail / numSps : avail
  const spW = Math.max(90, Math.min(160, spCellW - 16))

  // In dep mode, center active SPs as a group (preserve relative spacing, shift to center)
  const activeSpsForLayout = ancestorIds
    ? spList.filter(sp => activeSpsIds.has(sp.id))
    : spList
  const depGroupW = activeSpsForLayout.length * spCellW
  const depGroupStartX = (containerW - depGroupW) / 2

  const spNodes = spList.map((sp, i) => {
    const isActive = activeSpsIds.has(sp.id)
    const hidden = activeSpsIds.size > 0 && !isActive

    let cx
    if (ancestorIds) {
      // Dep mode: center the active-SP group, preserve natural spacing
      const activeIdx = activeSpsForLayout.findIndex(s => s.id === sp.id)
      cx = isActive
        ? depGroupStartX + (activeIdx + 0.5) * spCellW
        : PAD_H + (i + 0.5) * spCellW  // hidden, position doesn't matter
    } else {
      const naturalCx = PAD_H + (i + 0.5) * spCellW
      cx = (isActive && activeSpsIds.size === 1) ? containerW / 2 : naturalCx
    }
    const rawCount = (sp.tickets ?? []).length
    const openCount = (sp.tickets ?? []).filter(t => t.state !== 'Closed').length
    const node = {
      id: `sp-${sp.id}`, type: 'subproject',
      cx, cy: Y_SP + SP_H / 2,
      w: (!ancestorIds && isActive) ? Math.max(spW, 160) : spW,
      h: SP_H,
      label: sp.name, entityId: sp.id,
      open: isActive, hidden,
      rawCount, openCount, depth: -1,
    }
    nodeMap[node.id] = node
    nodeList.push(node)
    edgePaths.push({ d: bezierV(rootNode, node), fromId: 'root', toId: node.id, hidden })
    return node
  })

  // Gather tickets to render: pool from all active SPs
  let totalH = Y_SP + SP_H + 40

  if (activeSpsIds.size > 0) {
    // Collect tickets from all active SPs
    let tickets = spList
      .filter(sp => activeSpsIds.has(sp.id))
      .flatMap(sp => (sp.tickets ?? []).map(t => ({ ...t, _spId: sp.id })))

    if (!showClosed) tickets = tickets.filter(t => t.state !== 'Closed')
    if (filterLower)  tickets = tickets.filter(t => t.title.toLowerCase().includes(filterLower))
    if (ancestorIds)  tickets = tickets.filter(t => ancestorIds.has(t.id))

    const depths = computeDepths(tickets)
    const maxDepth = tickets.length ? Math.max(...tickets.map(t => depths[t.id] ?? 0)) : -1

    // Group by depth
    const layers = new Map()
    for (const t of tickets) {
      const d = depths[t.id] ?? 0
      if (!layers.has(d)) layers.set(d, [])
      layers.get(d).push(t)
    }

    const maxPerRow = Math.max(1, Math.floor((avail + TICKET_GAP_X) / (TICKET_W + TICKET_GAP_X)))
    let currentY = Y_SP + SP_H + SP_TICKET_GAP

    for (let d = 0; d <= maxDepth; d++) {
      const layer = layers.get(d) ?? []
      if (layer.length === 0) continue

      for (let ri = 0; ri < layer.length; ri += maxPerRow) {
        const rowTickets = layer.slice(ri, ri + maxPerRow)
        const rowW = rowTickets.length * TICKET_W + (rowTickets.length - 1) * TICKET_GAP_X
        const rowStartX = (containerW - rowW) / 2

        rowTickets.forEach((t, j) => {
          const h = ticketHeight(t.title)
          const cx = rowStartX + j * (TICKET_W + TICKET_GAP_X) + TICKET_W / 2
          const node = {
            id: `t-${t.id}`, type: 'ticket',
            cx, cy: currentY + h / 2,
            w: TICKET_W, h, depth: d,
            label: t.title, ticketId: t.id, state: t.state,
            description: t.description ?? '',
            comments: t.comments ?? [],
            blocked_by: t.blocked_by ?? [],
            blocked: (t.blocked_by ?? []).some(b => b.state !== 'Closed'),
            blockerCount: (t.blocked_by ?? []).filter(b => b.state !== 'Closed').length,
            blockerIds: (t.blocked_by ?? []).filter(b => b.state !== 'Closed').map(b => b.id),
            allBlockerIds: (t.blocked_by ?? []).map(b => b.id),
            parentId: `sp-${t._spId}`,
            priority: t.priority,
          }
          nodeMap[node.id] = node
          nodeList.push(node)
        })

        const maxRowH = Math.max(...rowTickets.map(t => ticketHeight(t.title)))
        currentY += maxRowH + TICKET_GAP_Y
      }

      currentY += LAYER_H
    }

    // Edges — ticket→ticket (blockers) or sp→ticket
    // In dep mode, use all blockers (including closed) so the full ancestry chain is connected
    for (const node of nodeList) {
      if (node.type !== 'ticket') continue
      const edgeBlockerIds = ancestorIds ? node.allBlockerIds : node.blockerIds
      const visibleBlockers = edgeBlockerIds.filter(bid => nodeMap[`t-${bid}`])
      if (visibleBlockers.length > 0) {
        for (const bid of visibleBlockers) {
          edgePaths.push({ d: bezierV(nodeMap[`t-${bid}`], node), fromId: `t-${bid}`, toId: node.id })
        }
      } else {
        const parentSpNode = nodeMap[node.parentId]
        if (parentSpNode) {
          edgePaths.push({ d: bezierV(parentSpNode, node), fromId: node.parentId, toId: node.id })
        }
      }
    }

    totalH = currentY + 32
  }

  return { nodeList, edgePaths, totalH }
}

// ── Node renderer (SVG foreignObject for rich HTML nodes) ─────────────────────

function RootNode({ node, onLaunch, onEdit, onSettings, onDeselect }) {
  const [hover, setHover] = useState(false)
  const leaveTimer = useRef(null)
  function handleEnter() { clearTimeout(leaveTimer.current); setHover(true) }
  function handleLeave() { leaveTimer.current = setTimeout(() => setHover(false), 200) }
  return (
    <foreignObject x={node.cx - node.w / 2} y={node.cy - node.h / 2} width={node.w} height={node.h + 36}>
      <div
        className="v2n-root"
        onClick={onDeselect}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <span>{node.label}</span>
        {hover && (
          <div className="v2n-toolbar">
            {onLaunch && (
              <button className="mm-tb-btn" data-tip="Plan" onClick={e => { e.stopPropagation(); onLaunch('plan', null, { type: 'root', label: node.label, entityId: node.entityId }) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </button>
            )}
            {onEdit && (
              <button className="mm-tb-btn" data-tip="Edit plan" onClick={e => { e.stopPropagation(); onEdit({ type: 'root', label: node.label, entityId: node.entityId }) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
            )}
            {onLaunch && (
              <button className="mm-tb-btn" data-tip="Architect" onClick={e => { e.stopPropagation(); onLaunch('architect', null, { type: 'root', label: node.label, entityId: node.entityId }) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="22" x2="7" y2="4"/><line x1="3" y1="4" x2="21" y2="4"/><line x1="7" y1="4" x2="3" y2="8"/><line x1="7" y1="12" x2="21" y2="4"/><line x1="17" y1="4" x2="17" y2="14"/><rect x="14" y="14" width="6" height="4" rx="1"/></svg>
              </button>
            )}
            {onSettings && (
              <button className="mm-tb-btn" data-tip="Settings" onClick={e => { e.stopPropagation(); onSettings() }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            )}
          </div>
        )}
      </div>
    </foreignObject>
  )
}

function SpNode({ node, onClick, onLaunch, onEdit }) {
  const [hover, setHover] = useState(false)
  const leaveTimer = useRef(null)
  function handleEnter() { clearTimeout(leaveTimer.current); setHover(true) }
  function handleLeave() { leaveTimer.current = setTimeout(() => setHover(false), 200) }
  const count = node.open ? node.rawCount : node.openCount
  const entity = { type: 'subproject', label: node.label, entityId: node.entityId }

  return (
    <foreignObject x={node.cx - node.w / 2} y={node.cy - node.h / 2} width={node.w} height={node.h + 36}>
      <div
        className={`v2n-sp${node.open ? ' v2n-sp--open' : ''}`}
        onClick={() => onClick(node.entityId)}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <span className="v2n-sp-name">{node.label}</span>
        <span className="v2n-sp-count">{count}</span>
        {hover && onLaunch && (
          <div className="v2n-toolbar">
            <button className="mm-tb-btn" data-tip="Plan" onClick={e => { e.stopPropagation(); onLaunch('plan', null, entity) }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </button>
            <button className="mm-tb-btn" data-tip="Edit plan" onClick={e => { e.stopPropagation(); onEdit(entity) }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button className="mm-tb-btn" data-tip="Architect" onClick={e => { e.stopPropagation(); onLaunch('architect', null, entity) }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="22" x2="7" y2="4"/><line x1="3" y1="4" x2="21" y2="4"/><line x1="7" y1="4" x2="3" y2="8"/><line x1="7" y1="12" x2="21" y2="4"/><line x1="17" y1="4" x2="17" y2="14"/><rect x="14" y="14" width="6" height="4" rx="1"/></svg>
            </button>
          </div>
        )}
      </div>
    </foreignObject>
  )
}

function TicketNode({ node, onSingleClick, onDoubleClick, inDepMode, isSelected }) {
  const bc = node.blockerCount ?? 0
  return (
    <foreignObject x={node.cx - node.w / 2} y={node.cy - node.h / 2} width={node.w} height={node.h}>
      <div
        className={`v2n-ticket${node.state === 'Closed' ? ' v2n-ticket--closed' : ''}${isSelected ? ' v2n-ticket--selected' : ''}`}
        onClick={() => (node.blockerCount > 0 && !inDepMode) ? onSingleClick(node) : onDoubleClick(node)}
        onDoubleClick={e => { e.stopPropagation(); onDoubleClick(node) }}
      >
        <div className="v2n-ticket-top">
          <span className="v2n-dot" style={{ background: STATE_COLOR[node.state] ?? STATE_COLOR['Unopened'] }} />
          <span className="v2n-tid">T{node.ticketId}</span>
          {bc > 0 && <span className="v2n-badge">{bc}</span>}
        </div>
        <div className="v2n-ticket-title">{node.label}</div>
      </div>
    </foreignObject>
  )
}

// ── Ticket detail modal ────────────────────────────────────────────────────────

function TaskModal({ node, onClose, onLaunch }) {
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSaving, setCommentSaving] = useState(false)
  const [localComments, setLocalComments] = useState([])

  async function submitComment() {
    if (!commentDraft.trim() || commentSaving) return
    setCommentSaving(true)
    try {
      const res = await fetch(`/api/tickets/${node.ticketId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentDraft.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setLocalComments(prev => [...prev, data.comment])
      setCommentDraft('')
    } catch {}
    setCommentSaving(false)
  }

  async function handleDelete() {
    if (!window.confirm(`Delete T${node.ticketId}: ${node.label}? This cannot be undone.`)) return
    await fetch(`/api/tickets/${node.ticketId}`, { method: 'DELETE' })
    onClose()
  }

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div className="mm-modal" onClick={e => e.stopPropagation()}>
        <div className="mm-modal-actions">
          {onLaunch && (<>
            <button className="mm-tb-btn" data-tip="Plan" title="Open planning session"
              onClick={e => { e.stopPropagation(); onClose(); onLaunch('plan', null, { type: 'ticket', ticketId: node.ticketId, entityId: node.ticketId }) }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
            </button>
            <button className="mm-tb-btn" data-tip="Architect" title="Open architect session"
              onClick={e => { e.stopPropagation(); onClose(); onLaunch('architect', null, { type: 'ticket', ticketId: node.ticketId, entityId: node.ticketId }) }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
              </svg>
            </button>
          </>)}
          <button className="mm-modal-delete" onClick={handleDelete} title="Delete ticket">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
          <button className="mm-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="mm-modal-header">
          <span className="mm-modal-state" style={{ background: STATE_COLOR[node.state] ?? STATE_COLOR['Unopened'] }} />
          <h2 className="mm-modal-title"><span className="mm-modal-id">T{node.ticketId}</span>{node.label}</h2>
        </div>
        {node.description
          ? <p className="mm-modal-desc">{node.description}</p>
          : <p className="mm-modal-desc mm-modal-empty">No description.</p>
        }
        {node.blocked_by?.length > 0 && (
          <div className="mm-modal-blockers">
            <div className="mm-modal-section-label">Blocked by</div>
            <ul>
              {node.blocked_by.map(b => (
                <li key={b.id} className="mm-modal-blocker">
                  <span className="mm-dot" style={{ background: STATE_COLOR[b.state] ?? STATE_COLOR['Unopened'] }} />
                  <span>{b.title}</span>
                  <span className="mm-modal-blocker-state">{b.state}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(node.comments?.length > 0 || localComments.length > 0) && (
          <div className="mm-modal-comments">
            <div className="mm-modal-section-label">Comments</div>
            <ul>
              {[...(node.comments ?? []), ...localComments].map(c => (
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
            <button className="btn-save" onClick={submitComment} disabled={!commentDraft.trim() || commentSaving}>
              {commentSaving ? 'Saving…' : 'Comment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MindMapV2({ project, onLaunch, onSettings, filter = '' }) {
  const containerRef                    = useRef(null)
  const [containerW, setContainerW]     = useState(0)
  const [expandedSp, setExpandedSp]     = useState(null)
  const [showClosed, setShowClosed]     = useState(true)
  const [selectedNode, setSelectedNode] = useState(null)
  const [editingNode, setEditingNode]   = useState(null)
  const [depTicketId, setDepTicketId]   = useState(null)
  const [preDepExpanded, setPreDepExpanded] = useState(null)

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerW(e.contentRect.width)
    })
    ro.observe(containerRef.current)
    setContainerW(containerRef.current.clientWidth)
    return () => ro.disconnect()
  }, [])

  const allTickets = useMemo(() => [
    ...(project.tickets ?? []),
    ...(project.sub_projects ?? []).flatMap(sp => sp.tickets ?? []),
  ], [project])

  const ancestorIds = useMemo(() =>
    depTicketId != null ? getAncestors(depTicketId, allTickets) : null,
    [depTicketId, allTickets],
  )

  function enterDepMode(node) {
    setPreDepExpanded(expandedSp)
    setDepTicketId(node.ticketId)
    // Keep the sp open so ancestors are visible
  }

  function exitDepMode() {
    setDepTicketId(null)
    setExpandedSp(preDepExpanded)
  }

  function toggleSp(spId) {
    setExpandedSp(prev => prev === spId ? null : spId)
  }

  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Escape' || selectedNode) return
      if (depTicketId != null) exitDepMode()
      else if (expandedSp != null) setExpandedSp(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [depTicketId, expandedSp, selectedNode]) // eslint-disable-line react-hooks/exhaustive-deps

  const filterLower = filter.toLowerCase()

  const layout = useMemo(
    () => buildLayout(project, expandedSp, showClosed, filterLower, ancestorIds, containerW),
    [project, expandedSp, showClosed, filterLower, ancestorIds, containerW],
  )

  const { nodeList, edgePaths, totalH } = layout

  // Dim logic: if hovered node tracked, dim unrelated nodes (same as V1 — skip for now for simplicity)
  function handleEdit(entity) {
    setEditingNode(entity)
  }

  return (
    <div ref={containerRef} className="v2-container">
      {/* Controls */}
      <div className="v2-controls">
        {depTicketId != null && (
          <button className="v2-exit-dep" onClick={exitDepMode}>✕ Exit dependency mode</button>
        )}
        <label className="mindmap-toggle" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />
          Show closed paths
        </label>
      </div>

      {/* SVG canvas */}
      <svg
        width={containerW || '100%'}
        height={totalH}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Edges */}
        <g className="v2-edges">
          {edgePaths.map((ep, i) => (
            <path
              key={i}
              d={ep.d}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1.5}
              style={{
                opacity: ep.hidden ? 0 : 0.7,
                transition: 'opacity 0.25s ease',
              }}
            />
          ))}
        </g>

        {/* Nodes */}
        {nodeList.map(node => {
          const style = node.type === 'subproject' ? {
            transition: 'transform 0.3s ease, opacity 0.25s ease',
            opacity: node.hidden ? 0 : 1,
            pointerEvents: node.hidden ? 'none' : 'all',
          } : undefined

          if (node.type === 'root') {
            return (
              <RootNode
                key={node.id}
                node={node}
                onLaunch={onLaunch}
                onEdit={handleEdit}
                onSettings={onSettings}
                onDeselect={() => { setExpandedSp(null); setDepTicketId(null) }}
              />
            )
          }
          if (node.type === 'subproject') {
            return (
              <g key={node.id} style={style}>
                <SpNode
                  node={node}
                  onClick={toggleSp}
                  onLaunch={onLaunch}
                  onEdit={handleEdit}
                />
              </g>
            )
          }
          if (node.type === 'ticket') {
            return (
              <TicketNode
                key={node.id}
                node={node}
                onSingleClick={enterDepMode}
                onDoubleClick={setSelectedNode}
                inDepMode={depTicketId != null}
                isSelected={node.ticketId === depTicketId}
              />
            )
          }
          return null
        })}
      </svg>

      {selectedNode && (
        <TaskModal node={selectedNode} onClose={() => setSelectedNode(null)} onLaunch={onLaunch} />
      )}

      {editingNode && (
        <PlanEditor node={editingNode} onClose={() => setEditingNode(null)} />
      )}
    </div>
  )
}
