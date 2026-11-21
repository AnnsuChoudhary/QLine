import { collection, doc, query, runTransaction, serverTimestamp, where } from 'firebase/firestore'
import { db } from './firebase/config.js'
import { getLocalDateKey, getLocalTimeKey, isTokenTimeDue, isValidDateKey } from './dates.js'

export function formatTokenNumber(number) {
  return Number.isSafeInteger(number) && number > 0 ? String(number).padStart(3, '0') : '—'
}

export async function joinQueue(orgId, queueId, user, options = {}) {
  if (!orgId || !queueId) throw new Error('Choose an organization and queue before joining.')
  if (!user?.uid) throw new Error('Sign in before joining a queue.')
  const queueDate = options.date || getLocalDateKey()
  const timeSlot = options.timeSlot || getLocalTimeKey()
  const serviceId = options.serviceId || queueId
  if (!isValidDateKey(queueDate)) throw new Error('Choose a valid date for your queue token.')
  if (queueDate < getLocalDateKey()) throw new Error('Choose today or a future date for your queue token.')
  if (typeof timeSlot !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeSlot)) {
    throw new Error('Choose a valid time slot for your queue token.')
  }
  const queueRef = doc(db, 'organizations', orgId, 'queues', queueId)
  return runTransaction(db, async (transaction) => {
    const queueSnapshot = await transaction.get(queueRef)
    if (!queueSnapshot.exists()) throw new Error('This queue is no longer available.')
    const queue = queueSnapshot.data()
    if (!queue || typeof queue !== 'object') throw new Error('This queue has invalid settings.')
    const dayIsOpen = queue.status === 'open'
      && (!queue.activeDate || queue.activeDate === queueDate)
    const tokenData = { queueDate, timeSlot }
    const startsNow = isTokenTimeDue(tokenData)
    if (!options.allowScheduled && (!dayIsOpen || !startsNow)) {
      throw new Error('This queue is not currently accepting live tokens.')
    }

    const counterKey = `${queueDate}__${serviceId}`
    const dailyCounters = queue.dailyCounters && typeof queue.dailyCounters === 'object'
      ? queue.dailyCounters
      : {}
    let firstUnusedNumber = queueDate === getLocalDateKey() && serviceId === queueId
      ? queue.nextTokenNumber ?? 1
      : 1
    if (!Number.isSafeInteger(dailyCounters[counterKey])) {
      const existingTokens = await transaction.get(query(
        collection(db, 'organizations', orgId, 'queues', queueId, 'tokens'),
        where('queueDate', '==', queueDate),
      ))
      firstUnusedNumber = existingTokens.docs.reduce((nextNumber, tokenDocument) => {
        const existing = tokenDocument.data()
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
    const tokenId = doc(collection(db, 'organizations', orgId, 'queues', queueId, 'tokens')).id
    const tokenRef = doc(collection(db, 'organizations', orgId, 'queues', queueId, 'tokens'), tokenId)
    const serviceName = typeof options.serviceName === 'string' && options.serviceName.trim()
      ? options.serviceName.trim()
      : typeof queue.name === 'string' && queue.name.trim() ? queue.name : queueId
    const status = dayIsOpen && startsNow ? 'waiting' : 'scheduled'

    transaction.update(queueRef, {
      dailyCounters: { ...dailyCounters, [counterKey]: tokenNumber + 1 },
      lastIssuedTokenId: tokenId,
    })
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
      createdAt: serverTimestamp(),
    })
    return { id: tokenId, tokenNumber, status, queueDate, timeSlot, serviceName }
  })
}
