# QLINE

Smart appointment and queue management for customers, staff, and business owners.

## Requirements

Node.js 22.13 or later (the API uses the built-in `node:sqlite` module).

## Development

```bash
npm install
npm run dev
```

The Vite UI is available at http://localhost:5173 and the API/WebSocket server
runs on port 3001. Use the interface switcher to try the customer, staff, and
business views. Data is stored in `data/qline.sqlite` and survives restarts.
Set `PORT` or `DATABASE_PATH` to use a different API port or SQLite file.
Customers can create an account with an email and password. Passwords are
stored as salted scrypt hashes and login sessions use HTTP-only cookies.

To provision staff or business accounts, set the comma-separated
`STAFF_EMAILS` or `BUSINESS_EMAILS` environment variable before those users
register. For example:

```bash
BUSINESS_EMAILS=owner@example.com npm run dev
```

Appointment availability is generated in 15-minute increments during the
configured location hours (currently 09:00–17:00); a slot is rechecked and
reserved atomically when booked. Booking another service or date shows only
currently available times.

## Production

```bash
npm run build
npm start
```

The API server serves the built application and its `/api` and `/ws` endpoints.
Run `npm test` for API, persistence, duplicate-booking, queue-flow, and WebSocket
integration tests.

Self-service customer registration and staff/business access control are
implemented. Email verification and password reset require an email delivery
provider and are not configured. Configure HTTPS and `COOKIE_SECURE=true` when
deploying behind a TLS-terminating proxy, and review the seeded location hours
before accepting bookings.
