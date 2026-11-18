export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const body = await response.text()
  let data
  try {
    data = body ? JSON.parse(body) : {}
  } catch {
    throw new Error(
      response.ok
        ? 'The QLine API returned an invalid response. Check that the API server is running.'
        : `The QLine API returned an invalid response (${response.status}). Check that the API server is running.`,
    )
  }
  if (!body && !response.ok) {
    throw new Error(`The QLine API returned an empty response (${response.status}). Check that the API server is running.`)
  }
  if (!body) throw new Error('The QLine API returned an empty response.')
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return data
}

export function formatDateLabel(value) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date)
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(date)
  return `${weekday}, ${day} ${monthName}`.toUpperCase()
}

export function formatDateTime(value) {
  return new Date(value).toLocaleString()
}

export function formatAppointmentDate(value) {
  const date = new Date(value)
  return {
    day: date.toLocaleDateString(undefined, { day: '2-digit' }),
    month: date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
  }
}

export function formatQueueTime(value) {
  return new Date(`${value.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
