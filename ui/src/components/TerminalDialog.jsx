import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io } from 'socket.io-client'
import '@xterm/xterm/css/xterm.css'

const TMUX_SERVER = 'http://localhost:5055'

const MODE_LABELS = {
  plan:                'Plan',
  'build-interactive': 'Build Interactively',
  auto:                'Auto-build',
  watch:               'Watch',
}

function buildMarkdown(mode, entity) {
  const modeNote = mode === 'build-interactive'
    ? 'Mode: Interactive — ask the user for confirmation before every action.'
    : 'Mode: Auto-build — work autonomously, no confirmation needed.'

  if (entity.type === 'ticket') {
    return [
      `# T${entity.ticketId} — ${entity.label}`,
      entity.description ? `\n${entity.description}` : '',
      `\n${modeNote}`,
    ].join('\n')
  }
  return `# ${entity.label}\n\n${modeNote}`
}

// Deterministic session name so Watch can find what spawn created.
// Format: {agent}-{entityType}-{entityId}
function entitySessionName(agent, entity) {
  const id = entity.ticketId ?? entity.entityId
  return `${agent}-${entity.type}-${id}`
}

export default function TerminalDialog({ agent, mode, entity, onClose }) {
  const containerRef = useRef(null)
  const termRef      = useRef(null)
  const socketRef    = useRef(null)
  const fitRef       = useRef(null)

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#1a1d23',
        foreground: '#abb2bf',
        cursor: '#61afef',
        selectionBackground: '#3e4451',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current  = fit

    const socket = io(TMUX_SERVER)
    socketRef.current = socket

    socket.on('connect', () => {
      const { cols, rows } = term

      if (mode === 'plan') {
        socket.emit('resume', { agent, cols, rows })

      } else if (mode === 'watch') {
        // Attach to an existing auto/build session — does not kill it on disconnect
        const session = entitySessionName(agent, entity)
        socket.emit('attach', { session, cols, rows })

      } else {
        // auto / build-interactive: spawn with a predictable name so Watch can find it
        socket.emit('spawn', {
          agent,
          markdown: buildMarkdown(mode, entity),
          cols,
          rows,
          session_name: entitySessionName(agent, entity),
        })
      }
    })

    socket.on('output', data => term.write(data))

    socket.on('session_ended', () => {
      term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n')
    })

    socket.on('session_not_found', ({ session }) => {
      term.write(`\r\n\x1b[31mNo active session found: ${session}\x1b[0m\r\n`)
      term.write('\x1b[90mStart an Auto-build or Build Interactively session first.\x1b[0m\r\n')
    })

    term.onData(data => socket.emit('input', data))

    const ro = new ResizeObserver(() => {
      fit.fit()
      if (socketRef.current) {
        socketRef.current.emit('resize', { cols: term.cols, rows: term.rows })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      socket.disconnect()
      term.dispose()
    }
  }, [agent, mode, entity])

  return (
    <div className="tdialog-backdrop" onClick={onClose}>
      <div className="tdialog" onClick={e => e.stopPropagation()}>
        <div className="tdialog-header">
          <span className="tdialog-title">
            {MODE_LABELS[mode]} — {agent}
            {entity.ticketId ? ` — T${entity.ticketId}` : ` — ${entity.label}`}
          </span>
          <button className="tdialog-close" onClick={onClose}>✕</button>
        </div>
        <div className="tdialog-body" ref={containerRef} />
      </div>
    </div>
  )
}
