import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { api as requestApi } from '../src/api.js'
import { createAppServer } from '../server/index.js'

const running = []

async function startServer(dbPath = ':memory:', options = {}) {
  const app = createAppServer({ dbPath, ...options })
  const address = await app.listen(0, '127.0.0.1')
  const baseUrl = `http://127.0.0.1:${address.port}`
  running.push(app)
  return { app, baseUrl }
}

async function request(baseUrl, cookie, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  return { response, body: await response.json() }
}

function post(baseUrl, cookie, path, body) {
  return request(baseUrl, cookie, path, { method: 'POST', body: JSON.stringify(body) })
}

async function register(baseUrl, name, email) {
  const { response, body } = await post(baseUrl, '', '/api/auth/register', {
    name,
    email,
    password: 'qline-test-password',
  })
  assert.ok([200, 201].includes(response.status), JSON.stringify(body))
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie, 'registration creates an authenticated session')
  return { user: body.user, cookie }
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()))
})

test('API client explains empty and non-JSON backend responses', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('', { status: 502 })
    await assert.rejects(requestApi('/api/dashboard'), /empty response \(502\)/)
    globalThis.fetch = async () => new Response('<html>proxy error</html>', { status: 502 })
    await assert.rejects(requestApi('/api/dashboard'), /invalid response \(502\)/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('customers can register, sign in, and sign out with separate persisted accounts', async () => {
  const { baseUrl } = await startServer()
  const anonymous = await request(baseUrl, '', '/api/dashboard')
  assert.equal(anonymous.response.status, 401)
  const created = await register(baseUrl, 'Jamie Customer', 'jamie@example.test')
  assert.equal(created.user.role, 'customer')
  assert.equal('passwordHash' in created.user, false)
  const duplicate = await post(baseUrl, '', '/api/auth/register', {
    name: 'Other Name', email: 'jamie@example.test', password: 'qline-test-password',
  })
  assert.equal(duplicate.response.status, 409)

  const wrongPassword = await post(baseUrl, '', '/api/auth/login', {
    email: 'jamie@example.test', password: 'incorrect-password',
  })
  assert.equal(wrongPassword.response.status, 401)

  const signedIn = await post(baseUrl, '', '/api/auth/login', {
    email: 'JAMIE@example.test', password: 'qline-test-password',
  })
  assert.equal(signedIn.response.status, 200)
  const secondCookie = signedIn.response.headers.get('set-cookie').split(';', 1)[0]
  const session = await request(baseUrl, secondCookie, '/api/session')
  assert.equal(session.body.user.id, created.user.id)

  const signedOut = await post(baseUrl, secondCookie, '/api/auth/logout', {})
  assert.equal(signedOut.response.status, 200)
  const unauthorized = await request(baseUrl, secondCookie, '/api/dashboard')
  assert.equal(unauthorized.response.status, 401)
})

test('queue joins, staff calls, customer positions, and cancellation sync over authenticated WebSockets', async () => {
  const { baseUrl } = await startServer(':memory:', { businessEmails: ['owner@qline.test'] })
  const firstUser = await register(baseUrl, 'Jamie One', 'one@example.test')
  const secondUser = await register(baseUrl, 'Jamie Two', 'two@example.test')
  const businessUser = await register(baseUrl, 'Clinic Owner', 'owner@qline.test')

  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', { headers: { Cookie: firstUser.cookie } })
  const staffSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', { headers: { Cookie: businessUser.cookie } })
  await Promise.all([socket, staffSocket].map((client) => new Promise((resolve, reject) => {
    client.once('open', resolve)
    client.once('error', reject)
  })))
  const events = []
  const staffEvents = []
  socket.on('message', (message) => events.push(JSON.parse(message.toString())))
  staffSocket.on('message', (message) => staffEvents.push(JSON.parse(message.toString())))

  const first = await post(baseUrl, firstUser.cookie, '/api/queue', { serviceId: 'consultation' })
  assert.equal(first.response.status, 201)
  assert.equal(first.body.tokenLabel, 'A–001')
  const second = await post(baseUrl, secondUser.cookie, '/api/queue', { serviceId: 'new-patient' })
  assert.equal(second.body.tokenLabel, 'A–002')
  assert.equal(second.body.peopleAhead, 1)
  assert.equal(second.body.waitMinutes, 20)

  const duplicate = await post(baseUrl, firstUser.cookie, '/api/queue', { serviceId: 'consultation' })
  assert.equal(duplicate.response.status, 409)
  const forbidden = await post(baseUrl, firstUser.cookie, '/api/queue/next', {})
  assert.equal(forbidden.response.status, 403)

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(events.some((event) => event.type === 'queue.changed' && event.data.action === 'joined'))
  assert.ok(staffEvents.some((event) => event.type === 'queue.changed' && event.data.action === 'joined'))
  const dashboardBeforeCall = await request(baseUrl, secondUser.cookie, '/api/dashboard')
  assert.equal(dashboardBeforeCall.body.customerQueue.peopleAhead, 1)
  assert.equal(dashboardBeforeCall.body.queue.length, 1)
  assert.equal(dashboardBeforeCall.body.next, null)
  const staffDashboard = await request(baseUrl, businessUser.cookie, '/api/dashboard')
  assert.equal(staffDashboard.body.queue.length, 2)
  assert.equal(staffDashboard.body.next.tokenLabel, 'A–001')

  const called = await post(baseUrl, businessUser.cookie, '/api/queue/next', {})
  assert.equal(called.body.current.tokenLabel, 'A–001')
  const dashboardAfterCall = await request(baseUrl, secondUser.cookie, '/api/dashboard')
  assert.equal(dashboardAfterCall.body.customerQueue.peopleAhead, 1)
  assert.ok(events.some((event) => event.type === 'queue.changed' && event.data.action === 'called'))
  assert.ok(staffEvents.some((event) => event.type === 'queue.changed' && event.data.action === 'called'))

  await post(baseUrl, businessUser.cookie, '/api/queue/next', {})
  const completed = await request(baseUrl, businessUser.cookie, '/api/dashboard')
  assert.equal(completed.body.completedCount, 1)
  assert.equal(completed.body.current.tokenLabel, 'A–002')

  const leave = await request(baseUrl, secondUser.cookie, `/api/queue/${second.body.id}`, { method: 'DELETE' })
  assert.equal(leave.response.status, 200)
  const afterLeave = await request(baseUrl, secondUser.cookie, '/api/dashboard')
  assert.equal(afterLeave.body.customerQueue, null)
  assert.equal(afterLeave.body.waitingCount, 0)
  assert.ok(events.some((event) => event.type === 'queue.changed' && event.data.action === 'cancelled'))
  socket.close()
  staffSocket.close()
})

test('appointment slots prevent overlaps and bookings persist across server restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qline-test-'))
  const dbPath = join(directory, 'qline.sqlite')
  const { app, baseUrl } = await startServer(dbPath)
  const customer = await register(baseUrl, 'Jamie Booking', 'booking@example.test')
  const otherCustomer = await register(baseUrl, 'Taylor Booking', 'other-booking@example.test')
  const date = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const query = `/api/slots?date=${date}&serviceId=follow-up`
  const initialSlots = await request(baseUrl, customer.cookie, query)
  assert.ok(initialSlots.body.length > 1)
  const startsAt = initialSlots.body[0].startsAt
  const created = await post(baseUrl, customer.cookie, '/api/appointments', {
    serviceId: 'follow-up',
    startsAt,
  })
  assert.equal(created.response.status, 201)
  const staleSlot = await post(baseUrl, customer.cookie, '/api/appointments', {
    serviceId: 'follow-up',
    startsAt,
  })
  assert.equal(staleSlot.response.status, 409)
  const conflictingService = await post(baseUrl, otherCustomer.cookie, '/api/appointments', {
    serviceId: 'new-patient',
    startsAt,
  })
  assert.equal(conflictingService.response.status, 409)
  const otherServiceSlots = await request(baseUrl, otherCustomer.cookie, `/api/slots?date=${date}&serviceId=new-patient`)
  assert.ok(!otherServiceSlots.body.some((slot) => slot.startsAt === startsAt))
  const remainingSlots = await request(baseUrl, customer.cookie, query)
  assert.ok(!remainingSlots.body.some((slot) => slot.startsAt === startsAt))

  const dashboard = await request(baseUrl, customer.cookie, '/api/dashboard')
  assert.equal(dashboard.body.customerAppointments.length, 1)
  await app.close()
  running.splice(running.indexOf(app), 1)
  const restarted = await startServer(dbPath)
  const persisted = await request(restarted.baseUrl, customer.cookie, '/api/dashboard')
  assert.equal(persisted.body.customerAppointments.length, 1)
  const cancelled = await request(restarted.baseUrl, customer.cookie, `/api/appointments/${created.body.id}`, { method: 'DELETE' })
  assert.equal(cancelled.response.status, 200)
  await rm(directory, { recursive: true, force: true })
})

test('invalid queue requests and closed queues return explicit errors', async () => {
  const { baseUrl } = await startServer(':memory:', { businessEmails: ['owner@clinic.test'] })
  const customer = await register(baseUrl, 'Profile Customer', 'profile@example.test')
  const business = await register(baseUrl, 'Clinic Owner', 'owner@clinic.test')
  const profile = await request(baseUrl, customer.cookie, `/api/customers/${customer.user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Updated Customer' }),
  })
  assert.equal(profile.response.status, 200)
  const customers = await request(baseUrl, business.cookie, '/api/dashboard')
  assert.ok(customers.body.customers.some((item) => item.id === customer.user.id && item.name === 'Updated Customer'))

  const invalid = await post(baseUrl, customer.cookie, '/api/queue', { serviceId: 'not-a-service' })
  assert.equal(invalid.response.status, 400)
  const closed = await post(baseUrl, business.cookie, '/api/locations/northside/status', { status: 'closed' })
  assert.equal(closed.response.status, 200)
  const joinWhileClosed = await post(baseUrl, customer.cookie, '/api/queue', { serviceId: 'consultation' })
  assert.equal(joinWhileClosed.response.status, 409)
})

test('database upgrades an existing pre-authentication Qline database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qline-legacy-'))
  const dbPath = join(directory, 'legacy.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE services (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, duration_minutes INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, service_id TEXT NOT NULL,
      starts_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'booked',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(customer_id, service_id, starts_at)
    );
    CREATE TABLE queue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token INTEGER NOT NULL, queue_date TEXT NOT NULL,
      customer_id TEXT NOT NULL, service_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), called_at TEXT, completed_at TEXT,
      UNIQUE(queue_date, token)
    );
    CREATE TABLE queue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO services (id, name, duration_minutes) VALUES ('consultation', 'General consultation', 20);
    INSERT INTO locations (id, name, address) VALUES ('northside', 'Northside Clinic', 'Main location');
    INSERT INTO customers (id, name) VALUES ('legacy-customer', 'Legacy Customer');
    INSERT INTO queue_entries (token, queue_date, customer_id, service_id) VALUES (1, date('now'), 'legacy-customer', 'consultation');
  `)
  legacy.close()
  const { app } = await startServer(dbPath)
  const migrated = app.db.prepare(`
    SELECT q.appointment_id AS appointmentId, a.kind, a.status
    FROM queue_entries q JOIN appointments a ON a.id = q.appointment_id
  `).get()
  assert.equal(migrated.kind, 'queue')
  assert.equal(migrated.status, 'booked')
  const location = app.db.prepare('SELECT opens_at AS opensAt, closes_at AS closesAt FROM locations WHERE id = ?').get('northside')
  assert.equal(location.opensAt, '09:00')
  assert.equal(location.closesAt, '17:00')
  await app.close()
  running.splice(running.indexOf(app), 1)
  await rm(directory, { recursive: true, force: true })
})
