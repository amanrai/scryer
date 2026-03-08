import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io } from 'socket.io-client'
import '@xterm/xterm/css/xterm.css'

const TMUX_SERVER = 'http://localhost:5055'

// Startup delay in ms per agent — time until the startup message is sent
const DEFAULT_WARMUP_MS = 10000


export default function PlanningPanel({ session, entityType, entityId, entity, agent, launchedAt, warmup, onMinimize, onClose }) {
  const [planContent, setPlanContent] = useState('')
  const [planFresh, setPlanFresh]     = useState(false)
  const [fontSize, setFontSize]       = useState(14)

  const planHtml = useMemo(() => marked.parse(planContent || ''), [planContent])
  const containerRef  = useRef(null)
  const lastContentRef = useRef('')
  const termRef       = useRef(null)
  const fitRef        = useRef(null)

  // ── Startup countdown ──────────────────────────────────────────────────────
  const totalMs    = warmup ?? DEFAULT_WARMUP_MS
  const elapsed    = launchedAt ? Date.now() - launchedAt : totalMs
  const initRemain = Math.max(0, totalMs - elapsed)

  const [remainingMs, setRemainingMs] = useState(initRemain)
  const startupDoneRef = useRef(initRemain <= 0)

  useEffect(() => {
    if (initRemain <= 0) { startupDoneRef.current = true; return }
    const origin = Date.now()
    const tick = setInterval(() => {
      const left = Math.max(0, totalMs - elapsed - (Date.now() - origin))
      setRemainingMs(left)
      if (left <= 0) {
        clearInterval(tick)
        startupDoneRef.current = true
      }
    }, 80)
    return () => clearInterval(tick)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Poll plan.md every 2 s ─────────────────────────────────────────────────
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

  // ── Terminal ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: { background: '#1a1d23', foreground: '#abb2bf', cursor: '#61afef', selectionBackground: '#3e4451' },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
      fontSize,
      lineHeight: 1.4,
      cursorBlink: true,
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
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

    term.onData(data => { if (startupDoneRef.current) socket.emit('input', data) })

    const ro = new ResizeObserver(() => {
      fit.fit()
      socket.emit('resize', { cols: term.cols, rows: term.rows })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      socket.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [session]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Font size changes ──────────────────────────────────────────────────────
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize
      fitRef.current?.fit()
    }
  }, [fontSize])

  const label = entity.ticketId ? `T${entity.ticketId} — ${entity.label}` : entity.label
  const showCountdown = remainingMs > 0

  return (
    <div className="planning-modal-backdrop" onClick={onMinimize}>
      <div className="planning-modal" onClick={e => e.stopPropagation()}>
        <div className="planning-panel-header">
          <span className="planning-panel-title">Plan — {label}</span>
          <div className="term-font-controls">
            <button className="term-font-btn" onClick={() => setFontSize(s => Math.max(9, s - 1))} title="Decrease font size">A−</button>
            <button className="term-font-btn" onClick={() => setFontSize(s => Math.min(24, s + 1))} title="Increase font size">A+</button>
          </div>
          <button className="planning-close-btn" onClick={onMinimize} title="Minimize">─</button>
          <button className="planning-close-btn" onClick={onClose} title="Close">✕</button>
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
            {showCountdown && (
              <div className="term-startup-overlay">
                <div className="term-startup-spinner" />
                <div className="term-startup-secs">{Math.ceil(remainingMs / 1000)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
