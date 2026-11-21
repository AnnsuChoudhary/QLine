import { Link } from 'react-router-dom'
import { CalendarDays, Building2, ArrowRight } from 'lucide-react'
import AppHeader from '../components/AppHeader.jsx'

export default function LandingPage() {
  return (
    <main className="landing-shell">
      <AppHeader />
      <section className="hero">
        <p className="eyebrow">SMART APPOINTMENTS & LIVE QUEUES</p>
        <h1>Skip the wait.<br />Keep your day moving.</h1>
        <p>Book appointments, join live queues, and manage organizations with one simple platform.</p>
        <div className="hero-actions">
          <Link className="button primary" to="/join"><CalendarDays size={18} /> Join a Queue / Book Appointment <ArrowRight size={16} /></Link>
          <Link className="button secondary" to="/register?role=organization"><Building2 size={18} /> Register / Manage Your Organization</Link>
        </div>
      </section>
      <section className="feature-grid">
        <article><CalendarDays /><h2>Book with confidence</h2><p>Find available times and manage upcoming appointments across organizations.</p></article>
        <article><span className="feature-token">42</span><h2>Follow live tokens</h2><p>See queue progress in real time and arrive when it is your turn.</p></article>
        <article><Building2 /><h2>Run one location or many</h2><p>Manage services, staff workflows, operating hours, and customer flow.</p></article>
      </section>
    </main>
  )
}
