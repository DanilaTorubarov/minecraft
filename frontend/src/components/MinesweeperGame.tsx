import { useEffect, useRef, useState } from 'react'
import tnt from '../assets/items/tnt.png'
import iron from '../assets/items/iron_ingot.png'
import gold from '../assets/items/gold_ingot.png'
import diamond from '../assets/items/diamond.png'
import icon from '../assets/icons/game-minesweeper.png'
import PayerSelect from './PayerSelect'
import GameBetControls from './GameBetControls'
import { ApiError, cashOutMines, getMinigameState, revealMines, startMines } from '../lib/api'
import { invalidateServerData } from '../lib/serverData'
import { useStakedBalance } from '../lib/useMinigames'
import { playSound } from '../lib/sounds'
import { ORE_LABELS, clampBet, formatBoost, formatCoins, formatMultiplier, formatReturn, minigameFailure,
  revealedCells, safeCellsOpened, type MinigameRules, type MinesRound, type OreContent, type Payer } from '../lib/minigames'

const ITEMS: Record<OreContent, string> = { tnt, iron, gold, diamond }
const PRESETS: Record<number, string> = { 8: 'Balanced', 10: 'Risky', 13: 'Hard', 16: 'Expert' }

export default function MinesweeperGame({ onBack, payer, accounts, onChoosePayer, rules }: {
  onBack: () => void; payer: Payer; accounts: Payer[]; onChoosePayer: (uuid: string) => void; rules: MinigameRules
}) {
  const [round, setRound] = useState<MinesRound | null>(null)
  const [bet, setBet] = useState(() => clampBet(50, rules.min_bet, rules.max_bet, payer.coins))
  const [mines, setMines] = useState(rules.mines.presets[0].mines)
  const [loading, setLoading] = useState(true)
  const [restoreError, setRestoreError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showTable, setShowTable] = useState(false)
  const [history, setHistory] = useState<MinesRound[]>([])
  const sending = useRef(false)
  const playing = round?.status === 'active'
  const roundAccount = accounts.find((account) => account.uuid === round?.payer_uuid)
  const wallet = playing && round ? roundAccount ?? { uuid: round.payer_uuid, username: 'Unlinked player', coins: round.balance } : payer
  const { balance, applySettled } = useStakedBalance(wallet.uuid, wallet.coins)
  const cells = round ? revealedCells(round) : new Map<number, OreContent>()
  const opened = round ? safeCellsOpened(round) : 0
  const preset = rules.mines.presets.find((value) => value.mines === mines) ?? rules.mines.presets[0]
  const validBet = Number.isSafeInteger(bet) && bet >= rules.min_bet && bet <= rules.max_bet && bet <= balance

  useEffect(() => {
    let active = true
    getMinigameState().then((found) => {
      if (!active) return
      if (found) { setRound(found); setBet(found.bet); setMines(found.mines) }
      setRestoreError('')
    }).catch((failure: unknown) => {
      if (active) setRestoreError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [attempt])

  const act = async (action: () => Promise<MinesRound>) => {
    if (sending.current) return
    sending.current = true; setBusy(true); setError('')
    try {
      const next = await action()
      setRound(next); setBet(next.bet); setMines(next.mines)
      applySettled(next.balance, next.payer_uuid, accounts.find((account) => account.uuid === next.payer_uuid)?.coins ?? next.balance)
      if (accounts.some((account) => account.uuid === next.payer_uuid)) onChoosePayer(next.payer_uuid)
      invalidateServerData('stats')
      if (next.status === 'settled') {
        setHistory((old) => [next, ...old.filter((entry) => entry.round_id !== next.round_id)].slice(0, 5))
        playSound(next.payout > 0 ? 'done' : 'close')
      } else playSound('click')
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 412) window.dispatchEvent(new Event('economy-policy-changed'))
      setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      invalidateServerData('stats')
    } finally { sending.current = false; setBusy(false) }
  }

  const boost = (ore: Exclude<OreContent, 'tnt'>) => preset[`boost_${ore}`]
  const focusCell = (index: number, key: string, container: HTMLElement) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }[key]
    if (offset === undefined) return false
    const target = Math.max(0, Math.min(rules.mines.cells - 1, index + offset))
    container.querySelector<HTMLButtonElement>(`[data-cell="${target}"]`)?.focus()
    return true
  }

  if (loading) return <p className="loading">Checking for an unfinished round…</p>
  if (restoreError) return <div className="note" data-tone="error" role="alert"><p>{restoreError}</p><p>Recover your current round before starting another.</p><button className="btn" onClick={() => { setLoading(true); setAttempt((value) => value + 1) }}>Retry recovery</button><button className="btn btn-quiet" onClick={onBack}>All games</button></div>

  return <div className="minigame-workspace mines-workspace">
    <div className="game-toolbar">
      <button className="btn btn-quiet" onClick={onBack} disabled={busy}>All games</button>
      <PayerSelect payer={{ ...wallet, coins: playing && round ? round.balance : balance }} accounts={roundAccount || !playing ? accounts : [wallet, ...accounts]} onChoose={onChoosePayer} disabled={playing || busy} />
      <button className="btn btn-quiet" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>Ore rewards</button>
    </div>
    <div className="page-head game-heading"><img src={icon} alt="" /><div><h1>Minesweeper</h1><p className="page-sub">Find the ore. Leave the TNT.</p></div></div>
    {error && <p className="note" data-tone="error" role="alert">{error} Retry the same cell or cash-out to recover its result.</p>}
    <div className="game-layout mines-layout">
      <section className="mine-machine" aria-label="Minesweeper game">
        <div className="mine-scoreboard">
          <div><span>TNT</span><strong>{String(round?.mines ?? mines).padStart(2, '0')}</strong></div>
          <div className="mine-center-status"><strong>{playing ? formatMultiplier(round.multiplier_x100) : round ? round.outcome === 'paid' ? 'Cleared' : round.outcome === 'expired' ? 'Expired' : 'TNT hit' : 'Ready'}</strong><span>{playing ? `${opened} ore found` : '5 × 5 minefield'}</span></div>
          <div><span>{playing ? 'Cash-out' : 'Payout'}</span><strong>{formatCoins(playing ? round.cashout : round?.payout ?? 0)}</strong></div>
        </div>
        {round ? <div className="mine-board" role="group" aria-label="5 by 5 minefield. Use arrow keys to move between cells." aria-busy={busy}>
          {Array.from({ length: rules.mines.cells }, (_, index) => {
            const content = cells.get(index)
            const available = playing && !busy && !content
            const name = content === 'tnt' ? 'TNT' : content ? ORE_LABELS[content] : 'Covered'
            return <button key={index} type="button" data-cell={index} className={`mine-cell ${content ? `revealed ${content}` : 'covered'}`}
              aria-disabled={!available} aria-label={`Row ${Math.floor(index / 5) + 1}, column ${index % 5 + 1}: ${name}`}
              onKeyDown={(event) => { if (focusCell(index, event.key, event.currentTarget.parentElement!)) event.preventDefault() }}
              onClick={() => { if (available) void act(() => revealMines(round.round_id, index)) }}>
              {content && <><img src={ITEMS[content]} alt="" draggable={false} />{content !== 'tnt' && <span>{formatBoost(boost(content))}</span>}</>}
            </button>
          })}
        </div> : <div className="mine-ready"><img src={icon} alt="" /><h2>Your field is ready to deal</h2><p>Choose a stake and difficulty, then start. Find {rules.mines.min_safe} ores to unlock cash-out.</p></div>}
        <div className="game-result" role="status">
          {playing ? <p>{opened < round.min_safe ? `Find ${round.min_safe - opened} more ore to unlock cash-out.` : `Cash out ${formatCoins(round.cashout)} coins or open another cell.`}</p>
            : round ? <p>{round.outcome === 'paid' ? `${formatCoins(round.payout)} coins returned to ${roundAccount?.username ?? 'the original payer'}.` : round.outcome === 'expired' ? 'The 15-minute deadline passed. The stake was forfeited.' : `TNT hit. The ${formatCoins(round.bet)}-coin stake was lost.`}</p>
              : <p>TNT ends the round. Clear every safe cell to collect automatically.</p>}
        </div>
        {playing ? <button className="btn btn-primary game-primary" disabled={busy || opened < round.min_safe} onClick={() => { void act(() => cashOutMines(round.round_id)) }}>{busy ? 'Checking…' : `Cash out · ${formatCoins(round.cashout)} coins`}</button>
          : <button className="btn btn-primary game-primary" disabled={busy || !validBet} onClick={() => { void act(() => startMines({ uuid: payer.uuid, bet, mines, economy_level: rules.economy.level })) }}>{busy ? 'Dealing…' : `${round ? 'Play again' : 'Start round'} · ${formatCoins(bet)} coins`}</button>}
      </section>
      <div className="game-options">
        <fieldset className="game-difficulty" disabled={playing || busy}><legend>Difficulty</legend><div>{rules.mines.presets.map((value) => <button key={value.mines} className="btn btn-quiet" aria-pressed={mines === value.mines} onClick={() => setMines(value.mines)}>{PRESETS[value.mines]}<small>{value.mines} TNT</small></button>)}</div></fieldset>
        <GameBetControls id="mines-stake" bet={bet} balance={balance} rules={rules} disabled={playing || busy} onChange={setBet} />
        <p className="game-rules">Expected return at earliest cash-out: {formatReturn(playing && round ? round.rtp_x10000 : preset.rtp_x10000)}. A round expires 15 minutes after it starts. Leaving this page keeps it available until then.</p>
      </div>
    </div>
    {!playing && <p className="game-rules">For new fields: {preset.ore_adjustment === 'none' ? 'standard ore distribution' : `${formatReturn(preset.ore_adjustment_chance_x10000)} chance to replace one ${preset.ore_adjustment === 'iron_to_gold' ? 'iron with gold' : 'gold with iron'}`}. TNT count and ore rewards stay as shown. Each field keeps its dealt rules.</p>}
    {showTable && <section className="game-paytable"><h2>Ore rewards · {preset.mines} TNT</h2><p className="page-sub">Each ore adds to your multiplier. Find at least {rules.mines.min_safe} ores before cashing out.</p><table><thead><tr><th>Find</th><th>Reward</th></tr></thead><tbody>
      {(['iron', 'gold', 'diamond'] as const).map((ore) => <tr key={ore}><th><img src={ITEMS[ore]} alt="" />{ORE_LABELS[ore]}</th><td>{formatBoost(boost(ore))}</td></tr>)}
      <tr><th><img src={tnt} alt="" />TNT</th><td>Stake lost</td></tr>
    </tbody></table></section>}
    {history.length > 0 && <section className="game-history"><h2>Recent rounds</h2><ul className="rows">{history.map((entry) => <li className="row" key={entry.round_id}><span>Stake: {formatCoins(entry.bet)} · {entry.mines} TNT</span><strong>{formatCoins(entry.payout)} returned</strong></li>)}</ul></section>}
  </div>
}
