import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ThemeContext } from './ThemeContext.js'

const THEME_STORAGE_KEY = 'qline-theme'

function getInitialPreference() {
  const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
  return null
}

export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(getInitialPreference)
  const [systemTheme, setSystemTheme] = useState(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  ))
  const theme = preference || systemTheme

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (preference) window.localStorage.setItem(THEME_STORAGE_KEY, preference)
    else window.localStorage.removeItem(THEME_STORAGE_KEY)
  }, [preference])

  useEffect(() => {
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    const updateSystemTheme = (event) => setSystemTheme(event.matches ? 'dark' : 'light')
    colorScheme.addEventListener('change', updateSystemTheme)
    return () => colorScheme.removeEventListener('change', updateSystemTheme)
  }, [])

  const value = useMemo(() => ({
    theme,
    toggleTheme: () => setPreference(theme === 'dark' ? 'light' : 'dark'),
  }), [theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
