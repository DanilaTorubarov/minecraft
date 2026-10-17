import { useEffect, useState } from 'react'
import personalizationIcon from '../assets/icons/vista-personalization.png'
import { parseTheme, readTheme, resolveTheme, THEME_KEY, type ThemePreference } from '../lib/theme'

export default function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(preference, media.matches)
    }
    apply()
    media.addEventListener('change', apply)
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) setPreference(parseTheme(event.newValue))
    }
    window.addEventListener('storage', sync)
    return () => {
      media.removeEventListener('change', apply)
      window.removeEventListener('storage', sync)
    }
  }, [preference])

  function change(value: string) {
    const next = parseTheme(value)
    setPreference(next)
    try { localStorage.setItem(THEME_KEY, next) } catch { /* The selection still works without storage. */ }
  }

  return (
    <label className="theme-control">
      <img src={personalizationIcon} alt="" aria-hidden="true" />
      <span>Color theme</span>
      <select value={preference} onChange={(event) => change(event.target.value)}>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  )
}
