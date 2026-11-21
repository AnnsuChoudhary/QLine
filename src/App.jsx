import { Route, Routes } from 'react-router-dom'
import './App.css'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import LandingPage from './pages/LandingPage.jsx'
import AuthPage from './pages/AuthPage.jsx'
import JoinPage from './pages/JoinPage.jsx'
import OrganizationPage from './pages/OrganizationPage.jsx'
import AppointmentsPage from './pages/AppointmentsPage.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import NotFoundPage from './pages/NotFoundPage.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/join" element={<JoinPage />} />
        <Route path="/org/:orgSlug" element={<OrganizationPage />} />
        <Route path="/my-appointments" element={<AppointmentsPage />} />
      </Route>

      <Route element={<ProtectedRoute orgAdminOnly />}>
        <Route path="/dashboard" element={<DashboardPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
