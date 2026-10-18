import { useState, useEffect, useRef } from 'react'
import tntImg from '../assets/items/tnt.png'
import ironImg from '../assets/items/iron_ingot.png'
import goldImg from '../assets/items/gold_ingot.png'
import diamondImg from '../assets/items/diamond.png'
import minesIcon from '../assets/icons/game-minesweeper.png'
import coinIcon from '../assets/icons/coin.png'
import { playSound } from '../lib/sounds'
import { useAuth } from '../lib/auth-context'
import { useStatistics } from '../lib/useStatistics'

export type OreType = 'iron' | 'gold' | 'diamond'
export type CellContent = 'tnt' | OreType

export type CellState = {
  id: number
  content: CellContent
  isRevealed: boolean
  isTriggeredTnt?: boolean
  multiplierBoost: number
}

type Props = {
  onBack: () => void
}

type GameStatus = 'idle' | 'playing' | 'cashed_out' | 'exploded'

type GameHistory = {
  bet: number
  payout: number
  multiplier: number
  minesCount: number
  oresFound: OreType[]
  status: 'win' | 'loss'
}

// Multiplier boosts based on TNT count
type DifficultyPreset = {
  mines: number
  labelRu: string
  minSafe: number
  winChanceStr: string
  boostIron: number
  boostGold: number
  boostDiamond: number
}

const DIFFICULTY_PRESETS: DifficultyPreset[] = [
  { mines: 8, labelRu: '8 TNT (Баланс)', minSafe: 2, winChanceStr: '45%', boostIron: 0.35, boostGold: 0.75, boostDiamond: 2.20 },
  { mines: 10, labelRu: '10 TNT (Опасно)', minSafe: 2, winChanceStr: '35%', boostIron: 0.55, boostGold: 1.25, boostDiamond: 3.50 },
  { mines: 13, labelRu: '13 TNT (Хардкор)', minSafe: 2, winChanceStr: '22%', boostIron: 0.95, boostGold: 2.20, boostDiamond: 6.50 },
  { mines: 16, labelRu: '16 TNT (Безумие)', minSafe: 2, winChanceStr: '12%', boostIron: 1.80, boostGold: 4.00, boostDiamond: 12.00 },
]

const PRESET_BETS = [10, 50, 100, 250, 500]

function generateBoard(minesCount: number, preset: DifficultyPreset): CellState[] {
  const totalCells = 25
  const safeCount = totalCells - minesCount

  // Balanced ore rarity: exactly 1 diamond (rare jackpot), ~18% gold, ~78% iron
  const diamondCount = 1
  const goldCount = Math.max(2, Math.round(safeCount * 0.18))
  const ironCount = safeCount - diamondCount - goldCount

  const safePool: CellContent[] = [
    ...Array(ironCount).fill('iron'),
    ...Array(goldCount).fill('gold'),
    ...Array(diamondCount).fill('diamond'),
  ]

  // Shuffle safe pool
  for (let i = safePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = safePool[i]
    safePool[i] = safePool[j]
    safePool[j] = temp
  }

  // Create full content list (mines + safe)
  const fullContent: CellContent[] = [
    ...Array(minesCount).fill('tnt'),
    ...safePool,
  ]

  // Shuffle full list (Fisher-Yates)
  for (let i = fullContent.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = fullContent[i]
    fullContent[i] = fullContent[j]
    fullContent[j] = temp
  }

  return fullContent.map((content, idx) => {
    let boost = 0
    if (content === 'iron') boost = preset.boostIron
    else if (content === 'gold') boost = preset.boostGold
    else if (content === 'diamond') boost = preset.boostDiamond

    return {
      id: idx,
      content,
      isRevealed: false,
      multiplierBoost: boost,
    }
  })
}

export default function MinesweeperGame({ onBack }: Props) {
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
  const [selectedMines, setSelectedMines] = useState<number>(8)
  const [status, setStatus] = useState<GameStatus>('idle')
  const [board, setBoard] = useState<CellState[]>(() =>
    generateBoard(8, DIFFICULTY_PRESETS[0])
  )
  const [currentMultiplier, setCurrentMultiplier] = useState<number>(1.0)
  const [oresFound, setOresFound] = useState<OreType[]>([])
  const [history, setHistory] = useState<GameHistory[]>([])
  const [showPaytable, setShowPaytable] = useState<boolean>(false)

  const currentPreset =
    DIFFICULTY_PRESETS.find((p) => p.mines === selectedMines) ?? DIFFICULTY_PRESETS[0]

  const revealedSafeCount = board.filter((c) => c.isRevealed && c.content !== 'tnt').length
  const currentPayout = Math.floor(bet * currentMultiplier)

  const handleBetChange = (value: number) => {
    if (status === 'playing') return
    const clamped = Math.max(10, Math.min(Math.max(10, balance), value))
    setBet(clamped)
  }

  // Start a new game round
  const handleStartGame = () => {
    if (status === 'playing') return
    if (bet > balance) {
      playSound('click')
      return
    }

    // Deduct bet
    setBalance((prev) => prev - bet)
    const newBoard = generateBoard(selectedMines, currentPreset)
    setBoard(newBoard)
    setCurrentMultiplier(1.0)
    setOresFound([])
    setStatus('playing')
    playSound('open')
  }

  // Click on a cell in the 5x5 grid
  const handleCellClick = (index: number) => {
    if (status !== 'playing') return
    const cell = board[index]
    if (cell.isRevealed) return

    if (cell.content === 'tnt') {
      // BOOM! Exploded!
      playSound('close')
      const updatedBoard = board.map((c, i) => {
        if (i === index) {
          return { ...c, isRevealed: true, isTriggeredTnt: true }
        }
        return { ...c, isRevealed: true }
      })
      setBoard(updatedBoard)
      setStatus('exploded')

      setHistory((prev) => [
        {
          bet,
          payout: 0,
          multiplier: currentMultiplier,
          minesCount: selectedMines,
          oresFound,
          status: 'loss',
        },
        ...prev.slice(0, 4),
      ])
    } else {
      // Safe Ore uncovered!
      playSound('click')
      const newMult = Math.round((currentMultiplier + cell.multiplierBoost) * 100) / 100
      const updatedOres = [...oresFound, cell.content as OreType]

      const updatedBoard = board.map((c, i) =>
        i === index ? { ...c, isRevealed: true } : c
      )

      setBoard(updatedBoard)
      setCurrentMultiplier(newMult)
      setOresFound(updatedOres)

      // Check if all safe cells are uncovered (complete victory)
      const totalSafe = 25 - selectedMines
      if (updatedOres.length >= totalSafe) {
        // Automatic full win
        const finalPayout = Math.floor(bet * newMult)
        setBalance((prev) => prev + finalPayout)
        setStatus('cashed_out')
        playSound('done')

        setHistory((prev) => [
          {
            bet,
            payout: finalPayout,
            multiplier: newMult,
            minesCount: selectedMines,
            oresFound: updatedOres,
            status: 'win',
          },
          ...prev.slice(0, 4),
        ])
      }
    }
  }

  // Cash out current accumulated winnings
  const handleCashOut = () => {
    if (status !== 'playing' || revealedSafeCount < currentPreset.minSafe) return

    const payout = Math.floor(bet * currentMultiplier)
    setBalance((prev) => prev + payout)
    setStatus('cashed_out')
    playSound('done')

    // Reveal rest of board so player sees where TNT and diamonds were
    setBoard((prev) => prev.map((c) => ({ ...c, isRevealed: true })))

    setHistory((prev) => [
      {
        bet,
        payout,
        multiplier: currentMultiplier,
        minesCount: selectedMines,
        oresFound,
        status: 'win',
      },
      ...prev.slice(0, 4),
    ])
  }

  return (
    <div className="mines-game">
      {/* Top Navigation Bar */}
      <div className="chest-top-bar">
        <button
          type="button"
          className="btn btn-quiet chest-back-btn"
          onClick={onBack}
          disabled={status === 'playing'}
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
          onClick={() => setShowPaytable((v) => !v)}
          aria-expanded={showPaytable}
        >
          {showPaytable ? 'Скрыть множители' : 'Коэффициенты руд'}
        </button>
      </div>

      {/* Main Game Stage Layout */}
      <div className="mines-stage-layout">
        <div className="mines-machine-card">
          {/* Header Info */}
          <div className="chest-machine-header">
            <img src={minesIcon} alt="" className="chest-machine-logo" />
            <div>
              <h2>Сапёр: Шахтёрское поле</h2>
              <p>
                Ищите драгоценные руды Minecraft и умножайте ставку. Берегитесь скрытого динамита и вовремя забирайте выигрыш!
              </p>
            </div>
          </div>

          {/* Current Score / Status Banner */}
          <div className="mines-banner-wrap" aria-live="polite">
            {status === 'idle' && (
              <div className="mines-banner-idle">
                <span>Выберите ставку и начните раунд (для кэшаута найдите минимум {currentPreset.minSafe} руды, шанс {currentPreset.winChanceStr})</span>
              </div>
            )}
            {status === 'playing' && revealedSafeCount === 0 && (
              <div className="mines-banner-playing">
                <span>Откройте 1-ю клетку (для кэшаута нужно открыть минимум {currentPreset.minSafe} руды)</span>
              </div>
            )}
            {status === 'playing' && revealedSafeCount === 1 && (
              <div className="mines-banner-playing">
                <span>Найдена 1 руда! Откройте 2-ю клетку, чтобы забрать выигрыш (шанс {currentPreset.winChanceStr})</span>
              </div>
            )}
            {status === 'playing' && revealedSafeCount >= currentPreset.minSafe && (
              <div className="mines-banner-active">
                <span className="mines-active-label">Текущий выигрыш:</span>
                <strong className="mines-active-val">
                  +{currentPayout.toLocaleString()} монет
                </strong>
                <span className="mines-active-mult">(x{currentMultiplier.toFixed(2)})</span>
              </div>
            )}
            {status === 'cashed_out' && (
              <div className="mines-banner-win">
                <strong>ВЫИГРЫШ ЗАБРАН!</strong>
                <span>
                  +{currentPayout.toLocaleString()} монет (x{currentMultiplier.toFixed(2)})
                </span>
              </div>
            )}
            {status === 'exploded' && (
              <div className="mines-banner-loss">
                <strong>ВЗРЫВ ДИНАМИТА!</strong>
                <span>Вы наткнулись на TNT. Ставка {bet} монет сгорела.</span>
              </div>
            )}
          </div>

          {/* 5x5 Grid Field */}
          <div className="mines-grid-container">
            <div
              className={`mines-grid-field ${status === 'playing' ? 'in-play' : ''}`}
              role="grid"
              aria-label="Минное поле 5 на 5"
            >
              {board.map((cell, idx) => {
                const isTnt = cell.content === 'tnt'
                const isTriggered = cell.isTriggeredTnt
                const isUncoveredSafe = cell.isRevealed && !isTnt

                let cellClass = 'mines-cell'
                if (!cell.isRevealed) {
                  cellClass += ' covered'
                  if (status === 'playing') cellClass += ' clickable'
                } else {
                  cellClass += ' revealed'
                  if (isTnt) {
                    cellClass += isTriggered ? ' tnt-triggered' : ' tnt-hidden'
                  } else {
                    cellClass += ` ore-${cell.content}`
                  }
                }

                return (
                  <button
                    key={idx}
                    type="button"
                    className={cellClass}
                    onClick={() => handleCellClick(idx)}
                    disabled={status !== 'playing' || cell.isRevealed}
                    aria-label={
                      cell.isRevealed
                        ? isTnt
                          ? 'Динамит'
                          : `Найдено ${cell.content}`
                        : `Клетка ${idx + 1}`
                    }
                  >
                    {!cell.isRevealed && (
                      <div className="mines-cell-face closed">
                        <span className="mines-cell-gem" aria-hidden="true" />
                      </div>
                    )}

                    {cell.isRevealed && isTnt && (
                      <div className="mines-cell-face open tnt">
                        <img
                          src={tntImg}
                          alt="Динамит"
                          className="mines-item-img tnt-img"
                          draggable={false}
                        />
                        {isTriggered && <span className="mines-blast-glow" aria-hidden="true" />}
                      </div>
                    )}

                    {isUncoveredSafe && (
                      <div className={`mines-cell-face open ${cell.content}`}>
                        <img
                          src={
                            cell.content === 'diamond'
                              ? diamondImg
                              : cell.content === 'gold'
                              ? goldImg
                              : ironImg
                          }
                          alt={
                            cell.content === 'diamond'
                              ? 'Алмаз'
                              : cell.content === 'gold'
                              ? 'Золото'
                              : 'Железо'
                          }
                          className="mines-item-img ore-img"
                          draggable={false}
                        />
                        <span className="mines-boost-tag">
                          +{cell.multiplierBoost.toFixed(2)}x
                        </span>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Action Button: Start or Cash Out */}
          <div className="mines-action-bar">
            {status !== 'playing' ? (
              <button
                type="button"
                className="btn chest-spin-btn mines-start-btn"
                onClick={handleStartGame}
                disabled={balance < 10 || bet > balance}
                data-ui-sound="open"
              >
                <span className="chest-btn-text">
                  {status === 'idle' ? 'Начать раунд' : 'Играть снова'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className={`btn chest-spin-btn mines-cashout-btn ${
                  revealedSafeCount >= currentPreset.minSafe ? 'active' : 'waiting'
                }`}
                onClick={handleCashOut}
                disabled={revealedSafeCount < currentPreset.minSafe}
                data-ui-sound="done"
              >
                <span className="chest-btn-text">
                  {revealedSafeCount >= currentPreset.minSafe
                    ? `Забрать ${currentPayout.toLocaleString()} монет (x${currentMultiplier.toFixed(2)})`
                    : `Откройте ещё ${currentPreset.minSafe - revealedSafeCount} ${
                        currentPreset.minSafe - revealedSafeCount === 1 ? 'клетку' : 'клетки'
                      } для выигрыша`}
                </span>
              </button>
            )}
          </div>

          {/* Controls: Bet & Mines selector */}
          <div className="chest-controls-panel mines-controls-panel">
            {/* Mines Count Selector */}
            <div className="mines-selector-group">
              <span className="chest-bet-label">Количество динамита:</span>
              <div className="mines-preset-chips">
                {DIFFICULTY_PRESETS.map((preset) => (
                  <button
                    key={preset.mines}
                    type="button"
                    className={`btn btn-quiet chest-preset-chip ${
                      selectedMines === preset.mines ? 'active' : ''
                    }`}
                    onClick={() => setSelectedMines(preset.mines)}
                    disabled={status === 'playing'}
                  >
                    {preset.mines} TNT
                  </button>
                ))}
              </div>
            </div>

            {/* Bet Input Group */}
            <div className="chest-bet-input-group">
              <label htmlFor="mines-bet-input" className="chest-bet-label">
                Ставка:
              </label>
              <div className="chest-input-wrap">
                <input
                  id="mines-bet-input"
                  type="number"
                  min={10}
                  max={Math.max(10, balance)}
                  step={10}
                  value={bet}
                  onChange={(e) => handleBetChange(parseInt(e.target.value, 10) || 10)}
                  disabled={status === 'playing'}
                  className="chest-bet-input"
                />
                <span className="chest-input-currency">монет</span>
              </div>
            </div>

            {/* Bet presets */}
            <div className="chest-presets-row">
              {PRESET_BETS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  className={`btn btn-quiet chest-preset-chip ${bet === amt ? 'active' : ''}`}
                  onClick={() => handleBetChange(amt)}
                  disabled={status === 'playing' || amt > balance}
                >
                  {amt}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(Math.floor(bet / 2))}
                disabled={status === 'playing' || bet <= 10}
              >
                /2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(bet * 2)}
                disabled={status === 'playing' || bet * 2 > balance}
              >
                x2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(balance)}
                disabled={status === 'playing' || balance <= 0}
              >
                MAX
              </button>
            </div>
          </div>
        </div>

        {/* Multipliers Legend Card */}
        {showPaytable && (
          <aside className="chest-table-card mines-table-card" aria-label="Множители руд">
            <div className="chest-table-header">
              <h3>Коэффициенты ({currentPreset.mines} TNT • Шанс {currentPreset.winChanceStr})</h3>
              <span className="chest-table-hint">Мин. {currentPreset.minSafe} руды для кэшаута</span>
            </div>
            <div className="chest-table-list">
              <div className="chest-table-row">
                <div className="inv-bubble chest-table-bubble">
                  <img src={ironImg} alt="" className="chest-table-img" />
                </div>
                <div className="chest-table-info">
                  <strong>Железный слиток</strong>
                  <span className="chest-table-en">Iron Ingot • Частая руда</span>
                </div>
                <div className="chest-table-mults">
                  <strong>+{currentPreset.boostIron.toFixed(2)}x</strong>
                </div>
              </div>

              <div className="chest-table-row">
                <div className="inv-bubble chest-table-bubble">
                  <img src={goldImg} alt="" className="chest-table-img" />
                </div>
                <div className="chest-table-info">
                  <strong>Золотой слиток</strong>
                  <span className="chest-table-en">Gold Ingot • Редкая руда</span>
                </div>
                <div className="chest-table-mults">
                  <strong>+{currentPreset.boostGold.toFixed(2)}x</strong>
                </div>
              </div>

              <div className="chest-table-row jackpot-row">
                <div className="inv-bubble chest-table-bubble">
                  <img src={diamondImg} alt="" className="chest-table-img" />
                </div>
                <div className="chest-table-info">
                  <strong>Алмаз</strong>
                  <span className="chest-table-en">Diamond • Легендарная руда</span>
                </div>
                <div className="chest-table-mults">
                  <strong className="mult-diamond">+{currentPreset.boostDiamond.toFixed(2)}x</strong>
                </div>
              </div>

              <div className="chest-table-row tnt-info-row">
                <div className="inv-bubble chest-table-bubble">
                  <img src={tntImg} alt="" className="chest-table-img" />
                </div>
                <div className="chest-table-info">
                  <strong>Динамит (TNT)</strong>
                  <span className="chest-table-en">{currentPreset.mines} мин на поле • Взрыв</span>
                </div>
                <div className="chest-table-mults">
                  <span className="tnt-loss-tag">Потеря ставки</span>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* History of recent games */}
      {history.length > 0 && (
        <div className="chest-history-section">
          <h4>История последних раундов:</h4>
          <div className="chest-history-pills">
            {history.map((h, i) => (
              <div key={i} className={`chest-hist-pill ${h.status === 'win' ? 'win' : 'loss'}`}>
                <div className="chest-hist-icons">
                  {h.oresFound.slice(0, 5).map((ore, idx) => (
                    <img
                      key={idx}
                      src={ore === 'diamond' ? diamondImg : ore === 'gold' ? goldImg : ironImg}
                      alt={ore}
                      className="chest-hist-icon"
                    />
                  ))}
                  {h.status === 'loss' && (
                    <img src={tntImg} alt="TNT" className="chest-hist-icon" />
                  )}
                </div>
                <span className="chest-hist-val">
                  {h.status === 'win'
                    ? `+${h.payout} (x${h.multiplier.toFixed(2)})`
                    : `-${h.bet}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

