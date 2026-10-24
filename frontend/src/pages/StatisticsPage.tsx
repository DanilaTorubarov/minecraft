import { formatDate, formatDuration, type StatsView } from '../lib/api'
import PlayerHead from '../components/PlayerHead'
import { displayPlayerName } from '../lib/playerName'
import { STAT_GROUPS, countersOf, type StatCounters } from '../lib/statsFormat'

type Props = {
  onGoToAccount: () => void
  scope: string
  onSelectAccount: (scope: string) => void
  stats: StatsView | null
  loadError: string
  onRetry: () => void
}

/** The grouped metric cards, shared by the combined total and one account. */
function MetricCards({ values }: { values: StatCounters }) {
  return (
    <>
      {STAT_GROUPS.map((group) => (
        <section className="section" key={group.title}>
          <div className="section-head"><h2>{group.title}</h2></div>
          <div className="stat-grid">
            {group.metrics.map((metric) => (
              <div className="stat-card" key={metric.key}>
                <span className="stat-value">{metric.format(values[metric.key])}</span>
                <span className="stat-label">{metric.label}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function StatisticsPage({ onGoToAccount, scope, onSelectAccount, stats, loadError, onRetry }: Props) {
  const retry = (
    <div className="note" data-tone="error" role="alert">
      <p>{loadError}</p>
      <button
        type="button"
        className="btn"
        onClick={onRetry}
      >
        Retry loading statistics
      </button>
    </div>
  )

  if (stats === null) {
    return (
      <div className="page-head">
        <h1>Global statistics</h1>
        <p className="page-sub">
          What the game server measured while you played: time, blocks, mobs,
          distance, damage and more. Balances and numbers sync automatically
          while you play, and use /bal in game to check your coins.
        </p>
        {loadError !== '' ? retry : <p className="loading">Loading your statistics…</p>}
      </div>
    )
  }

  const { accounts, summary } = stats

  if (accounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Global statistics</h1>
          <p className="page-sub">What the game server measured while you played, per linked account and combined.</p>
        </div>
        {loadError !== '' && retry}
        <div className="note">
          <p>
            No linked accounts yet. Link a Minecraft account to see its play
            time, block activity, and coins.
          </p>
          <button type="button" className="btn" onClick={onGoToAccount}>
            Link an account
          </button>
        </div>
      </>
    )
  }

  // One account: its own numbers, nothing borrowed from the other accounts.
  if (scope !== 'all') {
    const account = accounts.find((value) => value.uuid === scope)
    if (account !== undefined) {
      const detail = account.stats
      return (
        <>
          <div className="page-head">
            <h1 className="player-heading"><PlayerHead username={account.username} textureHash={account.skin_hash} />{displayPlayerName(account.username)}</h1>
            <p className="page-sub">
              <span className="row-id" title={account.uuid}>{account.uuid}</span>
              {' · '}Linked {formatDate(account.linked_at)}
              {detail !== null && (
                <>
                  {' · First seen '}
                  {formatDate(detail.first_seen_at)}
                  {' · Last active '}
                  {formatDate(detail.last_seen_at)}
                </>
              )}
            </p>
          </div>
          {loadError !== '' && retry}
          <section className="section">
            <div className="section-head">
              <h2>Coin balance</h2>
              <span className="count">{account.coins.toLocaleString()} coins</span>
            </div>
            <p className="page-sub">
              Earn coins through hunting, fishing, farming, or mining contracts after logging in to
              Minecraft. Use /quests in game to browse contracts and /bal to check your balance.
              You can earn coins before linking this account.
            </p>
          </section>
          {detail !== null ? (
            <MetricCards values={countersOf(detail)} />
          ) : (
            <div className="note">
              <p>
                No activity reported yet for this account. The game server
                reports activity while you play, so the numbers appear shortly
                after you start playing.
              </p>
            </div>
          )}
          <button type="button" className="btn" onClick={() => onSelectAccount('all')}>
            Open Global Statistics
          </button>
        </>
      )
    }
    return <div className="note"><p>This Minecraft account is no longer linked.</p><button className="btn" onClick={onGoToAccount}>Manage linked accounts</button></div>
  }

  const hasActivity = summary.accounts_with_stats > 0

  return (
    <>
      <div className="page-head">
        <h1>Global statistics</h1>
        <p className="page-sub">
          What the game server measured while you played, across your {summary.accounts} linked{' '}
          {summary.accounts === 1 ? 'account' : 'accounts'} — {summary.accounts_with_stats} of{' '}
          {summary.accounts} have reported activity. Use /bal in game to check coin balances.
        </p>
      </div>

      {loadError !== '' && retry}

      <section className="section">
        <div className="section-head">
          <h2>Coin balance</h2>
          <span className="count">{summary.coins.toLocaleString()} coins</span>
        </div>
        <p className="page-sub">
          Total across your linked Minecraft accounts. Use /quests in game to browse contracts and earn coins.
          Balances update automatically after the game server confirms earnings.
        </p>
      </section>

      {hasActivity ? (
        <section className="section" aria-label="Combined totals">
          <div className="section-head"><h2>Combined totals</h2></div>
          <MetricCards values={countersOf(summary)} />
        </section>
      ) : (
        <div className="note">
          <p>
            No activity reported yet. The game server reports play time and block
            activity while you play, so the numbers appear shortly after you
            start playing.
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
                  <button
                    type="button"
                    className="stat-open"
                    onClick={() => onSelectAccount(account.uuid)}
                    aria-label={`Show ${displayPlayerName(account.username)}'s statistics`}
                  >
                    <PlayerHead username={account.username} textureHash={account.skin_hash} />{displayPlayerName(account.username)}
                  </button>
                  <span className="row-id" title={account.uuid}>
                    {account.uuid}
                  </span>
                </div>
                <div className="stat-cell">
                  <span className="stat-cell-value">{account.coins.toLocaleString()}</span>
                  <span className="stat-cell-label">Coins</span>
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
  )
}

export default StatisticsPage
