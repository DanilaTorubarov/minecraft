import { useEffect, useState } from 'react'
import tntImg from '../assets/items/tnt.png'
import ironImg from '../assets/items/iron_ingot.png'
import goldImg from '../assets/items/gold_ingot.png'
import diamondImg from '../assets/items/diamond.png'
import minesIcon from '../assets/icons/game-minesweeper.png'
import PayerSelect from './PayerSelect'
import { ApiError, cashOutMines, getMinigameState, revealMines, startMines } from '../lib/api'
import { invalidateServerData } from '../lib/serverData'
import { useStakedBalance } from '../lib/useMinigames'
import { playSound } from '../lib/sounds'
import {
  canAfford,
  clampBet,
  formatBoost,
  formatCoins,
  formatMultiplier,
  formatReturn,
  minigameFailure,
  revealedCells,
  safeCellsOpened,
  type MinigameRules,
  type MinesPresetRules,
  type MinesRound,
  type OreContent,
  type Payer,
} from '../lib/minigames'

type Props = {
  onBack: () => void
  payer: Payer
  accounts: Payer[]
  onChoosePayer: (uuid: string) => void
  rules: MinigameRules
}

const PRESET_BETS = [10, 50, 100, 250, 500]

/** Names for the difficulty chips; the multipliers themselves come from the server. */
const PRESET_LABELS: Record<number, string> = {
  8: 'Баланс',
  10: 'Опасно',
  13: 'Хардкор',
  16: 'Безумие',
}

const ORE_ICONS: Record<Exclude<OreContent, 'tnt'>, string> = {
  iron: ironImg,
  gold: goldImg,
  diamond: diamondImg,
}

const ORE_NAMES: Record<Exclude<OreContent, 'tnt'>, string> = {
  iron: 'Железо',
  gold: 'Золото',
  diamond: 'Алмаз',
}

type HistoryEntry = {
  bet: number
  payout: number
  multiplier_x100: number
  status: 'win' | 'loss'
}

export default function MinesweeperGame({ onBack, payer, accounts, onChoosePayer, rules }: Props) {
  const { balance, applySettled } = useStakedBalance(payer.uuid, payer.coins)
  const presets = rules.mines.presets
  const [bet, setBet] = useState(() => clampBet(50, rules.min_bet, rules.max_bet, payer.coins))
  const [selectedMines, setSelectedMines] = useState(presets[0]?.mines ?? 8)
  const [round, setRound] = useState<MinesRound | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showPaytable, setShowPaytable] = useState(false)

  const preset: MinesPresetRules = presets.find((value) => value.mines === selectedMines) ?? presets[0]
  const playing = round !== null && round.status === 'active'
  const cells = round !== null ? revealedCells(round) : new Map<number, OreContent>()
  const opened = round !== null ? safeCellsOpened(round) : 0
  // Checked, not rewritten: a stake the payer cannot cover is refused out loud.
  const validBet = bet >= rules.min_bet && bet <= rules.max_bet && canAfford(bet, balance)

  // A field is already paid for; a reload must not hide it and invite a second stake.
  useEffect(() => {
    let active = true
    getMinigameState()
      .then((restored) => {
        if (!active || restored === null) return
        setRound(restored)
        setBet(restored.bet)
        setSelectedMines(restored.mines)
        applySettled(restored.balance)
      })
      .catch((failure: unknown) => {
        if (active) setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      })
      .finally(() => {
        if (active) setRestoring(false)
      })
    return () => {
      active = false
    }
    // Restoring once on mount is the point: later ledger reads come from the round itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleBetChange = (value: number) => {
    if (playing) return
    setBet(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  }

  const settleHistory = (settled: MinesRound) => {
    setHistory((previous) => [
      {
        bet: settled.bet,
        payout: settled.payout,
        multiplier_x100: settled.multiplier_x100,
        status: settled.payout > 0 ? 'win' : 'loss',
      },
      ...previous.slice(0, 4),
    ])
    invalidateServerData('stats')
  }

  /** Applies a server reply to the board, and announces a round that just ended. */
  const applyRound = (next: MinesRound, wasPlaying: boolean) => {
    setRound(next)
    applySettled(next.balance)
    if (next.status === 'settled' && wasPlaying) {
      playSound(next.payout > 0 ? 'done' : 'close')
      settleHistory(next)
    } else if (next.status === 'active') {
      playSound('click')
    }
  }

  /** One ore's contribution to the running multiplier for the chosen difficulty. */
  const boostFor = (content: Exclude<OreContent, 'tnt'>): number => {
    if (content === 'iron') return preset.boost_iron
    if (content === 'gold') return preset.boost_gold
    return preset.boost_diamond
  }

  const handleStart = async () => {
    if (busy || playing || !validBet) {
      playSound('click')
      return
    }
    setError('')
    setBusy(true)
    try {
      const started = await startMines({ uuid: payer.uuid, bet, mines: selectedMines })
      setRound(started)
      setBet(started.bet)
      applySettled(started.balance)
      playSound('open')
    } catch (failure) {
      setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      invalidateServerData('stats')
    } finally {
      setBusy(false)
    }
  }

  const handleReveal = async (cell: number) => {
    if (round === null || !playing || busy || cells.has(cell)) return
    setError('')
    setBusy(true)
    try {
      applyRound(await revealMines(round.round_id, cell), true)
    } catch (failure) {
      setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      invalidateServerData('stats')
    } finally {
      setBusy(false)
    }
  }

  const handleCashOut = async () => {
    if (round === null || !playing || busy || opened < round.min_safe) return
    setError('')
    setBusy(true)
    try {
      applyRound(await cashOutMines(round.round_id), true)
    } catch (failure) {
      setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      invalidateServerData('stats')
    } finally {
      setBusy(false)
    }
  }

  if (restoring) {
    return <p className="loading">Проверяем незакрытый раунд…</p>
  }

  const settled = round !== null && round.status === 'settled'
  const totalCells = rules.mines.cells

  return (
    <div className="mines-game">
      {/* Top Navigation Bar */}
      <div className="chest-top-bar">
        <button
          type="button"
          className="btn btn-quiet chest-back-btn"
          onClick={onBack}
          // Leaving mid-round would abandon a stake that is already taken.
          disabled={playing}
          title={playing ? 'Завершите раунд, чтобы выйти' : undefined}
          data-ui-sound="close"
        >
          ← Все мини-игры
        </button>

        <PayerSelect
          payer={{ ...payer, coins: balance }}
          accounts={accounts.map((account) => (account.uuid === payer.uuid ? { ...account, coins: balance } : account))}
          onChoose={onChoosePayer}
          disabled={playing || busy}
        />

        <button
          type="button"
          className="btn btn-quiet chest-payout-btn"
          onClick={() => setShowPaytable((value) => !value)}
          aria-expanded={showPaytable}
        >
          {showPaytable ? 'Скрыть множители' : 'Коэффициенты руд'}
        </button>
      </div>

      {error !== '' && (
        <div className="casino-error" role="alert">
          {error}
        </div>
      )}

      {/* Main Game Stage Layout */}
      <div className="mines-stage-layout">
        <div className="mines-machine-card">
          {/* Header Info */}
          <div className="chest-machine-header">
            <img src={minesIcon} alt="" className="chest-machine-logo" />
            <div>
              <h2>Сапёр: Шахтёрское поле</h2>
              <p>
                Поле раскладывает сервер: клетки, руды и TNT неизвестны браузеру до открытия. Выигрыш зачисляется на
                баланс Minecraft (<span className="chest-inline-cmd">/bal</span>).
              </p>
            </div>
          </div>

          {/* Current Score / Status Banner */}
          <div className="mines-banner-wrap" aria-live="polite">
            {round === null && (
              <div className="mines-banner-idle">
                <span>
                  Выберите ставку и начните раунд (для кэшаута найдите минимум {rules.mines.min_safe} руды, возврат{' '}
                  {formatReturn(preset.rtp_x10000)})
                </span>
              </div>
            )}
            {playing && opened === 0 && (
              <div className="mines-banner-playing">
                <span>
                  Откройте 1-ю клетку (для кэшаута нужно открыть минимум {round.min_safe} руды)
                </span>
              </div>
            )}
            {playing && opened === 1 && (
              <div className="mines-banner-playing">
                <span>Найдена 1 руда! Откройте 2-ю клетку, чтобы забрать выигрыш</span>
              </div>
            )}
            {playing && opened >= (round?.min_safe ?? rules.mines.min_safe) && (
              <div className="mines-banner-active">
                <span className="mines-active-label">Текущий выигрыш:</span>
                <strong className="mines-active-val">
                  +{formatCoins(round.cashout)} монет
                </strong>
                <span className="mines-active-mult">({formatMultiplier(round.multiplier_x100)})</span>
              </div>
            )}
            {settled && round.payout > 0 && (
              <div className="mines-banner-win">
                <strong>ВЫИГРЫШ ЗАБРАН!</strong>
                <span>
                  +{formatCoins(round.payout)} монет ({formatMultiplier(round.multiplier_x100)})
                </span>
              </div>
            )}
            {settled && round.payout === 0 && (
              <div className="mines-banner-loss">
                <strong>{round.outcome === 'expired' ? 'РАУНД СГОРЕЛ' : 'ВЗРЫВ ДИНАМИТА!'}</strong>
                <span>
                  {round.outcome === 'expired'
                    ? 'Раунд был заброшен, ставка не возвращается.'
                    : `Ставка ${formatCoins(round.bet)} монет сгорела.`}
                </span>
              </div>
            )}
          </div>

          {/* 5x5 Grid Field */}
          <div className="mines-grid-container">
            <div
              className={`mines-grid-field ${playing ? 'in-play' : ''}`}
              role="grid"
              aria-label="Минное поле 5 на 5"
            >
              {Array.from({ length: totalCells }, (_, index) => {
                const content = cells.get(index)
                const isRevealed = content !== undefined
                const isTnt = content === 'tnt'
                const isUncoveredSafe = isRevealed && !isTnt

                let cellClass = 'mines-cell'
                if (!isRevealed) {
                  cellClass += ' covered'
                  if (playing) cellClass += ' clickable'
                } else {
                  cellClass += ' revealed'
                  if (isTnt) {
                    cellClass += ' tnt-triggered'
                  } else {
                    cellClass += ` ore-${content}`
                  }
                }

                return (
                  <button
                    key={index}
                    type="button"
                    className={cellClass}
                    onClick={() => handleReveal(index)}
                    disabled={!playing || isRevealed || busy}
                    aria-label={
                      isRevealed
                        ? isTnt
                          ? 'Динамит'
                          : `Найдено ${ORE_NAMES[content]}`
                        : `Клетка ${index + 1}`
                    }
                  >
                    {!isRevealed && (
                      <div className="mines-cell-face closed">
                        <span className="mines-cell-gem" aria-hidden="true" />
                      </div>
                    )}

                    {isRevealed && isTnt && (
                      <div className="mines-cell-face open tnt">
                        <img src={tntImg} alt="Динамит" className="mines-item-img tnt-img" draggable={false} />
                        <span className="mines-blast-glow" aria-hidden="true" />
                      </div>
                    )}

                    {isUncoveredSafe && (
                      <div className={`mines-cell-face open ${content}`}>
                        <img
                          src={ORE_ICONS[content]}
                          alt={ORE_NAMES[content]}
                          className="mines-item-img ore-img"
                          draggable={false}
                        />
                        <span className="mines-boost-tag">{formatBoost(boostFor(content))}</span>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Action Button: Start or Cash Out */}
          <div className="mines-action-bar">
            {!playing ? (
              <button
                type="button"
                className="btn chest-spin-btn mines-start-btn"
                onClick={handleStart}
                disabled={busy || !validBet}
                data-ui-sound="open"
              >
                <span className="chest-btn-text">
                  {bet < rules.min_bet
                    ? `Минимум ${rules.min_bet} монет`
                    : !canAfford(bet, balance)
                      ? 'Недостаточно монет'
                      : round === null
                        ? 'Начать раунд'
                        : 'Играть снова'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className={`btn chest-spin-btn mines-cashout-btn ${
                  opened >= round.min_safe ? 'active' : 'waiting'
                }`}
                onClick={handleCashOut}
                disabled={busy || opened < round.min_safe}
                data-ui-sound="done"
              >
                <span className="chest-btn-text">
                  {opened >= round.min_safe
                    ? `Забрать ${formatCoins(round.cashout)} монет (${formatMultiplier(round.multiplier_x100)})`
                    : `Откройте ещё ${round.min_safe - opened} ${
                        round.min_safe - opened === 1 ? 'клетку' : 'клетки'
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
                {presets.map((value) => (
                  <button
                    key={value.mines}
                    type="button"
                    className={`btn btn-quiet chest-preset-chip ${selectedMines === value.mines ? 'active' : ''}`}
                    onClick={() => setSelectedMines(value.mines)}
                    disabled={playing || busy}
                    title={`Возврат ${formatReturn(value.rtp_x10000)}`}
                  >
                    {value.mines} TNT ({PRESET_LABELS[value.mines] ?? 'Своё'})
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
                  min={rules.min_bet}
                  max={Math.max(rules.min_bet, Math.min(rules.max_bet, balance))}
                  step={10}
                  value={bet}
                  onChange={(event) => handleBetChange(parseInt(event.target.value, 10) || rules.min_bet)}
                  disabled={playing || busy}
                  className="chest-bet-input"
                />
                <span className="chest-input-currency">монет</span>
              </div>
            </div>

            {/* Bet presets */}
            <div className="chest-presets-row">
              {PRESET_BETS.filter((amount) => amount >= rules.min_bet && amount <= rules.max_bet).map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`btn btn-quiet chest-preset-chip ${bet === amount ? 'active' : ''}`}
                  onClick={() => handleBetChange(amount)}
                  disabled={playing || busy || amount > balance}
                >
                  {amount}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(Math.floor(bet / 2))}
                disabled={playing || busy || bet <= rules.min_bet}
              >
                /2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(bet * 2)}
                disabled={playing || busy || bet * 2 > balance || bet * 2 > rules.max_bet}
              >
                x2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(clampBet(balance, rules.min_bet, rules.max_bet, balance))}
                disabled={playing || busy || balance <= 0}
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
              <h3>
                Коэффициенты ({preset.mines} TNT • Возврат {formatReturn(preset.rtp_x10000)})
              </h3>
              <span className="chest-table-hint">Мин. {rules.mines.min_safe} руды для кэшаута</span>
            </div>
            <div className="chest-table-list">
              {(['iron', 'gold', 'diamond'] as const).map((ore) => (
                <div key={ore} className={`chest-table-row ${ore === 'diamond' ? 'jackpot-row' : ''}`}>
                  <div className="inv-bubble chest-table-bubble">
                    <img src={ORE_ICONS[ore]} alt="" className="chest-table-img" />
                  </div>
                  <div className="chest-table-info">
                    <strong>{ORE_NAMES[ore]}</strong>
                    <span className="chest-table-en">
                      {ore === 'iron' ? 'Iron Ingot' : ore === 'gold' ? 'Gold Ingot' : 'Diamond'}
                    </span>
                  </div>
                  <div className="chest-table-mults">
                    <strong>{formatMultiplier(boostFor(ore))}</strong>
                  </div>
                </div>
              ))}

              <div className="chest-table-row tnt-info-row">
                <div className="inv-bubble chest-table-bubble">
                  <img src={tntImg} alt="" className="chest-table-img" />
                </div>
                <div className="chest-table-info">
                  <strong>Динамит (TNT)</strong>
                  <span className="chest-table-en">{preset.mines} мин на поле • Взрыв</span>
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
            {history.map((entry, index) => (
              <div key={index} className={`chest-hist-pill ${entry.status === 'win' ? 'win' : 'loss'}`}>
                <span className="chest-hist-val">
                  {entry.status === 'win'
                    ? `+${formatCoins(entry.payout)} (${formatMultiplier(entry.multiplier_x100)})`
                    : `-${formatCoins(entry.bet)}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
