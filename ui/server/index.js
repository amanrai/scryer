import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 7654

app.use(express.json({ limit: '20mb' }))

// Serve drops directory as static files
const dropsDir = join(homedir(), 'Code', 'plane.so', 'drops')
app.use('/drops', express.static(dropsDir))

// API routes (added in T14)
import apiRouter from './api.js'
app.use('/api', apiRouter)

// Serve built frontend in production
if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
