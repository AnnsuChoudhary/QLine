import { Component } from 'react'

export default class AppErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('QLine failed to render this page.', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-error-boundary" role="alert">
          <h1>This page could not be displayed</h1>
          <p>QLine encountered an unexpected error. Reload the page to try again.</p>
          <button className="button primary" type="button" onClick={() => window.location.reload()}>Reload QLine</button>
        </main>
      )
    }
    return this.props.children
  }
}
