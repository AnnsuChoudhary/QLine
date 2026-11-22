import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { collection, doc, getDocs, onSnapshot, query, updateDoc, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import AppHeader from '../components/AppHeader.jsx'
import { useAuth } from '../context/useAuth.js'
import { formatTokenNumber, joinQueue } from '../queues.js'
import { getAvailableTimeSlots, getLocalDateKey, isTokenForDate, isValidDateKey } from '../dates.js'

export default function OrganizationPage() {
  const { orgSlug } = useParams()
  const { firebaseUser } = useAuth()
  const [result, setResult] = useState(null)
  const [queueState, setQueueState] = useState({ organizationId: '', queues: [] })
  const [selectedQueueId, setSelectedQueueId] = useState('')
  const [tokenState, setTokenState] = useState({ key: '', tokens: [] })
  const [bookingServiceId, setBookingServiceId] = useState('')
  const [bookingQueueId, setBookingQueueId] = useState('')
  const [bookingDate, setBookingDate] = useState('')
  const [bookingTime, setBookingTime] = useState('')
  const [bookingNotice, setBookingNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [queueError, setQueueError] = useState('')
  const [bookingError, setBookingError] = useState('')

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

  const organizationId = result?.orgSlug === orgSlug ? result.organization?.id : null
  useEffect(() => {
    if (!organizationId) return undefined
    return onSnapshot(
      collection(db, 'organizations', organizationId, 'queues'),
      (snapshot) => {
        const nextQueues = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        setQueueState({ organizationId, queues: nextQueues })
      },
      (requestError) => setQueueError(requestError.message),
    )
  }, [organizationId])

  const queues = queueState.organizationId === organizationId ? queueState.queues : []
  const activeQueueId = queues.some((item) => item.id === selectedQueueId) ? selectedQueueId : queues[0]?.id || ''
  const tokenStateKey = `${organizationId || ''}:${activeQueueId}`
  useEffect(() => {
    if (!organizationId || !activeQueueId) return undefined
    return onSnapshot(
      query(
        collection(db, 'organizations', organizationId, 'queues', activeQueueId, 'tokens'),
        where('status', 'in', ['scheduled', 'waiting', 'serving']),
      ),
      (snapshot) => setTokenState({
        key: tokenStateKey,
        tokens: snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
          .sort((left, right) => left.tokenNumber - right.tokenNumber),
      }),
      (requestError) => setQueueError(requestError.message),
    )
  }, [organizationId, activeQueueId, tokenStateKey])

  const loading = result?.orgSlug !== orgSlug
  const organization = result?.organization
  const error = result?.error
  const selectedQueue = queues.find((item) => item.id === activeQueueId)
  const today = getLocalDateKey()
  const tokens = tokenState.key === tokenStateKey
    ? tokenState.tokens.filter((token) => isTokenForDate(token, today))
    : []
  const currentToken = tokens
    .filter((item) => item.userId === firebaseUser?.uid && ['scheduled', 'waiting', 'serving'].includes(item.status))
    .sort((left, right) => {
      const priority = { serving: 0, waiting: 1, scheduled: 2 }
      return priority[left.status] - priority[right.status]
        || (left.timeSlot || '').localeCompare(right.timeSlot || '')
    })[0]
  const servingToken = tokens.find((item) => item.status === 'serving')
  const waitingCount = tokens.filter((item) => item.status === 'waiting').length
  const publishedServices = Array.isArray(organization?.services)
    ? organization.services
      .filter((service) => service && typeof service.name === 'string' && service.name.trim() && service.active !== false)
      .map((service, index) => ({
        ...service,
        id: typeof service.id === 'string' && service.id ? service.id : `${service.name}-${index}`,
      }))
    : []
  const offerings = publishedServices.length ? publishedServices : queues.map((queue) => ({
    id: queue.id,
    name: queue.name,
    description: queue.purpose,
    queueId: queue.id,
  }))
  const bookingService = offerings.find((service) => service.id === bookingServiceId)
  const bookingQueue = queues.find((queue) => queue.id === bookingQueueId)
  const availableSlots = bookingService
    ? getAvailableTimeSlots(
      bookingDate,
      Number.isSafeInteger(bookingService.duration) ? bookingService.duration : 30,
      organization?.openingTime || '09:00',
      organization?.closingTime || '17:00',
    )
    : []

  const joinSelectedQueue = async () => {
    if (!selectedQueue || currentToken) return
    setBusy(true)
    setQueueError('')
    try {
      await joinQueue(organization.id, selectedQueue.id, firebaseUser, {
        serviceId: selectedQueue.id,
        serviceName: selectedQueue.name,
      })
    } catch (requestError) {
      setQueueError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const leaveQueue = async () => {
    if (!currentToken) return
    setBusy(true)
    setQueueError('')
    try {
      await updateDoc(doc(db, 'organizations', organization.id, 'queues', selectedQueue.id, 'tokens', currentToken.id), { status: 'cancelled' })
    } catch (requestError) {
      setQueueError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const bookService = async (event) => {
    event.preventDefault()
    if (!bookingService || !bookingQueue) return
    setBusy(true)
    setBookingError('')
    setBookingNotice('')
    try {
      if (!isValidDateKey(bookingDate) || bookingDate < today) {
        throw new Error('Choose today or a future date for your booking.')
      }
      const currentSlots = getAvailableTimeSlots(
        bookingDate,
        Number.isSafeInteger(bookingService.duration) ? bookingService.duration : 30,
        organization.openingTime || '09:00',
        organization.closingTime || '17:00',
      )
      if (!currentSlots.includes(bookingTime)) {
        throw new Error('Choose an available time slot for the selected date.')
      }
      const token = await joinQueue(organization.id, bookingQueue.id, firebaseUser, {
        date: bookingDate,
        timeSlot: bookingTime,
        serviceId: bookingService.id,
        serviceName: bookingService.name,
        allowScheduled: true,
      })
      setBookingNotice(`${bookingService.name} is booked for ${bookingDate} at ${bookingTime}. Your token is ${formatTokenNumber(token.tokenNumber)}${token.status === 'waiting' ? ' and is in today’s live queue.' : '.'}`)
      setBookingServiceId('')
      setBookingTime('')
    } catch (requestError) {
      setBookingError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <main><AppHeader /><p className="load-state">Loading organization…</p></main>
  if (error) return <main><AppHeader /><p className="form-error page-shell" role="alert">{error}</p></main>
  if (!organization) return <main><AppHeader /><section className="page-shell"><h1>Organization not found</h1></section></main>

  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">{organization.category}</p><h1>{organization.name}</h1></div><span className="status-pill">Live</span></div>
        <div className="organization-grid">
          <section className="panel">
            <h2>Services & scheduled bookings</h2>
            <p className="muted">Choose a date and time window. Your token is reserved for that queue and becomes active when its slot starts.</p>
            {offerings.length ? offerings.map((service) => <article className="service-row" key={service.id}>
              <div><strong>{service.name}</strong><small>{service.duration ? `${service.duration} minutes` : service.description || 'Available offering'}</small></div>
              <button className="button primary" type="button" onClick={() => {
                setBookingServiceId(service.id)
                setBookingQueueId(service.queueId || selectedQueue?.id || queues[0]?.id || '')
                setBookingError('')
                setBookingNotice('')
              }}>Book</button>
            </article>) : <p className="muted">No services or queues are published yet.</p>}
            {bookingNotice && <p className="form-success" role="status">{bookingNotice}</p>}
            {bookingService && <form className="booking-form" onSubmit={bookService}>
              <h3>Schedule {bookingService.name}</h3>
              <label>Date<input type="date" min={today} value={bookingDate} onChange={(event) => { setBookingDate(event.target.value); setBookingTime('') }} required /></label>
              {!queues.some((item) => item.id === bookingService.queueId) && queues.length > 0 && <label>Queue
                <select value={bookingQueueId} onChange={(event) => setBookingQueueId(event.target.value)} required>
                  {queues.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>}
              {!queues.length && <p className="muted">This organization has no active queue to issue a token for yet.</p>}
              <label>Available time
                <select value={bookingTime} onChange={(event) => setBookingTime(event.target.value)} disabled={!bookingDate || !availableSlots.length} required>
                  <option value="">Choose a time</option>
                  {availableSlots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
                </select>
              </label>
              {!bookingDate
                ? <p className="muted">Choose a date to see its available time slots.</p>
                : !availableSlots.length && <p className="muted">No time slots are available for this date.</p>}
              <p className="muted">Slots run {organization.openingTime || '09:00'}–{organization.closingTime || '17:00'}; elapsed slots today are unavailable.</p>
              <button className="button primary" type="submit" disabled={busy || !bookingQueue || !bookingDate || !bookingTime}>{busy ? 'Booking…' : 'Confirm booking'}</button>
              <button className="button secondary" type="button" onClick={() => setBookingServiceId('')} disabled={busy}>Cancel</button>
              {bookingError && <p className="form-error" role="alert">{bookingError}</p>}
            </form>}
          </section>
          <aside className="panel live-token-panel">
            <p className="eyebrow">LIVE QUEUE · TODAY</p>
            {queues.length > 0 && <label className="queue-select-label user-queue-select">Choose a queue
              <select value={activeQueueId} onChange={(event) => setSelectedQueueId(event.target.value)} aria-label="Choose a queue">
                {queues.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.purpose || item.id.slice(0, 6)}</option>)}
              </select>
            </label>}
            {selectedQueue ? <>
              <p className="queue-description">{selectedQueue.purpose || 'General service queue'}</p>
              <strong className="large-token">{currentToken ? formatTokenNumber(currentToken.tokenNumber) : servingToken ? formatTokenNumber(servingToken.tokenNumber) : '—'}</strong>
              <p>{currentToken?.status === 'serving' ? 'It is your turn.' : currentToken?.status === 'waiting' ? 'Your token is in today’s live queue.' : currentToken ? `Scheduled for today at ${currentToken.timeSlot || 'your selected time'}; it enters the live queue when the slot starts and the queue is open.` : servingToken ? 'Now serving' : 'No token is being served.'}</p>
              {currentToken ? <><div className="queue-summary-stats"><span><strong>{waitingCount}</strong> waiting</span><span><strong>{Math.max(0, waitingCount - (currentToken.status === 'waiting' ? 1 : 0))}</strong> ahead</span></div><button className="button secondary" type="button" onClick={leaveQueue} disabled={busy}>{currentToken.status === 'scheduled' ? 'Cancel booking' : 'Leave queue'}</button></> : <button className="button primary" type="button" onClick={joinSelectedQueue} disabled={busy || selectedQueue.status !== 'open' || (selectedQueue.activeDate && selectedQueue.activeDate !== today)}>{busy ? 'Joining…' : `Join today’s ${selectedQueue.name}`}</button>}
            </> : <><strong className="large-token">—</strong><p>{queues.length ? 'Select a queue to see its live status.' : 'No queues are available yet.'}</p></>}
            {queueError && <p className="form-error" role="alert">{queueError}</p>}
          </aside>
        </div>
      </section>
    </main>
  )
}
