import { useEffect, useState } from 'react'
import {
  ApiError,
  formatDate,
  formatDuration,
  getStats,
  sharedMessage,
  type StatsView,
} from '../lib/api'
import { onServerDataInvalidated } from '../lib/serverData'

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const shared = sharedMessage(error.status)
    if (shared !== null) {
      return shared
    }
  }
  return fallback
}

type Props = {
  /** Opens the Account window on the cabinet, where linking happens. */
  onGoToAccount: () => void
}

function StatisticsPage({ onGoToAccount }: Props) {
  const [stats, setStats] = useState<StatsView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let active = true
    let pending = false
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const found = await getStats()
        if (!active) return
        setStats(found)
        setLoadError('')
        setLoaded(true)
      } catch (problem) {
        if (active) {
          setLoadError(messageFor(problem, 'Could not load your statistics. Try again.'))
        }
      } finally {
        pending = false
      }
    }
    void refresh()
    const onFocus = () => { void refresh() }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    // The game server reports activity in flushes, so a slow refresh while the
    // page is open keeps the numbers close to the game without busy polling.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 60000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = onServerDataInvalidated('stats', () => { void refresh() })
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [refreshVersion])

  const head = (
    <div className="page-head">
      <h1>Your statistics</h1>
      <p className="page-sub">
        Activity measured by the game server for your linked accounts. It is
        reported in flushes while you play, so the numbers catch up within a few
        minutes.
      </p>
    </div>
  )

  if (stats === null || !loaded) {
    return (
      <>
        {head}
        {loadError !== '' ? (
          <div className="note" data-tone="error" role="alert">
            <p>{loadError}</p>
            <button
              type="button"
              className="btn"
              onClick={() => setRefreshVersion((version) => version + 1)}
            >
              Retry loading statistics
            </button>
          </div>
        ) : (
          <p className="loading">Loading your statistics…</p>
        )}
      </>
    )
  }

  const { accounts, summary } = stats
  const hasActivity = summary.accounts_with_stats > 0

  return (
    <>
      {head}

      {loadError !== '' && (
        <div className="note" data-tone="error" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="btn"
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            Retry loading statistics
          </button>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="note">
          <p>
            No linked accounts yet. Link a Minecraft account to see its play time
            and block activity.
          </p>
          <button type="button" className="btn" onClick={onGoToAccount}>
            Link an account
          </button>
        </div>
      ) : (
        <>
          {hasActivity ? (
            <section className="section">
              <div className="section-head">
                <h2>Your totals</h2>
              </div>
              <div className="stat-grid">
                <div className="stat-card">
                  <span className="stat-value">{formatDuration(summary.play_seconds)}</span>
                  <span className="stat-label">Play time</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{summary.blocks_placed.toLocaleString()}</span>
                  <span className="stat-label">Blocks placed</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{summary.blocks_broken.toLocaleString()}</span>
                  <span className="stat-label">Blocks broken</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">
                    {summary.accounts_with_stats} of {summary.accounts}
                  </span>
                  <span className="stat-label">Accounts with activity</span>
                </div>
              </div>
            </section>
          ) : (
            <div className="note">
              <p>
                No activity reported yet. The game server reports play time and
                block activity while you play, so the numbers appear after a few
                minutes in the world.
              </p>
            </div>
          )}

          <section className="section">
            <div className="section-head">
              <h2>Per account</h2>
              <span className="count">{accounts.length}</span>
            </div>
            <div className="panel">
              <ul className="rows">
                {accounts.map((account) => (
                  <li className="stat-row" key={account.uuid}>
                    <div>
                      <span className="row-name">{account.username}</span>
                      <span className="row-id" title={account.uuid}>
                        {account.uuid}
                      </span>
                    </div>
                    {account.stats === null ? (
                      <span className="stat-none">No activity reported yet</span>
                    ) : (
                      <>
                        <div className="stat-cell">
                          <span className="stat-cell-value">
                            {formatDuration(account.stats.play_seconds)}
                          </span>
                          <span className="stat-cell-label">Play time</span>
                        </div>
                        <div className="stat-cell">
                          <span className="stat-cell-value">
                            {account.stats.blocks_placed.toLocaleString()}
                          </span>
                          <span className="stat-cell-label">Placed</span>
                        </div>
                        <div className="stat-cell">
                          <span className="stat-cell-value">
                            {account.stats.blocks_broken.toLocaleString()}
                          </span>
                          <span className="stat-cell-label">Broken</span>
                        </div>
                      </>
                    )}
                    <span className="stat-meta">
                      {account.stats !== null
                        ? `First seen ${formatDate(account.stats.first_seen_at)} · Last active ${formatDate(account.stats.last_seen_at)}`
                        : `Linked ${formatDate(account.linked_at)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </>
  )
}

export default StatisticsPage
