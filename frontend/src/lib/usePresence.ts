import { useEffect, useState, useCallback, useSyncExternalStore } from 'react'
import { getPresence, type UserPresence } from './api'
import { setInGameDetected, lowPerformanceEnabled } from './performanceSetting'

let currentPresence: UserPresence | null = null
const presenceSubscribers = new Set<() => void>()

function notifyPresence() {
  presenceSubscribers.forEach((fn) => fn())
}

export function subscribePresence(listener: () => void) {
  presenceSubscribers.add(listener)
  return () => {
    presenceSubscribers.delete(listener)
  }
}

export function getCachedPresence(): UserPresence | null {
  return currentPresence
}

let activeFetchPromise: Promise<UserPresence | null> | null = null

export async function fetchLivePresence(): Promise<UserPresence | null> {
  if (activeFetchPromise) return activeFetchPromise
  activeFetchPromise = (async () => {
    try {
      const data = await getPresence()
      currentPresence = data
      setInGameDetected(data.in_game)
      notifyPresence()
      return data
    } catch {
      return null
    } finally {
      activeFetchPromise = null
    }
  })()
  return activeFetchPromise
}

export function usePresence(enabled = true) {
  const presence = useSyncExternalStore(subscribePresence, getCachedPresence, () => null)
  const [loading, setLoading] = useState(!currentPresence && enabled)

  const refresh = useCallback(async () => {
    await fetchLivePresence()
  }, [])

  useEffect(() => {
    if (!enabled) return

    let mounted = true
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      await fetchLivePresence()
      if (mounted) setLoading(false)
    }

    void poll()

    const interval = setInterval(() => {
      void poll()
    }, lowPerformanceEnabled() ? 15000 : 6000)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void poll()
      }
    }

    const onFocus = () => {
      void poll()
    }

    window.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)

    return () => {
      mounted = false
      clearInterval(interval)
      window.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled])

  return { presence, loading, refresh }
}
