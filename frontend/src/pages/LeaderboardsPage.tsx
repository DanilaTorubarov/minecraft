import { useEffect, useState } from 'react'
import { getLeaderboards, type LeaderboardResponse } from '../lib/api'
import PlayerHead from '../components/PlayerHead'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'

type Category = {
  id: string
  label: string
  badge: string
  description: string
}

const CATEGORIES: Category[] = [
  { id: 'balance', label: 'Wealth', badge: 'Coins', description: 'Richest realm tycoons with the highest accumulated balances' },
  { id: 'playtime', label: 'Play Time', badge: 'Time', description: 'Most dedicated adventurers who spent the longest time in the realm' },
  { id: 'kills', label: 'Mob Slayers', badge: 'Kills', description: 'Fiercest warriors vanquishing the most hostile monsters' },
  { id: 'mining', label: 'Master Miners', badge: 'Blocks', description: 'Diligent excavators who extracted the most blocks' },
  { id: 'placed', label: 'Builders', badge: 'Placed', description: 'Architects and engineers who placed the most blocks' },
  { id: 'distance', label: 'Adventurers', badge: 'Travel', description: 'Explorers who traversed the longest distances across dimensions' },
  { id: 'advancements', label: 'Achievements', badge: 'Records', description: 'Pioneers who unlocked the most server advancements' },
]

type Props = {
  visible: boolean
  onOpenPlayer?: (uuid?: string) => void
  linkedUuids?: string[]
}

export default function LeaderboardsPage({ visible, onOpenPlayer, linkedUuids = [] }: Props) {
  const [activeCategory, setActiveCategory] = useState('balance')
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!visible) return
    let active = true
    const load = async () => {
      try {
        const res = await getLeaderboards(activeCategory, 50)
        if (active) {
          setData(res)
          setError(null)
          setLoading(false)
        }
      } catch {
        if (active) {
          setError('Could not load leaderboards from the realm server. Please check your connection.')
          setLoading(false)
        }
      }
    }
    load()
    const timer = setInterval(load, 30000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [visible, activeCategory, reloadKey])

  const selectCategory = (catId: string) => {
    if (catId === activeCategory) return
    setActiveCategory(catId)
    setLoading(true)
  }

  const handleRetry = () => {
    setLoading(true)
    setError(null)
    setReloadKey((k) => k + 1)
  }

  const categoryMeta = CATEGORIES.find((c) => c.id === activeCategory) ?? CATEGORIES[0]
  const entries = data?.entries ?? []
  const top1 = entries.find((e) => e.rank === 1)
  const top2 = entries.find((e) => e.rank === 2)
  const top3 = entries.find((e) => e.rank === 3)
  const runnersUp = entries.filter((e) => e.rank > 3)

  const isUserAccount = (uuid: string) => linkedUuids.includes(uuid)

  return (
    <div className="leaderboards-container">
      <div className="leaderboards-header">
        <div className="leaderboards-intro">
          <img src={perfCenterIcon} alt="" className="leaderboards-icon" />
          <div>
            <h1 className="leaderboards-title">Hall of Fame & Leaderboards</h1>
            <p className="leaderboards-sub">{categoryMeta.description}</p>
          </div>
        </div>

        {/* Category Navigation Tabs */}
        <nav className="leaderboards-nav" aria-label="Leaderboard categories">
          {CATEGORIES.map((cat) => {
            const isActive = cat.id === activeCategory
            return (
              <button
                key={cat.id}
                type="button"
                className={`leaderboard-tab ${isActive ? 'active' : ''}`}
                onClick={() => selectCategory(cat.id)}
                data-ui-sound="click"
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="tab-label">{cat.label}</span>
                <span className="tab-badge">{cat.badge}</span>
              </button>
            )
          })}
        </nav>
      </div>

      <div className="leaderboards-body">
        {loading && data === null ? (
          <div className="leaderboards-status">
            <div className="leaderboards-spinner" />
            <p>Loading realm champion records…</p>
          </div>
        ) : error ? (
          <div className="leaderboards-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleRetry}
            >
              Retry loading
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="leaderboards-empty">
            <p>No champion records yet in this category.</p>
            <p className="empty-sub">Play on the realm to etch your name into the Hall of Fame!</p>
          </div>
        ) : (
          <>
            {/* The Hall of Fame Podium */}
            <section className="podium-section" aria-label="Hall of fame champions">
              <div className="podium-grid">
                {/* 2nd Place - Silver (Left) */}
                <div className={`podium-card podium-silver ${top2 && isUserAccount(top2.uuid) ? 'is-me' : ''}`}>
                  <div className="podium-pedestal silver-step">
                    <span className="podium-medal">#2</span>
                  </div>
                  {top2 ? (
                    <div
                      className="podium-player"
                      onClick={() => onOpenPlayer?.(top2.uuid)}
                      role={onOpenPlayer ? 'button' : undefined}
                      tabIndex={onOpenPlayer ? 0 : undefined}
                      title={onOpenPlayer ? `View ${top2.username} in Player Controls` : undefined}
                    >
                      <div className="podium-avatar-wrapper silver-ring">
                        <PlayerHead username={top2.username} textureHash={top2.skin_hash} />
                        {isUserAccount(top2.uuid) && <span className="you-pill">You</span>}
                      </div>
                      <span className="podium-name">{top2.username}</span>
                      <span className="podium-score">{top2.formatted}</span>
                    </div>
                  ) : (
                    <div className="podium-vacant">Vacant</div>
                  )}
                </div>

                {/* 1st Place - Gold (Center, Elevated) */}
                <div className={`podium-card podium-gold ${top1 && isUserAccount(top1.uuid) ? 'is-me' : ''}`}>
                  <div className="podium-crown-badge">Champion</div>
                  <div className="podium-pedestal gold-step">
                    <span className="podium-medal">#1</span>
                  </div>
                  {top1 ? (
                    <div
                      className="podium-player"
                      onClick={() => onOpenPlayer?.(top1.uuid)}
                      role={onOpenPlayer ? 'button' : undefined}
                      tabIndex={onOpenPlayer ? 0 : undefined}
                      title={onOpenPlayer ? `View ${top1.username} in Player Controls` : undefined}
                    >
                      <div className="podium-avatar-wrapper gold-ring">
                        <PlayerHead username={top1.username} textureHash={top1.skin_hash} />
                        {isUserAccount(top1.uuid) && <span className="you-pill">You</span>}
                      </div>
                      <span className="podium-name">{top1.username}</span>
                      <span className="podium-score">{top1.formatted}</span>
                    </div>
                  ) : (
                    <div className="podium-vacant">Vacant</div>
                  )}
                </div>

                {/* 3rd Place - Bronze (Right) */}
                <div className={`podium-card podium-bronze ${top3 && isUserAccount(top3.uuid) ? 'is-me' : ''}`}>
                  <div className="podium-pedestal bronze-step">
                    <span className="podium-medal">#3</span>
                  </div>
                  {top3 ? (
                    <div
                      className="podium-player"
                      onClick={() => onOpenPlayer?.(top3.uuid)}
                      role={onOpenPlayer ? 'button' : undefined}
                      tabIndex={onOpenPlayer ? 0 : undefined}
                      title={onOpenPlayer ? `View ${top3.username} in Player Controls` : undefined}
                    >
                      <div className="podium-avatar-wrapper bronze-ring">
                        <PlayerHead username={top3.username} textureHash={top3.skin_hash} />
                        {isUserAccount(top3.uuid) && <span className="you-pill">You</span>}
                      </div>
                      <span className="podium-name">{top3.username}</span>
                      <span className="podium-score">{top3.formatted}</span>
                    </div>
                  ) : (
                    <div className="podium-vacant">Vacant</div>
                  )}
                </div>
              </div>
            </section>

            {/* Leaderboard Table (#4 - #50) */}
            {runnersUp.length > 0 && (
              <section className="leaderboards-table-section" aria-label="Ranking list">
                <div className="table-wrapper">
                  <table className="leaderboards-table">
                    <thead>
                      <tr>
                        <th className="th-rank">Rank</th>
                        <th className="th-player">Player</th>
                        <th className="th-score">{categoryMeta.label}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runnersUp.map((entry) => {
                        const isMe = isUserAccount(entry.uuid)
                        return (
                          <tr
                            key={entry.uuid}
                            className={`lb-row ${isMe ? 'lb-row-me' : ''}`}
                            onClick={() => onOpenPlayer?.(entry.uuid)}
                            role={onOpenPlayer ? 'button' : undefined}
                            tabIndex={onOpenPlayer ? 0 : undefined}
                          >
                            <td className="td-rank">
                              <span className="rank-num">#{entry.rank}</span>
                            </td>
                            <td className="td-player">
                              <div className="player-meta">
                                <span className="table-avatar">
                                  <PlayerHead username={entry.username} textureHash={entry.skin_hash} />
                                </span>
                                <span className="player-name">{entry.username}</span>
                                {isMe && <span className="you-badge">Your Account</span>}
                              </div>
                            </td>
                            <td className="td-score">
                              <span className="score-val">{entry.formatted}</span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
