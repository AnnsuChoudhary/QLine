import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, doc, getDocs, query, updateDoc, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'

export default function JoinPage() {
  const { firebaseUser, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [organizations, setOrganizations] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    getDocs(collection(db, 'organizations'))
      .then((snapshot) => {
        if (active) {
          setOrganizations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const openOrganization = async (organization) => {
    setError('')
    setLoading(true)
    try {
      const joinedOrgs = [...new Set([...(profile?.joinedOrgs || []), organization.id])]
      if (!profile?.joinedOrgs?.includes(organization.id)) {
        await updateDoc(doc(db, 'users', firebaseUser.uid), { joinedOrgs })
        await refreshProfile(firebaseUser.uid)
      }
      navigate(`/org/${organization.slug}`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const normalized = code.trim().toUpperCase()
      if (!/^[A-Z0-9]{6}$/.test(normalized)) {
        throw new Error('Enter the 6-character organization join code.')
      }
      const snapshot = await getDocs(query(collection(db, 'organizations'), where('joinCode', '==', normalized)))
      if (snapshot.empty) throw new Error('No organization found with that join code.')
      const organization = snapshot.docs[0]
      await openOrganization({ id: organization.id, ...organization.data() })
    } catch (requestError) {
      setError(requestError.message)
      setLoading(false)
    }
  }

  const joinedOrgs = new Set(profile?.joinedOrgs || [])

  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">USER ORGANIZATION HUB</p><h1>Choose an organization</h1></div></div>
        <div className="join-grid">
          <form className="panel join-form" onSubmit={submit}>
            <h2>Enter a join code</h2>
            <p>Use the 6-character code shared by an organization.</p>
            <label>Organization join code<input className="join-code-input" value={code} maxLength={6} placeholder="CLN402" onChange={(event) => setCode(event.target.value.toUpperCase())} required /></label>
            <button className="button primary" type="submit" disabled={loading}>Find organization</button>
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
          <section className="panel">
            <h2>Organizations</h2>
            {loading ? <p className="muted">Loading organizations…</p> : organizations.length ? organizations.map((organization) => (
              <button className="organization-row" type="button" key={organization.id} disabled={loading} onClick={() => openOrganization(organization)}>
                <span><strong>{organization.name}</strong><small>{organization.category}</small></span>
                <span>{joinedOrgs.has(organization.id) ? 'Open' : 'Join'}</span>
              </button>
            )) : <p className="muted">No organizations are available yet.</p>}
          </section>
        </div>
      </section>
    </main>
  )
}
