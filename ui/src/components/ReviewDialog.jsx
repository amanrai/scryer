import { useEffect, useState, useCallback } from 'react'

const STATUS_LABEL = {
  M:  { text: 'M', title: 'Modified',       color: '#e5c07b' },
  A:  { text: 'A', title: 'Added',           color: '#98c379' },
  D:  { text: 'D', title: 'Deleted',         color: '#e06c75' },
  R:  { text: 'R', title: 'Renamed',         color: '#61afef' },
  '??': { text: '?', title: 'Untracked',     color: '#abb2bf' },
}

function statusMeta(code) {
  return STATUS_LABEL[code] || STATUS_LABEL['??']
}

function parseDiff(raw) {
  if (!raw) return []
  const lines = raw.split('\n')
  const chunks = []
  let currentHunk = null

  for (const line of lines) {
    if (line.startsWith('@@')) {
      currentHunk = { header: line, lines: [] }
      chunks.push(currentHunk)
    } else if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'add', text: line.slice(1) })
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'del', text: line.slice(1) })
      } else if (!line.startsWith('\\')) {
        currentHunk.lines.push({ type: 'ctx', text: line.slice(1) })
      }
    }
  }
  return chunks
}

function DiffViewer({ diff, loading }) {
  if (loading) return <div className="review-diff-empty">Loading…</div>
  if (!diff) return <div className="review-diff-empty">Select a file to view changes.</div>

  const chunks = parseDiff(diff)
  if (!chunks.length) return <div className="review-diff-empty">No diff available.</div>

  return (
    <div className="review-diff-scroll">
      {chunks.map((chunk, ci) => (
        <div key={ci} className="review-hunk">
          <div className="review-hunk-header">{chunk.header}</div>
          <table className="review-diff-table">
            <tbody>
              {chunk.lines.map((line, li) => (
                <tr key={li} className={`review-diff-line review-diff-line--${line.type}`}>
                  <td className="review-diff-gutter">
                    {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
                  </td>
                  <td className="review-diff-code">
                    <pre>{line.text || ' '}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

export default function ReviewDialog({ project, onClose }) {
  const [files, setFiles]           = useState([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError]   = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [diff, setDiff]             = useState(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [committing, setCommitting]   = useState(false)
  const [commitMsg, setCommitMsg]     = useState('')
  const [showCommitInput, setShowCommitInput] = useState(false)
  const [discarding, setDiscarding]   = useState(false)
  const [actionError, setActionError] = useState(null)

  const fetchFiles = useCallback(() => {
    fetch(`/api/projects/${encodeURIComponent(project.name)}/review`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setFiles(d.files)
        setFilesError(null)
      })
      .catch(e => setFilesError(e.message))
      .finally(() => setFilesLoading(false))
  }, [project.name])

  useEffect(() => {
    fetchFiles()
    const id = setInterval(fetchFiles, 5000)
    return () => clearInterval(id)
  }, [fetchFiles])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleDiscard() {
    if (!selectedFile) return
    if (!window.confirm(`Discard changes to ${selectedFile.path}? This cannot be undone.`)) return
    setDiscarding(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.name)}/review/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selectedFile.path }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setSelectedFile(null)
      setDiff(null)
      fetchFiles()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setDiscarding(false)
    }
  }

  async function handleCommit() {
    if (!commitMsg.trim() || !selectedFile) return
    setCommitting(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.name)}/review/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selectedFile.path, message: commitMsg.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setShowCommitInput(false)
      setCommitMsg('')
      setSelectedFile(null)
      setDiff(null)
      fetchFiles()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setCommitting(false)
    }
  }

  function selectFile(file) {
    setSelectedFile(file)
    setDiff(null)
    setDiffLoading(true)
    fetch(`/api/projects/${encodeURIComponent(project.name)}/review/diff?file=${encodeURIComponent(file.path)}`)
      .then(r => r.json())
      .then(d => setDiff(d.diff || ''))
      .catch(() => setDiff(''))
      .finally(() => setDiffLoading(false))
  }

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div className="review-dialog" onClick={e => e.stopPropagation()}>
        <div className="review-header">
          <span className="review-title">Review — {project.name}</span>
          <button className="float-dialog-close" onClick={onClose}>✕</button>
        </div>

        <div className="review-body">
          {/* Left pane: changed files */}
          <div className="review-files">
            <div className="review-pane-label">
              Changed files
              {!filesLoading && !filesError && (
                <span className="review-file-count">{files.length}</span>
              )}
            </div>
            {filesLoading && <div className="review-file-empty">Loading…</div>}
            {filesError && <div className="review-file-empty review-file-error">{filesError}</div>}
            {!filesLoading && !filesError && files.length === 0 && (
              <div className="review-file-empty">No changes.</div>
            )}
            {files.map(f => {
              const meta = statusMeta(f.status)
              const selected = selectedFile?.path === f.path
              return (
                <button
                  key={f.path}
                  className={`review-file-row${selected ? ' review-file-row--selected' : ''}`}
                  onClick={() => selectFile(f)}
                  title={`${meta.title}: ${f.path}`}
                >
                  <span className="review-file-status" style={{ color: meta.color }}>{meta.text}</span>
                  <span className="review-file-path">{f.path}</span>
                </button>
              )
            })}
          </div>

          {/* Right pane: diff */}
          <div className="review-diff">
            <div className="review-diff-toolbar">
              <span className="review-pane-label" style={{ border: 'none', padding: 0 }}>
                {selectedFile ? selectedFile.path : 'Diff'}
              </span>
              {selectedFile && (
                <div className="review-actions">
                  <button className="review-btn review-btn--discard" onClick={handleDiscard} disabled={discarding}>
                    {discarding ? 'Discarding…' : 'Discard'}
                  </button>
                  {!showCommitInput ? (
                    <button className="review-btn review-btn--commit" onClick={() => setShowCommitInput(true)}>
                      Accept &amp; Commit
                    </button>
                  ) : (
                    <div className="review-commit-row">
                      <input
                        className="review-commit-input"
                        placeholder="Commit message…"
                        value={commitMsg}
                        onChange={e => setCommitMsg(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && commitMsg.trim()) handleCommit()
                          if (e.key === 'Escape') { setShowCommitInput(false); setCommitMsg('') }
                        }}
                        autoFocus
                      />
                      <button className="review-btn review-btn--commit" onClick={handleCommit} disabled={committing || !commitMsg.trim()}>
                        {committing ? 'Committing…' : 'Commit'}
                      </button>
                    </div>
                  )}
                  {actionError && <span className="review-file-error" style={{ fontSize: '0.7rem' }}>{actionError}</span>}
                </div>
              )}
            </div>
            <DiffViewer diff={diff} loading={diffLoading} />
          </div>
        </div>
      </div>
    </div>
  )
}
