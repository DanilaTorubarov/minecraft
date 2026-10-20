import { useEffect, useState } from 'react'
import {
  adjustAdminBalance,
  getAdminAccounts,
  type AdminAccount,
} from '../lib/api'
import { invalidateServerData } from '../lib/serverData'
import { playSound } from '../lib/sounds'
import firewallOnIcon from '../assets/icons/vista-firewall-on.png'
import coinIcon from '../assets/icons/coin.png'

interface Props {
  visible: boolean
}

type Operation = 'set' | 'add' | 'subtract'

export default function AdminPage({ visible }: Props) {
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [selectedUuid, setSelectedUuid] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Custom amount form
  const [operation, setOperation] = useState<Operation>('set')
  const [amountInput, setAmountInput] = useState<string>('')

  useEffect(() => {
    if (!visible) return
    let active = true
    const load = async () => {
      try {
        const data = await getAdminAccounts()
        if (active) {
          setAccounts(data)
          setError('')
          setLoading(false)
          setSelectedUuid((current) => {
            if (current && data.some((a) => a.uuid === current)) return current
            const selfAcc = data.find((a) => a.is_self)
            return selfAcc ? selfAcc.uuid : (data[0]?.uuid ?? '')
          })
        }
      } catch {
        if (active) {
          setError('Could not load accounts. Ensure you have administrator privileges.')
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [visible])

  const selectedAccount = accounts.find((a) => a.uuid === selectedUuid)

  const handleApply = async (op: Operation, amount: number) => {
    if (!selectedAccount) return
    if (isNaN(amount) || amount < 0) {
      setError('Please enter a valid positive number.')
      return
    }

    setSubmitting(true)
    setError('')
    setSuccessMessage('')
    try {
      playSound('click')
      const res = await adjustAdminBalance({
        uuid: selectedAccount.uuid,
        operation: op,
        amount,
      })

      playSound('done')
      const delta = res.new_coins - res.previous_coins
      const deltaFormatted = delta >= 0 ? `+${delta.toLocaleString()}` : `${delta.toLocaleString()}`
      setSuccessMessage(
        `Balance for ${res.username} successfully updated to ${res.new_coins.toLocaleString()} coins (${deltaFormatted} coins).`
      )
      setAmountInput('')
      invalidateServerData('stats')
      const freshAccounts = await getAdminAccounts()
      setAccounts(freshAccounts)
    } catch {
      setError('Failed to update balance. Please check server logs.')
    } finally {
      setSubmitting(false)
    }
  }

  const parsedAmount = parseInt(amountInput.replace(/[^0-9]/g, ''), 10)
  const validAmount = !isNaN(parsedAmount) && parsedAmount >= 0

  let previewNewBalance: number | null = null
  if (selectedAccount && validAmount) {
    if (operation === 'set') {
      previewNewBalance = parsedAmount
    } else if (operation === 'add') {
      previewNewBalance = selectedAccount.coins + parsedAmount
    } else if (operation === 'subtract') {
      previewNewBalance = Math.max(0, selectedAccount.coins - parsedAmount)
    }
  }

  const presets = [
    { label: '+1,000', amount: 1000 },
    { label: '+10,000', amount: 10000 },
    { label: '+50,000', amount: 50000 },
    { label: '+100,000', amount: 100000 },
    { label: '+1,000,000', amount: 1000000 },
  ]

  return (
    <div className="workspace admin-workspace" style={{ padding: '20px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header Banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '16px 20px',
          background: 'var(--surface-soft)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          backdropFilter: 'blur(16px)',
        }}
      >
        <img src={firewallOnIcon} alt="Admin" style={{ width: 44, height: 44, flexShrink: 0 }} />
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
            Administration Control Center
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Manage economy balances and grant coins in real time. Changes sync immediately to in-game /bal and web apps.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: '#ef4444',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {error}
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          style={{
            padding: '12px 16px',
            borderRadius: 6,
            background: 'rgba(34, 197, 94, 0.15)',
            border: '1px solid rgba(34, 197, 94, 0.4)',
            color: '#16a34a',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          ✓ {successMessage}
        </div>
      )}

      {loading && accounts.length === 0 ? (
        <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 32 }}>Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 32, background: 'var(--surface-soft)', borderRadius: 8 }}>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            No linked Minecraft accounts found yet. Link your Minecraft account first in Account Overview.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Target Account Selector */}
          <section
            style={{
              padding: '16px 20px',
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 8,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Target Minecraft Account</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} available
              </span>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {accounts.map((acc) => {
                const isSelected = acc.uuid === selectedUuid
                return (
                  <button
                    key={acc.uuid}
                    type="button"
                    onClick={() => {
                      playSound('click')
                      setSelectedUuid(acc.uuid)
                      setSuccessMessage('')
                      setError('')
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 14px',
                      borderRadius: 6,
                      border: isSelected
                        ? '1px solid var(--primary-edge, #0284c7)'
                        : '1px solid var(--line)',
                      background: isSelected
                        ? 'linear-gradient(rgba(14, 165, 233, 0.2), rgba(2, 132, 199, 0.3))'
                        : 'var(--surface-soft)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                      fontWeight: isSelected ? 600 : 400,
                      transition: 'all 150ms ease',
                    }}
                  >
                    <img
                      src={`https://mc-heads.net/avatar/${acc.username}/24`}
                      alt=""
                      style={{ width: 22, height: 22, borderRadius: 3 }}
                      onError={(e) => {
                        ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                      }}
                    />
                    <span>{acc.username}</span>
                    {acc.is_self && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'rgba(14, 165, 233, 0.25)',
                          color: '#0284c7',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                        }}
                      >
                        You
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 4 }}>
                      ({acc.coins.toLocaleString()}c)
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          {selectedAccount && (
            <>
              {/* Current Balance Display Card */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '20px 24px',
                  background: 'var(--surface-soft)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Current Coins Balance
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <img src={coinIcon} alt="" style={{ width: 28, height: 28 }} />
                    <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                      {selectedAccount.coins.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}>coins</span>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Character UUID</div>
                  <code style={{ fontSize: 11, color: 'var(--text)', opacity: 0.8 }}>{selectedAccount.uuid}</code>
                </div>
              </div>

              {/* Quick Add Presets */}
              <section
                style={{
                  padding: '16px 20px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text)' }}>
                  Quick Coin Grants
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {presets.map((preset) => (
                    <button
                      key={preset.amount}
                      type="button"
                      disabled={submitting}
                      onClick={() => handleApply('add', preset.amount)}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 6,
                        border: '1px solid var(--frame)',
                        background: 'var(--surface-soft)',
                        color: 'var(--text)',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        transition: 'background 150ms ease',
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => handleApply('set', 0)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 6,
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      background: 'rgba(239, 68, 68, 0.08)',
                      color: '#ef4444',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: submitting ? 'not-allowed' : 'pointer',
                      marginLeft: 'auto',
                    }}
                  >
                    Reset to 0
                  </button>
                </div>
              </section>

              {/* Custom Adjustment Form */}
              <section
                style={{
                  padding: '20px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                  Custom Balance Adjustment
                </div>

                {/* Operation Picker */}
                <div style={{ display: 'flex', gap: 6, background: 'var(--surface-soft)', padding: 4, borderRadius: 6, width: 'fit-content' }}>
                  {(['set', 'add', 'subtract'] as Operation[]).map((op) => {
                    const active = operation === op
                    const labels: Record<Operation, string> = {
                      set: 'Set Balance',
                      add: 'Add Coins',
                      subtract: 'Deduct Coins',
                    }
                    return (
                      <button
                        key={op}
                        type="button"
                        onClick={() => {
                          playSound('click')
                          setOperation(op)
                        }}
                        style={{
                          padding: '6px 14px',
                          borderRadius: 4,
                          border: active ? '1px solid var(--primary-edge, #0284c7)' : '1px solid transparent',
                          background: active ? 'var(--primary-bottom, #0284c7)' : 'transparent',
                          color: active ? '#ffffff' : 'var(--text)',
                          fontSize: 12,
                          fontWeight: active ? 600 : 500,
                          cursor: 'pointer',
                        }}
                      >
                        {labels[op]}
                      </button>
                    )
                  })}
                </div>

                {/* Input & Action */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (validAmount) {
                      handleApply(operation, parsedAmount)
                    }
                  }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="Enter amount (e.g. 500,000)"
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value)}
                        style={{
                          width: '100%',
                          minHeight: 40,
                          padding: '8px 12px',
                          borderRadius: 6,
                          border: '1px solid var(--frame)',
                          background: 'var(--field, rgba(0,0,0,0.15))',
                          color: 'var(--text)',
                          fontSize: 14,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={submitting || !validAmount}
                      className="btn"
                      style={{
                        minHeight: 40,
                        padding: '0 20px',
                        background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                        color: 'var(--primary-text, #ffffff)',
                        border: '1px solid var(--primary-edge, #0284c7)',
                        borderRadius: 6,
                        fontWeight: 600,
                        cursor: submitting || !validAmount ? 'not-allowed' : 'pointer',
                        opacity: submitting || !validAmount ? 0.6 : 1,
                      }}
                    >
                      {submitting ? 'Applying…' : 'Apply Balance'}
                    </button>
                  </div>

                  {previewNewBalance !== null && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 6 }}>
                      <span>Resulting balance:</span>
                      <strong style={{ color: 'var(--text)' }}>
                        {previewNewBalance.toLocaleString()} coins
                      </strong>
                    </div>
                  )}
                </form>
              </section>
            </>
          )}
        </div>
      )}
    </div>
  )
}
