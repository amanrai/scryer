import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io } from 'socket.io-client'
import '@xterm/xterm/css/xterm.css'

const TMUX_SERVER = 'http://localhost:5055'

function buildMarkdown(mode, entity) {
  const modeNote = mode === 'build-interactive'
    ? 'Mode: Interactive — ask the user for confirmation before every action.'
    : 'Mode: Auto-build — work autonomously, no confirmation needed.'
  if (entity.type === 'ticket') {
    return [
      `# T${entity.ticketId} — ${entity.label}`,
      entity.description || '',
      modeNote,
    ].join('\n\n')
  }
  return `# ${entity.label}\n\n${modeNote}`
}

function entitySessionName(agent, entity) {
  return `${agent}-${entity.type}-${entity.ticketId ?? entity.entityId}`
}

function sessionLabel({ agent, entity }) {
  const tag = entity.ticketId ? `T${entity.ticketId}` : entity.label
  return `${agent} — ${tag}`
}

// One xterm instance per session. Kept mounted even when inactive — hidden via display:none.
// Refits when switching to active to handle size changes while hidden.
function TerminalView({ session, active, onSocket }) {
  const containerRef   = useRef(null)
  const termRef        = useRef(null)
  const fitRef         = useRef(null)
  const socketRef      = useRef(null)
  const tmuxSessionRef = useRef(null) // name of the underlying tmux session

  useEffect(() => {
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
    termRef.current  = term
    fitRef.current   = fit

    const socket = io(TMUX_SERVER)
    socketRef.current = socket
    onSocket?.(socket)

    socket.on('connect', () => {
      const { cols, rows } = term
      const { mode, agent, entity } = session

      if (mode === 'plan') {
        socket.emit('resume', {
          agent, cols, rows,
          workdir: entity.workdir,
          fresh: entity.fresh ?? false,
          startup_input: entity.startup_input ?? '',
          scope_type: entity.type === 'root' ? 'project' : entity.type,
          scope_id: entity.entityId ?? entity.ticketId ?? '',
        })
      } else if (mode === 'watch') {
        socket.emit('attach', { session: entitySessionName(agent, entity), cols, rows })
      } else {
        socket.emit('spawn', {
          agent,
          markdown: buildMarkdown(mode, entity),
          cols,
          rows,
          session_name: entitySessionName(agent, entity),
        })
      }
    })

    socket.on('attached', ({ session: name }) => {
      tmuxSessionRef.current = name
    })
    socket.on('output', data => term.write(data))
    socket.on('session_ended', () => term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n'))
    socket.on('session_not_found', ({ session: s }) => {
      term.write(`\r\n\x1b[31mNo active session: ${s}\x1b[0m\r\n`)
      term.write('\x1b[90mStart an Auto-build or Build Interactively session first.\x1b[0m\r\n')
    })
    socket.on('workdir_error', ({ message }) => {
      term.write(`\r\n\x1b[31m[Planning session error]\x1b[0m\r\n`)
      term.write(`\x1b[33m${message}\x1b[0m\r\n`)
    })

    term.onData(data => socket.emit('input', data))

    const ro = new ResizeObserver(() => {
      fit.fit()
      socket.emit('resize', { cols: term.cols, rows: term.rows })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      // Plan sessions: kill the tmux session when the tab is closed.
      // Build/agent sessions: leave running so the agent continues working.
      if (session.mode === 'plan' && tmuxSessionRef.current) {
        socket.emit('kill_session', { session: tmuxSessionRef.current })
      }
      socket.disconnect()
      term.dispose()
    }
  }, [])

  // Refit when this tab becomes active — size may have changed while hidden
  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        socketRef.current?.emit('resize', { cols: termRef.current.cols, rows: termRef.current.rows })
      })
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', display: active ? 'block' : 'none' }}
    />
  )
}

// Dockable terminal panel — tabs + dock controls header, one TerminalView per session.
export default function TerminalPanel({ sessions, activeId, onActivate, onClose, dock, onDockChange, onCollapse }) {
  // Map of session id → socket instance (populated by TerminalView on connect)
  const socketMap = useRef(new Map())
  // Map of session id → confirmation mode boolean (default: true = on)
  const [confirmModes, setConfirmModes] = useState({})

  const activeSession = sessions.find(s => s.id === activeId)
  const isPlanSession = activeSession?.mode === 'plan'
  const confirmOn = confirmModes[activeId] !== false // default true

  function handleConfirmToggle() {
    const next = !confirmOn
    setConfirmModes(prev => ({ ...prev, [activeId]: next }))
    const socket = socketMap.current.get(activeId)
    if (socket) {
      const msg = next
        ? 'SYSTEM: Confirmation mode switched ON. Please propose each ticket change (create, update, comment) and wait for my approval before executing.\r'
        : 'SYSTEM: Confirmation mode switched OFF. You may now make ticket changes autonomously without asking for approval first.\r'
      socket.emit('input', msg)
    }
  }

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <div className="term-tabs">
          {sessions.map(s => (
            <button
              key={s.id}
              className={`term-tab${s.id === activeId ? ' active' : ''}`}
              onClick={() => onActivate(s.id)}
            >
              {sessionLabel(s)}
              <span
                className="term-tab-close"
                onClick={e => { e.stopPropagation(); onClose(s.id) }}
              >×</span>
            </button>
          ))}
        </div>
        <div className="term-panel-controls">
          {isPlanSession && (
            <button
              className={`term-confirm-toggle${confirmOn ? ' active' : ''}`}
              onClick={handleConfirmToggle}
              title={confirmOn ? 'Confirmation ON — click to disable' : 'Confirmation OFF — click to enable'}
            >
              {confirmOn ? '🔒 Confirm' : '🔓 Auto'}
            </button>
          )}
          <button className={`term-dock-btn${dock === 'left'   ? ' active' : ''}`} onClick={() => onDockChange('left')}   title="Dock left">◀</button>
          <button className={`term-dock-btn${dock === 'bottom' ? ' active' : ''}`} onClick={() => onDockChange('bottom')} title="Dock bottom">▼</button>
          <button className={`term-dock-btn${dock === 'right'  ? ' active' : ''}`} onClick={() => onDockChange('right')}  title="Dock right">▶</button>
          <button className="term-dock-btn" onClick={onCollapse} title="Collapse">✕</button>
        </div>
      </div>

      <div className="term-panel-body">
        {sessions.map(s => (
          <TerminalView
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSocket={socket => socketMap.current.set(s.id, socket)}
          />
        ))}
      </div>
    </div>
  )
}
