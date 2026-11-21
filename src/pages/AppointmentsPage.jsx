import { useEffect, useState } from 'react'
import { collectionGroup, onSnapshot, query, updateDoc, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'
import { getLocalDateKey, isAppointmentActive, isTokenForDate } from '../dates.js'

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
    tokenNumber,
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
    setCancellingId(token.id)
    setResults((current) => ({ ...current, error: '' }))
    try {
      await updateDoc(token.ref, { status: 'cancelled' })
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

  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">YOUR BOOKINGS</p><h1>My appointments</h1></div></div>
        {currentResults?.error && <p className="form-error" role="alert">{currentResults.error}</p>}
        {loading ? <p className="muted">Loading appointments and queue tokens…</p> : (
          <>
            <section className="appointment-list">
              <h2>Upcoming / scheduled</h2>
              {upcomingTokens.length ? upcomingTokens.map((token) => <article className="panel appointment-row" key={token.id}>
                <div><strong>{token.serviceName} · {token.tokenNumber}</strong><small>{token.queueDate || 'Today'}{token.timeSlot ? ` at ${token.timeSlot}` : ''} · {token.queueName}</small></div>
                <div className="appointment-actions"><span className="status-pill">{token.status === 'scheduled' ? 'Scheduled' : token.status}</span><button className="button secondary" type="button" onClick={() => cancelToken(token)} disabled={Boolean(cancellingId)}>{cancellingId === token.id ? 'Cancelling…' : 'Cancel'}</button></div>
              </article>) : <p className="muted">No upcoming queue tokens.</p>}
              {activeAppointments.length ? activeAppointments.map((appointment) => <article className="panel appointment-row" key={appointment.id}>
                <div><strong>{appointment.serviceName}</strong><small>{appointment.date}{appointment.timeSlot ? ` at ${appointment.timeSlot}` : ''}</small></div>
                <div className="appointment-actions"><span className="status-pill">{appointment.status === 'checked_in' ? 'Checked in' : 'Scheduled'}</span><button className="button secondary" type="button" onClick={() => cancelAppointment(appointment)} disabled={Boolean(cancellingId)}>{cancellingId === appointment.id ? 'Cancelling…' : 'Cancel booking'}</button></div>
              </article>) : upcomingTokens.length === 0 && <p className="muted">No upcoming appointments.</p>}
            </section>
            <section className="appointment-list">
              <h2>Today’s live queue tokens</h2>
              {liveTokens.length ? liveTokens.map((token) => <article className="panel appointment-row" key={token.id}>
                <div><strong>{token.serviceName} · {token.tokenNumber}</strong><small>{token.timeSlot ? `Today at ${token.timeSlot}` : 'Live token for today'} · {token.queueName}</small></div><span className="status-pill">{token.status}</span>
              </article>) : <p className="muted">No active live tokens today.</p>}
            </section>
            <section className="appointment-list appointment-history">
              <h2>History</h2>
              {historyAppointments.length > 0 && <div className="appointment-list">
                <h3>Past and completed appointments</h3>
                {historyAppointments.map((appointment) => <article className="panel appointment-row" key={appointment.id}>
                  <div><strong>{appointment.serviceName}</strong><small>{appointment.date}{appointment.timeSlot ? ` at ${appointment.timeSlot}` : ''}</small></div><span className="status-pill">{appointment.status}</span>
                </article>)}
              </div>}
              {historyTokens.length > 0 && <div className="appointment-list queue-token-list">
                <h3>Past queue tokens</h3>
                {historyTokens.map((token) => <article className="panel appointment-row" key={token.id}>
                  <div><strong>{token.serviceName} · {token.tokenNumber}</strong><small>{token.queueDate || 'Past'}{token.timeSlot ? ` at ${token.timeSlot}` : ''} · {token.queueName}</small></div><span className="status-pill">{token.status}</span>
                </article>)}
              </div>}
              {historyAppointments.length === 0 && historyTokens.length === 0 && <p className="muted">Completed, cancelled, and past items will appear here.</p>}
            </section>
          </>
        )}
      </section>
    </main>
  )
}
