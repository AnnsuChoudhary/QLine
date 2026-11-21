import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAvailableTimeSlots, getLocalDateKey, isAppointmentActive, isTokenForDate, isTokenTimeDue } from '../src/dates.js'

test('local date keys use calendar dates rather than UTC date boundaries', () => {
  const date = new Date(2026, 10, 21, 0, 15)
  assert.equal(getLocalDateKey(date), '2026-11-21')
})

test('live queue tokens must belong to today, including legacy timestamp records', () => {
  assert.equal(isTokenForDate({ queueDate: '2026-11-21' }, '2026-11-21'), true)
  assert.equal(isTokenForDate({ queueDate: '2026-11-20' }, '2026-11-21'), false)

  const createdAt = new Date(2026, 10, 21, 9)
  assert.equal(isTokenForDate({ createdAt: { toDate: () => createdAt } }, '2026-11-21'), true)
  assert.equal(isTokenForDate({ createdAt: { toDate: () => createdAt } }, '2026-11-22'), false)
  assert.equal(isTokenForDate({}, '2026-11-21'), false)
})

test('only scheduled or checked-in appointments today or later are active', () => {
  const today = '2026-11-21'
  assert.equal(isAppointmentActive({ status: 'booked', date: today }, today), true)
  assert.equal(isAppointmentActive({ status: 'checked_in', date: '2026-11-22' }, today), true)
  assert.equal(isAppointmentActive({ status: 'booked', date: '2026-11-20' }, today), false)
  assert.equal(isAppointmentActive({ status: 'completed', date: '2026-11-22' }, today), false)
  assert.equal(isAppointmentActive({ status: 'cancelled', date: today }, today), false)
})

test('available booking slots follow service duration and omit elapsed times today', () => {
  const now = new Date(2026, 10, 21, 9, 20)
  assert.deepEqual(
    getAvailableTimeSlots('2026-11-21', 20, '09:00', '10:00', now),
    ['09:40'],
  )
  assert.deepEqual(
    getAvailableTimeSlots('2026-11-22', 30, '09:00', '10:00', now),
    ['09:00', '09:30'],
  )
  assert.deepEqual(getAvailableTimeSlots('2026-11-31', 30, '09:00', '10:00', now), [])
  assert.deepEqual(getAvailableTimeSlots('2026-11-21', 30, '10:00', '09:00', now), [])
})

test('scheduled tokens become due only when their date and time arrive', () => {
  const now = new Date(2026, 10, 21, 10, 0)
  assert.equal(isTokenTimeDue({ queueDate: '2026-11-21', timeSlot: '10:00' }, now), true)
  assert.equal(isTokenTimeDue({ queueDate: '2026-11-21', timeSlot: '10:01' }, now), false)
  assert.equal(isTokenTimeDue({ queueDate: '2026-11-22', timeSlot: '09:00' }, now), false)
  assert.equal(isTokenTimeDue({ queueDate: '2026-11-20', timeSlot: '10:01' }, now), true)
})
