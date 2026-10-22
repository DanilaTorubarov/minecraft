import { useEffect, useRef, useState } from 'react'
import diamond from '../assets/items/diamond.png'
import heart from '../assets/items/heart_of_the_sea.png'
import trident from '../assets/items/trident.png'
import shell from '../assets/items/nautilus_shell.png'
import crystals from '../assets/items/prismarine_crystals.png'
import shard from '../assets/items/prismarine_shard.png'
import pufferfish from '../assets/items/pufferfish.png'
import fish from '../assets/items/tropical_fish.png'
import icon from '../assets/icons/game-lucky-chest.png'
import PayerSelect from './PayerSelect'
import GameBetControls from './GameBetControls'
import { ApiError, spinChest } from '../lib/api'
import { readChestRequest, writeChestRequest, type ChestRequest } from '../lib/chestRetry'
import { invalidateServerData } from '../lib/serverData'
import { useStakedBalance } from '../lib/useMinigames'
import { playSound } from '../lib/sounds'
import { CHEST_LABELS, clampBet, formatCoins, formatMultiplier, formatReturn, minigameFailure, newClientId, wait,
  type ChestSpin, type MinigameRules, type Payer } from '../lib/minigames'

const ITEMS: Record<string, string> = { diamond, heart_of_the_sea: heart, trident, nautilus_shell: shell,
  prismarine_crystals: crystals, prismarine_shard: shard, pufferfish, tropical_fish: fish }

/** The moving strip contains whole bubbles. Its last bubble is the server's result. */
function BubbleReel({ symbol, phase, index }: { symbol: string; phase: 'idle' | 'spinning' | 'settling'; index: number }) {
  const track = useRef<HTMLDivElement>(null)
  const motion = useRef<Animation | null>(null)
  const sequence = [...Object.keys(ITEMS), ...Object.keys(ITEMS), ...Object.keys(ITEMS), symbol]
  useEffect(() => {
    const element = track.current
    if (!element) return
    const step = element.firstElementChild?.getBoundingClientRect().height ?? 100
    const from = getComputedStyle(element).transform
    motion.current?.cancel()
    const end = `translateY(${-24 * step}px)`
    if (phase === 'idle' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.style.transform = end
      return
    }
    const animation = phase === 'spinning'
      ? element.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-8 * step}px)` }], { duration: 650, iterations: 12, fill: 'forwards' })
      : element.animate([{ transform: from === 'none' ? 'translateY(0)' : from }, { transform: end }], { duration: 1050 + index * 240, easing: 'cubic-bezier(.12,.65,.2,1)', fill: 'forwards' })
    motion.current = animation
    if (document.hidden || element.closest('[hidden]')) animation.pause()
  }, [phase, symbol, index])
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (phase === 'idle' && track.current) {
        const step = track.current.firstElementChild?.getBoundingClientRect().height ?? 100
        track.current.style.transform = `translateY(${-24 * step}px)`
      }
    })
    if (track.current?.parentElement) observer.observe(track.current.parentElement)
    return () => observer.disconnect()
  }, [phase])
  useEffect(() => {
    const visibility = () => {
      if (document.hidden || track.current?.closest('[hidden]')) motion.current?.pause()
      else if (motion.current?.playState === 'paused') motion.current.play()
    }
    const window = track.current?.closest('.desktop-window')
    const observer = new MutationObserver(visibility)
    if (window) observer.observe(window, { attributes: true, attributeFilter: ['hidden'] })
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    const reduce = () => {
      if (preference.matches && track.current) {
        motion.current?.cancel()
        const step = track.current.firstElementChild?.getBoundingClientRect().height ?? 100
        track.current.style.transform = `translateY(${-24 * step}px)`
      }
    }
    preference.addEventListener('change', reduce)
    document.addEventListener('visibilitychange', visibility)
    return () => { observer.disconnect(); preference.removeEventListener('change', reduce); document.removeEventListener('visibilitychange', visibility); motion.current?.cancel() }
  }, [])
  return <div className="slot-reel" role="img" aria-label={phase === 'spinning' ? `Reel ${index + 1} spinning` : `Reel ${index + 1}: ${CHEST_LABELS[symbol]}`}>
    <div className="slot-track" ref={track} aria-hidden="true">
      {sequence.map((item, position) => <div className="slot-row" key={position}>
        <div className="inv-bubble slot-bubble"><img src={ITEMS[item]} alt="" draggable={false} /></div>
      </div>)}
    </div>
  </div>
}

function tabStorage(): Storage | null { try { return sessionStorage } catch { return null } }

export default function LuckyChestGame({ onBack, payer, accounts, onChoosePayer, rules, userId, bankCoins }: {
  onBack: () => void; payer: Payer; accounts: Payer[]; onChoosePayer: (uuid: string) => void; rules: MinigameRules; userId: number; bankCoins: number
}) {
  const requestKey = `minecraft-chest-pending:${userId}`
  const [pending, setPending] = useState<ChestRequest | null>(() => readChestRequest(tabStorage(), requestKey))
  const [bet, setBet] = useState(() => clampBet(50, rules.min_bet, rules.max_bet, bankCoins))
  const [phase, setPhase] = useState<'idle' | 'spinning' | 'settling'>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<(ChestSpin & { payerName: string }) | null>(null)
  const [history, setHistory] = useState<ChestSpin[]>([])
  const [symbols, setSymbols] = useState(['diamond', 'heart_of_the_sea', 'trident'])
  const [showTable, setShowTable] = useState(false)
  const mounted = useRef(false)
  const sending = useRef(false)
  const selectedPayer = pending ? accounts.find((account) => account.uuid === pending.uuid) ?? payer : payer
  const { balance, applySettled } = useStakedBalance('bank', bankCoins)
  const busy = phase !== 'idle'
  const validBet = Number.isSafeInteger(bet) && bet >= rules.min_bet && bet <= rules.max_bet && bet <= balance
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const spin = async () => {
    if (sending.current || busy || (!pending && !validBet)) return
    sending.current = true
    const request = pending ?? { uuid: payer.uuid, bet, economy_level: rules.economy.level, client_id: newClientId() }
    setPending(request)
    writeChestRequest(tabStorage(), requestKey, request)
    setError(''); setResult(null); setPhase('spinning')
    try {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      // Fast replies still get a full bubble cycle before the reels decelerate.
      const [next] = await Promise.all([spinChest(request), wait(reduced ? 0 : 650)])
      // Resolve storage even if the window was unmounted while awaiting HTTP.
      writeChestRequest(tabStorage(), requestKey, null)
      invalidateServerData('stats')
      if (!mounted.current) return
      setPending(null)
      const paidAccount = accounts.find((account) => account.uuid === request.uuid)
      if (paidAccount) { onChoosePayer(request.uuid) }
      applySettled(next.balance, 'bank', bankCoins)
      setSymbols(next.reels)
      setPhase('settling')
      if (!reduced) await wait(1600)
      if (!mounted.current) return
      setResult({ ...next, payerName: paidAccount?.username ?? 'Web Bank' }); setHistory((old) => [next, ...old.slice(0, 4)])
      playSound(next.payout > 0 ? 'done' : 'click')
    } catch (failure) {
      if (!mounted.current) return
      const status = failure instanceof ApiError ? failure.status : 0
      // Only a definitive validation/balance refusal permits a fresh stake.
      if (status === 400 || status === 409 || status === 412) {
        setPending(null); writeChestRequest(tabStorage(), requestKey, null)
      }
      if (status === 412) window.dispatchEvent(new Event('economy-policy-changed'))
      setError(minigameFailure(status).message)
      invalidateServerData('stats')
    } finally {
      sending.current = false
      if (mounted.current) setPhase('idle')
    }
  }

  return <div className="minigame-workspace">
    <div className="game-toolbar">
      <button className="btn btn-quiet" onClick={onBack} disabled={busy}>All games</button>
      <div className="chest-balance-pill casino-payer-pill" title="Web Bank Balance">
        <span style={{ fontSize: '0.85em', opacity: 0.8 }}>Bank:</span>
        <span className="chest-balance-num">{formatCoins(balance)}</span>
        <span className="chest-balance-label">coins</span>
      </div>
      {pending && !accounts.some((account) => account.uuid === pending.uuid) ? <span>Recovering a spin for an unlinked player</span> : <PayerSelect payer={selectedPayer} accounts={accounts} onChoose={onChoosePayer} disabled={busy || pending !== null} />}
      <button className="btn btn-quiet" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>Paytable</button>
    </div>
    <div className="page-head game-heading"><img src={icon} alt="" /><div><h1>Lucky Chest</h1><p className="page-sub">Three bubbles. A little ocean luck.</p></div></div>
    {error && <p className="note" data-tone="error" role="alert">{error}</p>}
    {pending && !busy && <p className="note">A spin for {accounts.find((account) => account.uuid === pending.uuid)?.username ?? 'your previously selected player'} is unresolved. Recover it below before placing another stake.</p>}
    <div className="game-layout">
      <section className="slot-machine" aria-label="Lucky Chest reels">
        <div className="slot-reels" aria-busy={busy}>
          {symbols.map((symbol, index) => <BubbleReel key={index} symbol={symbol} index={index} phase={phase} />)}
        </div>
        <div className="game-result" role="status">
          {busy ? <p>{phase === 'spinning' ? 'Opening your chest…' : 'Finding your treasures…'}</p>
            : result ? <><strong>{result.payout > 0 ? 'Treasure found' : 'No winning combination'}</strong><p>{result.payout > 0 ? `${formatCoins(result.payout)} coins credited to Web Bank · ${formatMultiplier(result.multiplier_x100)}` : `Stake: ${formatCoins(result.bet)} coins from Web Bank. No payout this time.`}</p></>
              : <p>Match a pair or three of a kind. A lone diamond pays too.</p>}
        </div>
        <button className="btn btn-primary game-primary" disabled={busy || (!pending && !validBet)} onClick={() => { void spin() }}>
          {busy ? 'Opening…' : pending ? 'Recover spin' : `Open chest · ${formatCoins(bet)} coins`}
        </button>
      </section>
      <div className="game-options">
        <GameBetControls id="chest-stake" bet={bet} balance={balance} rules={rules} disabled={busy || pending !== null} onChange={setBet} />
        <p className="game-rules">Expected return: {formatReturn(rules.chest.rtp_x10000)} over many rounds. Each spin is independent; a win is never guaranteed.</p>
      </div>
    </div>
    {showTable && <section className="game-paytable"><h2>Paytable</h2><p className="page-sub">Multipliers include the stake. Any pair counts, wherever it lands.</p>
      <table><thead><tr><th>Treasure</th><th>Three alike</th><th>Pair</th></tr></thead><tbody>
        {rules.chest.symbols.map((item) => <tr key={item.id}><th><img src={ITEMS[item.id]} alt="" />{CHEST_LABELS[item.id]}</th><td>{formatMultiplier(item.triple_x100)}</td><td>{formatMultiplier(item.pair_x100)}</td></tr>)}
        <tr><th>One diamond</th><td colSpan={2}>{formatMultiplier(rules.chest.single_diamond_x100)}</td></tr>
      </tbody></table>
    </section>}
    {history.length > 0 && <section className="game-history"><h2>Recent spins</h2><ul className="rows">{history.map((entry) => <li className="row" key={entry.round_id}>
      <span>{entry.reels.map((item) => CHEST_LABELS[item]).join(' · ')}</span><strong>{formatCoins(entry.payout)} returned</strong>
    </li>)}</ul></section>}
  </div>
}
