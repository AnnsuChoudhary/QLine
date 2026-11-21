import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader.jsx'

export default function NotFoundPage() {
  return (
    <main>
      <AppHeader />
      <section className="marketing-page"><h1>Page not found</h1><Link className="button primary" to="/">Return home</Link></section>
    </main>
  )
}
