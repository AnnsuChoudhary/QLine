import { useEffect, useState } from 'react'
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'

export default function DashboardPage() {
  const { firebaseUser, profile } = useAuth()
  const [organization, setOrganization] = useState(null)
  const [queue, setQueue] = useState([])
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (!profile?.orgId) return
    Promise.all([
      getDoc(doc(db, 'organizations', profile.orgId)),
      getDocs(query(collection(db, 'organizations', profile.orgId, 'queue'), orderBy('tokenNumber'))),
    ]).then(([orgSnapshot, queueSnapshot]) => {
      setOrganization(orgSnapshot.exists() ? { id: orgSnapshot.id, ...orgSnapshot.data() } : null)
      setQueue(queueSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    })
  }, [profile?.orgId])

  const copy = async (value, label) => {
    await navigator.clipboard.writeText(value)
    setCopied(label)
    window.setTimeout(() => setCopied(''), 1600)
  }

  if (!firebaseUser || !profile?.orgId) return <main><AppHeader /><p className="load-state">Loading organization dashboard…</p></main>

  const bookingLink = `${window.location.origin}/org/${organization?.slug || ''}`
  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">ORGANIZATION ADMIN</p><h1>{organization?.name || 'Dashboard'}</h1></div>{organization?.verificationStatus === 'pending' && <span className="status-pill warning">Verification pending</span>}</div>
        <div className="dashboard-cards">
          <section className="panel"><h2>Live queue</h2>{queue.length ? queue.map((token) => <div className="queue-row" key={token.id}><strong>{String(token.tokenNumber).padStart(2, '0')}</strong><span>{token.userName}<small>{token.serviceName}</small></span><span className="status-pill">{token.status}</span></div>) : <p className="muted">No active queue tokens.</p>}<button className="button primary" type="button" disabled>Call next token</button></section>
          <section className="panel share-panel"><h2>Organization access</h2><label>Join code<div className="copy-row"><strong>{organization?.joinCode || '—'}</strong><button className="button secondary" type="button" onClick={() => copy(organization?.joinCode || '', 'code')}>{copied === 'code' ? 'Copied' : 'Copy'}</button></div></label><label>Shareable booking link<div className="copy-row"><span>{bookingLink}</span><button className="button secondary" type="button" onClick={() => copy(bookingLink, 'link')}>{copied === 'link' ? 'Copied' : 'Copy'}</button></div></label></section>
        </div>
      </section>
    </main>
  )
}
