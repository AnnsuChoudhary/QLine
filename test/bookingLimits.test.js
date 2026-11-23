import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addBookingToLimits,
  getBookingLimitError,
  removeActiveBookingFromLimits,
} from '../src/bookingLimits.js'

test('booking limits combine per-queue and per-organization active and daily counts', () => {
  const date = '2026-11-23'
  assert.equal(getBookingLimitError(null, null, 'queue-a', date), '')
  assert.match(
    getBookingLimitError(
      { activeByQueue: { 'queue-a': 3 }, activeTotal: 3 },
      { byQueue: {}, total: 0, date },
      'queue-a',
      date,
    ),
    /3 active bookings in this queue/,
  )
  assert.match(
    getBookingLimitError(
      { activeByQueue: {}, activeTotal: 5 },
      { byQueue: {}, total: 0, date },
      'queue-a',
      date,
    ),
    /5 active bookings with this organization/,
  )
  assert.match(
    getBookingLimitError(
      { activeByQueue: {}, activeTotal: 0 },
      { byQueue: { 'queue-a': 5 }, total: 5, date },
      'queue-a',
      date,
    ),
    /daily limit of 5 bookings for this queue/,
  )
  assert.match(
    getBookingLimitError(
      { activeByQueue: {}, activeTotal: 0 },
      { byQueue: {}, total: 10, date },
      'queue-a',
      date,
    ),
    /daily limit of 10 bookings with this organization/,
  )
  assert.match(
    getBookingLimitError(
      { activeByQueue: {}, activeTotal: 0, noShowCount: 3, cancellationCount: 0 },
      { byQueue: {}, total: 0, date },
      'queue-a',
      date,
    ),
    /repeated no-shows/,
  )
  assert.match(
    getBookingLimitError(
      { activeByQueue: {}, activeTotal: 0, noShowCount: 0, cancellationCount: 5 },
      { byQueue: {}, total: 0, date },
      'queue-a',
      date,
    ),
    /repeated cancellations/,
  )
  assert.equal(getBookingLimitError(
    { activeByQueue: {}, activeTotal: 0, noShowCount: 8, cancellationCount: 8 },
    { byQueue: {}, total: 0, date },
    'queue-a',
    date,
    { maxNoShows: 0, maxCancellations: 0 },
  ), '')
})

test('booking limit updates increment daily totals and release only active capacity', () => {
  const updated = addBookingToLimits(
    { activeTotal: 1, activeByQueue: { 'queue-a': 1 } },
    { total: 2, byQueue: { 'queue-a': 2 }, date: '2026-11-23' },
    'queue-a',
    '2026-11-23',
    'token-3',
  )
  assert.equal(updated.active.activeTotal, 2)
  assert.equal(updated.active.activeByQueue['queue-a'], 2)
  assert.equal(updated.daily.total, 3)
  assert.equal(updated.daily.byQueue['queue-a'], 3)

  const afterCancellation = removeActiveBookingFromLimits(updated.active, 'queue-a', 'token-3', 'completed')
  assert.equal(afterCancellation.activeTotal, 1)
  assert.equal(afterCancellation.activeByQueue['queue-a'], 1)
  assert.equal(afterCancellation.cancellationCount, 0)
  assert.equal(afterCancellation.noShowCount, 0)

  const cancelled = removeActiveBookingFromLimits(updated.active, 'queue-a', 'token-3', 'cancelled', true)
  const adminCancelled = removeActiveBookingFromLimits(updated.active, 'queue-a', 'token-3', 'cancelled')
  const noShow = removeActiveBookingFromLimits(updated.active, 'queue-a', 'token-3', 'no_show')
  assert.equal(cancelled.cancellationCount, 1)
  assert.equal(adminCancelled.cancellationCount, 0)
  assert.equal(cancelled.noShowCount, 0)
  assert.equal(noShow.noShowCount, 1)
  assert.equal(noShow.cancellationCount, 0)
})

test('booking limits reject malformed counters rather than treating them as empty', () => {
  assert.throws(
    () => getBookingLimitError({ activeTotal: -1, activeByQueue: {} }, null, 'queue-a', '2026-11-23'),
    /active booking limit record is invalid/,
  )
  assert.throws(
    () => getBookingLimitError(
      { activeTotal: 0, activeByQueue: {} },
      { total: 0, byQueue: {}, date: 'invalid' },
      'queue-a',
      '2026-11-23',
    ),
    /daily booking limit record is invalid/,
  )
})
