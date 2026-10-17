export type ThemePreference = 'light' | 'dark' | 'system'
export const THEME_KEY = 'minecraft-theme'

export function parseTheme(value: string | null): ThemePreference {
  return value === 'dark' || value === 'system' ? value : 'light'
}

export function readTheme(): ThemePreference {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY))
  } catch {
    return 'light'
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}
