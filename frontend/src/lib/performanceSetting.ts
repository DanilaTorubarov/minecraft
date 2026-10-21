import { useSyncExternalStore } from 'react'

export const LOW_PERFORMANCE_KEY = 'minecraft-low-performance'

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

export function applyLowPerformanceClass(enabled: boolean) {
  if (typeof document !== 'undefined' && document.documentElement) {
    if (enabled) {
      document.documentElement.dataset.lowPerformance = 'true'
    } else {
      delete document.documentElement.dataset.lowPerformance
    }
  }
}

let enabled = readLowPerformanceEnabled()
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
  applyLowPerformanceClass(enabled)

  window.addEventListener('storage', (event) => {
    if (event.key === LOW_PERFORMANCE_KEY || event.key === null) {
      enabled = readLowPerformanceEnabled()
      applyLowPerformanceClass(enabled)
      notify()
    }
  })
}

export function lowPerformanceEnabled(): boolean {
  return enabled
}

export function setLowPerformanceEnabled(next: boolean) {
  enabled = next
  applyLowPerformanceClass(next)
  try {
    localStorage.setItem(LOW_PERFORMANCE_KEY, next ? 'on' : 'off')
  } catch {
    // Mode still works for this visit without storage.
  }
  notify()
}

/** The shared low performance preference, kept in sync across tabs. */
export function useLowPerformanceSetting(): [boolean, (next: boolean) => void] {
  const on = useSyncExternalStore(subscribeLowPerformanceSetting, lowPerformanceEnabled, () => false)
  return [on, setLowPerformanceEnabled]
}
