import { useEffect, useRef, useState } from 'react'
import diamondImg from '../assets/items/diamond.png'
import heartImg from '../assets/items/heart_of_the_sea.png'
import tridentImg from '../assets/items/trident.png'
import nautilusImg from '../assets/items/nautilus_shell.png'
import crystalsImg from '../assets/items/prismarine_crystals.png'
import shardImg from '../assets/items/prismarine_shard.png'
import pufferImg from '../assets/items/pufferfish.png'
import fishImg from '../assets/items/tropical_fish.png'
import chestIcon from '../assets/icons/game-lucky-chest.png'
import PayerSelect from './PayerSelect'
import { ApiError, spinChest } from '../lib/api'
import { invalidateServerData } from '../lib/serverData'
import { useStakedBalance } from '../lib/useMinigames'
import { playSound } from '../lib/sounds'
import {
  CHEST_LABELS,
  canAfford,
  clampBet,
  formatCoins,
  formatMultiplier,
  formatReturn,
  minigameFailure,
  newClientId,
  wait,
  type ChestSpin,
  type MinigameRules,
  type Payer,
} from '../lib/minigames'

/** Every symbol the server can land, drawn from the official item textures. */
const SYMBOL_ICONS: Record<string, string> = {
  diamond: diamondImg,
  heart_of_the_sea: heartImg,
  trident: tridentImg,
  nautilus_shell: nautilusImg,
  prismarine_crystals: crystalsImg,
  prismarine_shard: shardImg,
  pufferfish: pufferImg,
  tropical_fish: fishImg,
}

const PRESET_BETS = [10, 50, 100, 250, 500]

type Props = {
  onBack: () => void
  payer: Payer
  accounts: Payer[]
  onChoosePayer: (uuid: string) => void
  rules: MinigameRules
}

function winType(spin: ChestSpin): 'jackpot' | 'big' | 'regular' {
  const [first, second, third] = spin.reels
  if (first === second && second === third) {
    return first === 'diamond' ? 'jackpot' : 'big'
  }
  return 'regular'
}

// One slot bubble. While the server is answering, the reel is already turning; the
// symbols it settles on are the ones the server paid for.
function BubbleSlot({
  symbol,
  isSpinning,
  isSettling,
  isWinning,
}: {
  symbol: string
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
  const label = CHEST_LABELS[symbol]?.ru ?? symbol
  const icon = SYMBOL_ICONS[symbol] ?? diamondImg
  return (
    <div className={bubbleClasses} role="img" aria-label={`Слот: ${label}`}>
      <div className="chest-reel-viewport">
        {isSpinning ? (
          <div className="chest-reel-strip spinning" aria-hidden="true">
            {Object.entries(SYMBOL_ICONS)
              .slice(0, 4)
              .map(([id, src]) => (
                <img key={id} src={src} alt="" className="chest-item-img" draggable={false} />
              ))}
            {Object.entries(SYMBOL_ICONS)
              .slice(0, 4)
              .map(([id, src]) => (
                <img key={`dup-${id}`} src={src} alt="" className="chest-item-img" draggable={false} />
              ))}
          </div>
        ) : (
          <div className={`chest-reel-strip ${isSettling ? 'settled' : ''}`}>
            <img src={icon} alt={label} className="chest-item-img" draggable={false} />
          </div>
        )}
      </div>
    </div>
  )
}

export default function LuckyChestGame({ onBack, payer, accounts, onChoosePayer, rules }: Props) {
  const { balance, applySettled } = useStakedBalance(payer.uuid, payer.coins)
  const [bet, setBet] = useState(() => clampBet(50, rules.min_bet, rules.max_bet, payer.coins))
  const [isSpinning, setIsSpinning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [symbols, setSymbols] = useState<[string, string, string]>(['diamond', 'heart_of_the_sea', 'trident'])
  const [reelSpinning, setReelSpinning] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [reelSettling, setReelSettling] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [lastResult, setLastResult] = useState<ChestSpin | null>(null)
  const [history, setHistory] = useState<ChestSpin[]>([])
  const [showTable, setShowTable] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A stake the payer cannot cover is never sent, and never silently rewritten:
  // the window says so and disables play instead.
  const validBet = bet >= rules.min_bet && bet <= rules.max_bet && canAfford(bet, balance)
  const canSpin = !busy && !isSpinning && validBet

  const handleBetChange = (value: number) => {
    if (isSpinning) return
    setBet(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  }

  const handleSpin = async () => {
    if (isSpinning || !canSpin) {
      playSound('click')
      return
    }
    setError('')
    setBusy(true)
    setIsSpinning(true)
    setLastResult(null)
    setReelSpinning([true, true, true])
    setReelSettling([false, false, false])
    playSound('open')
    try {
      // The whole round — stake, roll and payout — is settled by this one request.
      const result = await spinChest({ uuid: payer.uuid, bet, client_id: newClientId() })
      applySettled(result.balance)
      // The reels only catch up to an outcome that is already final.
      await wait(900)
      if (!mounted.current) return
      setSymbols((previous) => [result.reels[0], previous[1], previous[2]])
      setReelSpinning([false, true, true])
      setReelSettling([true, false, false])
      playSound('click')
      await wait(500)
      if (!mounted.current) return
      setSymbols((previous) => [result.reels[0], result.reels[1], previous[2]])
      setReelSpinning([false, false, true])
      setReelSettling([true, true, false])
      playSound('click')
      await wait(500)
      if (!mounted.current) return
      setSymbols([result.reels[0], result.reels[1], result.reels[2]])
      setReelSpinning([false, false, false])
      setReelSettling([true, true, true])
      setIsSpinning(false)
      setLastResult(result)
      setHistory((previous) => [result, ...previous.slice(0, 4)])
      playSound(result.payout > 0 ? 'done' : 'click')
      invalidateServerData('stats')
      await wait(450)
      if (!mounted.current) return
      setReelSettling([false, false, false])
    } catch (failure) {
      if (!mounted.current) return
      setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      setIsSpinning(false)
      setReelSpinning([false, false, false])
      setReelSettling([false, false, false])
      // A response can be lost after the spin was charged, so re-read the real balance.
      invalidateServerData('stats')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const chest = rules.chest

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

        <PayerSelect
          payer={{ ...payer, coins: balance }}
          accounts={accounts.map((account) => (account.uuid === payer.uuid ? { ...account, coins: balance } : account))}
          onChoose={onChoosePayer}
          disabled={isSpinning}
        />

        <button
          type="button"
          className="btn btn-quiet chest-payout-btn"
          onClick={() => setShowTable((value) => !value)}
          aria-expanded={showTable}
        >
          {showTable ? 'Скрыть таблицу' : 'Таблица выплат'}
        </button>
      </div>

      {error !== '' && (
        <div className="casino-error" role="alert">
          {error}
        </div>
      )}

      {/* Main Game Stage */}
      <div className="chest-stage-layout">
        <div className="chest-machine-card">
          <div className="chest-machine-header">
            <img src={chestIcon} alt="" className="chest-machine-logo" />
            <div>
              <h2>Сундук удачи</h2>
              <p>
                Морские сокровища Minecraft. Комбинация и выплата считаются на сервере, а монеты — тот же баланс,
                что и в игре (<span className="chest-inline-cmd">/bal</span>).
              </p>
            </div>
          </div>

          {/* 3 Bubble Slots */}
          <div className="chest-bubbles-row">
            {symbols.map((symbol, index) => {
              const isWinning =
                lastResult !== null &&
                lastResult.payout > 0 &&
                (lastResult.reels.filter((reel) => reel === symbol).length >= 2 ||
                  (symbol === 'diamond' && lastResult.multiplier_x100 > 0))
              return (
                <div key={index} className="chest-slot-column">
                  <BubbleSlot
                    symbol={symbol}
                    isSpinning={reelSpinning[index]}
                    isSettling={reelSettling[index]}
                    isWinning={isWinning}
                  />
                </div>
              )
            })}
          </div>

          {/* Outcome Announcement */}
          <div className="chest-outcome-banner" aria-live="polite">
            {isSpinning && <span className="chest-outcome-status spinning">Сундук открывается...</span>}
            {!isSpinning && lastResult && lastResult.payout > 0 && (
              <div className={`chest-win-notice ${winType(lastResult)}`}>
                <strong>
                  {winType(lastResult) === 'jackpot'
                    ? 'АЛМАЗНЫЙ ДЖЕКПОТ!'
                    : winType(lastResult) === 'big'
                      ? 'КРУПНЫЙ ВЫИГРЫШ!'
                      : 'ВЫИГРЫШ!'}
                </strong>{' '}
                <span>
                  +{formatCoins(lastResult.payout)} монет ({formatMultiplier(lastResult.multiplier_x100)})
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
                  min={rules.min_bet}
                  max={Math.max(rules.min_bet, Math.min(rules.max_bet, balance))}
                  step={10}
                  value={bet}
                  onChange={(event) => handleBetChange(parseInt(event.target.value, 10) || rules.min_bet)}
                  disabled={isSpinning}
                  className="chest-bet-input"
                />
                <span className="chest-input-currency">монет</span>
              </div>
            </div>

            {/* Quick Bet Buttons */}
            <div className="chest-presets-row">
              {PRESET_BETS.filter((amount) => amount >= rules.min_bet && amount <= rules.max_bet).map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`btn btn-quiet chest-preset-chip ${bet === amount ? 'active' : ''}`}
                  onClick={() => handleBetChange(amount)}
                  disabled={isSpinning || amount > balance}
                >
                  {amount}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(Math.floor(bet / 2))}
                disabled={isSpinning || bet <= rules.min_bet}
              >
                /2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(bet * 2)}
                disabled={isSpinning || bet * 2 > balance || bet * 2 > rules.max_bet}
              >
                x2
              </button>
              <button
                type="button"
                className="btn btn-quiet chest-preset-chip"
                onClick={() => handleBetChange(clampBet(balance, rules.min_bet, rules.max_bet, balance))}
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
              disabled={!canSpin}
              data-ui-sound="open"
            >
              <span className="chest-btn-glow" aria-hidden="true" />
              <span className="chest-btn-text">
                {isSpinning
                  ? 'Крутим...'
                  : bet < rules.min_bet
                    ? `Минимум ${rules.min_bet} монет`
                    : !canAfford(bet, balance)
                      ? 'Недостаточно монет'
                      : 'Открыть сундук'}
              </span>
            </button>
          </div>
        </div>

        {/* Payout Multiplier Table */}
        {showTable && (
          <aside className="chest-table-card" aria-label="Таблица выплат">
            <div className="chest-table-header">
              <h3>Коэффициенты выплат</h3>
              <span className="chest-table-hint">
                3 в ряд / 2 в ряд · тройка {formatReturn(chest.triple_chance_x10000)} · возврат{' '}
                {formatReturn(chest.rtp_x10000)}
              </span>
            </div>
            <div className="chest-table-list">
              {chest.symbols.map((symbol) => (
                <div
                  key={symbol.id}
                  className={`chest-table-row ${symbol.id === 'diamond' ? 'jackpot-row' : ''}`}
                >
                  <div className="inv-bubble chest-table-bubble">
                    <img src={SYMBOL_ICONS[symbol.id] ?? diamondImg} alt="" className="chest-table-img" />
                  </div>
                  <div className="chest-table-info">
                    <strong>{CHEST_LABELS[symbol.id]?.ru ?? symbol.id}</strong>
                    <span className="chest-table-en">{CHEST_LABELS[symbol.id]?.en ?? symbol.id}</span>
                  </div>
                  <div className="chest-table-mults">
                    <span className="mult-3">
                      3x = <strong>{formatMultiplier(symbol.triple_x100)}</strong>
                    </span>
                    <span className="mult-2">
                      2x = <strong>{formatMultiplier(symbol.pair_x100)}</strong>
                    </span>
                  </div>
                </div>
              ))}
              <div className="chest-table-row">
                <div className="inv-bubble chest-table-bubble">
                  <img src={diamondImg} alt="" className="chest-table-img" />
                </div>
                <div className="chest-table-info">
                  <strong>Один алмаз</strong>
                  <span className="chest-table-en">Lone Diamond</span>
                </div>
                <div className="chest-table-mults">
                  <span className="mult-1">
                    1x = <strong>{formatMultiplier(chest.single_diamond_x100)}</strong>
                  </span>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* History of recent spins */}
      {history.length > 0 && (
        <div className="chest-history-section">
          <h4>История последних открытий:</h4>
          <div className="chest-history-pills">
            {history.map((spin) => (
              <div key={spin.round_id} className={`chest-hist-pill ${spin.payout > 0 ? 'win' : 'loss'}`}>
                <div className="chest-hist-icons">
                  {spin.reels.map((symbol, index) => (
                    <img
                      key={index}
                      src={SYMBOL_ICONS[symbol] ?? diamondImg}
                      alt={CHEST_LABELS[symbol]?.ru ?? symbol}
                      className="chest-hist-icon"
                    />
                  ))}
                </div>
                <span className="chest-hist-val">
                  {spin.payout > 0 ? `+${formatCoins(spin.payout)}` : `-${formatCoins(spin.bet)}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
