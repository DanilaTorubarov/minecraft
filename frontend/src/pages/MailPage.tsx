import { useEffect, useState, type FormEvent } from 'react'
import {
  ApiError,
  getParcels,
  sendParcel,
  type Parcel,
} from '../lib/api'
import { parcelSummary } from '../lib/parcels'
import { displayPlayerName } from '../lib/playerName'
import ItemBubble from '../components/ItemBubble'
import { playSound } from '../lib/sounds'
import globeIcon from '../assets/icons/vista-search-globe.png'

interface Props {
  uuid: string
  username: string
  visible: boolean
  onOpenInventory?: () => void
}

export default function MailPage({ uuid, username, visible, onOpenInventory }: Props) {
  const [parcels, setParcels] = useState<{ received: Parcel[]; sent: Parcel[] } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [recipient, setRecipient] = useState('')
  const [coins, setCoins] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionSuccess, setActionSuccess] = useState('')
  const [actionError, setActionError] = useState('')

  const refresh = async () => {
    try {
      const data = await getParcels()
      setParcels(data)
      setLoadError('')
    } catch {
      setLoadError('Could not load mail and parcels. Try again shortly.')
    }
  }

  useEffect(() => {
    if (!visible) return
    let active = true
    const run = async () => {
      try {
        const data = await getParcels()
        if (active) {
          setParcels(data)
          setLoadError('')
        }
      } catch {
        if (active) setLoadError('Could not load mail and parcels. Try again shortly.')
      }
    }
    void run()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void run()
    }, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [visible])

  const handleSendCoinParcel = async (e: FormEvent) => {
    e.preventDefault()
    const coinsNum = Number(coins)
    if (!recipient.trim() || isNaN(coinsNum) || coinsNum <= 0) {
      setActionError('Please enter a recipient username and a valid coin amount.')
      return
    }
    setSubmitting(true)
    setActionError('')
    setActionSuccess('')
    try {
      await sendParcel({
        sender_uuid: uuid,
        recipient_username: recipient.trim(),
        coins: coinsNum,
        message: message.trim() || undefined,
      })
      playSound('done')
      setActionSuccess(`Parcel sent to ${displayPlayerName(recipient.trim())} with ${coinsNum.toLocaleString()} coins! When they log into Minecraft, they will see: You received a delivery from ${username}! Type /mail claim.`)
      setRecipient('')
      setCoins('')
      setMessage('')
      await refresh()
    } catch (err) {
      playSound('click')
      if (err instanceof ApiError && err.status === 404) {
        setActionError('Recipient player not found. Make sure the username has joined the server.')
      } else if (err instanceof ApiError && err.status === 422) {
        setActionError('Insufficient coin balance to send this parcel.')
      } else if (err instanceof ApiError && err.status === 400) {
        setActionError('Cannot send parcel to yourself or invalid input.')
      } else {
        setActionError('Failed to send parcel. Please check connection and try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const myReceived = parcels?.received.filter((p) => p.recipient_uuid === uuid) ?? []
  const mySent = parcels?.sent.filter((p) => p.sender_uuid === uuid) ?? []
  const pendingReceived = myReceived.filter((p) => p.status === 'pending')

  return (
    <div className="mail-page" style={{ display: 'grid', gap: '20px', paddingBottom: '24px' }}>
      <header className="mail-header" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img src={globeIcon} alt="" style={{ width: '24px', height: '24px', objectFit: 'contain' }} />
            Offline Mail & Delivery Parcels
          </h2>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
            Send items or currency to players even when they are offline. Deliveries are collected in game with <code>/mail claim</code>.
          </p>
        </div>
        <div style={{ padding: '6px 14px', background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '20px', fontWeight: 600, fontSize: '13px' }}>
          Pending Deliveries: {pendingReceived.length}
        </div>
      </header>

      {actionSuccess && (
        <div className="note" data-tone="success" role="status" style={{ margin: 0 }}>
          <p>{actionSuccess}</p>
        </div>
      )}

      {actionError && (
        <div className="note" data-tone="error" role="alert" style={{ margin: 0 }}>
          <p>{actionError}</p>
        </div>
      )}

      {loadError && (
        <div className="note" data-tone="error" role="alert" style={{ margin: 0 }}>
          <p>{loadError}</p>
          <button className="btn" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {/* Incoming Parcels Section */}
      <section style={{ background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '12px', padding: '16px' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: '15px', fontWeight: 700 }}>
          Incoming Deliveries ({pendingReceived.length} Pending)
        </h3>
        {pendingReceived.length > 0 ? (
          <>
            <div className="note" style={{ margin: '0 0 12px', background: 'rgba(56, 189, 248, 0.1)', borderColor: 'rgba(56, 189, 248, 0.3)' }}>
              <p style={{ margin: 0 }}>
                💡 <strong>How to claim:</strong> Log into Minecraft as <strong>{username}</strong> and type <code>/mail claim</code> in chat to collect your items and coins!
              </p>
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' }}>
              {pendingReceived.map((p) => (
                <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--line)', borderRadius: '8px' }}>
                  {p.item ? <ItemBubble slot={p.item} onSelect={() => {}} /> : <div style={{ fontSize: '24px' }}>🪙</div>}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{parcelSummary(p)}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      From <strong>{displayPlayerName(p.sender_username)}</strong> · Sent {new Date(p.created_at).toLocaleString()}
                      {p.message && <span> — <em>"{p.message}"</em></span>}
                    </div>
                  </div>
                  <span style={{ fontSize: '12px', background: '#eab308', color: '#000', fontWeight: 700, padding: '3px 8px', borderRadius: '4px' }}>
                    Ready to claim in-game
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
            No pending deliveries awaiting collection. Deliveries sent to you from the web or other players will appear here.
          </p>
        )}
      </section>

      {/* Send Coin Parcel Section */}
      <section style={{ background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '12px', padding: '16px' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 700 }}>
          Send Currency Parcel
        </h3>
        <p style={{ margin: '0 0 14px', fontSize: '13px', color: 'var(--muted)' }}>
          Directly wire coins to any player on the server. If they are offline, they will receive a notification the moment they join.
        </p>

        <form onSubmit={(e) => void handleSendCoinParcel(e)} style={{ display: 'grid', gap: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
            <label style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
              Recipient Minecraft Username:
              <input
                type="text"
                placeholder="e.g. Danila"
                required
                maxLength={32}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--well)' }}
              />
            </label>
            <label style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
              Coins to Send:
              <input
                type="number"
                min="1"
                placeholder="Amount in coins"
                required
                value={coins}
                onChange={(e) => setCoins(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--well)' }}
              />
            </label>
          </div>
          <label style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
            Letter Message / Note (Optional):
            <input
              type="text"
              placeholder="e.g. Thanks for the help building the fort!"
              maxLength={256}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--well)' }}
            />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? 'Dispatching…' : 'Dispatch Coin Parcel'}
            </button>
            {onOpenInventory && (
              <button
                type="button"
                className="btn"
                onClick={onOpenInventory}
                style={{ fontSize: '12px' }}
              >
                🎒 Send Items from Inventory →
              </button>
            )}
          </div>
        </form>
      </section>

      {/* Sent History Section */}
      <section style={{ background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '12px', padding: '16px' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: '15px', fontWeight: 700 }}>
          Sent Parcels ({mySent.length})
        </h3>
        {mySent.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' }}>
            {mySent.slice(0, 10).map((p) => (
              <li key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--line)', borderRadius: '6px', fontSize: '13px' }}>
                <div>
                  <strong>{parcelSummary(p)}</strong> to <strong>{displayPlayerName(p.recipient_username)}</strong>
                  <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                    Sent {new Date(p.created_at).toLocaleString()}
                    {p.message && <span> · "{p.message}"</span>}
                  </div>
                </div>
                <div>
                  {p.status === 'claimed' ? (
                    <span style={{ color: '#22c55e', fontWeight: 600, fontSize: '12px' }}>
                      ✔ Claimed
                    </span>
                  ) : (
                    <span style={{ color: '#eab308', fontWeight: 600, fontSize: '12px' }}>
                      ⏳ Waiting for recipient (/mail claim)
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
            You haven't sent any parcels from this player yet.
          </p>
        )}
      </section>
    </div>
  )
}
