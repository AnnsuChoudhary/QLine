import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer, WebSocket } from 'ws'

const services = [
  { id: 'consultation', name: 'General consultation', duration: 20 },
  { id: 'new-patient', name: 'New patient', duration: 30 },
  { id: 'prescription', name: 'Prescription review', duration: 15 },
  { id: 'follow-up', name: 'Follow-up', duration: 15 },
]
const locations = [{ id: 'northside', name: 'Northside Clinic', address: 'Main location', status: 'open' }]
function localDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      opens_at TEXT NOT NULL DEFAULT '09:00', closes_at TEXT NOT NULL DEFAULT '17:00'
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer', 'staff', 'business')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL REFERENCES customers(id),
      service_id TEXT NOT NULL REFERENCES services(id), starts_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'appointment' CHECK(kind IN ('appointment', 'queue')),
      status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked', 'completed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS queue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token INTEGER NOT NULL, queue_date TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id), service_id TEXT NOT NULL REFERENCES services(id),
      appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
      status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'serving', 'completed', 'cancelled', 'skipped')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), called_at TEXT, completed_at TEXT,
      UNIQUE(queue_date, token)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_queue_entry_per_customer
      ON queue_entries(customer_id) WHERE status IN ('waiting', 'serving');
    CREATE TABLE IF NOT EXISTS queue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
  if (!columns('appointments').has('kind')) {
    db.exec("ALTER TABLE appointments ADD COLUMN kind TEXT NOT NULL DEFAULT 'appointment'")
  }
  if (!columns('queue_entries').has('appointment_id')) {
    db.exec('ALTER TABLE queue_entries ADD COLUMN appointment_id INTEGER REFERENCES appointments(id)')
  }
  if (!columns('locations').has('opens_at')) {
    db.exec("ALTER TABLE locations ADD COLUMN opens_at TEXT NOT NULL DEFAULT '09:00'")
  }
  if (!columns('locations').has('closes_at')) {
    db.exec("ALTER TABLE locations ADD COLUMN closes_at TEXT NOT NULL DEFAULT '17:00'")
  }
  const unlinkedQueueEntries = db.prepare(`
    SELECT id, customer_id, service_id, created_at, status
    FROM queue_entries WHERE appointment_id IS NULL
  `).all()
  for (const entry of unlinkedQueueEntries) {
    const startsAt = new Date(Date.parse(`${entry.created_at.replace(' ', 'T')}Z`) + Number(entry.id)).toISOString()
    const status = entry.status === 'completed' ? 'completed' : ['cancelled', 'skipped'].includes(entry.status) ? 'cancelled' : 'booked'
    const appointment = db.prepare(`
      INSERT INTO appointments (customer_id, service_id, starts_at, kind, status)
      VALUES (?, ?, ?, 'queue', ?)
    `).run(entry.customer_id, entry.service_id, startsAt, status)
    db.prepare('UPDATE queue_entries SET appointment_id = ? WHERE id = ?').run(Number(appointment.lastInsertRowid), entry.id)
  }
  const addService = db.prepare('INSERT OR IGNORE INTO services (id, name, duration_minutes) VALUES (?, ?, ?)')
  for (const service of services) addService.run(service.id, service.name, service.duration)
  const addLocation = db.prepare('INSERT OR IGNORE INTO locations (id, name, address, status, opens_at, closes_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (const location of locations) addLocation.run(location.id, location.name, location.address, location.status, '09:00', '17:00')
  return db
}

function sessionCookie(token, secure = false) {
  return `qline_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`
}

function sessionUser(db, request) {
  const token = request.headers.cookie?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('qline_session='))
    ?.slice('qline_session='.length)
  if (!token) return null
  const tokenHash = createHash('sha256').update(token).digest('hex')
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > unixepoch()
  `).get(tokenHash) ?? null
}

function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    tokenHash,
    userId,
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  )
  return token
}

function accountRole(email, businessEmails, staffEmails) {
  const addresses = businessEmails.map((item) => item.trim().toLowerCase())
  const staff = staffEmails.map((item) => item.trim().toLowerCase())
  if (addresses.includes(email)) return 'business'
  if (staff.includes(email)) return 'staff'
  return 'customer'
}

function availableSlots(db, date, serviceId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const service = db.prepare('SELECT duration_minutes AS duration FROM services WHERE id = ? AND active = 1').get(serviceId)
  const location = db.prepare("SELECT opens_at AS opensAt, closes_at AS closesAt, status FROM locations WHERE id = 'northside'").get()
  if (!service || !location || location.status !== 'open') return []
  const now = new Date()
  const dayStart = new Date(`${date}T00:00:00`)
  const dayDiff = Math.floor((new Date(`${date}T12:00:00`).getTime() - new Date(`${localDate()}T12:00:00`).getTime()) / 86400000)
  if (Number.isNaN(dayStart.getTime()) || dayDiff < 0 || dayDiff > 30) return []
  const [openHour, openMinute] = location.opensAt.split(':').map(Number)
  const [closeHour, closeMinute] = location.closesAt.split(':').map(Number)
  const open = new Date(`${date}T${location.opensAt}:00`)
  const close = new Date(`${date}T${location.closesAt}:00`)
  const booked = db.prepare(`
    SELECT a.starts_at AS startsAt, s.duration_minutes AS duration
    FROM appointments a JOIN services s ON s.id = a.service_id
    WHERE a.kind = 'appointment' AND a.status = 'booked'
  `).all().filter((booking) => {
    const bookedStart = Date.parse(booking.startsAt)
    const bookedEnd = bookedStart + Number(booking.duration) * 60000
    return bookedStart < close.getTime() && bookedEnd > open.getTime()
  })
  const slots = []
  for (let minutes = openHour * 60 + openMinute; minutes + Number(service.duration) <= closeHour * 60 + closeMinute; minutes += 15) {
    const start = new Date(`${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`)
    const end = new Date(start.getTime() + Number(service.duration) * 60000)
    if (start <= now) continue
    const overlaps = booked.some((booking) => {
      const bookedStart = Date.parse(booking.startsAt)
      const bookedEnd = bookedStart + Number(booking.duration) * 60000
      return start.getTime() < bookedEnd && end.getTime() > bookedStart
    })
    if (!overlaps) {
      slots.push({
        startsAt: start.toISOString(),
        label: start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      })
    }
  }
  return slots
}

function queueRows(db, date = localDate()) {
  const rows = db.prepare(`
    SELECT q.id, q.token, q.queue_date AS queueDate, q.customer_id AS customerId,
      c.name, s.name AS service, s.duration_minutes AS duration, q.status,
      q.created_at AS createdAt, q.called_at AS calledAt
    FROM queue_entries q JOIN customers c ON c.id = q.customer_id
    JOIN services s ON s.id = q.service_id
    WHERE q.queue_date = ? AND q.status IN ('waiting', 'serving')
    ORDER BY q.token
  `).all(date)
  const servingCount = rows.filter((entry) => entry.status === 'serving').length
  let waitingIndex = 0
  let estimatedWait = rows.filter((entry) => entry.status === 'serving')
    .reduce((minutes, entry) => {
      const calledAt = entry.calledAt ? new Date(`${entry.calledAt.replace(' ', 'T')}Z`).getTime() : Date.now()
      const elapsed = Math.max(0, (Date.now() - calledAt) / 60000)
      return minutes + Math.max(0, Number(entry.duration) - elapsed)
    }, 0)
  return rows.map((entry) => {
    if (entry.status === 'serving') {
      return { ...entry, tokenLabel: `A–${String(entry.token).padStart(3, '0')}`, peopleAhead: 0, waitMinutes: 0 }
    }
    waitingIndex += 1
    const peopleAhead = waitingIndex - 1 + servingCount
    const result = {
      ...entry,
      tokenLabel: `A–${String(entry.token).padStart(3, '0')}`,
      peopleAhead,
      waitMinutes: Math.ceil(estimatedWait),
    }
    estimatedWait += Number(entry.duration)
    return result
  })
}

function dashboardData(db, { customerId = '', role = 'customer', range = 'today' } = {}) {
  const today = localDate()
  const allQueue = queueRows(db, today)
  const queue = role === 'customer' ? allQueue.filter((entry) => entry.customerId === customerId) : allQueue
  const appointmentsToday = db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE substr(starts_at, 1, 10) = ? AND status != 'cancelled'").get(today).count
  const completedCount = db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE substr(starts_at, 1, 10) = ? AND status = 'completed'").get(today).count
  const completedWait = db.prepare(`
    SELECT AVG((julianday(called_at) - julianday(created_at)) * 1440) AS average
    FROM queue_entries WHERE queue_date = ? AND status IN ('completed', 'serving') AND called_at IS NOT NULL
  `).get(today).average
  const averageWaitMinutes = Math.round(completedWait ?? queue.filter((entry) => entry.status === 'waiting').reduce((total, entry) => total + Math.max(0, (Date.now() - new Date(`${entry.createdAt.replace(' ', 'T')}Z`).getTime()) / 60000), 0) / Math.max(1, queue.filter((entry) => entry.status === 'waiting').length))
  const flow = range === 'week'
    ? db.prepare(`
        SELECT substr(created_at, 1, 10) AS time, COUNT(*) AS customers
        FROM queue_entries WHERE created_at >= datetime('now', '-6 days')
        GROUP BY substr(created_at, 1, 10) ORDER BY time
      `).all()
    : db.prepare(`
        SELECT printf('%02d', CAST(strftime('%H', created_at) AS INTEGER)) AS hour, COUNT(*) AS customers
        FROM queue_entries WHERE queue_date = ? GROUP BY hour ORDER BY hour
      `).all(today).map(({ hour, customers }) => ({
        time: `${Number(hour) % 12 || 12}${Number(hour) < 12 ? 'am' : 'pm'}`,
        customers,
      }))
  const appointments = db.prepare(`
    SELECT a.id, a.customer_id AS customerId, c.name AS customer, s.name AS service,
      a.starts_at AS startsAt, a.status
    FROM appointments a JOIN customers c ON c.id = a.customer_id
    JOIN services s ON s.id = a.service_id
    WHERE a.status = 'booked' AND a.kind = 'appointment'
      AND (? != 'customer' OR a.customer_id = ?)
    ORDER BY a.starts_at LIMIT 100
  `).all(role, customerId)
  const customerQueue = allQueue.find((entry) => entry.customerId === customerId) ?? null
  const customerAppointments = customerId
    ? db.prepare(`
        SELECT a.id, s.name AS service, a.starts_at AS startsAt, a.status
        FROM appointments a JOIN services s ON s.id = a.service_id
        WHERE a.customer_id = ? AND a.status = 'booked' AND a.kind = 'appointment' ORDER BY a.starts_at
      `).all(customerId)
    : []
  const events = role === 'customer'
    ? []
    : db.prepare('SELECT id, type, message, created_at AS createdAt FROM queue_events ORDER BY id DESC LIMIT 10').all()
  return {
    today,
    appointmentsToday,
    waitingCount: allQueue.filter((entry) => entry.status === 'waiting').length,
    averageWaitMinutes,
    completedCount,
    flow,
    queue,
    current: role === 'customer' ? null : allQueue.find((entry) => entry.status === 'serving') ?? null,
    next: role === 'customer' ? null : allQueue.find((entry) => entry.status === 'waiting') ?? null,
    queueOpen: db.prepare("SELECT status FROM locations WHERE id = 'northside'").get()?.status === 'open',
    appointments,
    customerAppointments,
    customerQueue,
    customers: role === 'customer'
      ? db.prepare('SELECT id, name FROM customers WHERE id = ?').all(customerId)
      : db.prepare('SELECT id, name FROM customers ORDER BY name').all(),
    services: db.prepare('SELECT id, name, duration_minutes AS duration FROM services WHERE active = 1 ORDER BY name').all(),
    locations: db.prepare('SELECT id, name, address, status FROM locations ORDER BY name').all(),
    events,
  }
}

function validateId(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    const error = new Error(`${label} is required.`)
    error.status = 400
    throw error
  }
  const trimmed = value.trim()
  if (!trimmed) {
    const error = new Error(`${label} is required.`)
    error.status = 400
    throw error
  }
  return trimmed
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 20_000) {
      const error = new Error('Request body is too large.')
      error.status = 413
      throw error
    }
  }
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    const error = new Error('Request body must be valid JSON.')
    error.status = 400
    throw error
  }
}

function send(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  response.end(JSON.stringify(value))
}

export function createAppServer({
  dbPath = process.env.DATABASE_PATH ?? './data/qline.sqlite',
  businessEmails = (process.env.BUSINESS_EMAILS ?? '').split(',').filter(Boolean),
  staffEmails = (process.env.STAFF_EMAILS ?? '').split(',').filter(Boolean),
} = {}) {
  const db = createDatabase(dbPath)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return send(response, 200, { status: 'ok' })
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        return send(response, 200, { user: sessionUser(db, request) })
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJson(request)
        const name = validateId(body.name, 'Name')
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (name.length > 100) return send(response, 400, { error: 'Name must be 100 characters or fewer.' })
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
          return send(response, 400, { error: 'Enter a valid email address.' })
        }
        if (password.length < 8 || password.length > 128) {
          return send(response, 400, { error: 'Password must be between 8 and 128 characters.' })
        }
        const userId = randomUUID()
        const salt = randomBytes(16).toString('hex')
        const passwordHash = scryptSync(password, salt, 64).toString('hex')
        try {
          db.exec('BEGIN IMMEDIATE')
          db.prepare('INSERT INTO users (id, email, name, password_salt, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
            .run(userId, email, name, salt, passwordHash, accountRole(email, businessEmails, staffEmails))
          db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run(userId, name)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          if (error.errcode === 2067) return send(response, 409, { error: 'An account with this email already exists.' })
          throw error
        }
        db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()').run()
        const token = createSession(db, userId)
        const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(userId)
        const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true'
        return send(response, 201, { user }, { 'Set-Cookie': sessionCookie(token, secure) })
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(request)
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const account = db.prepare('SELECT id, email, name, role, password_salt AS salt, password_hash AS passwordHash FROM users WHERE email = ?').get(email)
        if (!account || password.length > 128) return send(response, 401, { error: 'Email or password is incorrect.' })
        const candidate = scryptSync(password, account.salt, 64)
        if (!timingSafeEqual(candidate, Buffer.from(account.passwordHash, 'hex'))) {
          return send(response, 401, { error: 'Email or password is incorrect.' })
        }
        db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()').run()
        const token = createSession(db, account.id)
        const user = { id: account.id, email: account.email, name: account.name, role: account.role }
        const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true'
        return send(response, 200, { user }, { 'Set-Cookie': sessionCookie(token, secure) })
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = request.headers.cookie?.split(';')
          .map((item) => item.trim())
          .find((item) => item.startsWith('qline_session='))
          ?.slice('qline_session='.length)
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'))
        const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true'
        return send(response, 200, { message: 'Signed out.' }, { 'Set-Cookie': sessionCookie('', secure).replace('Max-Age=2592000', 'Max-Age=0') })
      }
      const signedInUser = sessionUser(db, request)
      if (url.pathname.startsWith('/api/') && !signedInUser) return send(response, 401, { error: 'Please sign in to continue.' })
      if (request.method === 'GET' && url.pathname === '/api/slots') {
        return send(response, 200, availableSlots(
          db,
          url.searchParams.get('date') ?? '',
          url.searchParams.get('serviceId') ?? '',
        ))
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        return send(response, 200, dashboardData(db, {
          customerId: signedInUser.id,
          role: signedInUser.role,
          range: url.searchParams.get('range') === 'week' ? 'week' : 'today',
        }))
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (!['staff', 'business'].includes(signedInUser.role)) return send(response, 403, { error: 'Staff access is required.' })
        return send(response, 200, db.prepare('SELECT id, type, message, created_at AS createdAt FROM queue_events ORDER BY id DESC LIMIT 50').all())
      }
      if (request.method === 'PUT' && /^\/api\/customers\/[^/]+$/.test(url.pathname)) {
        const id = validateId(decodeURIComponent(url.pathname.split('/')[3]), 'Customer ID')
        if (id !== signedInUser.id) return send(response, 403, { error: 'You can only update your own profile.' })
        const body = await readJson(request)
        const name = validateId(body.name, 'Customer name')
        if (name.length > 100) return send(response, 400, { error: 'Customer name must be 100 characters or fewer.' })
        db.prepare('INSERT INTO customers (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(id, name)
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id)
        broadcast('queue.changed', { action: 'customer-updated', id })
        return send(response, 200, { id, name })
      }
      if (request.method === 'POST' && url.pathname === '/api/appointments') {
        if (signedInUser.role !== 'customer') return send(response, 403, { error: 'Customer access is required to book an appointment.' })
        const body = await readJson(request)
        const serviceId = validateId(body.serviceId, 'Service')
        const startsAt = typeof body.startsAt === 'string' ? body.startsAt : ''
        if (!Number.isFinite(Date.parse(startsAt)) || Date.parse(startsAt) < Date.now()) {
          return send(response, 400, { error: 'Choose a future appointment slot.' })
        }
        let result
        db.exec('BEGIN IMMEDIATE')
        try {
          const date = localDate(new Date(startsAt))
          const available = availableSlots(db, date, serviceId).some((slot) => slot.startsAt === new Date(startsAt).toISOString())
          if (!available) {
            db.exec('ROLLBACK')
            return send(response, 409, { error: 'That slot is no longer available. Choose another available time.' })
          }
          result = db.prepare('INSERT INTO appointments (customer_id, service_id, starts_at) VALUES (?, ?, ?)').run(
            signedInUser.id,
            serviceId,
            new Date(startsAt).toISOString(),
          )
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          if (error.errcode === 2067) {
            return send(response, 409, { error: 'That slot is no longer available. Choose another available time.' })
          }
          throw error
        }
        db.prepare('INSERT INTO queue_events (type, message) VALUES (?, ?)').run('appointment-booked', `${signedInUser.name} booked ${db.prepare('SELECT name FROM services WHERE id = ?').get(serviceId).name}.`)
        broadcast('queue.changed', { action: 'appointment-booked', id: Number(result.lastInsertRowid) })
        return send(response, 201, { id: Number(result.lastInsertRowid), message: 'Appointment booked.' })
      }
      if (request.method === 'POST' && url.pathname === '/api/queue') {
        if (signedInUser.role !== 'customer') return send(response, 403, { error: 'Customer access is required to join the queue.' })
        const body = await readJson(request)
        const customerId = signedInUser.id
        const customerName = signedInUser.name
        const serviceId = validateId(body.serviceId, 'Service')
        if (db.prepare("SELECT status FROM locations WHERE id = 'northside'").get()?.status !== 'open') {
          return send(response, 409, { error: 'The queue is currently closed.' })
        }
        if (!db.prepare('SELECT id FROM services WHERE id = ? AND active = 1').get(serviceId)) {
          return send(response, 400, { error: 'Choose an available service.' })
        }
        const date = localDate()
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('INSERT INTO customers (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(customerId, customerName)
          const existing = db.prepare("SELECT id FROM queue_entries WHERE customer_id = ? AND status IN ('waiting', 'serving')").get(customerId)
          if (existing) {
            db.exec('ROLLBACK')
            return send(response, 409, { error: 'You are already in the queue.' })
          }
          const token = Number(db.prepare('SELECT COALESCE(MAX(token), 0) + 1 AS next FROM queue_entries WHERE queue_date = ?').get(date).next)
          const appointmentResult = db.prepare("INSERT INTO appointments (customer_id, service_id, starts_at, kind) VALUES (?, ?, ?, 'queue')").run(customerId, serviceId, new Date().toISOString())
          const result = db.prepare('INSERT INTO queue_entries (token, queue_date, customer_id, service_id, appointment_id) VALUES (?, ?, ?, ?, ?)').run(token, date, customerId, serviceId, Number(appointmentResult.lastInsertRowid))
          db.prepare('INSERT INTO queue_events (type, message) VALUES (?, ?)').run('joined', `${customerName} joined the queue.`)
          db.exec('COMMIT')
          const entry = queueRows(db, date).find((row) => row.id === Number(result.lastInsertRowid))
          broadcast('queue.changed', { action: 'joined', entry })
          return send(response, 201, entry)
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
      if (request.method === 'DELETE' && /^\/api\/queue\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').at(-1))
        const customerId = signedInUser.id
        const entry = db.prepare("SELECT q.id, c.name FROM queue_entries q JOIN customers c ON c.id = q.customer_id WHERE q.id = ? AND q.customer_id = ? AND q.status IN ('waiting', 'serving')").get(id, customerId)
        if (!entry) return send(response, 404, { error: 'Active queue entry not found.' })
        db.prepare("UPDATE queue_entries SET status = 'cancelled' WHERE id = ?").run(id)
        db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = (SELECT appointment_id FROM queue_entries WHERE id = ?)").run(id)
        db.prepare('INSERT INTO queue_events (type, message) VALUES (?, ?)').run('cancelled', `${entry.name} left the queue.`)
        broadcast('queue.changed', { action: 'cancelled', id })
        return send(response, 200, { message: 'You left the queue.' })
      }
      if (request.method === 'POST' && url.pathname === '/api/queue/next') {
        if (!['staff', 'business'].includes(signedInUser.role)) return send(response, 403, { error: 'Staff access is required.' })
        db.exec('BEGIN IMMEDIATE')
        try {
          const current = db.prepare("SELECT id FROM queue_entries WHERE queue_date = ? AND status = 'serving' ORDER BY token LIMIT 1").get(localDate())
          if (current) {
            db.prepare("UPDATE queue_entries SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(current.id)
            db.prepare("UPDATE appointments SET status = 'completed' WHERE id = (SELECT appointment_id FROM queue_entries WHERE id = ?)").run(current.id)
          }
          const next = db.prepare("SELECT q.id, c.name FROM queue_entries q JOIN customers c ON c.id = q.customer_id WHERE q.queue_date = ? AND q.status = 'waiting' ORDER BY q.token LIMIT 1").get(localDate())
          if (next) db.prepare("UPDATE queue_entries SET status = 'serving', called_at = datetime('now') WHERE id = ?").run(next.id)
          if (current || next) {
            db.prepare('INSERT INTO queue_events (type, message) VALUES (?, ?)').run('called', next ? `${next.name} is now being served.` : 'The current service was completed.')
          }
          db.exec('COMMIT')
          const currentQueue = queueRows(db)
          broadcast('queue.changed', { action: 'called', current: currentQueue.find((row) => row.status === 'serving') ?? null })
          return send(response, 200, { current: currentQueue.find((row) => row.status === 'serving') ?? null, queue: currentQueue })
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
      if (request.method === 'DELETE' && /^\/api\/appointments\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').at(-1))
        const isStaff = ['staff', 'business'].includes(signedInUser.role)
        const result = isStaff
          ? db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND status = 'booked'").run(id)
          : db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND customer_id = ? AND status = 'booked'").run(id, signedInUser.id)
        if (!result.changes) return send(response, 404, { error: 'Booked appointment not found.' })
        broadcast('queue.changed', { action: 'appointment-cancelled', id })
        return send(response, 200, { message: 'Appointment cancelled.' })
      }
      if (request.method === 'POST' && /^\/api\/locations\/[^/]+\/status$/.test(url.pathname)) {
        if (signedInUser.role !== 'business') return send(response, 403, { error: 'Business access is required.' })
        const id = url.pathname.split('/')[3]
        const body = await readJson(request)
        if (!['open', 'closed'].includes(body.status)) return send(response, 400, { error: 'Status must be open or closed.' })
        const result = db.prepare('UPDATE locations SET status = ? WHERE id = ?').run(body.status, id)
        if (!result.changes) return send(response, 404, { error: 'Location not found.' })
        broadcast('queue.changed', { action: 'location-updated', id, status: body.status })
        return send(response, 200, { message: `Location ${body.status}.` })
      }
      if (request.method === 'POST' && /^\/api\/queue\/\d+\/status$/.test(url.pathname)) {
        if (!['staff', 'business'].includes(signedInUser.role)) return send(response, 403, { error: 'Staff access is required.' })
        const id = Number(url.pathname.split('/')[3])
        const body = await readJson(request)
        if (!['completed', 'skipped'].includes(body.status)) return send(response, 400, { error: 'Status must be completed or skipped.' })
        const entry = db.prepare("SELECT c.name FROM queue_entries q JOIN customers c ON c.id = q.customer_id WHERE q.id = ? AND q.status IN ('waiting', 'serving')").get(id)
        if (!entry) return send(response, 404, { error: 'Active queue entry not found.' })
        db.prepare("UPDATE queue_entries SET status = ?, completed_at = datetime('now') WHERE id = ?").run(body.status, id)
        db.prepare('UPDATE appointments SET status = ? WHERE id = (SELECT appointment_id FROM queue_entries WHERE id = ?)').run(body.status === 'completed' ? 'completed' : 'cancelled', id)
        db.prepare('INSERT INTO queue_events (type, message) VALUES (?, ?)').run(body.status, `${entry.name} was ${body.status}.`)
        broadcast('queue.changed', { action: body.status, id })
        return send(response, 200, { message: `Customer ${body.status}.` })
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/')) return send(response, 404, { error: 'API route not found.' })
      if (request.method === 'GET') {
        const dist = resolve('dist')
        const requested = decodeURIComponent(url.pathname)
        const candidate = resolve(dist, `.${requested}`)
        const filePath = candidate.startsWith(`${dist}/`) && existsSync(candidate) && statSync(candidate).isFile()
          ? candidate
          : resolve(dist, 'index.html')
        if (existsSync(filePath)) {
          const contentTypes = {
            '.css': 'text/css; charset=utf-8',
            '.html': 'text/html; charset=utf-8',
            '.ico': 'image/x-icon',
            '.js': 'text/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
          }
          response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream' })
          createReadStream(filePath).pipe(response)
          return
        }
      }
      return send(response, 404, { error: 'Not found.' })
    } catch (error) {
      console.error('Request failed:', error)
      return send(response, error.status ?? 500, { error: error.status ? error.message : 'The server could not complete the request.' })
    }
  })
  const wss = new WebSocketServer({ noServer: true })
  function broadcast(type, data) {
    const message = JSON.stringify({ type, data })
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message)
    }
  }
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/ws' || !sessionUser(db, request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
  })
  wss.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'connected', data: { message: 'Connected to live queue updates.' } }))
  })
  return {
    server,
    db,
    listen(port = Number(process.env.PORT ?? 3001), host = '0.0.0.0') {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          resolveListen(server.address())
        })
      })
    },
    close() {
      return new Promise((resolveClose, reject) => {
        for (const client of wss.clients) client.close()
        wss.close((wsError) => {
          server.close((serverError) => {
            db.close()
            const error = wsError ?? serverError
            if (error) reject(error)
            else resolveClose()
          })
        })
      })
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const app = createAppServer()
  app.listen().then(({ port }) => console.log(`QLine API and WebSocket server listening on port ${port}`))
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await app.close()
      process.exit(0)
    })
  }
}
