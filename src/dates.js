export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getLocalTimeKey(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export function isValidDateKey(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function getAvailableTimeSlots(dateKey, durationMinutes, openingTime = '09:00', closingTime = '17:00', now = new Date()) {
  if (!isValidDateKey(dateKey)) return []
  const duration = Number.isSafeInteger(durationMinutes) && durationMinutes > 0 ? durationMinutes : 30
  const toMinutes = (value) => {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null
    const [hours, minutes] = value.split(':').map(Number)
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null
  }
  const opensAt = toMinutes(openingTime)
  const closesAt = toMinutes(closingTime)
  if (opensAt === null || closesAt === null || closesAt <= opensAt) return []

  const nowKey = getLocalDateKey(now)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const firstSlot = dateKey === nowKey ? Math.max(opensAt, nowMinutes + 1) : opensAt
  const slots = []
  for (let start = opensAt; start + duration <= closesAt; start += duration) {
    if (dateKey !== nowKey || start >= firstSlot) {
      slots.push(`${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`)
    }
  }
  return slots
}

export function isTokenForDate(token, dateKey = getLocalDateKey()) {
  if (typeof token.queueDate === 'string') return token.queueDate === dateKey
  const createdAt = token.createdAt?.toDate?.()
  return createdAt instanceof Date && getLocalDateKey(createdAt) === dateKey
}

export function isAppointmentActive(appointment, dateKey = getLocalDateKey()) {
  return ['booked', 'checked_in'].includes(appointment.status)
    && typeof appointment.date === 'string'
    && appointment.date >= dateKey
}

export function isTokenTimeDue(token, now = new Date()) {
  if (typeof token.queueDate !== 'string' || typeof token.timeSlot !== 'string') return false
  const today = getLocalDateKey(now)
  return token.queueDate < today || (token.queueDate === today && token.timeSlot <= getLocalTimeKey(now))
}
