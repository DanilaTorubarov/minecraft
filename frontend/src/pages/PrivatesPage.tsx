import { useEffect, useState } from 'react'
import {
  ApiError,
  depositPrivateFuel,
  withdrawPrivateFuel,
  getPlayerInventory,
  getPlayerPrivates,
  getTerritoryAlerts,
  type InventorySlot,
  type InventoryView,
  type PrivateBlockView,
  type TerritoryAlert,
} from '../lib/api'
import {
  detectFuelCrystal,
  formatFuelTime,
  radiusToChunks,
  crystalsAvailable,
  FUEL_CRYSTAL_TYPES,
  PRIVATE_BLOCK_PRICES,
  type FuelCrystalInfo,
} from '../lib/fuel'
import { isFuelCriticallyLow } from '../lib/parcels'
import { playSound } from '../lib/sounds'
import firewallWarningIcon from '../assets/icons/vista-firewall-warning.png'
import firewallOnIcon from '../assets/icons/vista-firewall-on.png'
import firewallOffIcon from '../assets/icons/vista-firewall-off.png'
import searchGlobeIcon from '../assets/icons/vista-search-globe.png'

interface Props {
  uuid: string
  username: string
  visible: boolean
  onOpenMarketplace?: () => void
}

interface InventoryCrystal {
  slot: number
  item: NonNullable<InventorySlot>
  info: FuelCrystalInfo
}

export default function PrivatesPage({ uuid, username, visible, onOpenMarketplace }: Props) {
  const [blocks, setBlocks] = useState<PrivateBlockView[] | null>(null)
  const [inventory, setInventory] = useState<InventoryView | null>(null)
  const [alerts, setAlerts] = useState<TerritoryAlert[]>([])
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [submittingSlot, setSubmittingSlot] = useState<number | null>(null)
  const [withdrawingKey, setWithdrawingKey] = useState<string | null>(null)

  const refreshData = async () => {
    try {
      const [privates, inv, al] = await Promise.all([
        getPlayerPrivates(uuid),
        getPlayerInventory(uuid),
        getTerritoryAlerts().catch(() => []),
      ])
      setBlocks(privates)
      setInventory(inv)
      setAlerts(al.filter((a) => a.uuid === uuid))
      setLoadError('')
    } catch {
      setLoadError('Could not load private blocks. Try again shortly.')
    }
  }

  useEffect(() => {
    if (!visible) return
    let active = true
    const load = async () => {
      try {
        const [privates, inv, al] = await Promise.all([
          getPlayerPrivates(uuid),
          getPlayerInventory(uuid),
          getTerritoryAlerts().catch(() => []),
        ])
        if (active) {
          setBlocks(privates)
          setInventory(inv)
          setAlerts(al.filter((a) => a.uuid === uuid))
          setLoadError('')
        }
      } catch {
        if (active) setLoadError('Could not load private blocks. Try again shortly.')
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [uuid, visible])

  // Extract all fuel crystals currently present in the player's inventory
  const fuelCrystals: InventoryCrystal[] = []
  if (inventory?.slots) {
    for (let i = 0; i < 36; i++) {
      const it = inventory.slots[i]
      if (it) {
        const info = detectFuelCrystal(it)
        if (info) {
          fuelCrystals.push({ slot: i, item: it, info })
        }
      }
    }
  }

  const handleDeposit = async (blockIndex: number, slotIndex: number, crystalName: string, hours: number) => {
    if (submittingSlot !== null) return
    setSubmittingSlot(slotIndex)
    setActionError('')
    setActionMessage('')
    try {
      const result = await depositPrivateFuel(uuid, blockIndex, slotIndex)
      playSound('done')
      setActionMessage(
        `Successfully deposited ${crystalName} into Protection Core #${blockIndex}! Added ${hours} hours of fuel (+${Math.round(result.added_seconds / 3600)}h). Active size: ${result.size}×${result.size}.`
      )
      await refreshData()
    } catch (err) {
      playSound('click')
      if (err instanceof ApiError && err.status === 400) {
        setActionError('The selected slot no longer contains a valid fuel crystal or the core is not placed.')
      } else {
        setActionError('Failed to deposit fuel. Please try again.')
      }
    } finally {
      setSubmittingSlot(null)
    }
  }

  const handleWithdraw = async (blockIndex: number, tier: number, crystalName: string, hours: number) => {
    const key = `${blockIndex}-${tier}`
    if (withdrawingKey !== null) return
    setWithdrawingKey(key)
    setActionError('')
    setActionMessage('')
    try {
      await withdrawPrivateFuel(uuid, blockIndex, tier, 1)
      playSound('done')
      setActionMessage(
        `Successfully withdrew 1 ${crystalName} (-${hours}h) back to your inventory!`
      )
      await refreshData()
    } catch (err) {
      playSound('click')
      if (err instanceof ApiError && err.status === 409) {
        setActionError('Inventory is full! Free up a slot in Minecraft or web inventory first.')
      } else if (err instanceof ApiError && err.status === 400) {
        setActionError(`Not enough Tier ${tier} fuel remaining to withdraw a crystal.`)
      } else {
        setActionError('Failed to withdraw fuel crystal. Please try again.')
      }
    } finally {
      setWithdrawingKey(null)
    }
  }

  if (loadError) {
    return (
      <div className="note" data-tone="error" role="alert">
        <p>{loadError}</p>
        <button className="btn" onClick={() => void refreshData()}>Retry</button>
      </div>
    )
  }

  if (blocks === null || inventory === null) {
    return <p className="loading">Loading private blocks and fuel status…</p>
  }

  const ownedMap = new Map<number, PrivateBlockView>()
  for (const b of blocks) {
    ownedMap.set(b.block_index, b)
  }

  return (
    <div className="privates-page" style={{ display: 'grid', gap: '20px', paddingBottom: '24px' }}>
      <header className="privates-header" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img src={firewallOnIcon} alt="" style={{ width: '24px', height: '24px', objectFit: 'contain' }} />
            Private Territory Cores
          </h2>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
            Manage private zones, boundaries, and fuel levels for <strong>{username}</strong>.
          </p>
        </div>
        <div style={{ padding: '6px 14px', background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '20px', fontWeight: 600, fontSize: '13px' }}>
          Owned: {blocks.length} / 3 Cores
        </div>
      </header>

      {alerts.length > 0 && (
        <section className="territory-alerts-panel" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '8px', padding: '14px 16px', display: 'grid', gap: '10px' }}>
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#ef4444', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img src={firewallWarningIcon} alt="" style={{ width: '20px', height: '20px' }} />
            Territory Defense Alerts ({alerts.length})
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' }}>
            {alerts.map((al) => (
              <li key={al.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', fontSize: '13px', background: 'rgba(0, 0, 0, 0.2)', padding: '8px 12px', borderRadius: '6px' }}>
                <div>
                  <strong>{al.title}:</strong> {al.message}
                </div>
                {al.fuel_seconds !== undefined && isFuelCriticallyLow(al.fuel_seconds) && (
                  <span style={{ background: '#ef4444', color: '#fff', fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                    &lt; 2h Fuel!
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {actionMessage && (
        <div className="note" data-tone="success" role="status" style={{ margin: 0 }}>
          <p>{actionMessage}</p>
        </div>
      )}

      {actionError && (
        <div className="note" data-tone="error" role="alert" style={{ margin: 0 }}>
          <p>{actionError}</p>
        </div>
      )}

      {/* Fuel Inventory Section */}
      <section className="fuel-inventory-panel" style={{ background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '8px', padding: '16px', display: 'grid', gap: '12px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>⚡ Available Fuel Crystals</span>
            <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--muted)' }}>
              ({fuelCrystals.reduce((sum, c) => sum + (c.item.amount || 1), 0)} in inventory)
            </span>
          </h3>
          {onOpenMarketplace && (
            <button className="btn btn-quiet" onClick={onOpenMarketplace} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <img src={searchGlobeIcon} alt="" style={{ width: '16px', height: '16px', objectFit: 'contain' }} />
              <span>Marketplace</span>
            </button>
          )}
        </div>

        {fuelCrystals.length === 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '14px', padding: '14px', background: 'var(--surface-soft)', borderRadius: '6px', border: '1px solid var(--line)' }}>
            <img src={firewallWarningIcon} alt="" style={{ width: '36px', height: '36px', flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: '1 1 240px' }}>
              <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: '13px' }}>No fuel crystals in inventory</p>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }}>
                Fuel crystals power your Protection Cores and expand your territory from 3×3 up to 15×15. Mine them in the Mining Dimension (<strong>/mine</strong>) or purchase them from players on the Marketplace.
              </p>
            </div>
            {onOpenMarketplace && (
              <button className="btn" onClick={onOpenMarketplace} style={{ flexShrink: 0, fontWeight: 600 }}>
                Buy Fuel on Marketplace
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
            {fuelCrystals.map(({ slot, item, info }) => (
              <div key={slot} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '6px' }}>
                {item.icon ? (
                  <img src={item.icon} alt="" style={{ width: '28px', height: '28px', imageRendering: 'pixelated' }} />
                ) : (
                  <div style={{ width: '28px', height: '28px', borderRadius: '4px', background: 'var(--line)' }} />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {info.name} <span style={{ color: 'var(--muted)', fontSize: '12px' }}>×{item.amount || 1}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                    Tier {info.tier} (+{info.hours}h · {info.footprint})
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Private Blocks Slots 1, 2, 3 */}
      <section className="private-blocks-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: '16px' }}>
        {[1, 2, 3].map((index) => {
          const block = ownedMap.get(index)
          if (block) {
            const isActive = block.placed && block.fuel_seconds > 0
            const isPlaced = block.placed
            return (
              <article
                key={index}
                style={{
                  background: 'var(--content-glass)',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '14px',
                  boxShadow: 'var(--shadow)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--line)', paddingBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img
                      src={isActive ? firewallOnIcon : firewallOffIcon}
                      alt=""
                      style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                    />
                    <strong style={{ fontSize: '15px' }}>Protection Core #{index}</strong>
                  </div>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: isActive ? 'var(--success-bg)' : isPlaced ? 'var(--danger-bg)' : 'var(--surface-soft)',
                      color: isActive ? 'var(--success)' : isPlaced ? 'var(--danger)' : 'var(--muted)',
                      border: '1px solid currentColor',
                    }}
                  >
                    {isActive ? 'Active' : isPlaced ? 'Dormant (No Fuel)' : 'Not Placed'}
                  </span>
                </div>

                <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', fontSize: '13px' }}>
                  <dt style={{ color: 'var(--muted)' }}>Footprint:</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>
                    {radiusToChunks(block.radius)}×{radiusToChunks(block.radius)} chunks ({block.size}×{block.size} blocks){' '}
                    <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(Full World Height)</span>
                  </dd>

                  <dt style={{ color: 'var(--muted)' }}>Location:</dt>
                  <dd style={{ margin: 0, wordBreak: 'break-all' }}>
                    {isPlaced ? `${block.world} (${block.x}, ${block.y}, ${block.z})` : 'In Inventory or Unplaced'}
                  </dd>

                  <dt style={{ color: 'var(--muted)' }}>Members:</dt>
                  <dd style={{ margin: 0, color: 'var(--muted)' }}>
                    {Array.isArray(block.members) && block.members.length > 0
                      ? `${block.members.length} trusted player(s)`
                      : 'None (Owner only)'}
                  </dd>

                  {isPlaced && (
                    <>
                      <dt style={{ color: 'var(--muted)' }}>Fast Travel:</dt>
                      <dd style={{ margin: 0 }}>
                        {isActive ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '12px' }}>
                            <code style={{ fontWeight: 600, color: 'var(--accent)', background: 'var(--surface-soft)', padding: '1px 5px', borderRadius: '4px' }}>/ps tp {block.block_index}</code>
                            <span style={{ color: 'var(--muted)' }}>or</span>
                            <code style={{ fontWeight: 600, color: 'var(--accent)', background: 'var(--surface-soft)', padding: '1px 5px', borderRadius: '4px' }}>/home {block.block_index}</code>
                            <span style={{ color: 'var(--muted)', fontSize: '11px' }}>(25 coins · 3s warmup)</span>
                          </div>
                        ) : (
                          <span style={{ fontSize: '12px', color: 'var(--danger)' }}>
                            Disabled (Dormant · deposit fuel crystals to activate)
                          </span>
                        )}
                      </dd>
                    </>
                  )}
                </dl>

                {/* Fuel Queue Breakdown */}
                {isPlaced && (
                  <div style={{ background: 'var(--content-glass)', border: '1px solid var(--line)', borderRadius: '6px', padding: '10px', display: 'grid', gap: '8px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, color: 'var(--text)' }}>
                      <span>Fuel Queue (Sequential):</span>
                      <span style={{ color: isActive ? 'var(--success)' : 'var(--danger)' }}>{formatFuelTime(block.fuel_seconds)}</span>
                    </div>

                    <div style={{ display: 'grid', gap: '5px' }}>
                      {[4, 3, 2, 1].map((t) => {
                        const info = FUEL_CRYSTAL_TYPES[t]
                        const sec = t === 4 ? (block.tier_4_seconds ?? 0) : t === 3 ? (block.tier_3_seconds ?? 0) : t === 2 ? (block.tier_2_seconds ?? 0) : (block.tier_1_seconds ?? 0)
                        const isTierActive = t === 4
                          ? sec > 0
                          : t === 3
                          ? (block.tier_4_seconds ?? 0) === 0 && sec > 0
                          : t === 2
                          ? (block.tier_4_seconds ?? 0) === 0 && (block.tier_3_seconds ?? 0) === 0 && sec > 0
                          : (block.tier_4_seconds ?? 0) === 0 && (block.tier_3_seconds ?? 0) === 0 && (block.tier_2_seconds ?? 0) === 0 && sec > 0

                        const canWithdraw = crystalsAvailable(sec, t) > 0
                        const isWithdrawingThis = withdrawingKey === `${block.block_index}-${t}`

                        return (
                          <div
                            key={t}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              flexWrap: 'wrap',
                              gap: '6px',
                              padding: '5px 8px',
                              borderRadius: '4px',
                              background: isTierActive ? 'rgba(56, 189, 248, 0.12)' : 'var(--surface-soft)',
                              border: isTierActive ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent',
                            }}
                          >
                            <div>
                              <span style={{ fontWeight: 600, color: t === 4 ? '#c084fc' : t === 3 ? '#f87171' : t === 2 ? '#38bdf8' : '#fb923c' }}>
                                Tier {t} ({t === 4 ? '16×16' : t === 3 ? '10×10' : t === 2 ? '5×5' : '2×2'}):
                              </span>{' '}
                              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{formatFuelTime(sec)}</span>
                              {isTierActive && (
                                <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--success)', fontWeight: 700, textTransform: 'uppercase' }}>
                                  [Active]
                                </span>
                              )}
                              {!isTierActive && sec > 0 && (
                                <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--muted)', fontWeight: 600 }}>
                                  [Queued]
                                </span>
                              )}
                            </div>

                            {canWithdraw && (
                              <button
                                type="button"
                                className="btn btn-quiet"
                                disabled={withdrawingKey !== null}
                                onClick={() => void handleWithdraw(block.block_index, t, info.name, info.hours)}
                                style={{ minHeight: '24px', padding: '2px 8px', fontSize: '11px' }}
                                title={`Withdraw 1 ${info.name} (-${info.hours}h) back to inventory`}
                              >
                                {isWithdrawingThis ? 'Withdrawing…' : `Withdraw 1 (${info.name})`}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {isPlaced && isFuelCriticallyLow(block.fuel_seconds) && (
                  <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '6px', padding: '6px 10px', fontSize: '12px', color: '#ef4444', fontWeight: 600 }}>
                    ⚠️ Critical Fuel: Under 2 hours remaining! Deposit crystals to prevent deactivation.
                  </div>
                )}

                {/* Fuel Deposit Area */}
                {isPlaced ? (
                  <div style={{ marginTop: 'auto', paddingTop: '12px', borderTop: '1px solid var(--line)', display: 'grid', gap: '8px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
                      Deposit Fuel Crystal:
                    </span>
                    {fuelCrystals.length > 0 ? (
                      <div style={{ display: 'grid', gap: '6px' }}>
                        {fuelCrystals.map(({ slot, info }) => (
                          <button
                            key={slot}
                            className="btn btn-quiet"
                            disabled={submittingSlot !== null}
                            onClick={() => void handleDeposit(block.block_index, slot, info.name, info.hours)}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '6px 10px',
                              fontSize: '12px',
                              textAlign: 'left',
                            }}
                          >
                            <span>
                              <strong>+ {info.hours}h</strong> {info.name}
                            </span>
                            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                              {submittingSlot === slot ? 'Depositing…' : 'Deposit'}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '12px' }}>
                        <span style={{ color: 'var(--muted)' }}>No crystals in inventory</span>
                        {onOpenMarketplace && (
                          <button className="btn btn-quiet" onClick={onOpenMarketplace} style={{ fontSize: '11px' }}>
                            Buy on Marketplace
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 'auto', paddingTop: '10px', borderTop: '1px solid var(--line)', fontSize: '12px', color: 'var(--muted)' }}>
                    Place this Protection Core in-game to activate territory. If lost, type <strong>/ps claim</strong> in chat to recover it for free.
                  </div>
                )}
              </article>
            )
          }

          // Unpurchased Slot
          const price = PRIVATE_BLOCK_PRICES[index] || 500
          return (
            <article
              key={index}
              style={{
                background: 'var(--surface-soft)',
                border: '1px dashed var(--line)',
                borderRadius: '8px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                opacity: 0.88,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: '15px', color: 'var(--muted)' }}>Protection Core #{index}</strong>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: 'var(--line)', color: 'var(--muted)' }}>
                  Unpurchased
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>
                Unlock Private Block #{index} for <strong>{price.toLocaleString()} coins</strong>.
              </p>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }}>
                Type <strong>/ps buy</strong> in-game to purchase. Requires maintaining at least 1,000 coins in reserve.
              </p>
            </article>
          )
        })}
      </section>
    </div>
  )
}
