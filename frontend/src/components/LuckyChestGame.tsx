import { useState, useEffect, useRef } from 'react'
import diamondImg from '../assets/items/diamond.png'
import heartImg from '../assets/items/heart_of_the_sea.png'
import tridentImg from '../assets/items/trident.png'
import nautilusImg from '../assets/items/nautilus_shell.png'
import crystalsImg from '../assets/items/prismarine_crystals.png'
import shardImg from '../assets/items/prismarine_shard.png'
import pufferImg from '../assets/items/pufferfish.png'
import fishImg from '../assets/items/tropical_fish.png'
import chestIcon from '../assets/icons/game-lucky-chest.png'
import coinIcon from '../assets/icons/coin.png'
import { playSound } from '../lib/sounds'
import { useAuth } from '../lib/auth-context'
import { useStatistics } from '../lib/useStatistics'

export type MarineItem = {
  id: string
  nameRu: string
  nameEn: string
  icon: string
  mult3: number
  mult2?: number
  mult1?: number
}

export const MARINE_ITEMS: MarineItem[] = [
  {
    id: 'diamond',
    nameRu: 'Алмаз',
    nameEn: 'Diamond',
    icon: diamondImg,
    mult3: 50,
    mult2: 5,
    mult1: 1.5,
  },
  {
    id: 'heart_of_the_sea',
    nameRu: 'Сердце моря',
    nameEn: 'Heart of the Sea',
    icon: heartImg,
    mult3: 25,
    mult2: 3,
  },
  {
    id: 'trident',
    nameRu: 'Трезубец',
    nameEn: 'Trident',
    icon: tridentImg,
    mult3: 15,
    mult2: 2.5,
  },
  {
    id: 'nautilus_shell',
    nameRu: 'Раковина наутилуса',
    nameEn: 'Nautilus Shell',
    icon: nautilusImg,
    mult3: 10,
    mult2: 2,
  },
  {
    id: 'prismarine_crystals',
    nameRu: 'Кристалл призмарина',
    nameEn: 'Prismarine Crystals',
    icon: crystalsImg,
    mult3: 7,
    mult2: 1.8,
  },
  {
    id: 'prismarine_shard',
    nameRu: 'Осколок призмарина',
    nameEn: 'Prismarine Shard',
    icon: shardImg,
    mult3: 5,
    mult2: 1.5,
  },
  {
    id: 'pufferfish',
    nameRu: 'Иглобрюх',
    nameEn: 'Pufferfish',
    icon: pufferImg,
    mult3: 3,
    mult2: 1.3,
  },
  {
    id: 'tropical_fish',
    nameRu: 'Тропическая рыба',
    nameEn: 'Tropical Fish',
    icon: fishImg,
    mult3: 2,
    mult2: 1.2,
  },
]

function getRandomItem(): MarineItem {
  const index = Math.floor(Math.random() * MARINE_ITEMS.length)
  return MARINE_ITEMS[index]
}

// Generates spin results where chance to win (46%) is slightly less than chance to lose (54%)
function generateBalancedOutcome(): [MarineItem, MarineItem, MarineItem] {
  const roll = Math.random()

  // 1. 8% chance: 3 of a kind (Triple win / Jackpot)
  if (roll < 0.08) {
    const tripleRoll = Math.random()
    let chosen: MarineItem
    if (tripleRoll < 0.10) chosen = MARINE_ITEMS[0] // Diamond (Jackpot x50)
    else if (tripleRoll < 0.25) chosen = MARINE_ITEMS[1] // Heart (x25)
    else if (tripleRoll < 0.40) chosen = MARINE_ITEMS[2] // Trident (x15)
    else if (tripleRoll < 0.55) chosen = MARINE_ITEMS[3] // Nautilus (x10)
    else if (tripleRoll < 0.70) chosen = MARINE_ITEMS[4] // Crystals (x7)
    else if (tripleRoll < 0.82) chosen = MARINE_ITEMS[5] // Shard (x5)
    else if (tripleRoll < 0.92) chosen = MARINE_ITEMS[6] // Puffer (x3)
    else chosen = MARINE_ITEMS[7] // Fish (x2)
    return [chosen, chosen, chosen]
  }

  // 2. 28% chance: 2 of a kind (Pair match)
  if (roll < 0.36) {
    const pairItem = getRandomItem()
    let otherItem = getRandomItem()
    while (otherItem.id === pairItem.id) {
      otherItem = getRandomItem()
    }
    const pattern = Math.floor(Math.random() * 3)
    if (pattern === 0) return [pairItem, pairItem, otherItem]
    if (pattern === 1) return [pairItem, otherItem, pairItem]
    return [otherItem, pairItem, pairItem]
  }

  // 3. 10% chance: Single Diamond bonus (x1.5)
  if (roll < 0.46) {
    const diamond = MARINE_ITEMS[0]
    const nonDiamonds = MARINE_ITEMS.filter((it) => it.id !== 'diamond')
    const b = nonDiamonds[Math.floor(Math.random() * nonDiamonds.length)]
    let c = nonDiamonds[Math.floor(Math.random() * nonDiamonds.length)]
    while (c.id === b.id) {
      c = nonDiamonds[Math.floor(Math.random() * nonDiamonds.length)]
    }
    const pos = Math.floor(Math.random() * 3)
    if (pos === 0) return [diamond, b, c]
    if (pos === 1) return [b, diamond, c]
    return [b, c, diamond]
  }

  // 4. 54% chance: Lose (no match, no diamond)
  const nonDiamonds = MARINE_ITEMS.filter((it) => it.id !== 'diamond')
  const idxA = Math.floor(Math.random() * nonDiamonds.length)
  let idxB = Math.floor(Math.random() * nonDiamonds.length)
  while (idxB === idxA) {
    idxB = Math.floor(Math.random() * nonDiamonds.length)
  }
  let idxC = Math.floor(Math.random() * nonDiamonds.length)
  while (idxC === idxA || idxC === idxB) {
    idxC = Math.floor(Math.random() * nonDiamonds.length)
  }
  return [nonDiamonds[idxA], nonDiamonds[idxB], nonDiamonds[idxC]]
}

type SpinResult = {
  items: [MarineItem, MarineItem, MarineItem]
  multiplier: number
  payout: number
  winType: 'jackpot' | 'big' | 'regular' | 'none'
  matchedItem: MarineItem | null
}

function calculatePayout(reels: [MarineItem, MarineItem, MarineItem], bet: number): SpinResult {
  const [a, b, c] = reels

  // 3 of a kind
  if (a.id === b.id && b.id === c.id) {
    const mult = a.mult3
    const winType = a.id === 'diamond' ? 'jackpot' : mult >= 15 ? 'big' : 'regular'
    return {
      items: reels,
      multiplier: mult,
      payout: Math.floor(bet * mult),
      winType,
      matchedItem: a,
    }
  }

  // 2 of a kind
  if (a.id === b.id && a.mult2) {
    return {
      items: reels,
      multiplier: a.mult2,
      payout: Math.floor(bet * a.mult2),
      winType: a.mult2 >= 3 ? 'big' : 'regular',
      matchedItem: a,
    }
  }
  if (b.id === c.id && b.mult2) {
    return {
      items: reels,
      multiplier: b.mult2,
      payout: Math.floor(bet * b.mult2),
      winType: b.mult2 >= 3 ? 'big' : 'regular',
      matchedItem: b,
    }
  }
  if (a.id === c.id && a.mult2) {
    return {
      items: reels,
      multiplier: a.mult2,
      payout: Math.floor(bet * a.mult2),
      winType: a.mult2 >= 3 ? 'big' : 'regular',
      matchedItem: a,
    }
  }

  // 1 Diamond bonus
  if (a.id === 'diamond' || b.id === 'diamond' || c.id === 'diamond') {
    const diamond = MARINE_ITEMS[0]
    const mult = diamond.mult1 ?? 1.5
    return {
      items: reels,
      multiplier: mult,
      payout: Math.floor(bet * mult),
      winType: 'regular',
      matchedItem: diamond,
    }
  }

  return {
    items: reels,
    multiplier: 0,
    payout: 0,
    winType: 'none',
    matchedItem: null,
  }
}

type Props = {
  onBack: () => void
}

const PRESET_BETS = [10, 50, 100, 250, 500]

// Single Slot Bubble where the bubble sphere itself rotates together with the spinning items
function BubbleSlot({
  targetItem,
  isSpinning,
  isSettling,
  isWinning,
}: {
  targetItem: MarineItem
  isSpinning: boolean
  isSettling: boolean
  isWinning: boolean
}) {
  const bubbleClasses = [
    'inv-bubble',
    'chest-inv-bubble',
    isSpinning ? 'chest-bubble-spinning' : '',
    isSettling && !isSpinning ? 'chest-bubble-settling' : '',
    isWinning ? 'chest-bubble-winning inv-enchanted' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={bubbleClasses}
      role="img"
      aria-label={`Слот: ${targetItem.nameRu}`}
    >
      <div className="chest-reel-viewport">
        {isSpinning ? (
          <div className="chest-reel-strip spinning" aria-hidden="true">
            {MARINE_ITEMS.slice(0, 4).map((it, idx) => (
              <img
                key={idx}
                src={it.icon}
                alt=""
                className="chest-item-img"
                draggable={false}
              />
            ))}
            {MARINE_ITEMS.slice(0, 4).map((it, idx) => (
              <img
                key={`dup-${idx}`}
                src={it.icon}
                alt=""
                className="chest-item-img"
                draggable={false}
              />
            ))}
          </div>
        ) : (
          <div className={`chest-reel-strip ${isSettling ? 'settled' : ''}`}>
            <img
              src={targetItem.icon}
              alt={targetItem.nameRu}
              className="chest-item-img"
              draggable={false}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default function LuckyChestGame({ onBack }: Props) {
  const { user } = useAuth()
  const { stats } = useStatistics(user?.id)

  const hasLinkedAccount = (stats?.accounts?.length ?? 0) > 0
  const serverCoins = stats?.summary?.coins

  const [balance, setBalance] = useState<number>(() => {
    if (typeof serverCoins === 'number') {
      return serverCoins
    }
    try {
      const stored = localStorage.getItem('chest_game_balance')
      if (stored !== null) {
        const val = parseInt(stored, 10)
        if (!isNaN(val) && val >= 0) return val
      }
    } catch {}
    return 1000
  })

  // Synchronize when server stats load or update
  const initialSyncedRef = useRef(false)
  useEffect(() => {
    if (hasLinkedAccount && typeof serverCoins === 'number') {
      if (!initialSyncedRef.current) {
        initialSyncedRef.current = true
        setBalance(serverCoins)
        try {
          localStorage.setItem('chest_game_balance', serverCoins.toString())
        } catch {}
      }
    }
  }, [hasLinkedAccount, serverCoins])

  useEffect(() => {
    try {
      localStorage.setItem('chest_game_balance', balance.toString())
    } catch {}
  }, [balance])

  const [bet, setBet] = useState<number>(50)
  const [isSpinning, setIsSpinning] = useState<boolean>(false)
  const [reels, setReels] = useState<[MarineItem, MarineItem, MarineItem]>([
    MARINE_ITEMS[0], // Diamond
    MARINE_ITEMS[1], // Heart of the Sea
    MARINE_ITEMS[2], // Trident
  ])
  const [reelSpinning, setReelSpinning] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [reelSettling, setReelSettling] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [lastResult, setLastResult] = useState<SpinResult | null>(null)
  const [history, setHistory] = useState<SpinResult[]>([])
  const [showTable, setShowTable] = useState<boolean>(false)

  const handleBetChange = (value: number) => {
    if (isSpinning) return
    const clamped = Math.max(10, Math.min(Math.max(10, balance), value))
    setBet(clamped)
  }

  const handleSpin = () => {
    if (isSpinning) return
    if (bet > balance) {
      playSound('click')
      return
    }

    // Deduct bet immediately
    setBalance((prev) => prev - bet)
    setIsSpinning(true)
    setLastResult(null)
    setReelSpinning([true, true, true])
    setReelSettling([false, false, false])
    playSound('open')

    // Determine target items using the balanced model (54% win, 46% loss)
    const targetReels = generateBalancedOutcome()

    // Sequential stop for authentic slot machine feel
    // Reel 1 stops at 900ms
    setTimeout(() => {
      setReels((prev) => [targetReels[0], prev[1], prev[2]])
      setReelSpinning([false, true, true])
      setReelSettling([true, false, false])
      playSound('click')
    }, 900)

    // Reel 2 stops at 1400ms
    setTimeout(() => {
      setReels((prev) => [targetReels[0], targetReels[1], prev[2]])
      setReelSpinning([false, false, true])
      setReelSettling([true, true, false])
      playSound('click')
    }, 1400)

    // Reel 3 stops at 1900ms
    setTimeout(() => {
      setReels(targetReels)
      setReelSpinning([false, false, false])
      setReelSettling([true, true, true])
      setIsSpinning(false)

      const result = calculatePayout(targetReels, bet)
      setLastResult(result)
      setHistory((prev) => [result, ...prev.slice(0, 4)])

      if (result.payout > 0) {
        setBalance((prev) => prev + result.payout)
        playSound('done')
      } else {
        playSound('click')
      }

      setTimeout(() => {
        setReelSettling([false, false, false])
      }, 450)
    }, 1900)
  }

  return (
    <div className="lucky-chest-game">
      {/* Top Navigation Bar */}
      <div className="chest-top-bar">
        <button
          type="button"
          className="btn btn-quiet chest-back-btn"
          onClick={onBack}
          disabled={isSpinning}
          data-ui-sound="close"
        >
          ← Все мини-игры
        </button>

        <div className="chest-balance-pill">
          <img src={coinIcon} alt="" className="chest-coin-icon" />
          <span className="chest-balance-num">{balance.toLocaleString()}</span>
          <span className="chest-balance-label">монет</span>
        </div>

        <button
          type="button"
          className="btn btn-quiet chest-payout-btn"
          onClick={() => setShowTable((v) => !v)}
          aria-expanded={showTable}
        >
          {showTable ? 'Скрыть таблицу' : 'Таблица выплат'}
        </button>
      </div>

      {/* Main Game Stage */}
      <div className="chest-stage-layout">
        <div className="chest-machine-card">
          <div className="chest-machine-header">
            <img src={chestIcon} alt="" className="chest-machine-logo" />
            <div>
              <h2>Сундук удачи</h2>
              <p>Морские сокровища Minecraft. Выбивайте комбинации в водных пузырьках и ловите алмазный джекпот!</p>
            </div>
          </div>

          {/* 3 Bubble Slots */}
          <div className="chest-bubbles-row">
            {reels.map((item, idx) => {
              const isWinReel =
                lastResult !== null &&
                lastResult.payout > 0 &&
                (lastResult.items.filter((it) => it.id === item.id).length >= 2 ||
                  (item.id === 'diamond' && lastResult.multiplier > 0))

              return (
                <div key={idx} className="chest-slot-column">
                  <BubbleSlot
                    targetItem={item}
                    isSpinning={reelSpinning[idx]}
                    isSettling={reelSettling[idx]}
                    isWinning={isWinReel}
                  />
                </div>
              )
            })}
          </div>

          {/* Outcome Announcement */}
          <div className="chest-outcome-banner" aria-live="polite">
            {isSpinning && (
              <span className="chest-outcome-status spinning">Сундук открывается...</span>
            )}
            {!isSpinning && lastResult && lastResult.payout > 0 && (
              <div className={`chest-win-notice ${lastResult.winType}`}>
                <strong>
                  {lastResult.winType === 'jackpot'
                    ? 'АЛМАЗНЫЙ ДЖЕКПОТ!'
                    : lastResult.winType === 'big'
                    ? 'КРУПНЫЙ ВЫИГРЫШ!'
                    : 'ВЫИГРЫШ!'}
                </strong>{' '}
                <span>
                  +{lastResult.payout.toLocaleString()} монет (x{lastResult.multiplier})
                </span>
              </div>
            )}
            {!isSpinning && lastResult && lastResult.payout === 0 && (
              <span className="chest-outcome-status loss">Пусто. Попробуйте ещё раз.</span>
            )}
            {!isSpinning && !lastResult && (
              <span className="chest-outcome-status idle">Выберите ставку и откройте сундук</span>
            )}
          </div>

          {/* Betting Controls */}
          <div className="chest-controls-panel">
            <div className="chest-bet-input-group">
              <label htmlFor="chest-bet-input" className="chest-bet-label">
                Ставка:
              </label>
              <div className="chest-input-wrap">
                <input
                  id="chest-bet-input"
                  type="number"
                  min={10}
                  max={Math.max(10, balance)}
                  step={10}
                  value={bet}
                  onChange={(e) => handleBetChange(parseInt(e.target.value, 10) || 10)}
                  disabled={isSpinning}
                  className="chest-bet-input"
                />
                <span className="chest-input-currency">монет</span>
              </div>
            </div>

            {/* Quick Bet Buttons */}
            <div className="chest-presets-row">
              {PRESET_BETS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  className={`btn btn-quiet chest-preset-chip ${bet === amt ? 'active' : ''}`}
                  onClick={() => handleBetChange(amt)}
                  disabled={isSpinning || amt > balance}
                >
                  {amt}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(Math.floor(bet / 2))}
                disabled={isSpinning || bet <= 10}
              >
                /2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(bet * 2)}
                disabled={isSpinning || bet * 2 > balance}
              >
                x2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(balance)}
                disabled={isSpinning || balance <= 0}
              >
                MAX
              </button>
            </div>

            {/* Big Action Spin Button */}
            <button
              type="button"
              className="btn chest-spin-btn"
              onClick={handleSpin}
              disabled={isSpinning || balance < 10 || bet > balance}
              data-ui-sound="open"
            >
              <span className="chest-btn-glow" aria-hidden="true" />
              <span className="chest-btn-text">
                {isSpinning ? 'Крутим...' : 'Открыть сундук'}
              </span>
            </button>
          </div>
        </div>

        {/* Payout Multiplier Table */}
        {showTable && (
          <aside className="chest-table-card" aria-label="Таблица выплат">
            <div className="chest-table-header">
              <h3>Коэффициенты выплат</h3>
              <span className="chest-table-hint">3 в ряд / 2 в ряд</span>
            </div>
            <div className="chest-table-list">
              {MARINE_ITEMS.map((item) => (
                <div
                  key={item.id}
                  className={`chest-table-row ${item.id === 'diamond' ? 'jackpot-row' : ''}`}
                >
                  <div className="inv-bubble chest-table-bubble">
                    <img src={item.icon} alt="" className="chest-table-img" />
                  </div>
                  <div className="chest-table-info">
                    <strong>{item.nameRu}</strong>
                    <span className="chest-table-en">{item.nameEn}</span>
                  </div>
                  <div className="chest-table-mults">
                    <span className="mult-3">3x = <strong>x{item.mult3}</strong></span>
                    {item.mult2 && (
                      <span className="mult-2">2x = <strong>x{item.mult2}</strong></span>
                    )}
                    {item.mult1 && (
                      <span className="mult-1">1x = <strong>x{item.mult1}</strong></span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      {/* History of recent spins */}
      {history.length > 0 && (
        <div className="chest-history-section">
          <h4>История последних открытий:</h4>
          <div className="chest-history-pills">
            {history.map((h, i) => (
              <div key={i} className={`chest-hist-pill ${h.payout > 0 ? 'win' : 'loss'}`}>
                <div className="chest-hist-icons">
                  {h.items.map((it, idx) => (
                    <img key={idx} src={it.icon} alt={it.nameRu} className="chest-hist-icon" />
                  ))}
                </div>
                <span className="chest-hist-val">
                  {h.payout > 0 ? `+${h.payout}` : `-${bet}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
