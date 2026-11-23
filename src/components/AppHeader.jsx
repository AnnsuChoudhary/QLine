import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { Menu, X } from 'lucide-react'
import { auth } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import ThemeToggle from './ThemeToggle.jsx'

export default function AppHeader() {
  const { firebaseUser, profile } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [signOutError, setSignOutError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const logout = async () => {
    setSigningOut(true)
    setSignOutError('')
    try {
      await signOut(auth)
      setMenuOpen(false)
      navigate('/')
    } catch (error) {
      setSignOutError(error.message)
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <header className="app-header">
      <Link className="brand" to="/"><span className="brand-mark">Q</span><span>Qline</span></Link>
      <nav className="app-nav">
        {firebaseUser ? (
          <>
            <div className={`app-links${menuOpen ? ' mobile-open' : ''}`} id="app-navigation-links" onClick={() => setMenuOpen(false)}>
              {profile?.role === 'org_admin' ? (
                <Link to="/dashboard">Dashboard</Link>
              ) : (
                <>
                  <Link to="/join">Join organization</Link>
                  <Link to="/my-appointments">My appointments</Link>
                </>
              )}
              <Link className="mobile-profile-link" to="/profile">Profile</Link>
            </div>
            <Link className="app-context" to="/profile" title="Open your profile">
              <strong>{profile?.name || firebaseUser.displayName || firebaseUser.email || 'Account'}</strong>
              <small>{firebaseUser.email}</small>
            </Link>
            <button type="button" className="button secondary" onClick={logout} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
          </>
        ) : (
          <>
            <div className={`app-links${menuOpen ? ' mobile-open' : ''}`} id="app-navigation-links" onClick={() => setMenuOpen(false)}>
              <Link to={`/login${location.search}`} state={location.state}>Sign in</Link>
            </div>
            <Link className="button primary" to={`/register${location.search}`} state={location.state}>Get started</Link>
          </>
        )}
        <ThemeToggle />
        <button
          className="icon-button app-menu-toggle"
          type="button"
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={menuOpen}
          aria-controls="app-navigation-links"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
        </button>
      </nav>
      {signOutError && <p className="header-error" role="alert">{signOutError}</p>}
    </header>
  )
}
