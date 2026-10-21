import { useSyncExternalStore } from 'react'

export const LOW_PERFORMANCE_KEY = 'minecraft-low-performance'
export const AUTO_IN_GAME_LOW_PERFORMANCE_KEY = 'minecraft-auto-low-performance-in-game'

export function parseLowPerformanceSetting(value: string | null): boolean {
  return value === 'on' || value === 'true'
}

export function readLowPerformanceEnabled(): boolean {
  try {
    return parseLowPerformanceSetting(localStorage.getItem(LOW_PERFORMANCE_KEY))
  } catch {
    return false
  }
}

export function readAutoLowPerformanceInGame(): boolean {
  try {
    const val = localStorage.getItem(AUTO_IN_GAME_LOW_PERFORMANCE_KEY)
    if (val === null) return true // Default enabled: auto low performance when in game
    return val === 'on' || val === 'true'
  } catch {
    return true
  }
}

export function applyLowPerformanceClass(effective: boolean) {
  if (typeof document !== 'undefined' && document.documentElement) {
    if (effective) {
      document.documentElement.dataset.lowPerformance = 'true'
    } else {
      delete document.documentElement.dataset.lowPerformance
    }
  }
}

let manualEnabled = readLowPerformanceEnabled()
let autoInGameSetting = readAutoLowPerformanceInGame()
let inGameDetected = false

export function lowPerformanceEffective(): boolean {
  return manualEnabled || (autoInGameSetting && inGameDetected)
}

export function isAutoLowPerformanceActive(): boolean {
  return !manualEnabled && autoInGameSetting && inGameDetected
}

export function manualLowPerformanceEnabled(): boolean {
  return manualEnabled
}

export function autoLowPerformanceInGameEnabled(): boolean {
  return autoInGameSetting
}

export function inGameDetectedStatus(): boolean {
  return inGameDetected
}

const subscribers = new Set<() => void>()

export function subscribeLowPerformanceSetting(listener: () => void) {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

function notify() {
  subscribers.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  applyLowPerformanceClass(lowPerformanceEffective())

  window.addEventListener('storage', (event) => {
    if (
      event.key === LOW_PERFORMANCE_KEY ||
      event.key === AUTO_IN_GAME_LOW_PERFORMANCE_KEY ||
      event.key === null
    ) {
      manualEnabled = readLowPerformanceEnabled()
      autoInGameSetting = readAutoLowPerformanceInGame()
      applyLowPerformanceClass(lowPerformanceEffective())
      notify()
    }
  })
}

export function lowPerformanceEnabled(): boolean {
  return lowPerformanceEffective()
}

export function setLowPerformanceEnabled(next: boolean) {
  manualEnabled = next
  try {
    localStorage.setItem(LOW_PERFORMANCE_KEY, next ? 'on' : 'off')
  } catch {
    // Mode still works for this visit without storage.
  }
  applyLowPerformanceClass(lowPerformanceEffective())
  notify()
}

export function setAutoLowPerformanceInGame(next: boolean) {
  autoInGameSetting = next
  try {
    localStorage.setItem(AUTO_IN_GAME_LOW_PERFORMANCE_KEY, next ? 'on' : 'off')
  } catch {
    // Mode still works for this visit without storage.
  }
  applyLowPerformanceClass(lowPerformanceEffective())
  notify()
}

export function setInGameDetected(inGame: boolean) {
  if (inGameDetected !== inGame) {
    inGameDetected = inGame
    applyLowPerformanceClass(lowPerformanceEffective())
    notify()
  }
}

/** The shared low performance preference, kept in sync across tabs. */
export function useLowPerformanceSetting(): [
  boolean,
  (next: boolean) => void,
  boolean,
  (next: boolean) => void,
  boolean,
] {
  const effective = useSyncExternalStore(subscribeLowPerformanceSetting, lowPerformanceEffective, () => false)
  return [
    effective,
    setLowPerformanceEnabled,
    autoInGameSetting,
    setAutoLowPerformanceInGame,
    isAutoLowPerformanceActive(),
  ]
}
