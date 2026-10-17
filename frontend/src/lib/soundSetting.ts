import { useSyncExternalStore } from 'react'

// The shared interface-sound preference. UI sounds are on by default — the
// toggle in Settings turns them off. Kept free of asset imports so the Node
// test runner can exercise it.
export const SOUND_KEY = 'minecraft-sound'

export function parseSoundSetting(value: string | null): boolean {
  return value !== 'off'
}

export function readSoundEnabled(): boolean {
  try {
    return parseSoundSetting(localStorage.getItem(SOUND_KEY))
  } catch {
    return true
  }
}

let enabled = readSoundEnabled()
const subscribers = new Set<() => void>()

export function subscribeSoundSetting(listener: () => void) {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

function notify() {
  subscribers.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SOUND_KEY || event.key === null) {
      enabled = readSoundEnabled()
      notify()
    }
  })
}

export function soundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(next: boolean) {
  enabled = next
  try {
    localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
  } catch {
    // Sounds still work for this visit without storage.
  }
  notify()
}

/** The shared sound preference, kept in step across tabs like the theme. */
export function useSoundSetting(): [boolean, (next: boolean) => void] {
  const on = useSyncExternalStore(subscribeSoundSetting, soundEnabled, () => true)
  return [on, setSoundEnabled]
}
