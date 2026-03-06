import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io } from 'socket.io-client'
import '@xterm/xterm/css/xterm.css'

const TMUX_SERVER = 'http://localhost:5055'
const MIN_FONT = 9
const MAX_FONT = 24

export default function AgentTerminal({ agent, onClose }) {
  const containerRef = useRef(null)
  const termRef      = useRef(null)
  const socketRef    = useRef(null)
  const fitRef       = useRef(null)
  const [fontSize, setFontSize]   = useState(15)
  const [sessions, setSessions]   = useState([])
  const [activeTab, setActiveTab] = useState(null)

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#1a1d23',
        foreground: '#abb2bf',
        cursor:     '#61afef',
        selectionBackground: '#3e4451',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
      fontSize: 15,
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

    socket.on('session_list', (list) => {
      setSessions(list)
      // If there's no active tab yet, try to find an existing resume session
      // or kick off a new one
      if (!activeTab) {
        const existing = list.find(s => s.name.startsWith(`resume-${agent}-`))
        if (existing) {
          socket.emit('attach', { session: existing.name, cols: term.cols, rows: term.rows })
        } else {
          socket.emit('resume', { agent, cols: term.cols, rows: term.rows })
        }
      }
    })

    socket.on('attached', ({ session }) => {
      setActiveTab(session)
    })

    socket.on('output', (data) => term.write(data))
    socket.on('session_ended', () => {
      term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n')
      setActiveTab(null)
    })

    term.onData((data) => socket.emit('input', data))

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
  }, [agent])

  function switchTab(name) {
    if (name === activeTab) return
    const socket = socketRef.current
    const term   = termRef.current
    if (!socket || !term) return
    socket.emit('attach', { session: name, cols: term.cols, rows: term.rows })
  }

  function changeFont(delta) {
    setFontSize(prev => {
      const next = Math.min(MAX_FONT, Math.max(MIN_FONT, prev + delta))
      if (termRef.current) {
        termRef.current.options.fontSize = next
        fitRef.current?.fit()
        const socket = socketRef.current
        if (socket) socket.emit('resize', { cols: termRef.current.cols, rows: termRef.current.rows })
      }
      return next
    })
  }

  // Short display name for a session
  function tabLabel(name) {
    return name.replace(/-([\w]{8})$/, ' ·$1').replace(/^resume-/, '')
  }

  return (
    <div className="terminal-wrap">
      <div className="terminal-tabbar">
        <div className="terminal-tabs">
          {sessions.map(s => (
            <button
              key={s.name}
              className={`terminal-tab ${s.name === activeTab ? 'active' : ''}`}
              onClick={() => switchTab(s.name)}
            >
              {tabLabel(s.name)}
            </button>
          ))}
        </div>
        <div className="terminal-tabbar-actions">
          <button onClick={() => changeFont(-1)} disabled={fontSize <= MIN_FONT}>A−</button>
          <button onClick={() => changeFont(1)}  disabled={fontSize >= MAX_FONT}>A+</button>
          <button className="terminal-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </div>
  )
}
