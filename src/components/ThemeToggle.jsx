import { useContext } from 'react'
import { Moon, Sun } from 'lucide-react'
import { ThemeContext } from '../context/ThemeContext.js'

export default function ThemeToggle() {
  const { theme, toggleTheme } = useContext(ThemeContext)
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const Icon = theme === 'dark' ? Sun : Moon

  return (
    <button
      className="icon-button theme-toggle"
      type="button"
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
      onClick={toggleTheme}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  )
}
