import { Link, useLocation, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'

export default function AppHeader() {
  const { firebaseUser, profile } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const logout = async () => {
    await signOut(auth)
    navigate('/')
  }

  return (
    <header className="app-header">
      <Link className="brand" to="/"><span className="brand-mark">Q</span><span>Qline</span></Link>
      <nav className="app-nav">
        {firebaseUser ? (
          <>
            {profile?.role === 'org_admin' ? (
              <Link to="/dashboard">Dashboard</Link>
            ) : (
              <>
                <Link to="/join">Join organization</Link>
                <Link to="/my-appointments">My appointments</Link>
              </>
            )}
            <button type="button" className="button secondary" onClick={logout}>Sign out</button>
          </>
        ) : (
          <>
            <Link to={`/login${location.search}`} state={location.state}>Sign in</Link>
            <Link className="button primary" to={`/register${location.search}`} state={location.state}>Get started</Link>
          </>
        )}
      </nav>
    </header>
  )
}
