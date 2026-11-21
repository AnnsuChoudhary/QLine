import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'

export default function AppHeader() {
  const { firebaseUser, profile } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [organization, setOrganization] = useState(null)
  const [signOutError, setSignOutError] = useState('')
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    let active = true
    if (profile?.role !== 'org_admin' || !profile.orgId) return () => { active = false }
    getDoc(doc(db, 'organizations', profile.orgId))
      .then((snapshot) => {
        if (!active) return
        const data = snapshot.exists() ? snapshot.data() : null
        setOrganization({ id: profile.orgId, name: typeof data?.name === 'string' ? data.name : '' })
      })
      .catch((error) => {
        console.error('Failed to load the organization name for the app header.', error)
      })
    return () => { active = false }
  }, [profile?.orgId, profile?.role])

  const logout = async () => {
    setSigningOut(true)
    setSignOutError('')
    try {
      await signOut(auth)
      navigate('/')
    } catch (error) {
      setSignOutError(error.message)
    } finally {
      setSigningOut(false)
    }
  }

  const organizationName = organization && organization.id === profile?.orgId ? organization.name : ''
  return (
    <header className="app-header">
      <Link className="brand" to="/"><span className="brand-mark">Q</span><span>Qline</span></Link>
      <nav className="app-nav">
        {firebaseUser ? (
          <>
            <span className="app-context" title={firebaseUser.email || ''}>
              <strong>{profile?.role === 'org_admin' ? organizationName || 'Organization' : profile?.name || firebaseUser.displayName || 'Account'}</strong>
              <small>{profile?.role === 'org_admin' ? 'Organization admin' : firebaseUser.email}</small>
            </span>
            {profile?.role === 'org_admin' ? (
              <Link to="/dashboard">Dashboard</Link>
            ) : (
              <>
                <Link to="/join">Join organization</Link>
                <Link to="/my-appointments">My appointments</Link>
              </>
            )}
            <button type="button" className="button secondary" onClick={logout} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
          </>
        ) : (
          <>
            <Link to={`/login${location.search}`} state={location.state}>Sign in</Link>
            <Link className="button primary" to={`/register${location.search}`} state={location.state}>Get started</Link>
          </>
        )}
      </nav>
      {signOutError && <p className="header-error" role="alert">{signOutError}</p>}
    </header>
  )
}
