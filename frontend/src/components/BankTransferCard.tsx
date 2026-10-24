import { useState } from 'react'
import { ApiError, depositBank, withdrawBank, sharedMessage, type StatsAccount } from '../lib/api'
import { invalidateServerData } from '../lib/serverData'
import { playSound } from '../lib/sounds'
import { formatCoins } from '../lib/minigames'
import { displayPlayerName } from '../lib/playerName'

interface BankTransferCardProps {
  accounts: StatsAccount[]
  bankCoins: number
  compact?: boolean
}

export default function BankTransferCard({ accounts, bankCoins, compact = false }: BankTransferCardProps) {
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')
  const [selectedUuid, setSelectedUuid] = useState<string>(() => accounts[0]?.uuid ?? '')
  const [amountStr, setAmountStr] = useState<string>('100')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const activeAccount = accounts.find((a) => a.uuid === selectedUuid) ?? accounts[0]
  const currentPocket = activeAccount?.coins ?? 0
  const parsedAmount = Math.max(0, parseInt(amountStr || '0', 10))

  const maxAvailable = mode === 'deposit' ? currentPocket : bankCoins
  const canSubmit = !busy && activeAccount && parsedAmount > 0 && parsedAmount <= maxAvailable

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !activeAccount) return

    setBusy(true)
    setError('')
    setSuccess('')

    try {
      if (mode === 'deposit') {
        const res = await depositBank(activeAccount.uuid, parsedAmount)
        setSuccess(`Deposited ${formatCoins(parsedAmount)} coins to your Web Bank! Pocket: ${formatCoins(res.pocket_coins)}, Bank: ${formatCoins(res.bank_coins)}`)
      } else {
        const res = await withdrawBank(activeAccount.uuid, parsedAmount)
        setSuccess(`Withdrew ${formatCoins(parsedAmount)} coins to ${displayPlayerName(activeAccount.username)}'s pocket! Pocket: ${formatCoins(res.pocket_coins)}, Bank: ${formatCoins(res.bank_coins)}`)
      }
      playSound('done')
      invalidateServerData('stats')
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError(mode === 'deposit' ? 'Insufficient pocket coins on this player.' : 'Insufficient web bank balance.')
        } else {
          setError(sharedMessage(err.status) ?? 'Transfer failed. Please try again.')
        }
      } else {
        setError('Transfer failed. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const setQuickAmount = (val: number) => {
    const clamped = Math.min(val, maxAvailable)
    setAmountStr(clamped.toString())
  }

  if (accounts.length === 0) {
    return (
      <div className="panel" style={{ padding: '16px', borderRadius: '8px' }}>
        <p className="muted" style={{ margin: 0 }}>
          Link a Minecraft account to deposit or withdraw coins between your player pocket and web bank.
        </p>
      </div>
    )
  }

  return (
    <div className="bank-transfer-card panel" style={{ padding: compact ? '14px' : '20px', borderRadius: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div>
          <span style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted, #666)' }}>
            Web Bank Balance
          </span>
          <div style={{ fontSize: compact ? '1.5rem' : '2rem', fontWeight: 'bold', color: 'var(--primary, #0066cc)' }}>
            {formatCoins(bankCoins)} <span style={{ fontSize: '1rem', fontWeight: 'normal', color: 'var(--fg, inherit)' }}>coins</span>
          </div>
        </div>

        <div className="btn-row" style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className={`btn ${mode === 'deposit' ? 'btn-primary' : 'btn-quiet'}`}
            onClick={() => { setMode('deposit'); setError(''); setSuccess('') }}
            disabled={busy}
          >
            Deposit to Bank
          </button>
          <button
            type="button"
            className={`btn ${mode === 'withdraw' ? 'btn-primary' : 'btn-quiet'}`}
            onClick={() => { setMode('withdraw'); setError(''); setSuccess('') }}
            disabled={busy}
          >
            Withdraw to Pocket
          </button>
        </div>
      </div>

      <p className="page-sub" style={{ fontSize: '0.88rem', margin: '0 0 16px 0', opacity: 0.85 }}>
        {mode === 'deposit'
          ? 'Transfer coins from your linked Minecraft player into your Web Bank for Minigames.'
          : 'Transfer your Web Bank winnings back to your linked Minecraft player for in-game spending.'}
      </p>

      {error && <div className="note" data-tone="error" role="alert" style={{ marginBottom: 12 }}><p>{error}</p></div>}
      {success && <div className="note" style={{ marginBottom: 12, borderColor: 'var(--success, #28a745)' }}><p>{success}</p></div>}

      <form onSubmit={handleTransfer} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div className="field">
            <label htmlFor="bank-player-select" style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>
              Minecraft Player
            </label>
            <select
              id="bank-player-select"
              value={activeAccount?.uuid ?? ''}
              onChange={(e) => setSelectedUuid(e.target.value)}
              disabled={busy}
              style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border, #ccc)', background: 'var(--bg, #fff)', color: 'inherit' }}
            >
              {accounts.map((acc) => (
                <option key={acc.uuid} value={acc.uuid}>
                  {displayPlayerName(acc.username)} ({formatCoins(acc.coins)} pocket coins)
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="bank-amount-input" style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>
              Amount <span className="muted">(Max: {formatCoins(maxAvailable)})</span>
            </label>
            <input
              id="bank-amount-input"
              type="number"
              min="1"
              max={maxAvailable}
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              disabled={busy}
              style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border, #ccc)', background: 'var(--bg, #fff)', color: 'inherit' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div className="quick-amounts" style={{ display: 'flex', gap: 6 }}>
            {[100, 500, 1000].map((amt) => (
              <button
                key={amt}
                type="button"
                className="btn btn-quiet"
                onClick={() => setQuickAmount(amt)}
                disabled={busy || maxAvailable < amt}
                style={{ padding: '4px 10px', fontSize: '0.85rem' }}
              >
                +{amt}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setQuickAmount(maxAvailable)}
              disabled={busy || maxAvailable <= 0}
              style={{ padding: '4px 10px', fontSize: '0.85rem' }}
            >
              All ({formatCoins(maxAvailable)})
            </button>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit}
            style={{ minWidth: '140px' }}
          >
            {busy ? 'Processing…' : mode === 'deposit' ? `Deposit ${formatCoins(parsedAmount)} Coins` : `Withdraw ${formatCoins(parsedAmount)} Coins`}
          </button>
        </div>
      </form>
    </div>
  )
}
