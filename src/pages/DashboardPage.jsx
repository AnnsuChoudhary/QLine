import { useEffect, useRef, useState } from 'react'
import { collection, deleteDoc, doc, getDoc, onSnapshot, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'
import { getLocalDateKey, isTokenForDate, isTokenTimeDue } from '../dates.js'
import { concludePipelineRun, formatTokenNumber, updateQueueTokenStatus } from '../queues.js'
import { BOOKING_PROFILE_FIELDS, emailDomainPattern } from '../bookingVerification.js'
import { DEFAULT_BOOKING_INTEGRITY, removeActiveBookingFromLimits } from '../bookingLimits.js'
import { validatePipelineDraft } from '../pipelines.js'

const EMPTY_PIPELINES = []

function readQueue(document) {
  const data = document.data()
  return {
    id: document.id,
    name: typeof data?.name === 'string' && data.name.trim() ? data.name : 'Unnamed queue',
    purpose: typeof data?.purpose === 'string' ? data.purpose : '',
    status: data?.status === 'open' ? 'open' : 'closed',
    activeDate: typeof data?.activeDate === 'string' ? data.activeDate : '',
    pipelineIds: Array.isArray(data?.pipelineIds) ? data.pipelineIds.filter((id) => typeof id === 'string') : [],
  }
}

function readToken(document) {
  const data = document.data()
  return {
    id: document.id,
    userId: typeof data?.userId === 'string' ? data.userId : '',
    tokenNumber: Number.isFinite(data?.tokenNumber) ? data.tokenNumber : null,
    userName: typeof data?.userName === 'string' && data.userName.trim() ? data.userName : 'QLine user',
    status: typeof data?.status === 'string' ? data.status : 'waiting',
    queueDate: typeof data?.queueDate === 'string' ? data.queueDate : '',
    timeSlot: typeof data?.timeSlot === 'string' ? data.timeSlot : '',
    serviceName: typeof data?.serviceName === 'string' ? data.serviceName : '',
    serviceId: typeof data?.serviceId === 'string' ? data.serviceId : '',
    pipelineId: typeof data?.pipelineId === 'string' ? data.pipelineId : '',
    pipelineRunId: typeof data?.pipelineRunId === 'string' ? data.pipelineRunId : '',
    pipelineStep: Number.isSafeInteger(data?.pipelineStep) ? data.pipelineStep : 0,
    limitTracked: data?.limitTracked === true,
    createdAt: data?.createdAt,
    ref: document.ref,
  }
}

function readAppointment(document) {
  const data = document.data()
  return {
    id: `${document.ref.parent.parent?.id || ''}:${document.id}`,
    ref: document.ref,
    serviceName: typeof data?.serviceName === 'string' ? data.serviceName : 'Appointment',
    userName: typeof data?.userName === 'string' && data.userName.trim() ? data.userName : 'QLine user',
    date: typeof data?.date === 'string' ? data.date : '',
    timeSlot: typeof data?.timeSlot === 'string' ? data.timeSlot : '',
    status: typeof data?.status === 'string' ? data.status : 'booked',
  }
}

export default function DashboardPage() {
  const { firebaseUser, profile } = useAuth()
  const [organization, setOrganization] = useState(null)
  const [queueState, setQueueState] = useState({ orgId: '', queues: [] })
  const [pipelineState, setPipelineState] = useState({ orgId: '', pipelines: [] })
  const [readyPipelineRuns, setReadyPipelineRuns] = useState({ orgId: '', runs: [] })
  const [selectedQueueId, setSelectedQueueId] = useState('')
  const [selectedPipelineId, setSelectedPipelineId] = useState('')
  const [pipelineName, setPipelineName] = useState('')
  const [pipelineQueueIds, setPipelineQueueIds] = useState([])
  const [tokenState, setTokenState] = useState({ queueId: '', tokens: [] })
  const [dateTokenState, setDateTokenState] = useState({ queueId: '', date: '', tokens: [] })
  const [restrictionState, setRestrictionState] = useState({ orgId: '', userIds: new Set() })
  const [copied, setCopied] = useState('')
  const [queueName, setQueueName] = useState('')
  const [queuePurpose, setQueuePurpose] = useState('')
  const [serviceName, setServiceName] = useState('')
  const [serviceDuration, setServiceDuration] = useState('')
  const [businessHours, setBusinessHours] = useState({ openingTime: '09:00', closingTime: '17:00' })
  const [bookingEmailDomain, setBookingEmailDomain] = useState('')
  const [bookingRequiredProfileFields, setBookingRequiredProfileFields] = useState([])
  const [bookingIntegrity, setBookingIntegrity] = useState(DEFAULT_BOOKING_INTEGRITY)
  const [appointmentDate, setAppointmentDate] = useState(getLocalDateKey())
  const [appointmentState, setAppointmentState] = useState({ orgId: '', date: '', appointments: [], ready: false })
  const [appointmentError, setAppointmentError] = useState('')
  const [appointmentBusyId, setAppointmentBusyId] = useState('')
  const [restrictionBusyUid, setRestrictionBusyUid] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const promotedTokenIds = useRef(new Set())

  useEffect(() => {
    if (!profile?.orgId) return
    let active = true
    getDoc(doc(db, 'organizations', profile.orgId))
      .then((snapshot) => {
        if (!active) return
        if (!snapshot.exists()) {
          setOrganization(null)
          setError('The organization profile could not be found. Sign out and contact your organization administrator.')
          return
        }
        const data = snapshot.data()
        setOrganization({ id: snapshot.id, ...(data && typeof data === 'object' ? data : {}) })
        setBusinessHours({
          openingTime: typeof data.openingTime === 'string' ? data.openingTime : '09:00',
          closingTime: typeof data.closingTime === 'string' ? data.closingTime : '17:00',
        })
        setBookingEmailDomain(typeof data.bookingVerification?.requiredEmailDomain === 'string'
          ? data.bookingVerification.requiredEmailDomain
          : '')
        setBookingRequiredProfileFields(Array.isArray(data.bookingVerification?.requiredProfileFields)
          ? data.bookingVerification.requiredProfileFields.filter((field) => Object.hasOwn(BOOKING_PROFILE_FIELDS, field))
          : [])
        setBookingIntegrity({
          maxNoShows: data.bookingIntegrity?.maxNoShows ?? DEFAULT_BOOKING_INTEGRITY.maxNoShows,
          maxCancellations: data.bookingIntegrity?.maxCancellations ?? DEFAULT_BOOKING_INTEGRITY.maxCancellations,
        })
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
    const queuesQuery = collection(db, 'organizations', profile.orgId, 'queues')
    const unsubscribe = onSnapshot(queuesQuery, (snapshot) => {
      try {
        const queues = snapshot.docs.map(readQueue).sort((left, right) => left.name.localeCompare(right.name))
        setQueueState({ orgId: profile.orgId, queues })
      } catch (requestError) {
        setError(`Could not read the organization queues: ${requestError.message}`)
      }
    }, (requestError) => setError(requestError.message))
    const unsubscribePipelines = onSnapshot(
      collection(db, 'organizations', profile.orgId, 'pipelines'),
      (snapshot) => setPipelineState({
        orgId: profile.orgId,
        pipelines: snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
          .filter((pipeline) => typeof pipeline.name === 'string' && Array.isArray(pipeline.queueIds))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }),
      (requestError) => setError(`Could not read organization pipelines: ${requestError.message}`),
    )
    return () => {
      active = false
      unsubscribe()
      unsubscribePipelines()
    }
  }, [profile?.orgId])

  const queues = queueState.orgId === profile?.orgId ? queueState.queues : []
  const pipelines = pipelineState.orgId === profile?.orgId ? pipelineState.pipelines : EMPTY_PIPELINES
  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === selectedPipelineId)
  const pipelineRuns = readyPipelineRuns.orgId === profile?.orgId ? readyPipelineRuns.runs : []

  useEffect(() => {
    if (!profile?.orgId || !pipelines.length) return undefined
    const unsubscribeRuns = pipelines.map((pipeline) => onSnapshot(
      query(
        collection(db, 'organizations', profile.orgId, 'pipelines', pipeline.id, 'runs'),
        where('status', '==', 'ready'),
      ),
      (snapshot) => setReadyPipelineRuns((current) => ({
        orgId: profile.orgId,
        runs: [
          ...(current.orgId === profile.orgId
            ? current.runs.filter((run) => run.pipelineId !== pipeline.id)
            : []),
          ...snapshot.docs.map((item) => ({ id: item.id, pipelineId: pipeline.id, ...item.data() })),
        ],
      })),
      (requestError) => setError(`Could not read ready pipeline runs: ${requestError.message}`),
    ))
    return () => unsubscribeRuns.forEach((unsubscribe) => unsubscribe())
  }, [profile?.orgId, pipelines])
  const activeQueueId = queues.some((item) => item.id === selectedQueueId) ? selectedQueueId : queues[0]?.id || ''
  const restrictedUserIds = restrictionState.orgId === profile?.orgId ? restrictionState.userIds : new Set()

  useEffect(() => {
    if (!profile?.orgId || !activeQueueId) return undefined
    const tokensQuery = query(
      collection(db, 'organizations', profile.orgId, 'queues', activeQueueId, 'tokens'),
      where('status', 'in', ['scheduled', 'waiting', 'serving']),
    )
    return onSnapshot(tokensQuery, (snapshot) => {
      try {
        const tokens = snapshot.docs.map(readToken)
          .sort((left, right) => (left.tokenNumber ?? 0) - (right.tokenNumber ?? 0))
        setTokenState({ queueId: activeQueueId, tokens })
      } catch (requestError) {
        setError(`Could not read the selected queue: ${requestError.message}`)
      }
    }, (requestError) => setError(requestError.message))
  }, [profile?.orgId, activeQueueId])

  useEffect(() => {
    if (!profile?.orgId || !activeQueueId) return undefined
    const dateTokensQuery = query(
      collection(db, 'organizations', profile.orgId, 'queues', activeQueueId, 'tokens'),
      where('queueDate', '==', appointmentDate),
    )
    return onSnapshot(dateTokensQuery, (snapshot) => {
      try {
        const tokens = snapshot.docs.map(readToken)
          .sort((left, right) => (left.tokenNumber ?? 0) - (right.tokenNumber ?? 0))
        setDateTokenState({ queueId: activeQueueId, date: appointmentDate, tokens })
      } catch (requestError) {
        setError(`Could not read tokens for ${appointmentDate}: ${requestError.message}`)
      }
    }, (requestError) => setError(`Could not read tokens for ${appointmentDate}: ${requestError.message}`))
  }, [profile?.orgId, activeQueueId, appointmentDate])

  useEffect(() => {
    if (!profile?.orgId) return undefined
    return onSnapshot(
      collection(db, 'organizations', profile.orgId, 'bookingRestrictions'),
      (snapshot) => setRestrictionState({
        orgId: profile.orgId,
        userIds: new Set(snapshot.docs.map((item) => item.id)),
      }),
      (requestError) => setError(`Could not load booking restrictions: ${requestError.message}`),
    )
  }, [profile?.orgId])

  useEffect(() => {
    if (!profile?.orgId) return undefined
    const appointmentsQuery = query(
      collection(db, 'organizations', profile.orgId, 'appointments'),
      where('date', '==', appointmentDate),
    )
    return onSnapshot(appointmentsQuery, (snapshot) => {
      try {
        const appointments = snapshot.docs.map(readAppointment)
          .sort((left, right) => left.timeSlot.localeCompare(right.timeSlot))
        setAppointmentState({ orgId: profile.orgId, date: appointmentDate, appointments, ready: true })
        setAppointmentError('')
      } catch (requestError) {
        setAppointmentState({ orgId: profile.orgId, date: appointmentDate, appointments: [], ready: true })
        setAppointmentError(`Could not read scheduled appointments: ${requestError.message}`)
      }
    }, (requestError) => {
      setAppointmentState({ orgId: profile.orgId, date: appointmentDate, appointments: [], ready: true })
      setAppointmentError(`Could not read scheduled appointments: ${requestError.message}`)
    })
  }, [profile?.orgId, appointmentDate])

  const queue = tokenState.queueId === activeQueueId ? tokenState.tokens : []
  const today = getLocalDateKey()
  const activeTokens = queue
    .filter((token) => ['waiting', 'serving'].includes(token.status) && isTokenForDate(token, today))
    .sort((left, right) => (left.timeSlot || '').localeCompare(right.timeSlot || '')
      || (left.createdAt?.toMillis?.() ?? 0) - (right.createdAt?.toMillis?.() ?? 0))
  const dateTokens = dateTokenState.queueId === activeQueueId && dateTokenState.date === appointmentDate
    ? dateTokenState.tokens
    : []
  const selectedQueue = queues.find((item) => item.id === activeQueueId)
  const selectedQueueIsOpenToday = selectedQueue?.status === 'open'
    && (!selectedQueue.activeDate || selectedQueue.activeDate === today)
  const todayAppointments = appointmentState.orgId === profile?.orgId && appointmentState.date === appointmentDate
    ? appointmentState.appointments
    : []

  useEffect(() => {
    if (!profile?.orgId || !selectedQueue || selectedQueue.status !== 'open'
      || (selectedQueue.activeDate && selectedQueue.activeDate !== today)) return undefined

    const promoteDueTokens = async () => {
      const currentDate = getLocalDateKey()
      if (selectedQueue.activeDate && selectedQueue.activeDate !== currentDate) return
      const dueTokens = tokenState.tokens.filter((token) => token.status === 'scheduled'
        && token.queueDate === currentDate
        && isTokenTimeDue(token)
        && !promotedTokenIds.current.has(token.id))
      if (!dueTokens.length) return
      dueTokens.forEach((token) => promotedTokenIds.current.add(token.id))
      try {
        for (let offset = 0; offset < dueTokens.length; offset += 450) {
          const batch = writeBatch(db)
          dueTokens.slice(offset, offset + 450).forEach((token) => {
            batch.update(token.ref, { status: 'waiting', promotedAt: serverTimestamp() })
          })
          await batch.commit()
        }
      } catch (requestError) {
        dueTokens.forEach((token) => promotedTokenIds.current.delete(token.id))
        setError(`Could not activate scheduled tokens: ${requestError.message}`)
      }
    }

    promoteDueTokens()
    const intervalId = window.setInterval(promoteDueTokens, 30_000)
    return () => window.clearInterval(intervalId)
  }, [profile?.orgId, selectedQueue, selectedQueue?.id, selectedQueue?.status, selectedQueue?.activeDate, today, tokenState.tokens])

  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied(''), 1600)
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const createQueue = async (event) => {
    event.preventDefault()
    const name = queueName.trim()
    if (!name) return
    setBusy(true)
    setError('')
    try {
      const queueRef = doc(collection(db, 'organizations', profile.orgId, 'queues'))
      await setDoc(queueRef, {
        name,
        purpose: queuePurpose.trim(),
        pipelineIds: [],
        status: 'open',
        nextTokenNumber: 1,
        lastIssuedTokenId: '',
        dailyCounters: {},
        activeDate: today,
        createdAt: serverTimestamp(),
      })
      setSelectedQueueId(queueRef.id)
      setQueueName('')
      setQueuePurpose('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const startNewPipeline = () => {
    setSelectedPipelineId('')
    setPipelineName('')
    setPipelineQueueIds([])
    setError('')
  }

  const editPipeline = (pipelineId) => {
    const pipeline = pipelines.find((item) => item.id === pipelineId)
    if (!pipeline) return
    setSelectedPipelineId(pipelineId)
    setPipelineName(pipeline.name)
    setPipelineQueueIds([...pipeline.queueIds])
    setError('')
  }

  const savePipeline = async (event) => {
    event.preventDefault()
    let draft
    try {
      draft = validatePipelineDraft(pipelineName, pipelineQueueIds, queues)
    } catch (validationError) {
      setError(validationError.message)
      return
    }
    setBusy(true)
    setError('')
    try {
      const pipelineId = selectedPipelineId || crypto.randomUUID()
      const pipelineRef = doc(db, 'organizations', profile.orgId, 'pipelines', pipelineId)
      const isExisting = pipelines.some((pipeline) => pipeline.id === pipelineId)
      const nextPipelines = pipelines
        .filter((pipeline) => pipeline.id !== pipelineId)
        .concat([{
          id: pipelineId,
          ...draft,
          published: isExisting && selectedPipeline?.published === true,
        }])
      const queueMembership = new Map(queues.map((queue) => [queue.id, []]))
      nextPipelines.filter((pipeline) => pipeline.published).forEach((pipeline) => {
        pipeline.queueIds.forEach((queueId) => {
          const memberships = queueMembership.get(queueId)
          if (memberships && !memberships.includes(pipeline.id)) memberships.push(pipeline.id)
        })
      })
      const batch = writeBatch(db)
      const pipelineData = {
        ...draft,
        published: isExisting && selectedPipeline?.published === true,
        updatedAt: serverTimestamp(),
      }
      if (isExisting) batch.update(pipelineRef, pipelineData)
      else batch.set(pipelineRef, { ...pipelineData, createdAt: serverTimestamp() })
      queues.forEach((queue) => {
        batch.update(doc(db, 'organizations', profile.orgId, 'queues', queue.id), {
          pipelineIds: queueMembership.get(queue.id) || [],
        })
      })
      await batch.commit()
      setSelectedPipelineId(pipelineId)
      setPipelineName(draft.name)
      setPipelineQueueIds(draft.queueIds)
    } catch (requestError) {
      setError(`Could not save pipeline: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const setPipelinePublished = async (pipeline, published) => {
    setBusy(true)
    setError('')
    try {
      const nextPipelines = pipelines.map((item) => item.id === pipeline.id ? { ...item, published } : item)
      const queueMembership = new Map(queues.map((queue) => [queue.id, []]))
      nextPipelines.filter((item) => item.published).forEach((item) => {
        item.queueIds.forEach((queueId) => {
          const memberships = queueMembership.get(queueId)
          if (memberships && !memberships.includes(item.id)) memberships.push(item.id)
        })
      })
      const batch = writeBatch(db)
      batch.update(doc(db, 'organizations', profile.orgId, 'pipelines', pipeline.id), {
        published,
        updatedAt: serverTimestamp(),
      })
      queues.forEach((queue) => {
        batch.update(doc(db, 'organizations', profile.orgId, 'queues', queue.id), {
          pipelineIds: queueMembership.get(queue.id) || [],
        })
      })
      await batch.commit()
    } catch (requestError) {
      setError(`Could not ${published ? 'publish' : 'unpublish'} pipeline: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const completePipelineStep = async (token) => {
    setBusy(true)
    setError('')
    try {
      await updateQueueTokenStatus(profile.orgId, activeQueueId, token.id, 'completed')
    } catch (requestError) {
      setError(`Could not complete and advance the pipeline token: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const stopPipeline = async (token) => {
    setBusy(true)
    setError('')
    try {
      await concludePipelineRun(profile.orgId, token.pipelineId, token.pipelineRunId)
    } catch (requestError) {
      setError(`Could not stop the pipeline: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const callNext = async () => {
    if (!activeQueueId) return
    setBusy(true)
    setError('')
    try {
      const current = activeTokens.find((item) => item.status === 'serving')
      const next = activeTokens.find((item) => item.status === 'waiting')
      if (!current && !next) throw new Error('There are no waiting tokens in this queue.')
      if (current?.pipelineRunId) {
        throw new Error('Use Complete & Advance for a pipeline token so its next step is unlocked safely.')
      }

      const currentRef = current?.ref || null
      const nextRef = next?.ref || null
      if ((current && !currentRef) || (next && !nextRef)) {
        throw new Error('Could not resolve a token reference. Refresh the dashboard and try again.')
      }

      await runTransaction(db, async (transaction) => {
        const [currentSnapshot, nextSnapshot] = await Promise.all([
          currentRef ? transaction.get(currentRef) : Promise.resolve(null),
          nextRef ? transaction.get(nextRef) : Promise.resolve(null),
        ])
        if (currentSnapshot && (!currentSnapshot.exists() || currentSnapshot.data()?.status !== 'serving')) {
          throw new Error('The serving token changed. Refresh the dashboard and try again.')
        }
        if (nextSnapshot && (!nextSnapshot.exists() || nextSnapshot.data()?.status !== 'waiting')) {
          throw new Error('The next token changed. Refresh the dashboard and try again.')
        }
        let currentLimitsRef = null
        let currentLimitsSnapshot = null
        if (currentSnapshot?.data()?.limitTracked === true
          && typeof currentSnapshot.data().userId === 'string'
          && currentSnapshot.data().userId) {
          currentLimitsRef = doc(db, 'organizations', profile.orgId, 'bookingLimits', currentSnapshot.data().userId)
          currentLimitsSnapshot = await transaction.get(currentLimitsRef)
        }
        if (currentRef) {
          transaction.update(currentRef, { status: 'completed' })
          if (currentLimitsSnapshot?.exists()) {
            transaction.update(currentLimitsRef, removeActiveBookingFromLimits(
              currentLimitsSnapshot.data(),
              activeQueueId,
              currentRef.id,
              'completed',
            ))
          }
        }
        if (nextRef) transaction.update(nextRef, { status: 'serving', calledAt: serverTimestamp() })
      })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const toggleQueueStatus = async () => {
    if (!selectedQueue) return
    setBusy(true)
    setError('')
    try {
      await updateDoc(doc(db, 'organizations', profile.orgId, 'queues', selectedQueue.id), {
        status: selectedQueueIsOpenToday ? 'closed' : 'open',
        activeDate: selectedQueueIsOpenToday ? selectedQueue.activeDate : today,
      })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const cancelQueueToken = async (token) => {
    setBusy(true)
    setError('')
    try {
      await updateQueueTokenStatus(profile.orgId, activeQueueId, token.id, 'cancelled')
    } catch (requestError) {
      setError(`Could not cancel token ${formatTokenNumber(token.tokenNumber)}: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const toggleBookingRestriction = async (token) => {
    if (!token.userId) {
      setError('Could not identify the customer account for this token.')
      return
    }
    setRestrictionBusyUid(token.userId)
    setError('')
    const restrictionRef = doc(db, 'organizations', profile.orgId, 'bookingRestrictions', token.userId)
    try {
      if (restrictedUserIds.has(token.userId)) {
        await deleteDoc(restrictionRef)
      } else {
        await setDoc(restrictionRef, {
          reason: 'Repeated non-genuine bookings',
          updatedBy: firebaseUser.uid,
          updatedAt: serverTimestamp(),
        })
      }
    } catch (requestError) {
      setError(`Could not update this customer’s booking restriction: ${requestError.message}`)
    } finally {
      setRestrictionBusyUid('')
    }
  }

  const resetBookingStrikes = async (token) => {
    if (!token.userId || !token.limitTracked) {
      setError('Repeat counts are not available for this legacy token.')
      return
    }
    if (!window.confirm(`Reset the no-show and cancellation counts for ${token.userName}?`)) return
    setRestrictionBusyUid(token.userId)
    setError('')
    try {
      await updateDoc(doc(db, 'organizations', profile.orgId, 'bookingLimits', token.userId), {
        noShowCount: 0,
        cancellationCount: 0,
      })
    } catch (requestError) {
      setError(`Could not reset repeat-booking counts: ${requestError.message}`)
    } finally {
      setRestrictionBusyUid('')
    }
  }

  const markQueueTokenNoShow = async (token) => {
    setBusy(true)
    setError('')
    try {
      await updateQueueTokenStatus(profile.orgId, activeQueueId, token.id, 'no_show')
    } catch (requestError) {
      setError(`Could not mark token ${formatTokenNumber(token.tokenNumber)} as a no-show: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const saveBusinessHours = async (event) => {
    event.preventDefault()
    if (!/^\d{2}:\d{2}$/.test(businessHours.openingTime)
      || !/^\d{2}:\d{2}$/.test(businessHours.closingTime)
      || businessHours.closingTime <= businessHours.openingTime) {
      setError('Choose valid opening and closing times, with closing later than opening.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await updateDoc(doc(db, 'organizations', profile.orgId), businessHours)
      setOrganization((current) => current ? { ...current, ...businessHours } : current)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const saveBookingVerification = async (event) => {
    event.preventDefault()
    const domain = bookingEmailDomain.trim().toLowerCase()
    if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      setError('Enter a valid email domain, such as example.org, or leave it blank.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const bookingVerification = {
        requiredEmailDomain: domain,
        requiredEmailDomainPattern: domain ? emailDomainPattern(domain) : '',
        requiredProfileFields: [...new Set(bookingRequiredProfileFields)],
      }
      await updateDoc(doc(db, 'organizations', profile.orgId), { bookingVerification })
      setOrganization((current) => current ? { ...current, bookingVerification } : current)
    } catch (requestError) {
      setError(`Could not save booking verification rules: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const saveBookingIntegrity = async (event) => {
    event.preventDefault()
    const { maxNoShows, maxCancellations } = bookingIntegrity
    if (![maxNoShows, maxCancellations].every((value) => Number.isInteger(Number(value))
      && Number(value) >= 0 && Number(value) <= 20)) {
      setError('Repeat limits must be whole numbers from 0 to 20. Use 0 to disable a limit.')
      return
    }
    const policy = { maxNoShows: Number(maxNoShows), maxCancellations: Number(maxCancellations) }
    setBusy(true)
    setError('')
    try {
      await updateDoc(doc(db, 'organizations', profile.orgId), { bookingIntegrity: policy })
      setOrganization((current) => current ? { ...current, bookingIntegrity: policy } : current)
    } catch (requestError) {
      setError(`Could not save no-show and cancellation limits: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const saveServices = async (services) => {
    setBusy(true)
    setError('')
    try {
      await updateDoc(doc(db, 'organizations', profile.orgId), { services })
      setOrganization((current) => current ? { ...current, services } : current)
      return true
    } catch (requestError) {
      setError(requestError.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const createService = async (event) => {
    event.preventDefault()
    const name = serviceName.trim()
    const duration = Number(serviceDuration)
    if (!name || !Number.isSafeInteger(duration) || duration < 1) {
      setError('Enter a service name and a duration of at least one minute.')
      return
    }
    const services = Array.isArray(organization?.services)
      ? organization.services.filter((service) => service && typeof service.name === 'string' && service.name.trim())
      : []
    if (await saveServices([...services, { id: crypto.randomUUID(), name, duration, active: true }])) {
      setServiceName('')
      setServiceDuration('')
    }
  }

  const updateService = (serviceId, changes) => {
    const services = (Array.isArray(organization?.services) ? organization.services : [])
      .map((service, index) => {
        const id = typeof service.id === 'string' && service.id ? service.id : `${service.name}-${index}`
        return id === serviceId ? { ...service, ...changes } : service
      })
    return saveServices(services)
  }

  const removeService = (serviceId) => {
    const services = (Array.isArray(organization?.services) ? organization.services : [])
      .filter((service, index) => {
        const id = typeof service.id === 'string' && service.id ? service.id : `${service.name}-${index}`
        return id !== serviceId
      })
    return saveServices(services)
  }

  const updateAppointmentStatus = async (appointment, status) => {
    const today = getLocalDateKey()
    const isActive = ['booked', 'checked_in'].includes(appointment.status)
    const allowed = status === 'cancelled'
      ? isActive
      : status === 'checked_in'
        ? appointment.status === 'booked' && appointment.date === today
        : status === 'completed'
          ? isActive && appointment.date <= today
          : false
    if (!allowed) {
      setAppointmentError('This appointment can no longer be updated to that status.')
      return
    }

    setAppointmentBusyId(appointment.id)
    setAppointmentError('')
    try {
      await updateDoc(appointment.ref, { status })
    } catch (requestError) {
      setAppointmentError(`Could not update appointment: ${requestError.message}`)
    } finally {
      setAppointmentBusyId('')
    }
  }

  if (!firebaseUser || !profile) return <main><AppHeader /><p className="load-state">Loading organization dashboard…</p></main>
  if (!profile.orgId) return <main><AppHeader /><p className="form-error page-shell" role="alert">Your organization admin profile is missing its organization ID. Sign out and contact support.</p></main>

  const organizationSlug = typeof organization?.slug === 'string' ? organization.slug : ''
  const bookingLink = organizationSlug ? `${window.location.origin}/org/${encodeURIComponent(organizationSlug)}` : ''
  const joinCode = typeof organization?.joinCode === 'string' ? organization.joinCode : ''
  const services = Array.isArray(organization?.services) ? organization.services : []
  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">{organization?.category || 'ORGANIZATION ADMIN'}</p><h1>{organization?.name || 'Dashboard'}</h1></div>{organization?.verificationStatus === 'pending' && <span className="status-pill warning">Verification pending</span>}</div>
        <section className="panel queue-management">
          <div className="section-heading">
            <div><p className="eyebrow">QUEUE MANAGEMENT</p><h2>Queues & counters</h2></div>
            {queues.length > 0 && <label className="queue-select-label">Selected queue
              <select value={activeQueueId} onChange={(event) => setSelectedQueueId(event.target.value)} aria-label="Select queue">
                {queues.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.purpose || item.id.slice(0, 6)}</option>)}
              </select>
            </label>}
          </div>
          {selectedQueue && <div className="queue-description-row"><p className="queue-description">{selectedQueue.purpose || 'General service queue'} · {selectedQueueIsOpenToday ? 'Open for today' : 'Closed'} · {activeTokens.filter((token) => token.status === 'waiting').length} waiting <small>Queue ID: {selectedQueue.id}</small></p><button className="button secondary queue-status-button" type="button" onClick={toggleQueueStatus} disabled={busy}>{selectedQueueIsOpenToday ? 'Close queue' : 'Open today’s queue'}</button></div>}
          <form className="create-queue-form" onSubmit={createQueue}>
            <label>Queue name<input value={queueName} onChange={(event) => setQueueName(event.target.value)} placeholder="e.g. Payments counter" required /></label>
            <label>Purpose or counter<input value={queuePurpose} onChange={(event) => setQueuePurpose(event.target.value)} placeholder="e.g. Bill payments" /></label>
            <button className="button secondary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add queue'}</button>
          </form>
        </section>
        <section className="panel pipeline-management">
          <div className="section-heading">
            <div><p className="eyebrow">WORKFLOWS / PIPELINES</p><h2>Sequential queue pipelines</h2></div>
            <button className="button secondary" type="button" onClick={startNewPipeline} disabled={busy}>New pipeline</button>
          </div>
          <p className="muted">Chain at least two existing queues in the order customers should visit. Only the first step is joinable until the previous step is completed.</p>
          {pipelines.map((pipeline) => <article className="service-row" key={pipeline.id}>
            <div><strong>{pipeline.name}</strong><small>{pipeline.queueIds.map((queueId) => queues.find((queueItem) => queueItem.id === queueId)?.name || 'Unavailable queue').join(' → ')} · {pipeline.published ? 'Published' : 'Unpublished'}</small></div>
            <div className="service-actions">
              <button className="button secondary" type="button" onClick={() => editPipeline(pipeline.id)} disabled={busy}>Edit</button>
              <button className="button secondary" type="button" onClick={() => setPipelinePublished(pipeline, !pipeline.published)} disabled={busy}>{pipeline.published ? 'Unpublish' : 'Publish'}</button>
            </div>
          </article>)}
          {!pipelines.length && <p className="muted">No pipelines have been created.</p>}
          <form className="pipeline-form" onSubmit={savePipeline}>
            <label>Pipeline name<input value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} placeholder="e.g. Campus Hiring Drive" required /></label>
            <label>Add queue step
              <select value="" onChange={(event) => {
                if (event.target.value && !pipelineQueueIds.includes(event.target.value)) {
                  setPipelineQueueIds((current) => [...current, event.target.value])
                }
              }} disabled={!queues.length}>
                <option value="">Choose an existing queue</option>
                {queues.filter((item) => !pipelineQueueIds.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <ol className="pipeline-step-list">
              {pipelineQueueIds.map((queueId, index) => <li key={`${queueId}-${index}`}>
                <span><strong>Step {index + 1}</strong> · {queues.find((item) => item.id === queueId)?.name || 'Unavailable queue'}</span>
                <div>
                  <button className="button secondary" type="button" aria-label={`Move step ${index + 1} up`} onClick={() => setPipelineQueueIds((current) => current.map((id, position) => position === index - 1 ? current[index] : position === index ? current[index - 1] : id))} disabled={busy || index === 0}>Move up</button>
                  <button className="button secondary" type="button" aria-label={`Move step ${index + 1} down`} onClick={() => setPipelineQueueIds((current) => current.map((id, position) => position === index ? current[index + 1] : position === index + 1 ? current[index] : id))} disabled={busy || index === pipelineQueueIds.length - 1}>Move down</button>
                  <button className="button secondary" type="button" onClick={() => setPipelineQueueIds((current) => current.filter((_, position) => position !== index))} disabled={busy}>Remove</button>
                </div>
              </li>)}
            </ol>
            <button className="button primary" type="submit" disabled={busy || !organization}>{busy ? 'Saving…' : selectedPipelineId ? 'Save pipeline' : 'Create pipeline'}</button>
          </form>
        </section>
        <div className="dashboard-cards">
          <section className="panel live-queue-panel">
            <div className="section-heading"><h2>Live queue · Today</h2>{selectedQueue && <span className="status-pill">{selectedQueue.name}</span>}</div>
            {activeTokens.length ? activeTokens.slice(0, 5).map((token) => <div className="queue-row" key={token.id}><strong>{formatTokenNumber(token.tokenNumber)}</strong><span>{token.userName}<small>{token.serviceName || selectedQueue?.name}{token.timeSlot ? ` · ${token.timeSlot}` : ''}{token.pipelineId ? ` · Pipeline step ${token.pipelineStep}` : ''}</small></span><span className={`status-pill ${token.status}`}>{token.status}</span>{token.pipelineRunId && token.status === 'serving' && <button className="button secondary" type="button" onClick={() => completePipelineStep(token)} disabled={busy}>{busy ? 'Updating…' : 'Complete & Advance'}</button>}</div>) : <p className="muted">{selectedQueue ? 'No active queue tokens.' : 'Add a queue to start receiving tokens.'}</p>}
            <button className="button primary" type="button" onClick={callNext} disabled={busy || !selectedQueue || !activeTokens.some((token) => token.status === 'waiting' || token.status === 'serving')}>{busy ? 'Updating…' : activeTokens.some((token) => token.status === 'waiting') ? 'Call next token' : 'Finish current token'}</button>
          </section>
          <section className="panel share-panel"><h2>Organization access</h2><label>Join code<div className="copy-row"><strong>{joinCode || '—'}</strong><button className="button secondary" type="button" onClick={() => copy(joinCode, 'code')} disabled={!joinCode}>{copied === 'code' ? 'Copied' : 'Copy'}</button></div></label><label>Shareable booking link<div className="copy-row"><span>{bookingLink || 'Not available'}</span><button className="button secondary" type="button" onClick={() => copy(bookingLink, 'link')} disabled={!bookingLink}>{copied === 'link' ? 'Copied' : 'Copy'}</button></div></label></section>
        </div>
        <section className="panel service-management">
          <div className="section-heading"><div><p className="eyebrow">PUBLISHED OFFERINGS</p><h2>Services</h2></div></div>
          <p className="muted">Published services appear on your organization page. Bookings create date-scoped tokens in the selected queue.</p>
          {services.length === 0 && <p className="muted">No services are configured yet. Add a service below, or publish a queue to show it as an offering.</p>}
          {services.map((service, index) => {
            const id = typeof service.id === 'string' && service.id ? service.id : `${service.name}-${index}`
            return <article className="service-row" key={id}>
              <div><strong>{service.name}</strong><small>{service.duration ? `${service.duration} minutes` : 'Duration not set'} · {service.active === false ? 'Unpublished' : 'Published'}</small></div>
              <div className="service-actions">
                <button className="button secondary" type="button" onClick={() => updateService(id, { active: service.active === false })} disabled={busy}>{service.active === false ? 'Publish' : 'Unpublish'}</button>
                <button className="button secondary" type="button" onClick={() => removeService(id)} disabled={busy}>Remove</button>
              </div>
            </article>
          })}
          <form className="service-form" onSubmit={createService}>
            <label>Service name<input value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="e.g. Consultation" required /></label>
            <label>Duration (minutes)<input type="number" min="1" step="1" value={serviceDuration} onChange={(event) => setServiceDuration(event.target.value)} required /></label>
            <button className="button primary" type="submit" disabled={busy || !organization}>{busy ? 'Saving…' : 'Add and publish'}</button>
          </form>
        </section>
        <section className="panel schedule-hours">
          <div className="section-heading"><div><p className="eyebrow">BOOKING WINDOWS</p><h2>Available time slots</h2></div></div>
          <p className="muted">Customer slots are generated within these hours using each service’s duration. Elapsed slots are hidden for today.</p>
          <form className="service-form" onSubmit={saveBusinessHours}>
            <label>Opens at<input type="time" value={businessHours.openingTime} onChange={(event) => setBusinessHours((current) => ({ ...current, openingTime: event.target.value }))} required /></label>
            <label>Closes at<input type="time" value={businessHours.closingTime} onChange={(event) => setBusinessHours((current) => ({ ...current, closingTime: event.target.value }))} required /></label>
            <button className="button primary" type="submit" disabled={busy || !organization}>{busy ? 'Saving…' : 'Save hours'}</button>
          </form>
        </section>
        <section className="panel schedule-hours verification-settings">
          <div className="section-heading"><div><p className="eyebrow">AUTOMATED ELIGIBILITY</p><h2>Booking verification</h2></div></div>
          <p className="muted">Every customer must use a verified email address. You may require an organization email domain and profile details. Firebase security rules check these requirements when a token is created.</p>
          <p className="muted">Booking limits are enforced per customer: 3 active per queue, 5 active per organization, 5 bookings per queue per scheduled date, and 10 per organization per scheduled date. Cancel invalid tokens or restrict future bookings for repeat abusers from the token list.</p>
          <form className="service-form" onSubmit={saveBookingVerification}>
            <label>Allowed email domain (optional)<input type="text" value={bookingEmailDomain} onChange={(event) => setBookingEmailDomain(event.target.value)} placeholder="example.org" autoCapitalize="none" autoComplete="off" /></label>
            <fieldset className="booking-profile-requirements">
              <legend>Required customer profile details</legend>
              {Object.entries(BOOKING_PROFILE_FIELDS).map(([field, label]) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={bookingRequiredProfileFields.includes(field)}
                    onChange={() => setBookingRequiredProfileFields((current) => (
                      current.includes(field)
                        ? current.filter((item) => item !== field)
                        : [...current, field]
                    ))}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <button className="button primary" type="submit" disabled={busy || !organization}>{busy ? 'Saving…' : 'Save verification rules'}</button>
          </form>
          <h3>No-show and cancellation limits</h3>
          <p className="muted">After reaching either threshold, the customer cannot create more tokens with this organization. Cancellation limits count customer-cancelled tokens; only admins can mark a no-show. Set 0 to disable either limit.</p>
          <form className="service-form" onSubmit={saveBookingIntegrity}>
            <label>Maximum no-shows<input type="number" min="0" max="20" step="1" value={bookingIntegrity.maxNoShows} onChange={(event) => setBookingIntegrity((current) => ({ ...current, maxNoShows: event.target.value }))} required /></label>
            <label>Maximum cancellations<input type="number" min="0" max="20" step="1" value={bookingIntegrity.maxCancellations} onChange={(event) => setBookingIntegrity((current) => ({ ...current, maxCancellations: event.target.value }))} required /></label>
            <button className="button primary" type="submit" disabled={busy || !organization}>{busy ? 'Saving…' : 'Save repeat limits'}</button>
          </form>
        </section>
        <section className="panel scheduled-appointment-management">
          <div className="section-heading">
            <div><p className="eyebrow">APPOINTMENTS</p><h2>Scheduled appointments</h2></div>
            <label className="queue-select-label">Appointments for
              <input type="date" value={appointmentDate} onChange={(event) => { setAppointmentError(''); setAppointmentDate(event.target.value) }} />
            </label>
          </div>
          <p className="muted">Scheduled tokens stay upcoming until their time slot starts and today’s queue is open. Active tokens are advanced from the live queue above.</p>
          {appointmentError && <p className="form-error" role="alert">{appointmentError}</p>}
          <div className="appointment-list queue-token-list">
            <h3>Queue tokens · {appointmentDate}</h3>
            {dateTokens.length ? dateTokens.map((token) => {
              const pipeline = pipelines.find((item) => item.id === token.pipelineId)
              const readyRun = pipelineRuns.find((run) => run.id === token.pipelineRunId
                && run.pipelineId === token.pipelineId
                && run.currentTokenId === token.id
                && run.currentStep === token.pipelineStep)
              const nextQueue = pipeline && queues.find((item) => item.id === pipeline.queueIds[token.pipelineStep])
              const hasNextStep = Boolean(readyRun && nextQueue)
              const continuationLink = bookingLink && token.pipelineId && token.pipelineRunId
                ? `${bookingLink}?pipeline=${encodeURIComponent(token.pipelineId)}&run=${encodeURIComponent(token.pipelineRunId)}`
                : ''
              return <article className="panel appointment-row" key={token.id}>
              <div><strong>{token.serviceName || selectedQueue?.name || 'Queue'} · {formatTokenNumber(token.tokenNumber)}</strong><small>{token.queueDate}{token.timeSlot ? ` at ${token.timeSlot}` : ''}</small><small>Customer: {token.userName}</small></div>
              <div className="appointment-actions">
                <span className={`status-pill ${token.status}`}>{token.status.replace('_', ' ')}</span>
                {token.pipelineId && <small>Pipeline step {token.pipelineStep}</small>}
                {token.pipelineRunId && token.status === 'completed' && hasNextStep && continuationLink && <button className="button secondary" type="button" onClick={() => copy(continuationLink, `pipeline-${token.id}`)}>{copied === `pipeline-${token.id}` ? 'Link copied' : `Copy link to ${nextQueue.name}`}</button>}
                {token.pipelineRunId && token.status === 'completed' && hasNextStep && <button className="button secondary" type="button" onClick={() => stopPipeline(token)} disabled={busy}>{busy ? 'Updating…' : 'Conclude / Stop Pipeline'}</button>}
                {['scheduled', 'waiting'].includes(token.status) && <button className="button secondary" type="button" onClick={() => markQueueTokenNoShow(token)} disabled={busy}>Mark no-show</button>}
                {['scheduled', 'waiting', 'serving'].includes(token.status) && <button className="button secondary" type="button" onClick={() => cancelQueueToken(token)} disabled={busy}>Cancel token</button>}
                <button className="button secondary" type="button" onClick={() => toggleBookingRestriction(token)} disabled={Boolean(restrictionBusyUid)}>{restrictionBusyUid === token.userId ? 'Updating…' : restrictedUserIds.has(token.userId) ? 'Restore bookings' : 'Restrict bookings'}</button>
                {token.limitTracked && <button className="button secondary" type="button" onClick={() => resetBookingStrikes(token)} disabled={Boolean(restrictionBusyUid)}>{restrictionBusyUid === token.userId ? 'Updating…' : 'Reset repeat counts'}</button>}
              </div>
            </article>
            }) : <p className="muted">No queue tokens scheduled for this date and queue.</p>}
          </div>
          {!appointmentState.ready || appointmentState.orgId !== profile.orgId || appointmentState.date !== appointmentDate
            ? <p className="muted">Loading appointments for {appointmentDate}…</p>
            : appointmentError
              ? null
              : todayAppointments.length
              ? todayAppointments.map((appointment) => {
                const activeAppointment = ['booked', 'checked_in'].includes(appointment.status)
                const canCheckIn = appointment.status === 'booked' && appointment.date === getLocalDateKey()
                const canComplete = activeAppointment && appointment.date <= getLocalDateKey()
                return <article className="panel appointment-row scheduled-appointment-row" key={appointment.id}>
                  <div><strong>{appointment.serviceName}</strong><small>{appointment.date}{appointment.timeSlot ? ` at ${appointment.timeSlot}` : ''}</small><small>Customer: {appointment.userName}</small></div>
                  <div className="appointment-actions"><span className={`status-pill ${appointment.status}`}>{appointment.status.replace('_', ' ')}</span>
                    {canCheckIn && <button className="button secondary" type="button" onClick={() => updateAppointmentStatus(appointment, 'checked_in')} disabled={Boolean(appointmentBusyId)}>{appointmentBusyId === appointment.id ? 'Updating…' : 'Check in'}</button>}
                    {canComplete && <button className="button secondary" type="button" onClick={() => updateAppointmentStatus(appointment, 'completed')} disabled={Boolean(appointmentBusyId)}>Mark completed</button>}
                    {activeAppointment && <button className="button secondary" type="button" onClick={() => updateAppointmentStatus(appointment, 'cancelled')} disabled={Boolean(appointmentBusyId)}>Cancel booking</button>}
                  </div>
                </article>
              })
              : <p className="muted">No appointments scheduled for {appointmentDate}.</p>}
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}
