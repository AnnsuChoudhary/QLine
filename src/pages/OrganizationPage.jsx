import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import AppHeader from '../components/AppHeader.jsx'

export default function OrganizationPage() {
  const { orgSlug } = useParams()
  const [result, setResult] = useState(null)

  useEffect(() => {
    let active = true
    getDocs(query(collection(db, 'organizations'), where('slug', '==', orgSlug)))
      .then((snapshot) => {
        if (active) {
          setResult({
            orgSlug,
            organization: snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() },
          })
        }
      })
      .catch((requestError) => {
        if (active) setResult({ orgSlug, error: requestError.message })
      })
    return () => { active = false }
  }, [orgSlug])

  const loading = result?.orgSlug !== orgSlug
  const organization = result?.organization
  const error = result?.error

  if (loading) return <main><AppHeader /><p className="load-state">Loading organization…</p></main>
  if (error) return <main><AppHeader /><p className="form-error page-shell" role="alert">{error}</p></main>
  if (!organization) return <main><AppHeader /><section className="page-shell"><h1>Organization not found</h1></section></main>

  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">{organization.category}</p><h1>{organization.name}</h1></div><span className="status-pill">Live</span></div>
        <div className="organization-grid">
          <section className="panel"><h2>Services</h2>{organization.services?.length ? organization.services.map((service) => <article className="service-row" key={service.id}><div><strong>{service.name}</strong><small>{service.duration} minutes</small></div><button className="button primary" type="button">Book</button></article>) : <p className="muted">No services are published yet.</p>}</section>
          <aside className="panel live-token-panel"><p className="eyebrow">LIVE QUEUE</p><strong className="large-token">—</strong><p>Join this organization to receive a live token.</p><button className="button primary" type="button" disabled>Join live queue</button></aside>
        </div>
      </section>
    </main>
  )
}
