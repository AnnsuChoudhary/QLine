# QLINE

Smart appointment and queue management for customers, staff, and business owners.

## Requirements

Node.js 22.13 or later (the API uses the built-in `node:sqlite` module).

## Development

Copy `.env.example` to `.env` and configure the six required `VITE_FIREBASE_*`
values for the Firebase-backed UI. `VITE_FIREBASE_MEASUREMENT_ID` is optional.
The variables `PORT`, `DATABASE_PATH`, `BUSINESS_EMAILS`, `STAFF_EMAILS`, and
`COOKIE_SECURE` configure the separate local SQLite API and are optional.
`BUSINESS_EMAILS` and `STAFF_EMAILS` accept comma-separated email addresses.

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

The Firebase-backed UI uses Firebase Auth verification emails. Configure the
Firebase Auth email templates and authorized domains, and deploy
`firestore.rules`: queue joins and bookings require a verified email, while
organization admins can require an email domain and admission ID, employee ID,
or department in the customer profile. Customers edit those fields on their
Profile page. The client provides guidance, but Firestore rules enforce email,
profile, account restriction, and booking-counter checks when tokens are
created. Pipeline queue tokens are likewise authorized by Firestore rules so a
customer can only enter the first step or continue after completing the prior
step.

Organization admins can create and publish sequential pipelines from the
Dashboard’s **Workflows / Pipelines** section. A pipeline contains 2–20 existing
queues; customers see each step and can only join the next queue after the
previous token is completed. **Complete & Advance** unlocks the next step and
provides a customer continuation link, while **Conclude / Stop Pipeline**
closes a run early. Firestore rules validate the run and previous token on
every pipeline token write. This workflow uses the Firebase organization model;
the separate SQLite demo API does not have organization pipelines.

Per account and organization, booking rules allow at most 3 active tokens per
queue, 5 active tokens total, 5 tokens per queue per scheduled date, and 10
tokens total per scheduled date. The default repeat limits pause new bookings
after 3 admin-recorded no-shows or 5 customer cancellations; admins can set
either limit to 0 to disable it. Admins can cancel tokens, mark no-shows,
restrict or restore accounts, and reset repeat counts. These statuses and
counters are stored in Firestore; cancellation is a soft removal so the token
history remains available. Older tokens without limit tracking are not
retroactively included in these counts.

These are account-level controls, not proof of a person’s identity: there is
no CAPTCHA or separate fraud-scoring service. The local SQLite API maintains
separate local accounts and does not use Firebase Auth or these Firestore
booking rules. Configure HTTPS and `COOKIE_SECURE=true` when deploying that
API behind a TLS-terminating proxy.
