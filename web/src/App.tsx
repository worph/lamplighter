import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Chat from './pages/Chat'
import Repos from './pages/Repos'
import Repo from './pages/Repo'
import Activity from './pages/Activity'
import Settings from './pages/Settings'
import Round from './pages/Round'
import Proposal from './pages/Proposal'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/repos" element={<Repos />} />
        <Route path="/repos/:key" element={<Repo />} />
        <Route path="/rounds/:id" element={<Round />} />
        <Route path="/proposals/:id" element={<Proposal />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
