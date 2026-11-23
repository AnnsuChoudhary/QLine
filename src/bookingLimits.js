export const BOOKING_LIMITS = Object.freeze({
  activePerQueue: 3,
  activePerOrganization: 5,
  dailyPerQueue: 5,
  dailyPerOrganization: 10,
})

export const DEFAULT_BOOKING_INTEGRITY = Object.freeze({
  maxNoShows: 3,
  maxCancellations: 5,
})

function readCounter(map, key, label) {
  if (map !== undefined && map !== null && (typeof map !== 'object' || Array.isArray(map))) {
    throw new Error(`Your booking limit record has invalid ${label} data. Contact the organization administrator.`)
  }
  const value = map?.[key] ?? 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Your booking limit record has invalid ${label} data. Contact the organization administrator.`)
  }
  return value
}

function validateLimitDocuments(activeLimits, dailyLimits, date) {
  if (activeLimits != null
    && (!Number.isSafeInteger(activeLimits.activeTotal)
      || activeLimits.activeTotal < 0
      || (activeLimits.noShowCount !== undefined
        && (!Number.isSafeInteger(activeLimits.noShowCount) || activeLimits.noShowCount < 0))
      || (activeLimits.cancellationCount !== undefined
        && (!Number.isSafeInteger(activeLimits.cancellationCount) || activeLimits.cancellationCount < 0))
      || !activeLimits.activeByQueue
      || typeof activeLimits.activeByQueue !== 'object'
      || Array.isArray(activeLimits.activeByQueue))) {
    throw new Error('Your active booking limit record is invalid. Contact the organization administrator.')
  }
  if (dailyLimits != null
    && (!Number.isSafeInteger(dailyLimits.total)
      || dailyLimits.total < 0
      || !dailyLimits.byQueue
      || typeof dailyLimits.byQueue !== 'object'
      || Array.isArray(dailyLimits.byQueue)
      || dailyLimits.date !== date)) {
    throw new Error('Your daily booking limit record is invalid. Contact the organization administrator.')
  }
}

export function getBookingLimitError(activeLimits, dailyLimits, queueId, date, integrity = {}) {
  validateLimitDocuments(activeLimits, dailyLimits, date)
  const maxNoShows = integrity.maxNoShows ?? DEFAULT_BOOKING_INTEGRITY.maxNoShows
  const maxCancellations = integrity.maxCancellations ?? DEFAULT_BOOKING_INTEGRITY.maxCancellations
  if (!Number.isInteger(maxNoShows) || maxNoShows < 0 || maxNoShows > 20
    || !Number.isInteger(maxCancellations) || maxCancellations < 0 || maxCancellations > 20) {
    throw new Error('This organization has invalid repeat-booking settings. Contact its administrator.')
  }
  const noShowCount = readCounter(activeLimits, 'noShowCount', 'no-show')
  const cancellationCount = readCounter(activeLimits, 'cancellationCount', 'cancellation')
  if (maxNoShows > 0 && noShowCount >= maxNoShows) {
    return 'This organization has paused new bookings for your account after repeated no-shows. Contact its administrator if you believe this is a mistake.'
  }
  if (maxCancellations > 0 && cancellationCount >= maxCancellations) {
    return 'This organization has paused new bookings for your account after repeated cancellations. Contact its administrator if you believe this is a mistake.'
  }

  const activeQueueCount = readCounter(activeLimits?.activeByQueue, queueId, 'queue')
  const activeOrgCount = readCounter(activeLimits, 'activeTotal', 'organization')
  const dailyQueueCount = readCounter(dailyLimits?.byQueue, queueId, 'daily queue')
  const dailyOrgCount = readCounter(dailyLimits, 'total', 'daily organization')

  if (activeQueueCount >= BOOKING_LIMITS.activePerQueue) {
    return `You already have ${BOOKING_LIMITS.activePerQueue} active bookings in this queue. Cancel or complete one before booking again.`
  }
  if (activeOrgCount >= BOOKING_LIMITS.activePerOrganization) {
    return `You already have ${BOOKING_LIMITS.activePerOrganization} active bookings with this organization. Cancel or complete one before booking again.`
  }
  if (dailyQueueCount >= BOOKING_LIMITS.dailyPerQueue) {
    return `You have reached the daily limit of ${BOOKING_LIMITS.dailyPerQueue} bookings for this queue.`
  }
  if (dailyOrgCount >= BOOKING_LIMITS.dailyPerOrganization) {
    return `You have reached the daily limit of ${BOOKING_LIMITS.dailyPerOrganization} bookings with this organization.`
  }
  return ''
}

export function addBookingToLimits(activeLimits, dailyLimits, queueId, date, tokenId) {
  validateLimitDocuments(activeLimits, dailyLimits, date)
  return {
    active: {
      activeTotal: readCounter(activeLimits, 'activeTotal', 'organization') + 1,
      noShowCount: readCounter(activeLimits, 'noShowCount', 'no-show'),
      cancellationCount: readCounter(activeLimits, 'cancellationCount', 'cancellation'),
      activeByQueue: {
        ...(activeLimits?.activeByQueue || {}),
        [queueId]: readCounter(activeLimits?.activeByQueue, queueId, 'queue') + 1,
      },
      lastMutationTokenId: tokenId,
      lastMutationQueueId: queueId,
    },
    daily: {
      total: readCounter(dailyLimits, 'total', 'daily organization') + 1,
      byQueue: {
        ...(dailyLimits?.byQueue || {}),
        [queueId]: readCounter(dailyLimits?.byQueue, queueId, 'daily queue') + 1,
      },
      lastMutationTokenId: tokenId,
      lastMutationQueueId: queueId,
      date,
    },
  }
}

export function removeActiveBookingFromLimits(activeLimits, queueId, tokenId, status, countCancellation = false) {
  validateLimitDocuments(activeLimits, null)
  if (!['cancelled', 'completed', 'no_show'].includes(status)) {
    throw new Error('The queue token status is invalid for updating booking limits.')
  }
  const activeTotal = readCounter(activeLimits, 'activeTotal', 'organization')
  const activeQueueCount = readCounter(activeLimits?.activeByQueue, queueId, 'queue')
  if (activeTotal === 0 || activeQueueCount === 0) {
    throw new Error('Your active booking limit record is out of sync. Contact the organization administrator.')
  }
  return {
    activeTotal: activeTotal - 1,
    noShowCount: readCounter(activeLimits, 'noShowCount', 'no-show') + (status === 'no_show' ? 1 : 0),
    cancellationCount: readCounter(activeLimits, 'cancellationCount', 'cancellation')
      + (status === 'cancelled' && countCancellation ? 1 : 0),
    activeByQueue: {
      ...activeLimits.activeByQueue,
      [queueId]: activeQueueCount - 1,
    },
    lastMutationTokenId: tokenId,
    lastMutationQueueId: queueId,
  }
}
