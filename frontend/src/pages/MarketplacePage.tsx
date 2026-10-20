import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, buyMarketListing, cancelMarketListing, getMarketplace, type MarketListing, type MarketPurchase, type MarketView, type StatsAccount } from '../lib/api'
import ItemBubble from '../components/ItemBubble'
import { itemName, slotDescription } from '../lib/inventory'
import { invalidateServerData } from '../lib/serverData'

export default function MarketplacePage({ visible, accounts, onOpenInventory }: { visible: boolean; accounts: StatsAccount[]; onOpenInventory: (uuid: string) => void }) {
  const [market, setMarket] = useState<MarketView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [version, setVersion] = useState(0)
  const [search, setSearch] = useState('')
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1)
  const [mine, setMine] = useState(false)
  const [selection, setSelection] = useState<MarketListing | null>(null)
  const [buyer, setBuyer] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [pricing, setPricing] = useState<'unit' | 'lot'>('unit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  // Keep a failed network request's ID and exact quote for a safe retry, even if
  // the server committed it before the connection was lost.
  const [purchase, setPurchase] = useState<{ id: string; body: MarketPurchase } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const formId = useId()
  useEffect(() => { if (selection) heading.current?.focus() }, [selection])
  useEffect(() => {
    if (!visible) return
    let active = true, pending = false
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return
      pending = true
      try { const found = await getMarketplace({ mine, q: search, cursor }); if (active) { setMarket(found); setLoadError('') } }
      catch { if (active) setLoadError('Could not load Marketplace. Try again.') }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [visible, version, mine, search, cursor])
  const selected = purchase ? selection : market?.listings.find((listing) => listing.id === selection?.id) ?? selection
  const buyerAccount = accounts.find((account) => account.uuid === buyer) ?? accounts[0]
  const amount = pricing === 'lot' ? selected?.remaining ?? 0 : Number(quantity)
  const total = selected ? pricing === 'lot' ? selected.lot_price : selected.unit_price === null ? null : selected.unit_price * amount : null
  const valid = selected?.status === 'active' && amount >= 1 && amount <= selected.remaining && Number.isInteger(amount) && total !== null
  const choose = (listing: MarketListing) => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelection(listing); setQuantity('1'); setPricing(listing.unit_price !== null ? 'unit' : 'lot'); setError(''); setMessage(''); setPurchase(null)
  }
  const dismiss = () => { setSelection(null); setPurchase(null); returnFocus.current?.focus() }
  const trade = async (cancel = false) => {
    if (!selected || busy || (!cancel && !buyerAccount)) return
    setBusy(true); setError(''); setMessage('')
    try {
      if (cancel) await cancelMarketListing(selected.id)
      else {
        if (!purchase && (!valid || total === null)) return
        const request = purchase ?? { id: selected.id, body: { request_id: crypto.randomUUID(), buyer_uuid: buyerAccount.uuid, quantity: amount, pricing, expected_total: total!, expected_remaining: selected.remaining } }
        setPurchase(request)
        await buyMarketListing(request.id, request.body)
      }
      setMessage(cancel ? 'Listing cancelled. Unsold items are queued for return to the seller’s inventory.' : 'Purchase confirmed. Your items are queued for delivery. Keep an empty storage slot for them.')
      invalidateServerData('stats'); dismiss()
    } catch (problem) {
      const status = problem instanceof ApiError ? problem.status : 0
      if (status !== 0 && status < 500) setPurchase(null)
      setError(status === 422 ? 'This player does not have enough coins. Choose another player or a smaller quantity.'
        : status === 409 ? 'This listing changed or the request is already being processed. Refresh and select it again.'
        : 'Could not confirm the request. Retry to check the same purchase safely.')
    } finally { setBusy(false); setVersion((value) => value + 1) }
  }
  const listings = market?.listings ?? []
  return <>
    <div className="page-head"><h1>Marketplace</h1><p className="page-sub">Trade items with other players for coins. Every listing is backed by items the game server has received.</p></div>
    {market && <p className="note">Commission on new listings: {market.commission_bps / 100}%. Sellers keep their accepted rate for the life of each listing. Buyers pay the displayed price.</p>}
    <div className="market-toolbar">
      <label className="market-search">Find items or sellers<input type="search" value={search} maxLength={128} onChange={(event) => { setSearch(event.target.value); setCursors([]) }} placeholder="Search Marketplace" /></label>
      <div className="inv-actions" role="group" aria-label="Listings">
        <button className="btn" aria-pressed={!mine} onClick={() => { setMine(false); setCursors([]) }}>Browse</button>
        <button className="btn" aria-pressed={mine} onClick={() => { setMine(true); setCursors([]) }}>My listings</button>
      </div>
    </div>
    {accounts.length > 0 ? <details className="market-sell"><summary>Sell items from your inventory</summary><p>Open a player’s Inventory, select a bubble, then choose Send to Marketplace.</p><div className="inv-actions">{accounts.map((account) => <button key={account.uuid} className="btn" onClick={() => onOpenInventory(account.uuid)}>{account.username}’s inventory</button>)}</div></details> : <p className="note">Link a Minecraft account in Account to sell items or buy with its coins.</p>}
    {loadError && <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={() => setVersion((value) => value + 1)}>Retry loading Marketplace</button></div>}
    {message && <p className="note" data-tone="success" role="status">{message}</p>}
    {selected && <section key={selected.id} className="note inv-selection" aria-labelledby={formId} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); dismiss() } }}>
      <h2 ref={heading} tabIndex={-1} id={formId}>{itemName(selected.item)}</h2>
      <p>{slotDescription(selected.item)} · Seller: {selected.seller}</p>
      <p>Seller commission: {selected.commission_bps / 100}%, included in the displayed price. {selected.mine && `${selected.gross_sold.toLocaleString()} coins sold · ${selected.fee_paid.toLocaleString()} coins commission charged.`}</p>
      {selected.status !== 'active' ? <p>{selected.status === 'pending' ? 'Waiting for the game server to transfer these items.' : selected.status === 'conflict' ? 'The stack changed or could not be transferred. Nothing was listed.' : 'This listing is closed.'}</p>
        : selected.mine ? <><p>{selected.remaining} unsold items. Cancel this listing to return them to {selected.seller}’s inventory. Delivery waits for an empty storage slot.</p><button className="btn" disabled={busy} onClick={() => { void trade(true) }}>{busy ? 'Cancelling…' : 'Cancel listing & return items'}</button></>
        : <form onSubmit={(event) => { event.preventDefault(); void trade() }}>
          <fieldset disabled={busy || purchase !== null} className="market-buy-fields">
            <div className="market-fields">
              <label>Buy as<select value={buyerAccount?.uuid ?? ''} onChange={(event) => setBuyer(event.target.value)} required><option value="" disabled>Choose a linked player</option>{accounts.map((account) => <option key={account.uuid} value={account.uuid}>{account.username} · {account.coins.toLocaleString()} coins</option>)}</select></label>
              <label>Price option<select value={pricing} onChange={(event) => setPricing(event.target.value as 'unit' | 'lot')}>
                {selected.unit_price !== null && <option value="unit">Per item · {selected.unit_price.toLocaleString()} coins each</option>}
                {selected.lot_price !== null && <option value="lot">Whole lot · {selected.lot_price.toLocaleString()} coins</option>}
              </select></label>
              {pricing === 'unit' && <label>Quantity<input type="number" min="1" max={selected.remaining} step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>}
            </div>
          </fieldset>
          <p className="market-total">{purchase ? `Retrying the same purchase: ${purchase.body.quantity} items for ${purchase.body.expected_total.toLocaleString()} coins.` : valid ? `${amount} ${amount === 1 ? 'item' : 'items'} · ${total?.toLocaleString()} coins total` : 'Choose a valid quantity.'}</p>
          <p>Coins transfer immediately after purchase. Items arrive in {buyerAccount?.username ?? 'your player'}’s inventory once a storage slot is free, online or offline.</p>
          <button className="btn btn-primary" type="submit" disabled={busy || (!purchase && (!valid || !buyerAccount))}>{busy ? 'Confirming…' : purchase ? 'Retry purchase' : 'Confirm purchase'}</button>
        </form>}
      <button className="btn market-dismiss" disabled={busy} onClick={dismiss}>Close details</button>
      {error && <p role="alert">{error}</p>}
    </section>}
    {market === null && !loadError && <p className="loading">Loading Marketplace…</p>}
    {market && listings.length === 0 && <p className="note">{search ? 'No listings match your search.' : mine ? 'You have no listings yet. Send items from a player’s Inventory to start selling.' : 'No items are for sale yet. Send items from your Inventory to make the first listing.'}</p>}
    <ul className="market-listings" aria-label={mine ? 'Your listings' : 'Items for sale'}>
      {listings.map((listing) => <li className="market-listing" key={listing.id}>
        <ItemBubble slot={listing.item} onSelect={() => choose(listing)} />
        <div className="market-listing-copy"><button className="market-item-name" onClick={() => choose(listing)}>{itemName(listing.item)}</button><span>{listing.remaining} available · {listing.mine ? 'Your listing' : listing.seller}</span>
          {listing.status === 'active' ? <span className="market-prices">{listing.unit_price !== null && <span>{listing.unit_price.toLocaleString()} coins / item</span>}{listing.lot_price !== null && <span>{listing.lot_price.toLocaleString()} coins / whole lot</span>}</span> : <span>{listing.status === 'pending' ? 'Awaiting server transfer' : listing.status === 'conflict' ? 'Transfer unsuccessful' : 'Closed'}</span>}
        </div>
      </li>)}
    </ul>
    {market && (cursors.length > 0 || market.next_cursor) && <nav className="inv-actions" aria-label="Marketplace pages">
      <button className="btn" disabled={cursors.length === 0} onClick={() => setCursors((pages) => pages.slice(0, -1))}>Previous listings</button>
      <button className="btn" disabled={!market.next_cursor} onClick={() => { if (market.next_cursor) setCursors((pages) => [...pages, market.next_cursor!]) }}>More listings</button>
    </nav>}
    {market && market.deliveries.length > 0 && <section className="market-deliveries"><h2>Deliveries & returns</h2><p className="page-sub">Pending items wait safely for an empty storage slot. You can stay offline.</p><ul className="rows">{market.deliveries.map((delivery) => <li className="row" key={delivery.id}><span>{delivery.quantity} × {itemName(delivery.item)} → {delivery.username}</span><strong>{delivery.status === 'done' ? 'Delivered' : 'Waiting for inventory space / server'}</strong></li>)}</ul></section>}
  </>
}
