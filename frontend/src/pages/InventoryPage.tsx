import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ApiError, getMarketQuote, type MarketQuote, sendInventoryToMarket, getPlayerInventory, type InventorySlot, type InventoryView } from '../lib/api'
import ItemBubble from '../components/ItemBubble'
import { itemName, slotDescription } from '../lib/inventory'

const ARMOR_LABELS = ['Helmet', 'Chestplate', 'Leggings', 'Boots'] as const

export default function InventoryPage({ uuid, username, visible }: { uuid: string; username: string; visible: boolean }) {
  const [inventory, setInventory] = useState<InventoryView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<{ index: number; item: NonNullable<InventorySlot> } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [lotPrice, setLotPrice] = useState('')
  const [quote, setQuote] = useState<{ key: string; value: MarketQuote } | null>(null)
  const quoteKey = JSON.stringify([quantity, unitPrice, lotPrice])
  const currentQuote = quote?.key === quoteKey ? quote.value : null
  useEffect(() => {
    if (!selected || (!unitPrice && !lotPrice)) return
    let active = true
    const timer = window.setTimeout(() => {
      void getMarketQuote({ quantity: Number(quantity), unit_price: unitPrice ? Number(unitPrice) : null, lot_price: lotPrice ? Number(lotPrice) : null })
        .then((value) => { if (active) setQuote({ key: quoteKey, value }) })
        .catch(() => { if (active) setQuote(null) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [selected, quantity, unitPrice, lotPrice, quoteKey, version])
  const selectionId = useId()
  const selectionHeading = useRef<HTMLHeadingElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => { if (selected) selectionHeading.current?.focus() }, [selected])
  const select = (index: number) => {
    const item = inventory?.slots?.[index]
    if (!item) return
    returnFocus.current = document.activeElement as HTMLElement
    setQuantity(String(item.amount)); setUnitPrice(''); setLotPrice(''); setSelected({ index, item }); setActionError(''); setActionMessage('')
  }
  const dismiss = () => { setSelected(null); returnFocus.current?.focus() }
  const sendToMarket = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected?.item.fingerprint || !currentQuote || submitting) return
    setSubmitting(true); setActionError('')
    try {
      await sendInventoryToMarket(uuid, { expected_commission_bps: currentQuote.commission_bps, slot: selected.index, fingerprint: selected.item.fingerprint, quantity: Number(quantity), unit_price: unitPrice ? Number(unitPrice) : null, lot_price: lotPrice ? Number(lotPrice) : null })
      setActionMessage('Transfer requested. Your listing appears after the game server confirms the items were sent.')
      dismiss()
    } catch (error) {
      setActionError(error instanceof ApiError && error.status === 412
        ? 'The commission changed. Review the refreshed proceeds and submit again.'
        : error instanceof ApiError && error.status === 409
        ? 'The stack changed or another inventory transfer is pending. Refresh and select the item again.'
        : error instanceof ApiError && error.status === 429 ? 'You have reached the limit of 100 active listings for this player. Finish or cancel a listing first.' : 'Could not confirm the transfer request. Refresh before trying again.')
    } finally { setSubmitting(false); setVersion((value) => value + 1) }
  }
  useEffect(() => {
    if (!visible) return
    let active = true
    let pending = false
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return
      pending = true
      try {
        const found = await getPlayerInventory(uuid)
        if (active) { setInventory(found); setLoadError(''); if (found.marketplace) setActionMessage('') }
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
    <p className="page-sub">Select an item to send it to Marketplace. Choose how many to sell and set a price in coins.</p>
    <div aria-live="polite">
      {actionMessage ? <p className="note">{actionMessage}</p>
        : inventory?.marketplace?.status === 'pending' ? <p className="note">Sending items to Marketplace. Waiting for the game server; the player can stay offline.</p>
        : inventory?.marketplace?.status === 'active' ? <p className="note" data-tone="success">The game server confirmed the transfer. Your items are on Marketplace.</p>
        : inventory?.marketplace?.status === 'conflict' ? <p className="note">The stack changed or could not be transferred. Nothing was sent. Refresh and select it again.</p>
        : null}
    </div>
    {selected && <form key={selected.index} className="note inv-selection" aria-labelledby={selectionId} onSubmit={(event) => { void sendToMarket(event) }}
      onKeyDown={(event) => { if (event.key === 'Escape' && !submitting) { event.stopPropagation(); dismiss() } }}>
      <h2 id={selectionId} ref={selectionHeading} tabIndex={-1}>{itemName(selected.item)}</h2>
      <p>{slotDescription(selected.item)}</p>
      <p>These items leave {username}’s inventory when the game server confirms the transfer. Cancel a listing on Marketplace to have its unsold items returned.</p>
      <div className="market-fields">
        <label>Quantity <input type="number" min="1" max={selected.item.amount} step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>Price per item (coins) <input type="number" min="1" max="1000000000" step="1" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} placeholder="Optional" /></label>
        <label>Whole-lot price (coins) <input type="number" min="1" max="1000000000" step="1" value={lotPrice} onChange={(event) => setLotPrice(event.target.value)} placeholder="Optional" /></label>
      </div>
      <p>Set either price or both. The whole-lot price is independent, so you can offer a bulk discount. After a partial sale, its price reduces proportionally, rounded up to a whole coin.</p>
      {!selected.item.fingerprint && <p>This snapshot has no item fingerprint. After the inventory refreshes, close these details and select the item again to send it.</p>}
      {(unitPrice || lotPrice) && <div aria-live="polite">{currentQuote ? <>
        <p>Seller commission: {currentQuote.commission_bps / 100}%, fixed for this listing. Charged only on completed sales; fractions round up cumulatively across partial sales.</p>
        {currentQuote.unit && <p>If all selected items sell at the unit price: {currentQuote.unit.proceeds.toLocaleString()} coins to you · {currentQuote.unit.fee.toLocaleString()} coins commission.</p>}
        {currentQuote.lot && <p>If the whole lot sells now: {currentQuote.lot.proceeds.toLocaleString()} coins to you · {currentQuote.lot.fee.toLocaleString()} coins commission.</p>}
      </> : <p>Enter valid prices to load seller proceeds. If unavailable, <button type="button" className="btn btn-quiet" onClick={() => setVersion((value) => value + 1)}>Retry quote</button></p>}</div>}
      <div className="inv-actions">
        <button type="submit" className="btn btn-primary" disabled={submitting || !currentQuote || !selected.item.fingerprint || (!unitPrice && !lotPrice) || inventory?.marketplace?.status === 'pending'}>{submitting ? 'Sending…' : 'Send to Marketplace'}</button>
        <button type="button" className="btn" disabled={submitting} onClick={dismiss}>Cancel</button>
      </div>
      {actionError && <p role="alert">{actionError}</p>}
    </form>}
    {loadError !== '' && <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={() => setVersion((value) => value + 1)}>Retry loading inventory</button></div>}
    {!loadError && inventory === null && <p className="loading">Loading this player’s inventory…</p>}
    {!loadError && inventory !== null && slots === null && (
      <p className="note">The game server has not reported this player’s inventory yet. It appears while the player is online and refreshes every few seconds.</p>
    )}
    {slots !== null && <>
      <section aria-labelledby="inventory-equipment">
        <h2 className="inv-section-title" id="inventory-equipment">Equipment</h2>
        <div className="inv-grid inv-equipment-grid">
          <ItemBubble onSelect={() => select(39)} slot={slots[39] ?? null} label={ARMOR_LABELS[0]} />
          <ItemBubble onSelect={() => select(38)} slot={slots[38] ?? null} label={ARMOR_LABELS[1]} />
          <ItemBubble onSelect={() => select(37)} slot={slots[37] ?? null} label={ARMOR_LABELS[2]} />
          <ItemBubble onSelect={() => select(36)} slot={slots[36] ?? null} label={ARMOR_LABELS[3]} />
          <ItemBubble onSelect={() => select(40)} slot={slots[40] ?? null} label="Off hand" />
        </div>
      </section>
      <section aria-labelledby="inventory-hotbar">
        <h2 className="inv-section-title" id="inventory-hotbar">Hotbar</h2>
        <div className="inv-grid inv-main-grid">
          {slots.slice(0, 9).map((slot, index) => <ItemBubble key={`hotbar-${index}`} slot={slot} onSelect={() => select(index)} />)}
        </div>
      </section>
      <section aria-labelledby="inventory-main">
        <h2 className="inv-section-title" id="inventory-main">Main inventory</h2>
        <div className="inv-grid inv-main-grid">
          {slots.slice(9, 36).map((slot, index) => <ItemBubble key={`main-${index}`} slot={slot} onSelect={() => select(index + 9)} />)}
        </div>
      </section>
    </>}
  </>
}
