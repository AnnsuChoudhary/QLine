import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'

export default function ProtectedRoute({ orgAdminOnly = false, userOnly = false }) {
  const { firebaseUser, profile, loading } = useAuth()
  const location = useLocation()

  if (loading) return <main className="load-state">Loading QLine…</main>
  if (!firebaseUser) {
    const from = `${location.pathname}${location.search}${location.hash}`
    return <Navigate to="/login" replace state={{ from }} />
  }
  if (orgAdminOnly && !firebaseUser.emailVerified) return <Navigate to="/login" replace state={{ verificationRequired: true }} />
  if (orgAdminOnly && profile?.role !== 'org_admin') return <Navigate to="/join" replace />
  if (userOnly && profile?.role === 'org_admin') return <Navigate to="/dashboard" replace />
  return <Outlet />
}
