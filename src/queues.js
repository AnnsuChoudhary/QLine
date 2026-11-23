import { collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { auth, db } from './firebase/config.js'
import { getLocalDateKey, getLocalTimeKey, isTokenTimeDue, isValidDateKey } from './dates.js'
import { getBookingVerificationError } from './bookingVerification.js'
import { addBookingToLimits, getBookingLimitError, removeActiveBookingFromLimits } from './bookingLimits.js'
import { getNextPipelineStep } from './pipelines.js'

export function formatTokenNumber(number) {
  return Number.isSafeInteger(number) && number > 0 ? String(number).padStart(3, '0') : '—'
}

export async function updateQueueTokenStatus(orgId, queueId, tokenId, status) {
  if (!['cancelled', 'completed', 'no_show'].includes(status)) {
    throw new Error('Queue tokens can only be cancelled, completed, or marked as a no-show through this action.')
  }
  const cancelledBy = status === 'cancelled' ? auth.currentUser?.uid : ''
  if (status === 'cancelled' && !cancelledBy) throw new Error('Sign in before cancelling a queue token.')
  const tokenRef = doc(db, 'organizations', orgId, 'queues', queueId, 'tokens', tokenId)
  return runTransaction(db, async (transaction) => {
    const tokenSnapshot = await transaction.get(tokenRef)
    if (!tokenSnapshot.exists()) throw new Error('This queue token is no longer available.')
    const token = tokenSnapshot.data()
    if (!['scheduled', 'waiting', 'serving'].includes(token.status)) {
      throw new Error('This queue token is no longer active.')
    }
    let pipelineRunUpdate = null
    const pipelineRunRef = token.pipelineId && token.pipelineRunId
      ? doc(db, 'organizations', orgId, 'pipelines', token.pipelineId, 'runs', token.pipelineRunId)
      : null
    const pipelineRunSnapshot = pipelineRunRef ? await transaction.get(pipelineRunRef) : null
    if (pipelineRunSnapshot) {
      const pipelineRun = pipelineRunSnapshot.data()
      if (!pipelineRunSnapshot.exists()
        || pipelineRun.userId !== token.userId
        || pipelineRun.status !== 'active'
        || pipelineRun.currentTokenId !== tokenId
        || pipelineRun.currentQueueId !== queueId) {
        throw new Error('The pipeline state changed. Refresh the dashboard and try again.')
      }
      const steps = Array.isArray(pipelineRun.steps) ? [...pipelineRun.steps] : []
      const currentStep = steps.at(-1)
      if (!currentStep || currentStep.tokenId !== tokenId || currentStep.queueId !== queueId) {
        throw new Error('The current pipeline step could not be verified.')
      }
      currentStep.status = status
      const pipelineSnapshot = await transaction.get(doc(db, 'organizations', orgId, 'pipelines', token.pipelineId))
      if (!pipelineSnapshot.exists()) throw new Error('This pipeline is no longer available.')
      const isFinalStep = token.pipelineStep === pipelineSnapshot.data().queueIds?.length
      pipelineRunUpdate = {
        ref: pipelineRunRef,
        data: {
          status: status === 'completed' ? (isFinalStep ? 'completed' : 'ready') : 'concluded',
          steps,
          updatedAt: serverTimestamp(),
        },
      }
    }

    if (token.limitTracked === true && typeof token.userId === 'string' && token.userId) {
      const limitsRef = doc(db, 'organizations', orgId, 'bookingLimits', token.userId)
      const limitsSnapshot = await transaction.get(limitsRef)
      if (limitsSnapshot.exists()) {
        const limits = removeActiveBookingFromLimits(
          limitsSnapshot.data(),
          queueId,
          tokenId,
          status,
          status === 'cancelled' && cancelledBy === token.userId,
        )
        transaction.update(tokenRef, status === 'cancelled' ? { status, cancelledBy } : { status })
        transaction.update(limitsRef, limits)
      } else {
        transaction.update(tokenRef, status === 'cancelled' ? { status, cancelledBy } : { status })
      }
    } else {
      transaction.update(tokenRef, status === 'cancelled' ? { status, cancelledBy } : { status })
    }
    if (pipelineRunUpdate) transaction.update(pipelineRunUpdate.ref, pipelineRunUpdate.data)
    return true
  })
}

export async function joinQueue(orgId, queueId, user, options = {}) {
  if (typeof orgId !== 'string' || !orgId.trim() || typeof queueId !== 'string' || !queueId.trim()) {
    throw new Error('Choose an available organization and queue before joining.')
  }
  if (typeof user?.uid !== 'string' || !user.uid.trim()) throw new Error('Sign in before joining a queue.')
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('The booking details are invalid. Please try again.')
  }
  const queueDate = options.date || getLocalDateKey()
  const timeSlot = options.timeSlot || getLocalTimeKey()
  const serviceId = options.serviceId || queueId
  if (typeof serviceId !== 'string' || !serviceId.trim()) throw new Error('Choose a valid service before joining.')
  if (!isValidDateKey(queueDate)) throw new Error('Choose a valid date for your queue token.')
  if (queueDate < getLocalDateKey()) throw new Error('Choose today or a future date for your queue token.')
  if (typeof timeSlot !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeSlot)) {
    throw new Error('Choose a valid time slot for your queue token.')
  }
  const queueRef = doc(db, 'organizations', orgId, 'queues', queueId)
  const organizationRef = doc(db, 'organizations', orgId)
  const bookingLimitsRef = doc(db, 'organizations', orgId, 'bookingLimits', user.uid)
  const dailyLimitsRef = doc(db, 'organizations', orgId, 'bookingLimits', user.uid, 'days', queueDate)
  const restrictionRef = doc(db, 'organizations', orgId, 'bookingRestrictions', user.uid)
  const tokensCollection = collection(db, 'organizations', orgId, 'queues', queueId, 'tokens')
  const counterKey = `${queueDate}__${serviceId}`
  const pipelineOptions = options.pipeline
  const pipelineRef = pipelineOptions?.pipelineId
    ? doc(db, 'organizations', orgId, 'pipelines', pipelineOptions.pipelineId)
    : null
  const pipelineStep = pipelineOptions?.step ?? 1
  const pipelineRunRef = pipelineOptions?.runId
    ? doc(db, 'organizations', orgId, 'pipelines', pipelineOptions.pipelineId, 'runs', pipelineOptions.runId)
    : pipelineRef ? doc(collection(pipelineRef, 'runs')) : null
  const initialPipelineSnapshot = pipelineRef ? await getDoc(pipelineRef) : null
  if (pipelineRef && (!initialPipelineSnapshot?.exists()
    || initialPipelineSnapshot.data().published !== true
    || !Array.isArray(initialPipelineSnapshot.data().queueIds))) {
    throw new Error('This pipeline is no longer published.')
  }
  const previousQueueId = pipelineStep > 1
    ? initialPipelineSnapshot?.data().queueIds[pipelineStep - 2]
    : ''
  const previousTokenRef = pipelineStep > 1 && previousQueueId && pipelineOptions?.previousTokenId
    ? doc(db, 'organizations', orgId, 'queues', previousQueueId, 'tokens', pipelineOptions.previousTokenId)
    : null
  const initialQueueSnapshot = await getDoc(queueRef)
  if (!initialQueueSnapshot.exists()) throw new Error('This queue is no longer available. Choose another queue.')
  const initialQueue = initialQueueSnapshot.data()
  if (!initialQueue || typeof initialQueue !== 'object') {
    throw new Error('This queue has invalid settings. Contact the organization administrator.')
  }
  const initialCounters = initialQueue.dailyCounters && typeof initialQueue.dailyCounters === 'object'
    ? initialQueue.dailyCounters
    : {}
  let existingTokens = []
  if (!Number.isSafeInteger(initialCounters[counterKey])) {
    const snapshot = await getDocs(query(tokensCollection, where('queueDate', '==', queueDate)))
    existingTokens = snapshot.docs.map((tokenDocument) => tokenDocument.data())
  }

  return runTransaction(db, async (transaction) => {
    const [organizationSnapshot, queueSnapshot, bookingLimitsSnapshot, dailyLimitsSnapshot, restrictionSnapshot, pipelineSnapshot, pipelineRunSnapshot, previousTokenSnapshot] = await Promise.all([
      transaction.get(organizationRef),
      transaction.get(queueRef),
      transaction.get(bookingLimitsRef),
      transaction.get(dailyLimitsRef),
      transaction.get(restrictionRef),
      pipelineRef ? transaction.get(pipelineRef) : Promise.resolve(null),
      pipelineRunRef ? transaction.get(pipelineRunRef) : Promise.resolve(null),
      previousTokenRef ? transaction.get(previousTokenRef) : Promise.resolve(null),
    ])
    if (!organizationSnapshot.exists()) throw new Error('This organization is no longer available.')
    const organization = organizationSnapshot.data()
    const verificationError = getBookingVerificationError(user, organization, options.profile)
    if (verificationError) throw new Error(verificationError)
    if (restrictionSnapshot.exists()) {
      throw new Error('This organization has restricted new bookings for your account. Contact its administrator if you believe this is a mistake.')
    }
    if (!queueSnapshot.exists()) throw new Error('This queue is no longer available.')
    const queue = queueSnapshot.data()
    if (!queue || typeof queue !== 'object') throw new Error('This queue has invalid settings.')
    if (pipelineOptions) {
      const pipeline = pipelineSnapshot?.data()
      if (!pipelineSnapshot?.exists()
        || pipeline.published !== true
        || !Array.isArray(pipeline.queueIds)
        || pipeline.queueIds[pipelineStep - 1] !== queueId) {
        throw new Error('This queue is not the selected step in the published pipeline.')
      }
      if (pipelineStep === 1) {
        if (pipelineRunSnapshot?.exists()) throw new Error('This pipeline run already exists.')
      } else {
        const run = pipelineRunSnapshot?.data()
        if (!pipelineRunSnapshot?.exists()
          || !previousTokenSnapshot?.exists()
          || run.userId !== user.uid
          || run.pipelineId !== pipelineOptions.pipelineId
          || run.status !== 'ready'
          || run.currentStep !== pipelineStep - 1
          || run.currentTokenId !== pipelineOptions.previousTokenId
          || previousTokenSnapshot.data().status !== 'completed'
          || previousTokenSnapshot.data().userId !== user.uid
          || previousTokenSnapshot.data().pipelineRunId !== pipelineOptions.runId
          || previousTokenSnapshot.data().pipelineStep !== pipelineStep - 1) {
          throw new Error('Complete the previous pipeline step before joining this queue.')
        }
      }
    } else if (Array.isArray(queue.pipelineIds) && queue.pipelineIds.length) {
      throw new Error('Join this queue through its published pipeline to complete the required previous step.')
    }
    const bookingLimitError = getBookingLimitError(
      bookingLimitsSnapshot.exists() ? bookingLimitsSnapshot.data() : null,
      dailyLimitsSnapshot.exists() ? dailyLimitsSnapshot.data() : null,
      queueId,
      queueDate,
      organization.bookingIntegrity,
    )
    if (bookingLimitError) throw new Error(bookingLimitError)
    const dayIsOpen = queue.status === 'open'
      && (!queue.activeDate || queue.activeDate === queueDate)
    const tokenData = { queueDate, timeSlot }
    const startsNow = isTokenTimeDue(tokenData)
    if (!options.allowScheduled && (!dayIsOpen || !startsNow)) {
      throw new Error('This queue is not currently accepting live tokens.')
    }

    const dailyCounters = queue.dailyCounters && typeof queue.dailyCounters === 'object'
      ? queue.dailyCounters
      : {}
    let firstUnusedNumber = queueDate === getLocalDateKey() && serviceId === queueId
      ? queue.nextTokenNumber ?? 1
      : 1
    if (!Number.isSafeInteger(dailyCounters[counterKey])) {
      firstUnusedNumber = existingTokens.reduce((nextNumber, existing) => {
        const isSameService = existing.serviceId === serviceId
          || (!existing.serviceId && serviceId === queueId)
        return isSameService && Number.isSafeInteger(existing.tokenNumber)
          ? Math.max(nextNumber, existing.tokenNumber + 1)
          : nextNumber
      }, firstUnusedNumber)
    }
    const tokenNumber = dailyCounters[counterKey] ?? firstUnusedNumber
    if (!Number.isSafeInteger(tokenNumber) || tokenNumber < 1) {
      throw new Error('This date has an invalid token counter. Contact the organization administrator.')
    }
    const tokenId = doc(tokensCollection).id
    const tokenRef = doc(tokensCollection, tokenId)
    const nextLimits = addBookingToLimits(
      bookingLimitsSnapshot.exists() ? bookingLimitsSnapshot.data() : null,
      dailyLimitsSnapshot.exists() ? dailyLimitsSnapshot.data() : null,
      queueId,
      queueDate,
      tokenId,
    )
    const serviceName = typeof options.serviceName === 'string' && options.serviceName.trim()
      ? options.serviceName.trim()
      : typeof queue.name === 'string' && queue.name.trim() ? queue.name : queueId
    const status = dayIsOpen && startsNow ? 'waiting' : 'scheduled'

    transaction.update(queueRef, {
      dailyCounters: { ...dailyCounters, [counterKey]: tokenNumber + 1 },
      lastIssuedTokenId: tokenId,
    })
    if (bookingLimitsSnapshot.exists()) transaction.update(bookingLimitsRef, nextLimits.active)
    else transaction.set(bookingLimitsRef, nextLimits.active)
    if (dailyLimitsSnapshot.exists()) transaction.update(dailyLimitsRef, nextLimits.daily)
    else transaction.set(dailyLimitsRef, nextLimits.daily)
    const token = {
      tokenNumber,
      userId: user.uid,
      userName: user.displayName || user.email || 'QLine user',
      queueId,
      queueName: typeof queue.name === 'string' && queue.name.trim() ? queue.name : queueId,
      serviceId,
      serviceName,
      queueDate,
      timeSlot,
      counterKey,
      status,
      limitTracked: true,
      createdAt: serverTimestamp(),
    }
    if (pipelineOptions) {
      Object.assign(token, {
        pipelineId: pipelineOptions.pipelineId,
        pipelineRunId: pipelineRunRef.id,
        pipelineStep,
        previousTokenId: pipelineStep > 1 ? pipelineOptions.previousTokenId : '',
      })
      if (pipelineStep === 1) {
        transaction.set(pipelineRunRef, {
          pipelineId: pipelineOptions.pipelineId,
          userId: user.uid,
          status: 'active',
          currentStep: 1,
          currentQueueId: queueId,
          currentTokenId: tokenId,
          steps: [{ queueId, tokenId, tokenNumber, status }],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      } else {
        const run = pipelineRunSnapshot.data()
        transaction.update(pipelineRunRef, {
          status: 'active',
          currentStep: pipelineStep,
          currentQueueId: queueId,
          currentTokenId: tokenId,
          steps: [...run.steps, { queueId, tokenId, tokenNumber, status }],
          updatedAt: serverTimestamp(),
        })
      }
    }
    transaction.set(tokenRef, token)
    return {
      id: tokenId,
      tokenNumber,
      status,
      queueDate,
      timeSlot,
      serviceName,
      ...(pipelineOptions ? { pipelineRunId: pipelineRunRef.id, pipelineStep } : {}),
    }
  })
}

export async function joinPipelineStep(orgId, pipelineId, user, { runId = '', profile } = {}) {
  const pipelineRef = doc(db, 'organizations', orgId, 'pipelines', pipelineId)
  const pipelineSnapshot = await getDoc(pipelineRef)
  if (!pipelineSnapshot.exists() || pipelineSnapshot.data().published !== true) {
    throw new Error('This pipeline is not currently published.')
  }
  const pipeline = pipelineSnapshot.data()
  let step = 1
  let previousTokenId = ''
  let activeRunId = runId
  if (runId) {
    const runSnapshot = await getDoc(doc(pipelineRef, 'runs', runId))
    if (!runSnapshot.exists() || runSnapshot.data().userId !== user?.uid) {
      throw new Error('This pipeline run is not available for your account.')
    }
    const run = runSnapshot.data()
    step = getNextPipelineStep(pipeline, run) + 1
    if (!Number.isSafeInteger(step) || step < 2) {
      throw new Error('Complete the current pipeline step before continuing.')
    }
    previousTokenId = run.currentTokenId
  } else {
    activeRunId = doc(collection(pipelineRef, 'runs')).id
  }
  const queueId = pipeline.queueIds?.[step - 1]
  if (typeof queueId !== 'string' || !queueId) throw new Error('This pipeline step is not available.')
  const queuesRef = doc(db, 'organizations', orgId, 'queues', queueId)
  const queueSnapshot = await getDoc(queuesRef)
  if (!queueSnapshot.exists()) throw new Error('The pipeline queue is no longer available.')
  const queue = queueSnapshot.data()
  return joinQueue(orgId, queueId, user, {
    serviceId: queueId,
    serviceName: queue.name,
    profile,
    pipeline: { pipelineId, runId: activeRunId, step, previousTokenId },
  })
}

export async function concludePipelineRun(orgId, pipelineId, runId) {
  const runRef = doc(db, 'organizations', orgId, 'pipelines', pipelineId, 'runs', runId)
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(runRef)
    if (!snapshot.exists()) throw new Error('This pipeline run is no longer available.')
    if (snapshot.data().status !== 'ready') {
      throw new Error('This pipeline has already concluded.')
    }
    transaction.update(runRef, { status: 'concluded', updatedAt: serverTimestamp() })
    return true
  })
}
