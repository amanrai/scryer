import { Routes, Route } from 'react-router-dom'
import ProjectSelector from './screens/ProjectSelector.jsx'
import ProjectView from './screens/ProjectView.jsx'
import WorkLog from './screens/WorkLog.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ProjectSelector />} />
      <Route path="/projects/:name" element={<ProjectView />} />
      <Route path="/log" element={<WorkLog />} />
    </Routes>
  )
}
