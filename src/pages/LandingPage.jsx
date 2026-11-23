import { useEffect, useMemo, useState } from 'react'
import { collectionGroup, doc, getDoc, onSnapshot, query, where } from 'firebase/firestore'
import { Link } from 'react-router-dom'
import { ArrowRight, Building2, CalendarDays, Clock3 } from 'lucide-react'
import AppHeader from '../components/AppHeader.jsx'
import { useAuth } from '../context/useAuth.js'
import { db } from '../firebase/config.js'
import { getLocalDateKey } from '../dates.js'

export default function LandingPage() {
  const { firebaseUser, profile } = useAuth()
  const isOrganizationAdmin = profile?.role === 'org_admin'
  const displayName = profile?.name || firebaseUser?.displayName || ''
  const [bookings, setBookings] = useState({ uid: '', appointments: [], tokens: [], error: '' })
  const [organizations, setOrganizations] = useState({ ids: [], items: [], error: '' })
  const joinedOrgIds = useMemo(
    () => [...new Set((profile?.joinedOrgs || []).filter((id) => typeof id === 'string'))].slice(-4).reverse(),
    [profile?.joinedOrgs],
  )
  const joinedOrgKey = joinedOrgIds.join('|')

  useEffect(() => {
    const uid = firebaseUser?.uid
    if (!uid || profile?.role === 'org_admin') return undefined

    let appointments = []
    let tokens = []
    let appointmentsReady = false
    let tokensReady = false
    let error = ''
    const publish = () => {
      if (appointmentsReady && tokensReady) setBookings({ uid, appointments, tokens, error })
    }
    const handleError = (kind) => (requestError) => {
      console.error(`Could not load ${kind} for the home page:`, requestError)
      error = `Could not load ${kind}: ${requestError.message}`
      if (kind === 'appointments') appointmentsReady = true
      else tokensReady = true
      publish()
    }
    const unsubscribeAppointments = onSnapshot(
      query(collectionGroup(db, 'appointments'), where('userId', '==', uid)),
      (snapshot) => {
        try {
          appointments = snapshot.docs.map((item) => {
            const data = item.data()
            return {
              id: item.id,
              serviceName: typeof data.serviceName === 'string' ? data.serviceName : 'Appointment',
              orgId: item.ref.parent.parent?.id || '',
              date: typeof data.date === 'string' ? data.date : '',
              time: typeof data.timeSlot === 'string' ? data.timeSlot : '',
              status: typeof data.status === 'string' ? data.status : '',
            }
          })
          appointmentsReady = true
          publish()
        } catch (requestError) {
          handleError('appointments')(requestError)
        }
      },
      handleError('appointments'),
    )
    const unsubscribeTokens = onSnapshot(
      query(collectionGroup(db, 'tokens'), where('userId', '==', uid)),
      (snapshot) => {
        try {
          tokens = snapshot.docs.map((item) => {
            const data = item.data()
            const queueRef = item.ref.parent.parent
            return {
              id: item.id,
              serviceName: typeof data.serviceName === 'string' ? data.serviceName : 'Queue token',
              orgId: queueRef?.parent.parent?.id || '',
              date: typeof data.queueDate === 'string' ? data.queueDate : '',
              time: typeof data.timeSlot === 'string' ? data.timeSlot : '',
              status: typeof data.status === 'string' ? data.status : '',
              tokenNumber: data.tokenNumber,
            }
          })
          tokensReady = true
          publish()
        } catch (requestError) {
          handleError('queue tokens')(requestError)
        }
      },
      handleError('queue tokens'),
    )
    return () => {
      unsubscribeAppointments()
      unsubscribeTokens()
    }
  }, [firebaseUser?.uid, profile?.role])

  useEffect(() => {
    let active = true
    if (!joinedOrgIds.length) return () => { active = false }
    Promise.all(joinedOrgIds.map(async (id) => {
      const snapshot = await getDoc(doc(db, 'organizations', id))
      return snapshot.exists() ? { id, ...snapshot.data() } : null
    })).then((items) => {
      if (active) setOrganizations({ ids: joinedOrgIds, items: items.filter(Boolean), error: '' })
    }).catch((requestError) => {
      console.error('Could not load recently joined organizations:', requestError)
      if (active) setOrganizations({ ids: joinedOrgIds, items: [], error: `Could not load your organizations: ${requestError.message}` })
    })
    return () => { active = false }
  }, [joinedOrgIds])

  const today = getLocalDateKey()
  const organizationsReady = organizations.ids.join('|') === joinedOrgKey
  const currentBookings = bookings.uid === firebaseUser?.uid ? bookings : { appointments: [], tokens: [], error: '' }
  const activeAppointments = currentBookings.appointments
    .filter((item) => ['booked', 'checked_in'].includes(item.status) && item.date >= today)
    .sort((left, right) => `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`))
    .slice(0, 3)
  const activeTokens = currentBookings.tokens
    .filter((item) => ['scheduled', 'waiting', 'serving'].includes(item.status) && item.date >= today)
    .sort((left, right) => `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`))
    .slice(0, 3)

  return (
    <main className="landing-shell">
      <AppHeader />
      {firebaseUser && !isOrganizationAdmin ? (
        <section className="page-shell home-dashboard">
          <div className="home-welcome">
            <div><p className="eyebrow">YOUR QLINE</p><h1>{displayName ? `Good to see you, ${displayName}` : 'Your appointments and queues'}</h1>
              <p>Keep track of upcoming visits and active queue tokens, or find a place to join.</p></div>
            <div className="home-actions">
              <Link className="button primary" to="/join"><Building2 size={17} /> Find an organization</Link>
              <Link className="button secondary" to="/my-appointments">All appointments</Link>
            </div>
          </div>
          {currentBookings.error && <p className="form-error" role="alert">{currentBookings.error}</p>}
          <div className="home-overview-grid">
            <section className="panel home-bookings">
              <div className="section-heading"><h2>Next up</h2><Link to="/my-appointments">View all <ArrowRight size={15} /></Link></div>
              {currentBookings.uid !== firebaseUser.uid ? <p className="muted">Loading your latest bookings…</p> : (
                <>
                  {activeTokens.map((item) => <Link className="home-booking-row" to={`/org/${encodeURIComponent(item.orgId)}`} key={`token-${item.id}`}>
                    <span className="home-booking-icon"><Clock3 size={18} /></span>
                    <div><strong>{item.serviceName}{Number.isSafeInteger(item.tokenNumber) ? ` · ${String(item.tokenNumber).padStart(3, '0')}` : ''}</strong><small>{item.date === today ? 'Today' : item.date}{item.time ? ` · ${item.time}` : ''} · {item.status}</small></div>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>)}
                  {activeAppointments.map((item) => <Link className="home-booking-row" to={`/org/${encodeURIComponent(item.orgId)}`} key={`appointment-${item.id}`}>
                    <span className="home-booking-icon"><CalendarDays size={18} /></span>
                    <div><strong>{item.serviceName}</strong><small>{item.date === today ? 'Today' : item.date}{item.time ? ` · ${item.time}` : ''} · {item.status.replace('_', ' ')}</small></div>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>)}
                  {!activeTokens.length && !activeAppointments.length && <div className="home-empty"><p>No upcoming appointments or active tokens.</p><Link to="/join">Join an organization to get started</Link></div>}
                </>
              )}
            </section>
            <section className="panel home-organizations">
              <div className="section-heading"><h2>Recently joined</h2><Link to="/join">Browse</Link></div>
              {organizationsReady && organizations.error && <p className="form-error" role="alert">{organizations.error}</p>}
              {organizationsReady && organizations.items.length ? organizations.items.map((organization) => (
                <Link className="home-organization-row" to={`/org/${encodeURIComponent(organization.slug || organization.id)}`} key={organization.id}>
                  <span><strong>{organization.name || 'Organization'}</strong><small>{organization.category || 'QLine organization'}</small></span><ArrowRight size={17} />
                </Link>
              )) : !organizationsReady ? <p className="muted">Loading your organizations…</p> : !organizations.error && <p className="muted">{joinedOrgIds.length ? 'No joined organizations were found.' : 'Organizations you join will appear here.'}</p>}
              <Link className="button secondary home-join-link" to="/join">Join with a code</Link>
            </section>
          </div>
        </section>
      ) : (
        <>
          <section className="hero">
            <p className="eyebrow">{firebaseUser ? `WELCOME BACK${displayName ? `, ${displayName}` : ''}` : 'APPOINTMENTS & LIVE QUEUES'}</p>
            <h1>{firebaseUser ? <>Your day,<br />without the wait.</> : <>Skip the wait.<br />Keep your day moving.</>}</h1>
            <p>{isOrganizationAdmin
              ? 'Review your organization’s queue, bookings, services, and operating hours from one dashboard.'
              : firebaseUser
                ? 'Find your organization, manage bookings, and keep up with today’s queue.'
                : 'Book appointments, join live queues, and manage organizations with a straightforward service.'}</p>
            <div className="hero-actions">
              {isOrganizationAdmin ? (
                <Link className="button primary" to="/dashboard"><Building2 size={18} /> Open your dashboard <ArrowRight size={16} /></Link>
              ) : firebaseUser ? (
                <>
                  <Link className="button primary" to="/join"><CalendarDays size={18} /> Find an organization <ArrowRight size={16} /></Link>
                  <Link className="button secondary" to="/my-appointments">View my appointments</Link>
                </>
              ) : (
                <>
                  <Link className="button primary" to="/register"><CalendarDays size={18} /> Get started <ArrowRight size={16} /></Link>
                  <Link className="button secondary" to="/register?role=organization"><Building2 size={18} /> Register an organization</Link>
                </>
              )}
            </div>
          </section>
          {!firebaseUser && <section className="feature-grid" aria-label="QLine features">
            <article><CalendarDays /><h2>Appointments</h2><p>Find available times and manage your upcoming bookings.</p></article>
            <article><Clock3 /><h2>Live queue updates</h2><p>Follow your token and see queue progress when current information is available.</p></article>
            <article><Building2 /><h2>Organization tools</h2><p>Manage services, operating hours, appointments, and customer flow.</p></article>
          </section>}
        </>
      )}
    </main>
  )
}
