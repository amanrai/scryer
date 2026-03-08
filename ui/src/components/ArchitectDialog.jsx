import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io } from 'socket.io-client'
import '@xterm/xterm/css/xterm.css'

const TMUX_SERVER = 'http://localhost:5055'
const PRIORITY_COLORS = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--text-muted)' }

function itemTitle(item, edits, ticketById = {}) {
  const cleaned = Object.fromEntries(Object.entries(edits).filter(([, v]) => v != null))
  const merged = { ...item, ...cleaned }
  if (merged.kind === 'subproject') return merged.name
  const tid = merged.ticket_id
  const liveTitle = tid ? ticketById[tid]?.title : null
  if (merged.kind === 'close') return liveTitle || merged.reason || `T${tid ?? merged.id}`
  if (merged.kind === 'modify') return liveTitle || merged.title || `T${tid ?? merged.id}`
  return merged.title || `T${merged.id}`
}

function kindLabel(item) {
  if (item.kind === 'subproject') return 'subproject'
  if (item.kind === 'modify')     return `modify T${item.ticket_id ?? ''}`
  if (item.kind === 'close')      return `close T${item.ticket_id ?? ''}`
  return 'task'
}

// Initial per-item local state
function makeItemState(item) {
  return {
    status:         item.status === 'needs_revision' ? 'needs_revision' : 'pending',
    rejectionReason: item.rejection_reason || '',
    feedbackDraft:  '',
    showFeedback:   false,
    showHistory:    false,
    titleEdit:      null,
    descEdit:       null,
  }
}

export default function ArchitectDialog({ session, entityType, entityId, entity, projectName, onMinimize, onClose }) {
  const containerRef = useRef(null)
  const [proposal, setProposal]       = useState(null)
  const [itemStates, setItemStates]   = useState([])   // per-item local state
  const [selected, setSelected]       = useState(0)
  const [applying, setApplying]       = useState(false)
  const [results, setResults]         = useState(null)
  const [applyError, setApplyError]   = useState(null)
  const [ticketById, setTicketById]   = useState({})

  // Fetch live ticket titles so modify/close items resolve correctly
  useEffect(() => {
    if (!projectName) return
    fetch(`/api/projects/${encodeURIComponent(projectName)}`)
      .then(r => r.json())
      .then(d => {
        const map = {}
        const allTickets = [
          ...(d.tickets ?? []),
          ...(d.sub_projects ?? []).flatMap(sp => sp.tickets ?? []),
        ]
        allTickets.forEach(t => { map[t.id] = t })
        setTicketById(map)
      })
      .catch(() => {})
  }, [projectName])

  const label = entity.ticketId ? `T${entity.ticketId} — ${entity.label}` : entity.label
  const proposalApplied = proposal?._status === 'applied'
  const items = proposal?.items || []
  const apiType   = entity.type === 'root' ? 'project' : entity.type
  const entityId_ = entity.type === 'root' ? entity.label : (entity.ticketId ?? entity.entityId)

  // Poll for proposal.json — syncs agent-driven status changes (needs_revision → pending)
  const proposalSigRef = useRef(null)
  useEffect(() => {
    function poll() {
      fetch(`/api/architect/proposal?type=${apiType}&id=${entityId_}`)
        .then(r => r.json())
        .then(d => {
          if (!d.ready || !d.proposal) return
          const sig = JSON.stringify(d.proposal)
          if (sig === proposalSigRef.current) return
          proposalSigRef.current = sig
          const newItems = d.proposal.items || []
          setProposal(d.proposal)
          setItemStates(prev => {
            // Build id → prev state map for merge
            const prevById = {}
            if (prev.length && items.length === prev.length) {
              items.forEach((item, i) => { if (item.id) prevById[item.id] = prev[i] })
            }
            return newItems.map(item => {
              const existing = item.id ? prevById[item.id] : null
              if (!existing) return makeItemState(item)
              // Preserve human decisions (accepted/rejected); update if agent changed status
              const agentStatus = item.status
              const humanStatus = existing.status
              // If agent changed from needs_revision to pending → revert to pending for human
              const newStatus = agentStatus === 'needs_revision'
                ? 'needs_revision'
                : (humanStatus === 'needs_revision' ? 'pending' : humanStatus)
              return { ...existing, status: newStatus }
            })
          })
          setSelected(s => Math.min(s, Math.max(0, newItems.length - 1)))
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [entity]) // eslint-disable-line react-hooks/exhaustive-deps

  // Terminal
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      theme: { background: '#1a1d23', foreground: '#abb2bf', cursor: '#61afef', selectionBackground: '#3e4451' },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
      fontSize: 12, lineHeight: 1.4, cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    const socket = io(TMUX_SERVER)
    socket.on('connect', () => socket.emit('attach', { session, cols: term.cols, rows: term.rows }))
    socket.on('output', d => term.write(d))
    socket.on('session_ended', () => term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n'))
    socket.on('session_not_found', () => term.write(`\r\n\x1b[31mSession not found: ${session}\x1b[0m\r\n`))
    term.onData(d => socket.emit('input', d))
    const ro = new ResizeObserver(() => { fit.fit(); socket.emit('resize', { cols: term.cols, rows: term.rows }) })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); socket.disconnect(); term.dispose() }
  }, [session])

  function updateItemState(i, patch) {
    setItemStates(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }

  function setStatus(i, status) {
    updateItemState(i, { status })
  }

  // Call PATCH endpoint to write field to proposal.json (agent picks it up)
  async function patchItem(itemId, fields) {
    if (!itemId) return
    try {
      await fetch(`/api/architect/proposal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: apiType, id: String(entityId_), ...fields }),
      })
    } catch (_) {}
  }

  async function handleRejectionReason(i, value) {
    updateItemState(i, { rejectionReason: value })
    const item = items[i]
    if (item?.id) await patchItem(item.id, { rejection_reason: value })
  }

  async function submitRevisionRequest(i) {
    const state = itemStates[i]
    const item = items[i]
    if (!state?.feedbackDraft?.trim() || !item?.id) return
    updateItemState(i, { status: 'needs_revision', showFeedback: false, feedbackDraft: '' })
    await patchItem(item.id, { status: 'needs_revision', human_feedback: state.feedbackDraft.trim() })
  }

  async function handleClearProposal() {
    await fetch('/api/architect/proposal/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: apiType, id: String(entityId_) }),
    })
    proposalSigRef.current = null
    setProposal(null)
    setItemStates([])
    setSelected(0)
    setResults(null)
  }

  async function handleApply() {
    if (!items.length) return
    setApplying(true)
    setApplyError(null)
    try {
      // Pass all items with their local status so apply.py can record rejections/ignores
      const allItems = items.map((item, i) => {
        const s = itemStates[i] || {}
        const localStatus = s.status === 'needs_revision' ? 'pending' : (s.status || 'pending')
        return {
          ...item,
          ...(s.titleEdit != null ? { title: s.titleEdit } : {}),
          ...(s.descEdit  != null ? { description: s.descEdit } : {}),
          status: localStatus,
          rejection_reason: s.rejectionReason || item.rejection_reason || null,
        }
      })
      const res = await fetch('/api/architect/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: apiType, entity_id: String(entityId_), items: allItems }),
      })
      const data = await res.json()
      if (!res.ok) {
        setApplyError(data.error || `Server error ${res.status}`)
      } else if (data.errors?.length && !data.created?.length && !data.modified?.length && !data.closed?.length) {
        setApplyError(data.errors.map(e => e.error).join('; '))
      } else {
        setResults(data)
      }
    } catch (e) {
      setApplyError(e.message)
    }
    setApplying(false)
  }

  const acceptedCount = itemStates.filter(s => s.status === 'accepted').length
  const state = itemStates[selected]
  const item  = items[selected]
  const effectiveItem = item ? {
    ...item,
    ...(state?.titleEdit != null ? { title: state.titleEdit } : {}),
    ...(state?.descEdit  != null ? { description: state.descEdit } : {}),
  } : null

  return (
    <div className="planning-modal-backdrop" onClick={onClose}>
      <div className="arch-dialog" onClick={e => e.stopPropagation()}>
        <div className="planning-panel-header">
          <span className="planning-panel-title">Architect — {label}</span>
          {onMinimize && <button className="planning-close-btn" onClick={onMinimize} title="Minimize">─</button>}
          <button className="planning-close-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="arch-dialog-body">

          {/* Column 1: terminal */}
          <div className="arch-term-pane">
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
          </div>

          {/* Column 2: item list */}
          <div className="arch-list-pane">
            {!proposal && (
              <div className="arch-waiting">
                <div className="arch-waiting-dot" />
                Waiting for proposal…
              </div>
            )}
            {proposal && (
              <>
                {proposalApplied && (
                  <div className="arch-applied-banner">
                    <span>Proposal applied</span>
                    <button className="arch-clear-btn" onClick={handleClearProposal}>Clear</button>
                  </div>
                )}
                {proposal.reasoning && (
                  <div className="arch-reasoning">{proposal.reasoning}</div>
                )}
                <div className="arch-list-header">
                  <span>{items.length} item{items.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="arch-item-list">
                  {items.map((it, i) => {
                    const s = itemStates[i] || {}
                    const displayStatus = s.status || 'pending'
                    return (
                      <button
                        key={it.id || i}
                        className={`arch-row${i === selected ? ' arch-row--active' : ''} arch-row--${displayStatus}`}
                        onClick={() => setSelected(i)}
                      >
                        <span className={`arch-row-dot arch-row-dot--${displayStatus}`}>
                          {displayStatus === 'accepted' ? '✓' : displayStatus === 'rejected' ? '✕' : displayStatus === 'needs_revision' ? '…' : ''}
                        </span>
                        <span className="arch-row-kind">{kindLabel(it)}</span>
                        <span className="arch-row-title">{itemTitle(it, { title: s.titleEdit, name: s.titleEdit }, ticketById)}</span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Column 3: item detail + actions */}
          <div className="arch-detail-pane">
            {results ? (
              <div className="arch-results">
                <div className="arch-results-title">Applied</div>
                {results.created?.map((r, i) => (
                  <div key={i} className="arch-result-row arch-result--created">
                    + {r.kind === 'ticket' ? `T${r.id}: ${r.title}` : `[sp] ${r.name}`}
                  </div>
                ))}
                {results.modified?.map((r, i) => (
                  <div key={i} className="arch-result-row arch-result--modified">✎ T{r.id} modified</div>
                ))}
                {results.closed?.map((r, i) => (
                  <div key={i} className="arch-result-row arch-result--closed">✕ T{r.id} closed</div>
                ))}
                {results.errors?.map((r, i) => (
                  <div key={i} className="arch-result-row arch-result--error">! {r.error}</div>
                ))}
              </div>
            ) : effectiveItem && state ? (
              <>
                <div className="arch-detail-scroll">
                  <div className="arch-detail-meta">
                    <span className={`arch-detail-kind arch-detail-kind--${effectiveItem.kind}`}>{kindLabel(effectiveItem)}</span>
                    {effectiveItem.priority && (
                      <span className="arch-detail-priority" style={{ color: PRIORITY_COLORS[effectiveItem.priority] || PRIORITY_COLORS.medium }}>
                        {effectiveItem.priority}
                      </span>
                    )}
                    {effectiveItem.sub_project && (
                      <span className="arch-item-sp">{effectiveItem.sub_project}</span>
                    )}
                  </div>

                  {state.status === 'needs_revision' ? (
                    <div className="arch-needs-revision">
                      <div className="arch-needs-revision-label">
                        ⟳ Waiting for agent revision…
                        <button
                          className="arch-btn arch-btn--neutral"
                          style={{ marginLeft: 8, fontSize: '0.75rem', padding: '2px 8px' }}
                          onClick={async () => {
                            updateItemState(selected, { status: 'pending' })
                            await patchItem(effectiveItem.id, { status: 'pending', human_feedback: null })
                          }}
                        >Cancel</button>
                      </div>
                      <div className="arch-needs-revision-title">{itemTitle(effectiveItem, {}, ticketById)}</div>
                    </div>
                  ) : (
                    <>
                      <input
                        className="arch-edit-title"
                        value={effectiveItem.title ?? effectiveItem.name ?? ''}
                        onChange={e => updateItemState(selected, { titleEdit: e.target.value })}
                        placeholder="Title"
                      />
                      {effectiveItem.kind !== 'close' && (
                        <textarea
                          className="arch-edit-desc"
                          value={effectiveItem.description ?? ''}
                          onChange={e => updateItemState(selected, { descEdit: e.target.value })}
                          placeholder="Description"
                        />
                      )}
                      {effectiveItem.kind === 'close' && (
                        <div className="arch-detail-title" style={{ color: 'var(--red)' }}>{effectiveItem.reason}</div>
                      )}
                      {effectiveItem.blocks?.length > 0 && (
                        <div className="arch-detail-blocks">
                          <span className="arch-detail-blocks-label">blocks</span>
                          {effectiveItem.blocks.map((b, i) => <span key={i} className="arch-detail-block-tag">{b}</span>)}
                        </div>
                      )}
                    </>
                  )}

                  {/* Rejection reason — shown when rejected */}
                  {state.status === 'rejected' && (
                    <div className="arch-rejection-reason">
                      <label className="arch-rejection-label">Reason (optional)</label>
                      <input
                        className="arch-rejection-input"
                        placeholder="Why are you rejecting this?"
                        value={state.rejectionReason || ''}
                        onChange={e => handleRejectionReason(selected, e.target.value)}
                      />
                    </div>
                  )}

                  {/* Request revision */}
                  {state.status === 'pending' && effectiveItem.id && (
                    <div className="arch-revision-section">
                      {state.showFeedback ? (
                        <>
                          <textarea
                            className="arch-feedback-input"
                            placeholder="What should change? Be specific."
                            value={state.feedbackDraft || ''}
                            onChange={e => updateItemState(selected, { feedbackDraft: e.target.value })}
                            autoFocus
                            rows={3}
                          />
                          <div className="arch-feedback-actions">
                            <button
                              className="arch-btn arch-btn--revision"
                              disabled={!state.feedbackDraft?.trim()}
                              onClick={() => submitRevisionRequest(selected)}
                            >Send to agent</button>
                            <button
                              className="arch-btn"
                              onClick={() => updateItemState(selected, { showFeedback: false, feedbackDraft: '' })}
                            >Cancel</button>
                          </div>
                        </>
                      ) : (
                        <button
                          className="arch-btn arch-btn--revision-open"
                          onClick={() => updateItemState(selected, { showFeedback: true })}
                        >Request revision</button>
                      )}
                    </div>
                  )}

                  {/* Revision history */}
                  {effectiveItem.revisions?.length > 0 && (
                    <div className="arch-history">
                      <button
                        className="arch-history-toggle"
                        onClick={() => updateItemState(selected, { showHistory: !state.showHistory })}
                      >
                        {state.showHistory ? '▾' : '▸'} {effectiveItem.revisions.length} revision{effectiveItem.revisions.length !== 1 ? 's' : ''}
                      </button>
                      {state.showHistory && (
                        <div className="arch-history-list">
                          {[...effectiveItem.revisions].reverse().map((rev, i) => (
                            <div key={i} className="arch-history-entry">
                              <div className="arch-history-ts">{rev.revised_at ? new Date(rev.revised_at).toLocaleString() : `v${effectiveItem.revisions.length - i}`}</div>
                              {rev.title && <div className="arch-history-field"><span>title</span>{rev.title}</div>}
                              {rev.description && <div className="arch-history-field"><span>description</span><span className="arch-history-desc">{rev.description}</span></div>}
                              {rev.priority && <div className="arch-history-field"><span>priority</span>{rev.priority}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="arch-action-row">
                  <button
                    className={`arch-btn arch-btn--accept${state.status === 'accepted' ? ' arch-btn--active' : ''}`}
                    onClick={() => setStatus(selected, state.status === 'accepted' ? 'pending' : 'accepted')}
                    disabled={state.status === 'needs_revision'}
                  >Accept</button>
                  <button
                    className={`arch-btn arch-btn--reject${state.status === 'rejected' ? ' arch-btn--active' : ''}`}
                    onClick={() => setStatus(selected, state.status === 'rejected' ? 'pending' : 'rejected')}
                    disabled={state.status === 'needs_revision'}
                  >Reject</button>
                  <div className="arch-action-spacer" />
                  {applyError && <span className="arch-apply-error">{applyError}</span>}
                  <button
                    className="arch-apply-btn"
                    disabled={applying || acceptedCount === 0 || proposalApplied}
                    onClick={handleApply}
                  >
                    {applying ? 'Applying…' : proposalApplied ? 'Already applied' : `Apply ${acceptedCount} accepted`}
                  </button>
                </div>
              </>
            ) : (
              <div className="arch-detail-empty">Select an item from the list.</div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
