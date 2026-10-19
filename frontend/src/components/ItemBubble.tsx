import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { itemName, slotDescription } from '../lib/inventory'
import type { InventorySlot } from '../lib/api'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'

/** One slot as a Frutiger Aero bubble: a clear glass sphere with the item inside. */
export default function ItemBubble({ slot, label, onSelect }: { slot: InventorySlot; label?: string; onSelect: () => void }) {
  // A texture that will not load falls back to the sourced Performance Center
  // artwork, like every other image in the desktop; the name stays in text.
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const tooltipId = useId()
  const bubbleRef = useRef<HTMLButtonElement>(null)
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
      <button
        type="button"
        onClick={() => { setTooltip(null); onSelect() }}
        className={`inv-bubble${enchanted ? ' inv-enchanted' : ''}`}
        aria-label={`Inspect ${description}`}
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
      </button>
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

