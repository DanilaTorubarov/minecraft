import { useEffect, useState, useMemo } from 'react'
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
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [singleData, setSingleData] = useState<LeaderboardResponse | null>(null)
  const [allData, setAllData] = useState<Record<string, LeaderboardResponse>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!visible) return
    let active = true

    const load = async () => {
      try {
        if (activeCategory === 'all') {
          const results = await Promise.all(
            CATEGORIES.map(async (c) => {
              const res = await getLeaderboards(c.id, 5)
              return [c.id, res] as const
            })
          )
          if (active) {
            const map: Record<string, LeaderboardResponse> = {}
            for (const [id, res] of results) {
              map[id] = res
            }
            setAllData(map)
            setError(null)
            setLoading(false)
          }
        } else {
          const res = await getLeaderboards(activeCategory, 50)
          if (active) {
            setSingleData(res)
            setError(null)
            setLoading(false)
          }
        }
      } catch {
        if (active) {
          setError('Could not load leaderboard tables from the realm server. Please check your connection.')
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
    setSearch('')
    setLoading(true)
  }

  const handleRetry = () => {
    setLoading(true)
    setError(null)
    setReloadKey((k) => k + 1)
  }

  const isUserAccount = (uuid: string) => linkedUuids.includes(uuid)

  const activeCategoryMeta = CATEGORIES.find((c) => c.id === activeCategory)

  const filteredEntries = useMemo(() => {
    if (!singleData?.entries) return []
    const q = search.trim().toLowerCase()
    if (!q) return singleData.entries
    return singleData.entries.filter((e) => e.username.toLowerCase().includes(q))
  }, [singleData, search])

  const renderRankBadge = (rank: number) => {
    if (rank === 1) return <span className="rank-badge rank-gold" title="Rank 1">🥇 #1</span>
    if (rank === 2) return <span className="rank-badge rank-silver" title="Rank 2">🥈 #2</span>
    if (rank === 3) return <span className="rank-badge rank-bronze" title="Rank 3">🥉 #3</span>
    return <span className="rank-num">#{rank}</span>
  }

  const getAvatarRankClass = (rank: number) => {
    if (rank === 1) return 'rank-avatar-gold'
    if (rank === 2) return 'rank-avatar-silver'
    if (rank === 3) return 'rank-avatar-bronze'
    return ''
  }

  return (
    <div className="leaderboards-container">
      <div className="leaderboards-header">
        <div className="leaderboards-intro">
          <img src={perfCenterIcon} alt="" className="leaderboards-icon" />
          <div>
            <h1 className="leaderboards-title">Leaderboard Tables</h1>
            <p className="leaderboards-sub">
              {activeCategory === 'all'
                ? 'Server-wide rankings across wealth, activity, combat, and milestones'
                : activeCategoryMeta?.description}
            </p>
          </div>
        </div>

        {/* Category Navigation Tabs */}
        <nav className="leaderboards-nav" aria-label="Leaderboard categories">
          <button
            type="button"
            className={`leaderboard-tab ${activeCategory === 'all' ? 'active' : ''}`}
            onClick={() => selectCategory('all')}
            data-ui-sound="click"
            aria-current={activeCategory === 'all' ? 'page' : undefined}
          >
            <span className="tab-label">All Tables</span>
            <span className="tab-badge">Overview</span>
          </button>
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
        {loading && (activeCategory === 'all' ? Object.keys(allData).length === 0 : singleData === null) ? (
          <div className="leaderboards-status">
            <div className="leaderboards-spinner" />
            <p>Loading leaderboard tables…</p>
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
        ) : activeCategory === 'all' ? (
          /* Multi-table Grid (All Tables Overview) */
          <div className="leaderboard-tables-grid" aria-label="All leaderboard tables">
            {CATEGORIES.map((cat) => {
              const catData = allData[cat.id]
              const entries = catData?.entries ?? []
              return (
                <section key={cat.id} className="category-table-card" aria-label={`${cat.label} leaderboard`}>
                  <div className="category-card-header">
                    <div className="category-card-title-wrap">
                      <h2 className="category-card-title">{cat.label}</h2>
                      <span className="category-card-badge">{cat.badge}</span>
                    </div>
                    <p className="category-card-desc">{cat.description}</p>
                  </div>

                  <div className="table-wrapper">
                    <table className="leaderboards-table compact-table">
                      <thead>
                        <tr>
                          <th className="th-rank">Rank</th>
                          <th className="th-player">Player</th>
                          <th className="th-score">{cat.label}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.length === 0 ? (
                          <tr>
                            <td colSpan={3} className="td-empty">
                              No records yet
                            </td>
                          </tr>
                        ) : (
                          entries.map((entry) => {
                            const isMe = isUserAccount(entry.uuid)
                            return (
                              <tr
                                key={entry.uuid}
                                className={`lb-row ${isMe ? 'lb-row-me' : ''}`}
                                onClick={() => onOpenPlayer?.(entry.uuid)}
                                role={onOpenPlayer ? 'button' : undefined}
                                tabIndex={onOpenPlayer ? 0 : undefined}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    onOpenPlayer?.(entry.uuid)
                                  }
                                }}
                                title={onOpenPlayer ? `View ${entry.username} in Player Controls` : undefined}
                              >
                                <td className="td-rank">{renderRankBadge(entry.rank)}</td>
                                <td className="td-player">
                                  <div className="player-meta">
                                    <span className={`table-avatar ${getAvatarRankClass(entry.rank)}`}>
                                      <PlayerHead username={entry.username} textureHash={entry.skin_hash} />
                                    </span>
                                    <span className="player-name">{entry.username}</span>
                                    {isMe && <span className="you-badge">You</span>}
                                  </div>
                                </td>
                                <td className="td-score">
                                  <span className="score-val">{entry.formatted}</span>
                                </td>
                              </tr>
                            )
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="category-card-footer">
                    <button
                      type="button"
                      className="btn-view-all"
                      onClick={() => selectCategory(cat.id)}
                      data-ui-sound="click"
                    >
                      View full {cat.label} table (50) →
                    </button>
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          /* Single Category Full Table (Top 50) */
          <section className="leaderboards-table-section" aria-label={`${activeCategoryMeta?.label} leaderboard table`}>
            <div className="table-controls-bar">
              <div className="table-meta-info">
                <button
                  type="button"
                  className="btn-back-overview"
                  onClick={() => selectCategory('all')}
                  data-ui-sound="click"
                >
                  ← All Tables
                </button>
                <span className="table-count-badge">
                  {filteredEntries.length} {filteredEntries.length === 1 ? 'player' : 'players'}
                </span>
              </div>
              <div className="table-search-box">
                <input
                  type="search"
                  className="leaderboard-search-input"
                  placeholder={`Search in ${activeCategoryMeta?.label}…`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label={`Search players in ${activeCategoryMeta?.label} table`}
                />
                {search && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {singleData?.entries.length === 0 ? (
              <div className="leaderboards-empty">
                <p>No player records yet in this category.</p>
                <p className="empty-sub">Play on the realm to climb the leaderboard tables!</p>
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="leaderboards-empty">
                <p>No players matching &ldquo;{search}&rdquo; in {activeCategoryMeta?.label}.</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSearch('')}
                  style={{ marginTop: '8px' }}
                >
                  Clear search
                </button>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="leaderboards-table">
                  <thead>
                    <tr>
                      <th className="th-rank">Rank</th>
                      <th className="th-player">Player</th>
                      <th className="th-score">{activeCategoryMeta?.label}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry) => {
                      const isMe = isUserAccount(entry.uuid)
                      return (
                        <tr
                          key={entry.uuid}
                          className={`lb-row ${isMe ? 'lb-row-me' : ''}`}
                          onClick={() => onOpenPlayer?.(entry.uuid)}
                          role={onOpenPlayer ? 'button' : undefined}
                          tabIndex={onOpenPlayer ? 0 : undefined}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onOpenPlayer?.(entry.uuid)
                            }
                          }}
                          title={onOpenPlayer ? `View ${entry.username} in Player Controls` : undefined}
                        >
                          <td className="td-rank">{renderRankBadge(entry.rank)}</td>
                          <td className="td-player">
                            <div className="player-meta">
                              <span className={`table-avatar ${getAvatarRankClass(entry.rank)}`}>
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
            )}
          </section>
        )}
      </div>
    </div>
  )
}
