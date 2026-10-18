import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getPlayerInventory, type InventorySlot, type InventoryView } from '../lib/api'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'

const ARMOR_LABELS = ['Helmet', 'Chestplate', 'Leggings', 'Boots'] as const

/** The plain name a bubble talks about: the rename, or the item key with `minecraft:` and underscores tidied. */
function itemName(slot: NonNullable<InventorySlot>): string {
  if (slot.display_name) {
    return slot.display_name
  }
  const bare = slot.key.replace(/^minecraft:/, '').replace(/_/g, ' ')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

function enchantmentNames(slot: NonNullable<InventorySlot>): string {
  return Object.entries(slot.enchantments)
    .map(([key, level]) => `${key.replace(/^minecraft:/, '').replace(/_/g, ' ')} ${level}`)
    .join(', ')
}

function slotDescription(slot: NonNullable<InventorySlot>): string {
  const parts = [itemName(slot)]
  if (slot.amount > 1) {
    parts.push(`× ${slot.amount}`)
  }
  if (slot.damage !== null && slot.max_damage !== null && slot.max_damage > 0) {
    const left = Math.max(0, Math.round(((slot.max_damage - slot.damage) / slot.max_damage) * 100))
    parts.push(`${left}% durability left`)
  }
  const enchantments = enchantmentNames(slot)
  if (enchantments !== '') {
    parts.push(enchantments)
  }
  return parts.join(' · ')
}

/** One slot as a Frutiger Aero bubble: a clear glass sphere with the item inside. */
function ItemBubble({ slot, label }: { slot: InventorySlot; label?: string }) {
  // A texture that will not load falls back to the sourced Performance Center
  // artwork, like every other image in the desktop; the name stays in text.
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const tooltipId = useId()
  const bubbleRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keepTooltip = () => clearTimeout(closeTimer.current)
  const hideTooltip = () => {
    keepTooltip()
    closeTimer.current = setTimeout(() => setTooltip(null), 120)
  }
  const showTooltip = () => {
    keepTooltip()
    const rect = bubbleRef.current?.getBoundingClientRect()
    if (rect) setTooltip({
      left: Math.max(12, Math.min(window.innerWidth - 272, rect.left + rect.width / 2 - 130)),
      top: rect.top < 180 ? rect.bottom + 10 : rect.top - 12,
      below: rect.top < 180,
    })
  }
  useEffect(() => {
    if (!tooltip) return
    const dismiss = () => setTooltip(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', escape)
    }
  }, [tooltip])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  if (slot === null) {
    return (
      <div className="inv-cell">
        <div className="inv-bubble inv-empty" role="img" aria-label={label ? `${label}: empty slot` : 'Empty slot'} />
        {label && <span className="inv-label">{label}</span>}
      </div>
    )
  }
  const description = slotDescription(slot)
  const enchanted = Object.keys(slot.enchantments).length > 0
  const durability = slot.damage !== null && slot.max_damage !== null && slot.max_damage > 0
    ? Math.max(0, Math.min(1, (slot.max_damage - slot.damage) / slot.max_damage))
    : null
  const worn = durability !== null && slot.damage !== null && slot.damage > 0
  return (
    <div className="inv-cell">
      <div
        className={`inv-bubble${enchanted ? ' inv-enchanted' : ''}`}
        role="img"
        aria-label={description}
        ref={bubbleRef}
        tabIndex={0}
        aria-describedby={tooltip ? tooltipId : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onTouchStart={showTooltip}
      >
        <img
          className="inv-icon"
          src={slot.icon !== null && failedIcon !== slot.icon ? slot.icon : perfCenterIcon}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailedIcon(slot.icon)}
        />
        {slot.amount > 1 && <span className="inv-amount">{slot.amount}</span>}
        {worn && (
          <span
            className="inv-durability"
            data-level={durability > 0.5 ? 'ok' : durability > 0.25 ? 'warn' : 'low'}
            style={{ width: `${Math.round(durability * 100)}%` }}
          />
        )}
      </div>
      {label && <span className="inv-label">{label}</span>}
      {tooltip && createPortal(
        <div id={tooltipId} role="tooltip" className="inv-tooltip" data-below={tooltip.below}
          style={{ left: tooltip.left, top: tooltip.top }}
          onMouseEnter={keepTooltip} onMouseLeave={hideTooltip}>
          <strong>{itemName(slot)}</strong>
          <span>{description.split(' · ').slice(1).join(' · ')}</span>
          {(slot.icon === null || failedIcon === slot.icon) && <span>Item texture unavailable</span>}
        </div>, document.body,
      )}
    </div>
  )
}

export default function InventoryPage({ uuid, username, visible }: { uuid: string; username: string; visible: boolean }) {
  const [inventory, setInventory] = useState<InventoryView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!visible) return
    let active = true
    let pending = false
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return
      pending = true
      try {
        const found = await getPlayerInventory(uuid)
        if (active) { setInventory(found); setLoadError('') }
      } catch { if (active) setLoadError('Could not load this player’s inventory. Try again.') }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [uuid, visible, version])
  const slots = inventory?.slots ?? null
  const updatedAt = inventory?.updated_at
  const updatedText = updatedAt
    ? new Date(updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null
  return <>
    <div className="page-head">
      <h1>Inventory</h1>
      <p className="page-sub">What {username} is carrying, as the game server last saw it.{updatedText !== null ? ` Last seen ${updatedText}.` : ''}</p>
    </div>
    {loadError !== '' && <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={() => setVersion((value) => value + 1)}>Retry loading inventory</button></div>}
    {!loadError && inventory === null && <p className="loading">Loading this player’s inventory…</p>}
    {!loadError && inventory !== null && slots === null && (
      <p className="note">The game server has not reported this player’s inventory yet. It appears while the player is online and refreshes every few seconds.</p>
    )}
    {slots !== null && <>
      <section aria-labelledby="inventory-equipment">
        <h2 className="inv-section-title" id="inventory-equipment">Equipment</h2>
        <div className="inv-grid inv-equipment-grid">
          <ItemBubble slot={slots[39] ?? null} label={ARMOR_LABELS[0]} />
          <ItemBubble slot={slots[38] ?? null} label={ARMOR_LABELS[1]} />
          <ItemBubble slot={slots[37] ?? null} label={ARMOR_LABELS[2]} />
          <ItemBubble slot={slots[36] ?? null} label={ARMOR_LABELS[3]} />
          <ItemBubble slot={slots[40] ?? null} label="Off hand" />
        </div>
      </section>
      <section aria-labelledby="inventory-hotbar">
        <h2 className="inv-section-title" id="inventory-hotbar">Hotbar</h2>
        <div className="inv-grid inv-main-grid">
          {slots.slice(0, 9).map((slot, index) => <ItemBubble key={`hotbar-${index}`} slot={slot} />)}
        </div>
      </section>
      <section aria-labelledby="inventory-main">
        <h2 className="inv-section-title" id="inventory-main">Main inventory</h2>
        <div className="inv-grid inv-main-grid">
          {slots.slice(9, 36).map((slot, index) => <ItemBubble key={`main-${index}`} slot={slot} />)}
        </div>
      </section>
    </>}
  </>
}
