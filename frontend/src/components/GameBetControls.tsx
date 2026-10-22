import { clampBet, type MinigameRules } from '../lib/minigames'

export default function GameBetControls({ id, bet, balance, rules, disabled, onChange }: {
  id: string; bet: number; balance: number; rules: MinigameRules; disabled: boolean; onChange: (bet: number) => void
}) {
  const set = (value: number) => onChange(clampBet(value, rules.min_bet, rules.max_bet, balance))
  return <fieldset className="game-stake" disabled={disabled}>
    <div className="field"><label htmlFor={id}>Stake <span className="muted">(coins)</span></label>
    <input id={id} type="number" min={rules.min_bet} max={rules.max_bet} step="1" value={bet} aria-invalid={bet < rules.min_bet || bet > rules.max_bet || bet > balance} aria-describedby={`${id}-hint`}
      onChange={(event) => onChange(Number.isFinite(event.target.valueAsNumber) ? Math.max(0, Math.floor(event.target.valueAsNumber)) : 0)} /></div>
    <div className="game-stake-presets" aria-label="Quick stakes">
      {[10, 50, 100, 250, 500].filter((value) => value >= rules.min_bet && value <= rules.max_bet).map((value) =>
        <button className="btn btn-quiet" type="button" key={value} disabled={value > balance} aria-pressed={bet === value} onClick={() => onChange(value)}>{value}</button>)}
      <button className="btn btn-quiet" type="button" onClick={() => set(bet / 2)} disabled={bet <= rules.min_bet}>Half</button>
      <button className="btn btn-quiet" type="button" onClick={() => set(bet * 2)} disabled={bet * 2 > balance || bet * 2 > rules.max_bet}>Double</button>
      <button className="btn btn-quiet" type="button" onClick={() => set(balance)} disabled={balance < rules.min_bet}>Max</button>
    </div>
    <small id={`${id}-hint`} className="muted">{bet < rules.min_bet ? `Minimum stake: ${rules.min_bet} coins.` : bet > rules.max_bet ? `Maximum stake: ${rules.max_bet.toLocaleString()} coins.` : bet > balance ? 'Not enough Web Bank coins. Deposit coins from your player pocket.' : `${rules.min_bet.toLocaleString()}–${rules.max_bet.toLocaleString()} coins per round. Staked from your Web Bank.`}</small>
  </fieldset>
}
