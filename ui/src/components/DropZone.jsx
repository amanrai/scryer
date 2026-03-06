import { useState, useRef, useEffect } from 'react'

export default function DropZone() {
  const [history, setHistory] = useState([])
  const [over, setOver] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    fetch('/api/drops')
      .then(r => r.json())
      .then(d => setHistory(d.files || []))
  }, [])

  function handleFiles(files) {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        fetch('/api/drop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: e.target.result, filename: file.name }),
        })
          .then(r => r.json())
          .then(d => setHistory(prev => [d.saved, ...prev]))
      }
      reader.readAsDataURL(file)
    })
  }

  return (
    <div className="drop-pane">
      <div
        className={`drop-zone ${over ? 'over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); handleFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={e => handleFiles(e.target.files)}
        />
        <span className="drop-hint">drop screenshots here</span>
      </div>

      <div className="drop-history">
        {history.map(f => (
          <div key={f} className="drop-item">
            <img src={`/drops/${f}`} alt={f} />
            <span>{f.replace(/T|-/g, (c, i) => i === 10 ? ' ' : i < 10 ? '-' : c === 'T' ? ' ' : ':').slice(0, 19)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
