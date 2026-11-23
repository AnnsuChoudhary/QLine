import { collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { auth, db } from './firebase/config.js'
import { getLocalDateKey, getLocalTimeKey, isTokenTimeDue, isValidDateKey } from './dates.js'
import { getBookingVerificationError } from './bookingVerification.js'
import { addBookingToLimits, getBookingLimitError, removeActiveBookingFromLimits } from './bookingLimits.js'

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
    const [organizationSnapshot, queueSnapshot, bookingLimitsSnapshot, dailyLimitsSnapshot, restrictionSnapshot] = await Promise.all([
      transaction.get(organizationRef),
      transaction.get(queueRef),
      transaction.get(bookingLimitsRef),
      transaction.get(dailyLimitsRef),
      transaction.get(restrictionRef),
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
    transaction.set(tokenRef, {
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
    })
    return { id: tokenId, tokenNumber, status, queueDate, timeSlot, serviceName }
  })
}
