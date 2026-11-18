import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowRight,
  Bell,
  Building2,
  CalendarDays,
  ChevronDown,
  Clock3,
  LayoutDashboard,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  UserRound,
  X,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, formatAppointmentDate, formatDateLabel, formatDateTime, formatQueueTime } from './api.js'
import './App.css'

function useLiveDashboard(customerId, range) {
  const [dashboardState, setDashboardState] = useState({ customerId: null, dashboard: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const dashboard = dashboardState.customerId === customerId ? dashboardState.dashboard : null
  const refresh = useCallback(async () => {
    if (!customerId) throw new Error('Sign in to load your dashboard.')
    try {
      const query = new URLSearchParams({ range })
      const next = await api(`/api/dashboard?${query}`)
      setDashboardState({ customerId, dashboard: next })
      setError('')
    } catch (requestError) {
      setError(requestError.message)
      throw requestError
    } finally {
      setLoading(false)
    }
  }, [customerId, range])

  useEffect(() => {
    if (!customerId) return undefined
    const initialLoad = window.setTimeout(() => {
      setLoading(true)
      refresh().catch(() => {})
    }, 0)
    let reconnect
    let socket
    let stopped = false
    const connect = () => {
      if (stopped) return
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.type === 'queue.changed') refresh().catch(() => {})
      }
      socket.onclose = () => {
        if (!stopped) reconnect = window.setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      stopped = true
      window.clearTimeout(initialLoad)
      window.clearTimeout(reconnect)
      socket?.close()
    }
  }, [customerId, refresh])

  return { dashboard, loading, error, refresh }
}

function ThemeToggle({ theme, setTheme }) {
  return (
    <button
      className="icon-button theme-toggle"
      type="button"
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    >
      {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  )
}

function Logo() {
  return (
    <div className="brand">
      <div className="brand-mark"><span>Q</span></div>
      <span>Qline</span>
    </div>
  )
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
}

function Header({ theme, setTheme, role, setRole, onMenu, setPage, events, user, availableRoles, onLogout }) {
  const [openMenu, setOpenMenu] = useState('')
  return (
    <header className="topbar">
      <button className="mobile-menu icon-button" type="button" onClick={onMenu} aria-label="Open navigation">
        <Menu size={20} />
      </button>
      <Logo />
      <nav className="role-switch" aria-label="Interface preview">
        {availableRoles.map((item) => (
          <button key={item} type="button" className={role === item ? 'active' : ''} onClick={() => { setRole(item); setPage(item === 'staff' ? 'queue' : 'overview') }}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <div className="header-menu-wrap">
          <button className="icon-button notification" type="button" aria-label="Notifications" aria-expanded={openMenu === 'notifications'} onClick={() => setOpenMenu(openMenu === 'notifications' ? '' : 'notifications')}><Bell size={18} /><span /></button>
          {openMenu === 'notifications' && <div className="header-popover"><strong>Recent activity</strong>{events.length ? events.slice(0, 5).map((event) => <p key={event.id}>{event.message}</p>) : <p>No queue activity yet.</p>}</div>}
        </div>
        <ThemeToggle theme={theme} setTheme={setTheme} />
        <div className="header-menu-wrap">
          <button className="profile-button" type="button" aria-expanded={openMenu === 'profile'} onClick={() => setOpenMenu(openMenu === 'profile' ? '' : 'profile')}>
            <div className="avatar">{initials(user.name)}</div>
            <div className="profile-copy"><strong>{user.name}</strong><span>{user.email}</span></div>
            <ChevronDown size={15} />
          </button>
          {openMenu === 'profile' && <div className="header-popover profile-popover"><strong>Switch workspace</strong>{availableRoles.map((item) => <button key={item} type="button" onClick={() => { setRole(item); setPage(item === 'staff' ? 'queue' : 'overview'); setOpenMenu('') }}>{item[0].toUpperCase() + item.slice(1)} view</button>)}{user.role === 'business' && <button type="button" onClick={() => { setRole('business'); setPage('settings'); setOpenMenu('') }}>Profile and settings</button>}<button type="button" onClick={onLogout}>Sign out</button></div>}
        </div>
      </div>
    </header>
  )
}

function Sidebar({ role, page, setPage, open, setOpen, setRole, availableRoles }) {
  const items = role === 'staff'
    ? [['queue', 'Queue', Users], ['customers', 'Customers', UserRound], ['activity', 'Activity', Activity]]
    : [['overview', 'Overview', LayoutDashboard], ['appointments', 'Appointments', CalendarDays], ['queue', 'Live queue', Users], ['locations', 'Locations', Building2], ['settings', 'Settings', Settings]]
  return (
    <>
      {open && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <nav>
          {items.map(([id, label, Icon]) => (
            <button type="button" key={id} className={page === id ? 'active' : ''} onClick={() => { setPage(id); setOpen(false) }}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        {role !== 'customer' && availableRoles.includes(role === 'staff' ? 'customer' : 'staff') && <button className="sidebar-switch" type="button" onClick={() => { const nextRole = role === 'staff' ? 'customer' : 'staff'; setRole(nextRole); setPage(nextRole === 'staff' ? 'queue' : 'overview'); setOpen(false) }}>
          Switch to {role === 'staff' ? 'customer' : 'staff'} <ArrowRight size={16} />
        </button>}
      </aside>
    </>
  )
}

function StatusBadge({ status }) {
  const labels = { waiting: 'Waiting', serving: 'Serving', skipped: 'Skipped', completed: 'Completed', booked: 'Booked', cancelled: 'Cancelled' }
  return <span className={`status-badge ${status}`}><i />{labels[status] || status}</span>
}

function AuthView({ theme, setTheme, onAuthenticated, initialError = '' }) {
  const [mode, setMode] = useState('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { user } = await api(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
      })
      onAuthenticated(user)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="customer-shell auth-shell">
      <nav className="customer-nav"><Logo /><ThemeToggle theme={theme} setTheme={setTheme} /></nav>
      <div className="customer-content auth-content">
        <section className="service-panel auth-panel">
          <p className="eyebrow">{mode === 'register' ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</p>
          <h1>{mode === 'register' ? 'Join Qline' : 'Sign in to Qline'}</h1>
          <p className="auth-intro">Book appointments and follow your place in the queue.</p>
          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' && <label>Your name<input autoComplete="name" value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></label>}
            <label>Email address<input type="email" autoComplete="email" value={email} required onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={8} maxLength={128} value={password} required onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="button primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
          </form>
          {error && <p className="form-error" role="alert">{error}</p>}
          <p className="auth-switch">{mode === 'register' ? 'Already have an account?' : 'New to Qline?'} <button className="text-button" type="button" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError('') }}>{mode === 'register' ? 'Sign in' : 'Create an account'}</button></p>
        </section>
      </div>
    </main>
  )
}

function CustomerView({ theme, setTheme, dashboard, refresh, runAction, user, availableRoles, setRole, setPage, onLogout }) {
  const [selectedService, setSelectedService] = useState('')
  const [date, setDate] = useState(dashboard.today)
  const [slots, setSlots] = useState([])
  const [selectedSlot, setSelectedSlot] = useState('')
  const [slotError, setSlotError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const service = dashboard.services.find((item) => item.id === selectedService) ?? dashboard.services[0]
  const serviceId = service?.id
  const joined = dashboard.customerQueue

  useEffect(() => {
    if (!serviceId) return undefined
    let active = true
    const query = new URLSearchParams({ date, serviceId })
    api(`/api/slots?${query}`)
      .then((available) => {
        if (!active) return
        setSlots(available)
        setSelectedSlot((previous) => available.some((slot) => slot.startsAt === previous) ? previous : available[0]?.startsAt ?? '')
        setSlotError('')
      })
      .catch((error) => { if (active) setSlotError(error.message) })
    return () => { active = false }
  }, [date, serviceId])

  const bookAppointment = (event) => {
    event.preventDefault()
    if (!service || !selectedSlot) return
    runAction(async () => {
      try {
        await api('/api/appointments', {
          method: 'POST',
          body: JSON.stringify({ serviceId: service.id, startsAt: selectedSlot }),
        })
      } catch (error) {
        if (error.status === 409) {
          const query = new URLSearchParams({ date, serviceId: service.id })
          const available = await api(`/api/slots?${query}`)
          setSlots(available)
          setSelectedSlot(available[0]?.startsAt ?? '')
        }
        throw error
      }
      await refresh()
      const query = new URLSearchParams({ date, serviceId: service.id })
      const available = await api(`/api/slots?${query}`)
      setSlots(available)
      setSelectedSlot(available[0]?.startsAt ?? '')
    })
  }
  const joinQueue = () => service && runAction(async () => {
    await api('/api/queue', { method: 'POST', body: JSON.stringify({ serviceId: service.id }) })
    await refresh()
  })
  const leaveQueue = () => joined && runAction(async () => {
    await api(`/api/queue/${joined.id}`, { method: 'DELETE' })
    await refresh()
  })
  const showAppointments = () => document.getElementById('customer-appointments')?.scrollIntoView({ behavior: 'smooth' })

  return (
    <main className="customer-shell">
      <nav className="customer-nav">
        <Logo />
        <div>
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <div className="header-menu-wrap">
            <button className="customer-profile" type="button" aria-label="Open profile menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><div className="avatar">{initials(user.name)}</div><ChevronDown size={14} /></button>
            {menuOpen && <div className="header-popover profile-popover"><strong>{user.name}</strong>{availableRoles.filter((role) => role !== 'customer').map((role) => <button key={role} type="button" onClick={() => { setRole(role); setPage(role === 'staff' ? 'queue' : 'overview') }}>Switch to {role} view</button>)}<button type="button" onClick={onLogout}>Sign out</button></div>}
          </div>
        </div>
      </nav>
      <div className="customer-content">
        <section className="welcome-row">
          <div><p className="eyebrow">{formatDateLabel(dashboard.today)}</p><h1>Good morning, {user.name.split(' ')[0]}</h1></div>
          <button className="button secondary" type="button" onClick={showAppointments}><CalendarDays size={17} /> My appointments</button>
        </section>

        <div className="customer-grid">
          <section className="service-panel">
            <div className="section-heading"><div><p className="eyebrow">AVAILABLE SERVICES</p><h2>Book or join a queue</h2></div></div>
            <div className="service-list">
              {dashboard.services.map((item) => (
                <button
                  type="button"
                  className={`service-card ${(selectedService || dashboard.services[0]?.id) === item.id ? 'selected' : ''}`}
                  key={item.id}
                  onClick={() => { setSelectedService(item.id); setSelectedSlot('') }}
                >
                  <div className="service-icon"><UserRound size={20} /></div>
                  <div className="service-copy"><strong>{item.name}</strong><span><Clock3 size={14} /> {item.duration} min</span></div>
                  <div className="service-availability"><span>{dashboard.queueOpen ? 'Available now' : 'Currently closed'}</span><ArrowRight size={17} /></div>
                </button>
              ))}
            </div>
            <form className="booking-fields" onSubmit={bookAppointment}>
              <label>Appointment date<input type="date" min={dashboard.today} value={date} onChange={(event) => { setDate(event.target.value); setSelectedSlot('') }} /></label>
              <label>Available time<select value={selectedSlot} disabled={!slots.length} onChange={(event) => setSelectedSlot(event.target.value)} required><option value="">{slots.length ? 'Select a time' : 'No times available'}</option>{slots.map((slot) => <option key={slot.startsAt} value={slot.startsAt}>{slot.label}</option>)}</select></label>
              <div className="booking-actions"><button className="button primary" type="submit" disabled={!service || !selectedSlot}><CalendarDays size={17} /> Book appointment</button></div>
            </form>
            {slotError && <p className="form-error" role="alert">{slotError}</p>}
            {!slotError && !slots.length && <p className="empty-state">No available times for this service and date. Choose another date.</p>}
          </section>

          <aside className="live-card">
            <div className="live-card-top"><div><span className="live-dot" /> Live queue</div><span>{dashboard.queueOpen ? 'Open' : 'Closed'}</span></div>
            <div className="token-block">
              <p>Your digital token</p>
              <strong>{joined?.tokenLabel ?? '—'}</strong>
              <span>{joined ? 'Northside Clinic · Room 2' : 'Join to receive a token'}</span>
            </div>
            {joined ? (
              <>
                <div className="queue-progress"><span style={{ width: `${joined.peopleAhead === 0 ? 100 : Math.max(8, 100 / (joined.peopleAhead + 1))}%` }} /></div>
                <div className="queue-metrics"><div><strong>{joined.peopleAhead}</strong><span>People ahead</span></div><div><strong>{joined.waitMinutes} min</strong><span>Est. wait</span></div></div>
                <button className="button secondary leave-button" type="button" onClick={leaveQueue}>Leave queue</button>
              </>
            ) : (
              <button className="button primary leave-button" type="button" disabled={!dashboard.queueOpen || !service} onClick={joinQueue}>Join live queue</button>
            )}
          </aside>
        </div>

        <section className="upcoming" id="customer-appointments">
          <div className="section-heading"><div><p className="eyebrow">UPCOMING</p><h2>My appointments</h2></div><button className="text-button" type="button" onClick={showAppointments}>View all <ArrowRight size={15} /></button></div>
          {dashboard.customerAppointments.length ? dashboard.customerAppointments.map((appointment) => {
            const dateParts = formatAppointmentDate(appointment.startsAt)
            return <div className="appointment-row" key={appointment.id}>
              <div className="date-box"><strong>{dateParts.day}</strong><span>{dateParts.month}</span></div>
              <div className="appointment-copy"><strong>{appointment.service}</strong><span>{formatDateTime(appointment.startsAt)}</span></div>
              <StatusBadge status={appointment.status} />
              <button className="icon-button" type="button" aria-label={`Cancel ${appointment.service}`} onClick={() => runAction(async () => { await api(`/api/appointments/${appointment.id}`, { method: 'DELETE' }); await refresh() })}><X size={17} /></button>
            </div>
          }) : <p className="empty-state">You don’t have any upcoming appointments.</p>}
        </section>
      </div>
    </main>
  )
}

function StaffView({ dashboard, refresh, runAction }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedEntry, setSelectedEntry] = useState(null)
  const callNext = () => runAction(async () => { await api('/api/queue/next', { method: 'POST' }); await refresh() })
  const visible = dashboard.queue.filter((person) =>
    person.name.toLowerCase().includes(search.toLowerCase()) &&
    (statusFilter === 'all' || person.status === statusFilter))

  return (
    <main className="staff-main">
      <div className="page-heading">
        <div><p className="eyebrow">NORTHSIDE CLINIC</p><h1>Today’s queue</h1></div>
        <button className="button primary" type="button" onClick={callNext} disabled={!dashboard.waitingCount}>Call next <ArrowRight size={17} /></button>
      </div>
      <div className="staff-stats">
        <div><span>Waiting</span><strong>{dashboard.waitingCount}</strong></div>
        <div><span>Now serving</span><strong>{dashboard.current ? 1 : 0}</strong></div>
        <div><span>Average wait</span><strong>{dashboard.averageWaitMinutes} min</strong></div>
        <div><span>Completed</span><strong>{dashboard.completedCount}</strong></div>
      </div>
      <section className="queue-panel">
        <div className="queue-toolbar">
          <div className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customers" aria-label="Search customers" /></div>
          <select className="button secondary status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter queue by status">
            <option value="all">All statuses</option><option value="waiting">Waiting</option><option value="serving">Serving</option>
          </select>
        </div>
        <div className="queue-table">
          <div className="table-row table-head"><span>Customer</span><span>Service</span><span>Arrival</span><span>Status</span><span /></div>
          {visible.map((person) => (
            <div className="table-row" key={person.id}>
              <div className="customer-cell"><div className="avatar small">{person.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</div><strong>{person.name} <small>{person.tokenLabel}</small></strong></div>
              <span>{person.service}</span><span>{formatQueueTime(person.createdAt)}</span>
              <StatusBadge status={person.status} />
              <button className="icon-button" type="button" aria-label={`Open ${person.name}`} onClick={() => setSelectedEntry(person)}><ArrowRight size={16} /></button>
            </div>
          ))}
          {!visible.length && <p className="empty-state">No customers match this queue filter.</p>}
        </div>
      </section>
      {selectedEntry && <section className="queue-detail"><button className="icon-button" aria-label="Close customer details" onClick={() => setSelectedEntry(null)}><X size={16} /></button><strong>{selectedEntry.name} · {selectedEntry.tokenLabel}</strong><span>{selectedEntry.service} · {selectedEntry.peopleAhead} people ahead · {selectedEntry.waitMinutes} min estimated</span><div><button className="button secondary" type="button" onClick={() => runAction(async () => { await api(`/api/queue/${selectedEntry.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'skipped' }) }); setSelectedEntry(null); await refresh() })}>Skip customer</button><button className="button primary" type="button" onClick={() => runAction(async () => { await api(`/api/queue/${selectedEntry.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) }); setSelectedEntry(null); await refresh() })}>Mark complete</button></div></section>}
    </main>
  )
}

function BusinessView({ dashboard, refresh, runAction, setRole, setPage, page, range, setRange, user, onProfileSaved }) {
  const chartTheme = useMemo(() => ({ grid: 'var(--border)', text: 'var(--text-secondary)' }), [])
  if (page === 'queue') return <StaffView dashboard={dashboard} refresh={refresh} runAction={runAction} />
  if (page === 'appointments') return <AppointmentsView dashboard={dashboard} refresh={refresh} runAction={runAction} />
  if (page === 'locations') return <LocationsView dashboard={dashboard} refresh={refresh} runAction={runAction} />
  if (page === 'settings') return <SettingsView dashboard={dashboard} refresh={refresh} runAction={runAction} user={user} onProfileSaved={onProfileSaved} />
  if (page === 'customers') return <CustomersView dashboard={dashboard} />
  if (page === 'activity') return <ActivityView dashboard={dashboard} />
  return (
    <main className="dashboard-main">
      <div className="page-heading">
      <div><p className="eyebrow">{formatDateLabel(dashboard.today)}</p><h1>Good morning, {user.name.split(' ')[0]}</h1></div>
        <button className="button primary" type="button" onClick={() => setRole('customer')}><CalendarDays size={17} /> New appointment</button>
      </div>
      <div className="metric-grid">
        <article className="metric-card"><div><span>Today’s appointments</span><strong>{dashboard.appointmentsToday}</strong></div><div className="metric-trend neutral">Scheduled today</div></article>
        <article className="metric-card"><div><span>Customers in queue</span><strong>{dashboard.waitingCount}</strong></div><div className="metric-trend neutral">Waiting now</div></article>
        <article className="metric-card"><div><span>Average wait</span><strong>{dashboard.averageWaitMinutes} min</strong></div><div className="metric-trend neutral">From queue records</div></article>
        <article className="metric-card"><div><span>Completed</span><strong>{dashboard.completedCount}</strong></div><div className="metric-trend neutral">Today</div></article>
      </div>
      <div className="dashboard-grid">
        <section className="chart-card">
          <div className="section-heading"><div><p className="eyebrow">TRAFFIC</p><h2>Customer flow</h2></div><select className="button secondary status-filter" aria-label="Customer flow period" value={range} onChange={(event) => setRange(event.target.value)}><option value="today">Today</option><option value="week">This week</option></select></div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dashboard.flow} margin={{ top: 10, right: 4, bottom: 0, left: -24 }}>
                <defs><linearGradient id="queueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--primary)" stopOpacity={0.16}/><stop offset="95%" stopColor="var(--primary)" stopOpacity={0}/></linearGradient></defs>
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: chartTheme.text, fontSize: 12 }} dy={8} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: chartTheme.text, fontSize: 12 }} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} />
                <Area type="monotone" dataKey="customers" name="Customers" stroke="var(--primary)" strokeWidth={2} fill="url(#queueFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="queue-summary">
          <div className="section-heading"><div><p className="eyebrow">LIVE</p><h2>Queue status</h2></div><button className="text-button" type="button" onClick={() => setPage('queue')}>View all <ArrowRight size={15} /></button></div>
          <div className="now-serving"><span>Now serving</span><strong>{dashboard.current?.tokenLabel ?? '—'}</strong><p>{dashboard.current?.name ?? 'No customer being served'}</p></div>
          <div className="queue-summary-list">
            <div><span>Waiting</span><strong>{dashboard.waitingCount}</strong></div><div><span>Average wait</span><strong>{dashboard.averageWaitMinutes} min</strong></div><div><span>Next token</span><strong>{dashboard.next?.tokenLabel ?? '—'}</strong></div>
          </div>
        </section>
      </div>
    </main>
  )
}

function AppointmentsView({ dashboard, refresh, runAction }) {
  return <main className="dashboard-main"><div className="page-heading"><div><p className="eyebrow">SCHEDULE</p><h1>Appointments</h1></div><span>{dashboard.appointments.length} booked</span></div><section className="queue-panel"><div className="queue-table"><div className="table-row table-head"><span>Customer</span><span>Service</span><span>Date and time</span><span>Status</span><span /></div>{dashboard.appointments.map((appointment) => <div className="table-row" key={appointment.id}><div className="customer-cell"><strong>{appointment.customer}</strong></div><span>{appointment.service}</span><span>{formatDateTime(appointment.startsAt)}</span><StatusBadge status={appointment.status} /><button className="icon-button" type="button" aria-label={`Cancel appointment for ${appointment.customer}`} onClick={() => runAction(async () => { await api(`/api/appointments/${appointment.id}`, { method: 'DELETE' }); await refresh() })}><X size={16} /></button></div>)}{!dashboard.appointments.length && <p className="empty-state">No appointments have been booked.</p>}</div></section></main>
}

function LocationsView({ dashboard }) {
  return <main className="dashboard-main"><div className="page-heading"><div><p className="eyebrow">BUSINESS</p><h1>Locations</h1></div></div><div className="location-grid">{dashboard.locations.map((location) => <article className="metric-card" key={location.id}><div><span>{location.name}</span><strong>{location.address}</strong></div><StatusBadge status={location.status === 'open' ? 'serving' : 'cancelled'} /></article>)}</div></main>
}

function SettingsView({ dashboard, refresh, runAction, user, onProfileSaved }) {
  const [draft, setDraft] = useState(user.name)
  return <main className="dashboard-main"><div className="page-heading"><div><p className="eyebrow">PREFERENCES</p><h1>Settings</h1></div></div><section className="service-panel settings-panel"><form onSubmit={(event) => { event.preventDefault(); runAction(async () => { const updated = await api(`/api/customers/${encodeURIComponent(user.id)}`, { method: 'PUT', body: JSON.stringify({ name: draft }) }); onProfileSaved(updated.name); await refresh() }) }}><label>Profile name<input value={draft} maxLength={100} required onChange={(event) => setDraft(event.target.value)} /></label><button className="button primary" type="submit">Save profile</button></form>{dashboard.locations.map((location) => <div className="setting-row" key={location.id}><div><strong>Queue at {location.name}</strong><span>Customers can join only while the location is open.</span></div><button className="button secondary" type="button" onClick={() => runAction(async () => { await api(`/api/locations/${location.id}/status`, { method: 'POST', body: JSON.stringify({ status: location.status === 'open' ? 'closed' : 'open' }) }); await refresh() })}>{location.status === 'open' ? 'Close queue' : 'Open queue'}</button></div>)}</section></main>
}

function CustomersView({ dashboard }) {
  return <main className="dashboard-main"><div className="page-heading"><div><p className="eyebrow">CUSTOMERS</p><h1>Customers</h1></div><span>{dashboard.customers.length} records</span></div><section className="queue-panel"><div className="queue-table"><div className="table-row table-head"><span>Customer</span><span>Queue status</span><span>Token</span><span /><span /></div>{dashboard.customers.map((customer) => { const entry = dashboard.queue.find((person) => person.customerId === customer.id); return <div className="table-row" key={customer.id}><div className="customer-cell"><strong>{customer.name}</strong></div><span>{entry ? entry.status : 'No active queue entry'}</span><span>{entry?.tokenLabel ?? '—'}</span><span /><span /></div> })}{!dashboard.customers.length && <p className="empty-state">Customer records appear here when someone books or joins the queue.</p>}</div></section></main>
}

function ActivityView({ dashboard }) {
  return <main className="dashboard-main"><div className="page-heading"><div><p className="eyebrow">LIVE QUEUE</p><h1>Activity</h1></div></div><section className="upcoming">{dashboard.events.length ? dashboard.events.map((event) => <div className="setting-row" key={event.id}><div><strong>{event.message}</strong><span>{formatDateTime(event.createdAt.replace(' ', 'T') + 'Z')}</span></div></div>) : <p className="empty-state">Queue activity will appear here.</p>}</section></main>
}

function App() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('qline-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [auth, setAuth] = useState({ loading: true, user: null, error: '' })
  const [role, setRole] = useState('customer')
  const [page, setPage] = useState('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [range, setRange] = useState('today')
  const [actionError, setActionError] = useState('')
  const user = auth.user
  const availableRoles = user?.role === 'business'
    ? ['customer', 'staff', 'business']
    : user?.role === 'staff'
      ? ['customer', 'staff']
      : ['customer']
  const { dashboard, loading, error, refresh } = useLiveDashboard(user?.id, range)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('qline-theme', theme)
  }, [theme])

  useEffect(() => {
    let active = true
    api('/api/session')
      .then(({ user: currentUser }) => {
        if (!active) return
        setAuth({ loading: false, user: currentUser, error: '' })
        if (currentUser) {
          setRole(currentUser.role)
          setPage(currentUser.role === 'staff' ? 'queue' : 'overview')
        }
      })
      .catch((requestError) => {
        if (active) setAuth({ loading: false, user: null, error: requestError.message })
      })
    return () => { active = false }
  }, [])

  const runAction = async (action) => {
    setActionError('')
    try {
      await action()
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }
  const acceptLogin = (currentUser) => {
    setAuth({ loading: false, user: currentUser, error: '' })
    setRole(currentUser.role)
    setPage(currentUser.role === 'staff' ? 'queue' : 'overview')
  }
  const logout = () => runAction(async () => {
    await api('/api/auth/logout', { method: 'POST' })
    setAuth({ loading: false, user: null, error: '' })
    setActionError('')
  })
  const saveProfileName = (name) => {
    setAuth((current) => ({ ...current, user: { ...current.user, name } }))
  }

  if (auth.loading) return <div className="load-state" role="status">Connecting to Qline…</div>
  if (!user) return <AuthView theme={theme} setTheme={setTheme} onAuthenticated={acceptLogin} initialError={auth.error} />
  if (role === 'customer') {
    return dashboard
      ? <><CustomerView theme={theme} setTheme={setTheme} dashboard={dashboard} refresh={refresh} runAction={runAction} user={user} availableRoles={availableRoles} setRole={setRole} setPage={setPage} onLogout={logout} />{(actionError || error) && <div className="error-banner" role="alert">{actionError || error}</div>}</>
      : <div className="load-state" role={error ? 'alert' : 'status'}>{error || (loading ? 'Connecting to Qline…' : 'No dashboard data available.')}</div>
  }

  return (
    <div className="app-shell">
      <Header theme={theme} setTheme={setTheme} role={role} setRole={setRole} onMenu={() => setSidebarOpen(true)} setPage={setPage} events={dashboard?.events ?? []} user={user} availableRoles={availableRoles} onLogout={logout} />
      <Sidebar role={role} page={page} setPage={setPage} setRole={setRole} availableRoles={availableRoles} open={sidebarOpen} setOpen={setSidebarOpen} />
      {dashboard
        ? role === 'staff'
          ? page === 'customers' ? <CustomersView dashboard={dashboard} /> : page === 'activity' ? <ActivityView dashboard={dashboard} /> : <StaffView dashboard={dashboard} refresh={refresh} runAction={runAction} />
          : <BusinessView dashboard={dashboard} refresh={refresh} runAction={runAction} setRole={setRole} setPage={setPage} page={page} range={range} setRange={setRange} user={user} onProfileSaved={saveProfileName} />
        : <main className="dashboard-main"><p className="empty-state" role={error ? 'alert' : 'status'}>{error || (loading ? 'Connecting to QLine…' : 'No dashboard data available.')} {error && <button className="text-button" type="button" onClick={() => refresh().catch(() => {})}>Retry</button>}</p></main>}
      {(actionError || (error && dashboard)) && <div className="error-banner" role="alert">{actionError || error}</div>}
    </div>
  )
}

export default App
