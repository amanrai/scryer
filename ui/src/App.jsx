import { createContext, useContext, useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import ProjectSelector from './screens/ProjectSelector.jsx'
import ProjectView from './screens/ProjectView.jsx'
import WorkLog from './screens/WorkLog.jsx'

export const ThemeContext = createContext({ theme: 'dark', setTheme: () => {} })
export function useTheme() { return useContext(ThemeContext) }

export default function App() {
  const [theme, setThemeState] = useState('dark')

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.theme) applyTheme(d.theme) })
      .catch(() => {})
  }, [])

  function applyTheme(t) {
    setThemeState(t)
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : '')
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme: applyTheme }}>
      <Routes>
        <Route path="/" element={<ProjectSelector />} />
        <Route path="/projects/:name" element={<ProjectView />} />
        <Route path="/log" element={<WorkLog />} />
      </Routes>
    </ThemeContext.Provider>
  )
}
