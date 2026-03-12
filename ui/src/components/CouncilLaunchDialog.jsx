import { useState, useEffect } from 'react'

const DEFAULT_MODEL = { claude: 'claude-sonnet-4-6', codex: 'gpt-5.4', gemini: 'gemini-3.1-pro-preview' }

export default function CouncilLaunchDialog({ entityType, entityId, entityLabel, onClose, onLaunched }) {
  const [personas, setPersonas]   = useState([])
  const [seats, setSeats]         = useState([])
  const [launching, setLaunching] = useState(false)
  const [error, setError]         = useState(null)

  useEffect(() => {
    fetch('/api/personas')
      .then(r => r.json())
      .then(d => {
        setPersonas(d.personas ?? [])
        setSeats((d.personas ?? []).map((p, i) => ({
          persona_slug: p.id,
          provider:     'claude',
          model:      DEFAULT_MODEL.claude,
          seat_order: i,
          included:   true,
          instances:  1,
        })))
      })
  }, [])

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleIncluded(idx) {
    setSeats(prev => prev.map((s, i) => i === idx ? { ...s, included: !s.included } : s))
  }

  function setProvider(idx, provider) {
    setSeats(prev => prev.map((s, i) => i === idx
      ? { ...s, provider, model: DEFAULT_MODEL[provider] ?? '' }
      : s
    ))
  }

  function setModel(idx, model) {
    setSeats(prev => prev.map((s, i) => i === idx ? { ...s, model } : s))
  }

  async function launch() {
    const activeSets = seats.filter(s => s.included)
    if (!activeSets.length) { setError('Select at least one persona.'); return }
    setLaunching(true)
    setError(null)
    try {
      // Expand seats by instances count
      const expandedSeats = []
      let order = 0
      for (const s of activeSets) {
        for (let n = 0; n < (s.instances ?? 1); n++) {
          expandedSeats.push({ persona_slug: s.persona_slug, provider: s.provider, model: s.model, seat_order: order++ })
        }
      }
      const res = await fetch('/api/council/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id:   String(entityId),
          seats: expandedSeats,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      // Poll until the debate appears, then hand it to the parent
      let tries = 0
      const poll = setInterval(async () => {
        if (tries++ > 20) { clearInterval(poll); setError('Council started but debate not found — try refreshing.'); setLaunching(false); return }
        const r = await fetch(`/api/debates?entity_type=${entityType}&entity_id=${encodeURIComponent(entityId)}`)
        const d = await r.json()
        if (d.debate) { clearInterval(poll); onLaunched(d.debate) }
      }, 1000)
    } catch (e) {
      setError(e.message)
      setLaunching(false)
    }
  }

  const includedCount = seats.filter(s => s.included).length

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div className="council-launch-dialog" onClick={e => e.stopPropagation()}>
        <div className="council-launch-header">
          <span className="council-launch-icon">⚖</span>
          <div>
            <h2 className="council-launch-title">Launch Agent Council</h2>
            <p className="council-launch-sub">{entityLabel}</p>
          </div>
          <button className="mm-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="council-launch-body">
          <p className="council-launch-desc">
            Select the personas that will review this entity. Each analyses through their own lens
            and debates via the comment thread until all pass in the same round.
          </p>

          {personas.length === 0 && (
            <p className="mm-modal-desc mm-modal-empty">Loading personas…</p>
          )}

          <div className="council-seat-list">
            {personas.map((persona, idx) => {
              const seat = seats[idx] ?? {}
              return (
                <div key={persona.id} className={`council-seat ${seat.included ? 'included' : 'excluded'}`}>
                  <div className="council-seat-row">
                    <label className="council-seat-toggle">
                      <input
                        type="checkbox"
                        checked={seat.included ?? true}
                        onChange={() => toggleIncluded(idx)}
                      />
                      <span className="council-seat-name">{persona.name}</span>
                    </label>
                    {seat.included && (
                      <div className="council-seat-config">
                        <select
                          className="council-seat-select"
                          value={seat.provider ?? 'claude'}
                          onChange={e => setProvider(idx, e.target.value)}
                        >
                          <option value="claude">Claude</option>
                          <option value="codex">Codex</option>
                          <option value="gemini">Gemini</option>
                        </select>
                        <input
                          className="council-seat-model-input"
                          value={seat.model ?? ''}
                          onChange={e => setModel(idx, e.target.value)}
                          placeholder="model ID"
                          spellCheck={false}
                        />
                        <input
                          className="council-seat-instances"
                          type="number"
                          min={1}
                          max={5}
                          value={seat.instances ?? 1}
                          onChange={e => setSeats(prev => prev.map((s, i) => i === idx ? { ...s, instances: Math.max(1, parseInt(e.target.value) || 1) } : s))}
                          title="Instances"
                        />
                      </div>
                    )}
                  </div>
                  {persona.description && (
                    <p className="council-seat-desc">{persona.description.replace(/\*\*/g, '')}</p>
                  )}
                </div>
              )
            })}
          </div>

          {error && <p className="council-launch-error">{error}</p>}
        </div>

        <div className="council-launch-footer">
          <span className="council-seat-count">{includedCount} persona{includedCount !== 1 ? 's' : ''} selected</span>
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-save" onClick={launch} disabled={launching || !includedCount}>
            {launching ? 'Launching…' : 'Launch Council'}
          </button>
        </div>
      </div>
    </div>
  )
}
