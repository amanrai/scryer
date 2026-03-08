import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io } from 'socket.io-client'
import '@xterm/xterm/css/xterm.css'

const TMUX_SERVER = 'http://localhost:5055'

export default function PlanningPanel({ session, entityType, entityId, entity, agent, onCollapse }) {
  const [planContent, setPlanContent] = useState('')
  const [planFresh, setPlanFresh]     = useState(false)

  const planHtml = useMemo(() => marked.parse(planContent || ''), [planContent])
  const containerRef = useRef(null)
  const lastContentRef = useRef('')

  // Poll plan.md every 2 s
  useEffect(() => {
    function fetchPlan() {
      fetch(`/api/planning?type=${entityType}&id=${entityId}`)
        .then(r => r.json())
        .then(d => {
          if (d.content !== undefined && d.content !== lastContentRef.current) {
            lastContentRef.current = d.content
            setPlanContent(d.content)
            setPlanFresh(true)
            setTimeout(() => setPlanFresh(false), 1200)
          }
        })
        .catch(() => {})
    }
    fetchPlan()
    const id = setInterval(fetchPlan, 2000)
    return () => clearInterval(id)
  }, [entityType, entityId])

  // Terminal
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: { background: '#1a1d23', foreground: '#abb2bf', cursor: '#61afef', selectionBackground: '#3e4451' },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    const socket = io(TMUX_SERVER)

    socket.on('connect', () => {
      socket.emit('attach', { session, cols: term.cols, rows: term.rows })
    })
    socket.on('output', data => term.write(data))
    socket.on('session_ended', () => term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n'))
    socket.on('session_not_found', () => {
      term.write(`\r\n\x1b[31mSession not found: ${session}\x1b[0m\r\n`)
    })

    term.onData(data => socket.emit('input', data))

    const ro = new ResizeObserver(() => {
      fit.fit()
      socket.emit('resize', { cols: term.cols, rows: term.rows })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      socket.disconnect()
      term.dispose()
    }
  }, [session])

  const label = entity.ticketId ? `T${entity.ticketId} — ${entity.label}` : entity.label

  return (
    <div className="planning-modal-backdrop" onClick={onCollapse}>
      <div className="planning-modal" onClick={e => e.stopPropagation()}>
        <div className="planning-panel-header">
          <span className="planning-panel-title">Plan — {label}</span>
          <button className="planning-close-btn" onClick={onCollapse} title="Close">✕</button>
        </div>

        <div className="planning-panel-body">
          <div className={`planning-plan-pane${planFresh ? ' planning-plan-pane--fresh' : ''}`}>
            <div className="planning-plan-label">plan.md</div>
            {planContent
            ? <div className="planning-plan-content markdown-body" dangerouslySetInnerHTML={{ __html: planHtml }} />
            : <div className="planning-plan-content planning-plan-empty">(empty — agent will write here)</div>
          }
          </div>

          <div className="planning-term-pane">
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  )
}
