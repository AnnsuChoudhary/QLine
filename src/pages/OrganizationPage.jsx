import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { collection, doc, getDoc, getDocs, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import AppHeader from '../components/AppHeader.jsx'
import { useAuth } from '../context/useAuth.js'
import { formatTokenNumber, joinPipelineStep, joinQueue, updateQueueTokenStatus } from '../queues.js'
import { getAvailableTimeSlots, getLocalDateKey, isTokenForDate, isValidDateKey } from '../dates.js'
import { getNextPipelineStep, getPipelineStepStatus } from '../pipelines.js'

const EMPTY_PIPELINES = []

function getErrorMessage(error, fallback) {
  return typeof error?.message === 'string' && error.message.trim() ? error.message : fallback
}

export default function OrganizationPage() {
  const { orgSlug } = useParams()
  const [searchParams] = useSearchParams()
  const { firebaseUser, profile } = useAuth()
  const [result, setResult] = useState(null)
  const [queueState, setQueueState] = useState({ organizationId: '', queues: [] })
  const [pipelineState, setPipelineState] = useState({ organizationId: '', pipelines: [] })
  const [pipelineRunState, setPipelineRunState] = useState({ organizationId: '', runsByPipeline: {} })
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
      .then(async (snapshot) => {
        if (!active) return
        if (!snapshot.empty) {
          setResult({ orgSlug, organization: { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } })
          return
        }
        const byId = await getDoc(doc(db, 'organizations', orgSlug))
        if (active) setResult({ orgSlug, organization: byId.exists() ? { id: byId.id, ...byId.data() } : null })
      })
      .catch((requestError) => {
        if (active) setResult({ orgSlug, error: getErrorMessage(requestError, 'Could not load this organization.') })
      })
    return () => { active = false }
  }, [orgSlug])

  const organizationId = result?.orgSlug === orgSlug ? result.organization?.id : null
  const queues = queueState.organizationId === organizationId ? queueState.queues : []
  const pipelines = pipelineState.organizationId === organizationId ? pipelineState.pipelines : EMPTY_PIPELINES
  const runsByPipeline = pipelineRunState.organizationId === organizationId ? pipelineRunState.runsByPipeline : {}

  useEffect(() => {
    if (!organizationId) return undefined
    return onSnapshot(
      collection(db, 'organizations', organizationId, 'queues'),
      (snapshot) => {
        const nextQueues = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        setQueueState({ organizationId, queues: nextQueues })
      },
      (requestError) => setQueueError(getErrorMessage(requestError, 'Could not load the organization queues.')),
    )
  }, [organizationId])

  useEffect(() => {
    if (!organizationId) return undefined
    return onSnapshot(
      collection(db, 'organizations', organizationId, 'pipelines'),
      (snapshot) => setPipelineState({
        organizationId,
        pipelines: snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
          .filter((pipeline) => pipeline.published === true
            && typeof pipeline.name === 'string'
            && Array.isArray(pipeline.queueIds)
            && pipeline.queueIds.length >= 2),
      }),
      (requestError) => setQueueError(getErrorMessage(requestError, 'Could not load published pipelines.')),
    )
  }, [organizationId])

  useEffect(() => {
    if (!organizationId || !firebaseUser?.uid || !pipelines.length) {
      return undefined
    }
    const unsubscribers = pipelines.map((pipeline) => onSnapshot(
      query(
        collection(db, 'organizations', organizationId, 'pipelines', pipeline.id, 'runs'),
        where('userId', '==', firebaseUser.uid),
      ),
      (snapshot) => setPipelineRunState((current) => ({
        organizationId,
        runsByPipeline: {
          ...(current.organizationId === organizationId ? current.runsByPipeline : {}),
          [pipeline.id]: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
        },
      })),
      (requestError) => setQueueError(getErrorMessage(requestError, 'Could not load your pipeline progress.')),
    ))
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [organizationId, firebaseUser?.uid, pipelines])

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
      (requestError) => setQueueError(getErrorMessage(requestError, 'Could not load the selected queue tokens.')),
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
  const visiblePipelines = pipelines
  const publishedPipelineIds = new Set(pipelines.map((pipeline) => pipeline.id))
  const pipelineQueueIds = new Set(pipelines.flatMap((pipeline) => pipeline.queueIds))
  const offerings = (publishedServices.length ? publishedServices : queues.map((queue) => ({
    id: queue.id,
    name: queue.name,
    description: queue.purpose,
    queueId: queue.id,
  }))).filter((service) => !pipelineQueueIds.has(service.queueId || service.id))
  const bookingService = offerings.find((service) => service.id === bookingServiceId)
  const availableBookingQueues = queues.filter((queue) => !pipelineQueueIds.has(queue.id))
  const bookingQueue = availableBookingQueues.find((queue) => queue.id === bookingQueueId)
  const availableSlots = bookingService
    ? getAvailableTimeSlots(
      bookingDate,
      Number.isSafeInteger(bookingService.duration) ? bookingService.duration : 30,
      organization?.openingTime || '09:00',
      organization?.closingTime || '17:00',
    )
    : []
  const requiredEmailDomain = typeof organization?.bookingVerification?.requiredEmailDomain === 'string'
    ? organization.bookingVerification.requiredEmailDomain
    : ''
  const queueIsOpenToday = selectedQueue?.status === 'open'
    && (!selectedQueue.activeDate || selectedQueue.activeDate === today)
  const selectedQueueInPipeline = selectedQueue?.pipelineIds?.some((pipelineId) => publishedPipelineIds.has(pipelineId)) === true

  const joinSelectedQueue = async () => {
    if (currentToken) return
    if (selectedQueueInPipeline) {
      setQueueError('This queue is part of a published pipeline. Start from the pipeline’s first step.')
      return
    }
    if (!organization?.id || !selectedQueue?.id) {
      setQueueError('Choose an available organization queue before joining.')
      return
    }
    if (!firebaseUser?.uid) {
      setQueueError('Sign in before joining a queue.')
      return
    }
    setBusy(true)
    setQueueError('')
    try {
      await joinQueue(organization.id, selectedQueue.id, firebaseUser, {
        serviceId: selectedQueue.id,
        serviceName: selectedQueue.name,
        profile,
      })
    } catch (requestError) {
      setQueueError(getErrorMessage(requestError, 'Could not join this queue. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const leaveQueue = async () => {
    if (!organization?.id || !selectedQueue?.id || !currentToken?.id) {
      setQueueError('The queue token is no longer available. Refresh the page and try again.')
      return
    }
    if (!window.confirm('Cancel this token? Repeated cancellations may pause future bookings with this organization.')) return
    setBusy(true)
    setQueueError('')
    try {
      await updateQueueTokenStatus(organization.id, selectedQueue.id, currentToken.id, 'cancelled')
    } catch (requestError) {
      setQueueError(getErrorMessage(requestError, 'Could not update this queue token. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const joinPipeline = async (pipeline, runId = '') => {
    if (!firebaseUser?.uid) {
      setQueueError('Sign in before joining a pipeline.')
      return
    }
    if (!organization?.id) return
    setBusy(true)
    setQueueError('')
    try {
      await joinPipelineStep(organization.id, pipeline.id, firebaseUser, { runId, profile })
    } catch (requestError) {
      setQueueError(getErrorMessage(requestError, 'Could not join this pipeline step.'))
    } finally {
      setBusy(false)
    }
  }

  const bookService = async (event) => {
    event.preventDefault()
    if (!organization?.id) {
      setBookingError('This organization is no longer available. Refresh the page and try again.')
      return
    }
    if (!bookingService) {
      setBookingError('Choose an available service before booking.')
      return
    }
    if (!bookingQueue?.id || !availableBookingQueues.some((queue) => queue.id === bookingQueue.id)) {
      setBookingError('Choose an available queue for this booking.')
      return
    }
    if (!firebaseUser?.uid) {
      setBookingError('Sign in before confirming a booking.')
      return
    }
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
        profile,
      })
      setBookingNotice(`${bookingService.name} is booked for ${bookingDate} at ${bookingTime}. Your token is ${formatTokenNumber(token.tokenNumber)}${token.status === 'waiting' ? ' and is in today’s live queue.' : '.'}`)
      setBookingServiceId('')
      setBookingTime('')
    } catch (requestError) {
      setBookingError(getErrorMessage(requestError, 'Could not complete this booking. Please try again.'))
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
        <div className="page-heading"><div><p className="eyebrow">{organization.category || 'Organization'}</p><h1>{organization.name}</h1></div>{selectedQueue && <span className={`status-pill ${queueIsOpenToday ? 'serving' : 'completed'}`}>{queueIsOpenToday ? 'Queue open today' : 'Queue closed'}</span>}</div>
        <div className="organization-grid">
          <section className="panel">
            <h2>Services & scheduled bookings</h2>
            <p className="muted">Choose a date and time window. Your token is reserved for that queue and becomes active when its slot starts.</p>
            <p className="verification-note">Bookings require a verified email address{requiredEmailDomain ? ` from ${requiredEmailDomain}` : ''}. Verification is checked automatically when you book.</p>
            <p className="muted">Each account can hold up to 3 active bookings per queue and 5 across this organization, with per-scheduled-date limits of 5 per queue and 10 total. Repeated cancellations or no-shows may pause new bookings under this organization’s policy.</p>
            {offerings.length ? offerings.map((service) => <article className="service-row" key={service.id}>
              <div><strong>{service.name}</strong><small>{service.duration ? `${service.duration} minutes` : service.description || 'Available offering'}</small></div>
              <button className="button primary" type="button" onClick={() => {
                setBookingServiceId(service.id)
                setBookingQueueId(
                  availableBookingQueues.some((queue) => queue.id === service.queueId)
                    ? service.queueId
                    : selectedQueue && availableBookingQueues.some((queue) => queue.id === selectedQueue.id)
                      ? selectedQueue.id
                      : availableBookingQueues[0]?.id || '',
                )
                setBookingError('')
                setBookingNotice('')
              }}>Book</button>
            </article>) : <p className="muted">No services or queues are published yet.</p>}
            {bookingNotice && <p className="form-success" role="status">{bookingNotice}</p>}
            {bookingService && <form className="booking-form" onSubmit={bookService}>
              <h3>Schedule {bookingService.name}</h3>
              <label>Date<input type="date" min={today} value={bookingDate} onChange={(event) => { setBookingDate(event.target.value); setBookingTime('') }} required /></label>
              {!availableBookingQueues.some((item) => item.id === bookingService.queueId) && availableBookingQueues.length > 0 && <label>Queue
                <select value={bookingQueueId} onChange={(event) => setBookingQueueId(event.target.value)} required>
                  {availableBookingQueues.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>}
              {!availableBookingQueues.length && <p className="muted">No standalone queue is available for this service. Join its published pipeline from the pipeline section.</p>}
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
            {visiblePipelines.length > 0 && <section className="pipeline-tracking">
              <p className="eyebrow">WORKFLOWS / PIPELINES</p>
              <h2>Sequential processes</h2>
              {visiblePipelines.map((pipeline) => {
                const runs = runsByPipeline[pipeline.id] || []
                const requestedRun = runs.find((run) => run.id === searchParams.get('run')
                  && pipeline.id === searchParams.get('pipeline'))
                const run = requestedRun || runs.find((item) => ['active', 'ready'].includes(item.status)) || runs[0]
                const nextStep = run ? getNextPipelineStep(pipeline, run) : null
                return <article className="pipeline-customer-card" key={pipeline.id}>
                  <div className="section-heading"><strong>{pipeline.name}</strong>{run && <span className={`status-pill ${run.status}`}>{run.status === 'ready' ? 'Ready for next step' : run.status}</span>}</div>
                  <ol className="pipeline-customer-steps">
                    {pipeline.queueIds.map((queueId, index) => {
                      const stepNumber = index + 1
                      const queue = queues.find((item) => item.id === queueId)
                      const token = run?.steps?.[index]
                      return <li key={`${queueId}-${index}`}>
                        <span><strong>Step {stepNumber}: {queue?.name || 'Queue unavailable'}</strong>
                          {token?.tokenNumber ? ` · Token ${formatTokenNumber(token.tokenNumber)}` : ''}
                        </span>
                        <span className="status-pill">{getPipelineStepStatus(stepNumber, run)}</span>
                      </li>
                    })}
                  </ol>
                  {!run || ['completed', 'concluded'].includes(run.status)
                    ? <button className="button primary" type="button" onClick={() => joinPipeline(pipeline)} disabled={busy || !firebaseUser}>{busy ? 'Joining…' : `Start ${pipeline.name}`}</button>
                    : run.status === 'ready' && nextStep !== null
                      ? <button className="button primary" type="button" onClick={() => joinPipeline(pipeline, run.id)} disabled={busy}>{busy ? 'Joining…' : `Join step ${nextStep + 1}: ${queues.find((item) => item.id === pipeline.queueIds[nextStep])?.name || 'Next queue'}`}</button>
                      : <p className="muted">Continue with {queues.find((item) => item.id === run.currentQueueId)?.name || 'the current queue'}; your next step unlocks when this one is completed.</p>}
                </article>
              })}
            </section>}
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
              {currentToken ? <><div className="queue-summary-stats"><span><strong>{waitingCount}</strong> waiting</span><span><strong>{Math.max(0, waitingCount - (currentToken.status === 'waiting' ? 1 : 0))}</strong> ahead</span></div><button className="button secondary" type="button" onClick={leaveQueue} disabled={busy}>{currentToken.status === 'scheduled' ? 'Cancel booking' : 'Leave queue'}</button></> : <button className="button primary" type="button" onClick={joinSelectedQueue} disabled={busy || selectedQueueInPipeline || selectedQueue.status !== 'open' || (selectedQueue.activeDate && selectedQueue.activeDate !== today)}>{busy ? 'Joining…' : selectedQueueInPipeline ? 'Join through pipeline' : `Join today’s ${selectedQueue.name}`}</button>}
            </> : <><strong className="large-token">—</strong><p>{queues.length ? 'Select a queue to see its live status.' : 'No queues are available yet.'}</p></>}
            {queueError && <p className="form-error" role="alert">{queueError}</p>}
          </aside>
        </div>
      </section>
    </main>
  )
}
