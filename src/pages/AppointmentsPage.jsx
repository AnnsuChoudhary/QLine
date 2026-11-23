import { useEffect, useState } from 'react'
import { collectionGroup, onSnapshot, query, updateDoc, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'
import { getLocalDateKey, isAppointmentActive, isTokenForDate } from '../dates.js'
import { updateQueueTokenStatus } from '../queues.js'

function readAppointment(document) {
  const data = document.data()
  return {
    id: `${document.ref.parent.parent?.id || ''}:${document.id}`,
    ref: document.ref,
    serviceName: typeof data?.serviceName === 'string' ? data.serviceName : 'Appointment',
    date: typeof data?.date === 'string' ? data.date : '',
    timeSlot: typeof data?.timeSlot === 'string' ? data.timeSlot : '',
    status: typeof data?.status === 'string' ? data.status : 'booked',
  }
}

function readQueueToken(document) {
  const data = document.data()
  const queueRef = document.ref.parent.parent
  const orgId = queueRef?.parent.parent?.id || ''
  const tokenNumber = Number.isSafeInteger(data?.tokenNumber) ? String(data.tokenNumber).padStart(3, '0') : document.id
  const queueName = typeof data?.queueName === 'string' && data.queueName.trim()
    ? data.queueName
    : `Queue ${queueRef?.id || ''}`.trim()

  return {
    id: `${orgId}:${queueRef?.id || ''}:${document.id}`,
    orgId,
    tokenNumber,
    queueId: queueRef?.id || '',
    queueName,
    serviceName: typeof data?.serviceName === 'string' && data.serviceName.trim() ? data.serviceName : queueName,
    queueDate: typeof data?.queueDate === 'string' ? data.queueDate : '',
    timeSlot: typeof data?.timeSlot === 'string' ? data.timeSlot : '',
    createdAt: data?.createdAt,
    status: typeof data?.status === 'string' ? data.status : 'unknown',
    ref: document.ref,
  }
}

export default function AppointmentsPage() {
  const { firebaseUser } = useAuth()
  const [results, setResults] = useState({ uid: '', appointments: [], tokens: [], ready: false, error: '' })
  const [cancellingId, setCancellingId] = useState('')

  useEffect(() => {
    const uid = firebaseUser?.uid
    if (!uid) return undefined

    let appointments = []
    let tokens = []
    let appointmentsReady = false
    let tokensReady = false
    const errors = []
    const publish = () => {
      setResults({
        uid,
        appointments,
        tokens,
        ready: appointmentsReady && tokensReady,
        error: errors.join(' '),
      })
    }
    const reportError = (label) => (requestError) => {
      console.error(label, requestError)
      errors.push(`${label} ${requestError.message}`)
      if (label.startsWith('Could not load appointments')) appointmentsReady = true
      if (label.startsWith('Could not load queue tokens')) tokensReady = true
      publish()
    }

    const appointmentsQuery = query(collectionGroup(db, 'appointments'), where('userId', '==', uid))
    const tokensQuery = query(collectionGroup(db, 'tokens'), where('userId', '==', uid))
    const unsubscribeAppointments = onSnapshot(appointmentsQuery, (snapshot) => {
      try {
        appointments = snapshot.docs.map(readAppointment)
        appointmentsReady = true
        publish()
      } catch (requestError) {
        reportError('Could not load appointments:')(requestError)
      }
    }, reportError('Could not load appointments:'))
    const unsubscribeTokens = onSnapshot(tokensQuery, (snapshot) => {
      try {
        tokens = snapshot.docs.map(readQueueToken)
        tokensReady = true
        publish()
      } catch (requestError) {
        reportError('Could not load queue tokens:')(requestError)
      }
    }, reportError('Could not load queue tokens:'))

    return () => {
      unsubscribeAppointments()
      unsubscribeTokens()
    }
  }, [firebaseUser?.uid])

  const cancelAppointment = async (appointment) => {
    setCancellingId(appointment.id)
    setResults((current) => ({ ...current, error: '' }))
    try {
      await updateDoc(appointment.ref, { status: 'cancelled' })
    } catch (requestError) {
      console.error('Could not cancel appointment:', requestError)
      setResults((current) => ({ ...current, error: `Could not cancel appointment: ${requestError.message}` }))
    } finally {
      setCancellingId('')
    }
  }

  const cancelToken = async (token) => {
    if (!window.confirm('Cancel this token? Repeated cancellations may pause future bookings with this organization.')) return
    setCancellingId(token.id)
    setResults((current) => ({ ...current, error: '' }))
    try {
      await updateQueueTokenStatus(token.orgId, token.queueId, token.ref.id, 'cancelled')
    } catch (requestError) {
      console.error('Could not cancel queue token:', requestError)
      setResults((current) => ({ ...current, error: `Could not cancel queue token: ${requestError.message}` }))
    } finally {
      setCancellingId('')
    }
  }

  const currentResults = results.uid === firebaseUser?.uid ? results : null
  const loading = !currentResults || !currentResults.ready
  const today = getLocalDateKey()
  const activeAppointments = (currentResults?.appointments || [])
    .filter((appointment) => isAppointmentActive(appointment, today))
    .sort((left, right) => `${left.date} ${left.timeSlot}`.localeCompare(`${right.date} ${right.timeSlot}`))
  const historyAppointments = (currentResults?.appointments || [])
    .filter((appointment) => !activeAppointments.includes(appointment))
    .sort((left, right) => `${right.date} ${right.timeSlot}`.localeCompare(`${left.date} ${left.timeSlot}`))
  const upcomingTokens = (currentResults?.tokens || [])
    .filter((token) => ['scheduled', 'waiting', 'serving'].includes(token.status)
      && (token.queueDate ? token.queueDate >= today : isTokenForDate(token, today)))
    .sort((left, right) => `${left.queueDate} ${left.timeSlot}`.localeCompare(`${right.queueDate} ${right.timeSlot}`))
  const liveTokens = upcomingTokens
    .filter((token) => (token.queueDate ? token.queueDate === today : isTokenForDate(token, today))
      && ['waiting', 'serving'].includes(token.status))
  const historyTokens = (currentResults?.tokens || [])
    .filter((token) => !upcomingTokens.includes(token))
  const cancelledAppointments = (currentResults?.appointments || []).filter((item) => item.status === 'cancelled')
  const cancelledTokens = (currentResults?.tokens || []).filter((item) => item.status === 'cancelled')
  const currentAppointments = activeAppointments.filter((item) => item.date === today)
  const upcomingAppointments = activeAppointments.filter((item) => item.date > today)
  const completedAppointments = historyAppointments.filter((item) => item.status !== 'cancelled')
  const closedTokens = historyTokens.filter((item) => item.status !== 'cancelled')
  const otherUpcomingTokens = upcomingTokens.filter((item) => !liveTokens.includes(item))
  const [activeFilter, setActiveFilter] = useState('all')
  const filterGroups = [
    { id: 'all', label: 'All', count: currentAppointments.length + liveTokens.length + upcomingAppointments.length + otherUpcomingTokens.length + completedAppointments.length + closedTokens.length + cancelledAppointments.length + cancelledTokens.length },
    { id: 'current', label: 'Current / Live', count: currentAppointments.length + liveTokens.length },
    { id: 'upcoming', label: 'Upcoming / Scheduled', count: upcomingAppointments.length + otherUpcomingTokens.length },
    { id: 'closed', label: 'Closed / Completed', count: completedAppointments.length + closedTokens.length },
    { id: 'cancelled', label: 'Cancelled', count: cancelledAppointments.length + cancelledTokens.length },
  ]

  const renderToken = (token, canCancel = false) => (
    <article className="panel appointment-row" key={token.id}>
      <div><strong>{token.serviceName} · {token.tokenNumber}</strong><small>{token.queueDate || 'Today'}{token.timeSlot ? ` at ${token.timeSlot}` : ''} · {token.queueName}</small></div>
      <div className="appointment-actions"><span className={`status-pill ${token.status}`}>{token.status === 'scheduled' ? 'Scheduled' : token.status}</span>{canCancel && <button className="button secondary" type="button" onClick={() => cancelToken(token)} disabled={Boolean(cancellingId)}>{cancellingId === token.id ? 'Cancelling…' : 'Cancel'}</button>}</div>
    </article>
  )

  const renderAppointment = (appointment, canCancel = false) => {
    const isPast = appointment.date < today
    const status = isPast && ['booked', 'checked_in'].includes(appointment.status) ? 'completed' : appointment.status
    const label = isPast && ['booked', 'checked_in'].includes(appointment.status)
      ? 'Past'
      : appointment.status === 'checked_in'
        ? 'Checked in'
        : appointment.status === 'booked'
          ? 'Scheduled'
          : appointment.status
    return (
      <article className="panel appointment-row" key={appointment.id}>
        <div><strong>{appointment.serviceName}</strong><small>{appointment.date}{appointment.timeSlot ? ` at ${appointment.timeSlot}` : ''}</small></div>
        <div className="appointment-actions"><span className={`status-pill ${status}`}>{label}</span>{canCancel && <button className="button secondary" type="button" onClick={() => cancelAppointment(appointment)} disabled={Boolean(cancellingId)}>{cancellingId === appointment.id ? 'Cancelling…' : 'Cancel booking'}</button>}</div>
      </article>
    )
  }

  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">YOUR BOOKINGS</p><h1>My appointments</h1></div></div>
        {currentResults?.error && <p className="form-error" role="alert">{currentResults.error}</p>}
        {loading ? <p className="muted">Loading appointments and queue tokens…</p> : (
          <>
            <nav className="appointment-filter-bar" aria-label="Filter appointments">
              {filterGroups.map((group) => <button
                type="button"
                key={group.id}
                className={activeFilter === group.id ? 'active' : ''}
                aria-pressed={activeFilter === group.id}
                onClick={() => setActiveFilter(group.id)}
              >{group.label}<span>{group.count}</span></button>)}
            </nav>
            {activeFilter === 'all' ? (
              <section className="appointment-list filtered-appointment-group">
                <h2>Your bookings</h2>
                {liveTokens.map((item) => renderToken(item))}
                {currentAppointments.map((item) => renderAppointment(item, true))}
                {otherUpcomingTokens.map((item) => renderToken(item, true))}
                {upcomingAppointments.map((item) => renderAppointment(item, true))}
                {closedTokens.map((item) => renderToken(item))}
                {completedAppointments.map((item) => renderAppointment(item))}
                {cancelledTokens.map((item) => renderToken(item))}
                {cancelledAppointments.map((item) => renderAppointment(item))}
                {!filterGroups[0].count && <p className="muted">Your upcoming appointments and queue tokens will appear here.</p>}
              </section>
            ) : (
              <section className="appointment-list filtered-appointment-group">
                <h2>{filterGroups.find((group) => group.id === activeFilter)?.label}</h2>
                {activeFilter === 'current' && <>
                  {liveTokens.map((item) => renderToken(item))}
                  {currentAppointments.map((item) => renderAppointment(item, true))}
                </>}
                {activeFilter === 'upcoming' && <>
                  {otherUpcomingTokens.map((item) => renderToken(item, true))}
                  {upcomingAppointments.map((item) => renderAppointment(item, true))}
                </>}
                {activeFilter === 'closed' && <>
                  {closedTokens.map((item) => renderToken(item))}
                  {completedAppointments.map((item) => renderAppointment(item))}
                </>}
                {activeFilter === 'cancelled' && <>
                  {cancelledTokens.map((item) => renderToken(item))}
                  {cancelledAppointments.map((item) => renderAppointment(item))}
                </>}
                {filterGroups.find((group) => group.id === activeFilter)?.count === 0
                  && <p className="muted">No {filterGroups.find((group) => group.id === activeFilter)?.label.toLowerCase()} items.</p>}
              </section>
            )}
          </>
        )}
      </section>
    </main>
  )
}
