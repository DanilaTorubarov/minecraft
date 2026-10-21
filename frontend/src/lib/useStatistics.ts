import { useEffect, useState } from 'react'
import { ApiError, getStats, sharedMessage, type StatsView } from './api'
import { onServerDataInvalidated } from './serverData'
import { lowPerformanceEnabled } from './performanceSetting'

/** One server snapshot for every statistics app and its launcher. */
export function useStatistics(userId: number | undefined) {
  const [snapshot, setSnapshot] = useState<{ userId: number; stats: StatsView } | null>(null)
  const [failure, setFailure] = useState<{ userId: number; message: string } | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (userId === undefined) return
    const ownerId = userId
    let active = true
    let pending = false
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const stats = await getStats()
        if (active) { setSnapshot({ userId: ownerId, stats }); setFailure(null) }
      } catch (error) {
        if (active) setFailure({ userId: ownerId, message: (error instanceof ApiError ? sharedMessage(error.status) : null) ?? 'Could not load your statistics. Try again.' })
      } finally { pending = false }
    }
    void refresh()
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    const intervalMs = lowPerformanceEnabled() ? 15000 : 5000
    const timer = window.setInterval(refreshVisible, intervalMs)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    const unsubscribe = onServerDataInvalidated('stats', () => { void refresh() })
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
      unsubscribe()
    }
  }, [userId, version])
  return {
    stats: snapshot !== null && snapshot.userId === userId ? snapshot.stats : null,
    loadError: failure !== null && failure.userId === userId ? failure.message : '',
    retry: () => setVersion((value) => value + 1),
  }
}
