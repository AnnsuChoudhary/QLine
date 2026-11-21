import { useEffect, useState } from 'react'
import { collectionGroup, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'

export default function AppointmentsPage() {
  const { firebaseUser } = useAuth()
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!firebaseUser) return
    getDocs(query(collectionGroup(db, 'appointments'), where('userId', '==', firebaseUser.uid)))
      .then((snapshot) => setAppointments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))))
      .finally(() => setLoading(false))
  }, [firebaseUser])

  return (
    <main>
      <AppHeader />
      <section className="page-shell">
        <div className="page-heading"><div><p className="eyebrow">YOUR BOOKINGS</p><h1>Appointments & active tokens</h1></div></div>
        {loading ? <p className="muted">Loading appointments…</p> : appointments.length ? (
          <div className="appointment-list">{appointments.map((appointment) => <article className="panel appointment-row" key={appointment.id}><div><strong>{appointment.serviceName}</strong><small>{appointment.date} at {appointment.timeSlot}</small></div><span className="status-pill">{appointment.status}</span></article>)}</div>
        ) : <section className="panel empty-panel"><h2>No appointments yet</h2><p className="muted">Join an organization to book a service or view your live queue token.</p></section>}
      </section>
    </main>
  )
}
