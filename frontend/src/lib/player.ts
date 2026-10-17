// The quiet background music catalog. Track metadata lives here, free of asset
// imports, so the Node test runner can exercise the settings logic; the
// bundled audio files themselves are referenced from playerSources.ts.
export type Track = {
  id: string
  title: string
  artist: string
  credit: string
}

// Quiet background music from the Frutiger Aero Archive's local player catalog.
// The Kevin MacLeod tracks are licensed Creative Commons Attribution 3.0
// (see src/assets/music/SOURCES.md); the ambience loop is the archive's own.
export const TRACKS: Track[] = [
  {
    id: 'lobby-time',
    title: 'Lobby Time',
    artist: 'Kevin MacLeod',
    credit: 'Licensed under Creative Commons: By Attribution 3.0 (incompetech.com)',
  },
  {
    id: 'crinoline-dreams',
    title: 'Crinoline Dreams',
    artist: 'Kevin MacLeod',
    credit: 'Licensed under Creative Commons: By Attribution 3.0 (incompetech.com)',
  },
  {
    id: 'chill',
    title: 'Chill',
    artist: 'Kevin MacLeod',
    credit: 'Licensed under Creative Commons: By Attribution 3.0 (incompetech.com)',
  },
  {
    id: 'local-forecast',
    title: 'Local Forecast (slower)',
    artist: 'Kevin MacLeod',
    credit: 'Licensed under Creative Commons: By Attribution 3.0 (incompetech.com)',
  },
  {
    id: 'tropical-beach',
    title: 'Tropical Beach (ambience)',
    artist: 'Frutiger Aero Archive',
    credit: 'Archive sound loop',
  },
]

export const PLAYER_KEY = 'minecraft-player'

export type PlayerSettings = {
  track: number
  volume: number
  muted: boolean
}

const DEFAULTS: PlayerSettings = { track: 0, volume: 0.3, muted: false }

export function parsePlayerSettings(value: string | null): PlayerSettings {
  if (value === null) {
    return DEFAULTS
  }
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return DEFAULTS
  }
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULTS
  }
  const stored = raw as Record<string, unknown>
  const track =
    typeof stored.track === 'number' && Number.isInteger(stored.track)
      ? Math.min(TRACKS.length - 1, Math.max(0, stored.track))
      : DEFAULTS.track
  const volume =
    typeof stored.volume === 'number' && Number.isFinite(stored.volume)
      ? Math.min(1, Math.max(0, stored.volume))
      : DEFAULTS.volume
  const muted = typeof stored.muted === 'boolean' ? stored.muted : DEFAULTS.muted
  return { track, volume, muted }
}

export function readPlayerSettings(): PlayerSettings {
  try {
    return parsePlayerSettings(localStorage.getItem(PLAYER_KEY))
  } catch {
    return DEFAULTS
  }
}

export function writePlayerSettings(settings: PlayerSettings) {
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(settings))
  } catch {
    // The player still works for this visit without storage.
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00'
  }
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}
