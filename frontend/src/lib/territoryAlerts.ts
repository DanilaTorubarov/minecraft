// Dismissed territory alerts. Stored breach alerts are marked read on the server,
// but a low-fuel warning is derived from the block's live fuel level and has no
// row to mark, so the desktop remembers its id locally for a while. Without this
// a dismissed warning came back on every page reload.
export const DISMISSED_ALERTS_KEY = 'minecraft-dismissed-alerts'

/** Long enough to be respected, short enough that a still-empty core warns again. */
export const DISMISSED_ALERT_TTL_MS = 12 * 60 * 60 * 1000

export type DismissedAlerts = Record<string, number>

function isFresh(dismissedAt: unknown, now: number): dismissedAt is number {
  return typeof dismissedAt === 'number' && Number.isFinite(dismissedAt) && now - dismissedAt < DISMISSED_ALERT_TTL_MS
}

export function parseDismissedAlerts(raw: string | null, now: number): DismissedAlerts {
  if (raw === null) return {}
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  const dismissed: DismissedAlerts = {}
  for (const [id, dismissedAt] of Object.entries(stored as Record<string, unknown>)) {
    if (id !== '' && isFresh(dismissedAt, now)) dismissed[id] = dismissedAt
  }
  return dismissed
}

export function isAlertDismissed(dismissed: DismissedAlerts, id: string, now: number): boolean {
  return isFresh(dismissed[id], now)
}

export function dismissAlert(dismissed: DismissedAlerts, id: string, now: number): DismissedAlerts {
  return { ...dismissed, [id]: now }
}

export function readDismissedAlerts(now: number = Date.now()): DismissedAlerts {
  try {
    return parseDismissedAlerts(localStorage.getItem(DISMISSED_ALERTS_KEY), now)
  } catch {
    return {}
  }
}

export function writeDismissedAlerts(dismissed: DismissedAlerts, now: number = Date.now()): void {
  const fresh: DismissedAlerts = {}
  for (const [id, dismissedAt] of Object.entries(dismissed)) {
    if (isFresh(dismissedAt, now)) fresh[id] = dismissedAt
  }
  try {
    localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(fresh))
  } catch {
    // Dismissing still holds for this visit without storage.
  }
}
