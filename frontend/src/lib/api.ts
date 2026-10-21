import type { ChestSpin, MinesRound, MinigameRules } from './minigames'

export type Me = {
  id: number
  displayed_nickname: string
  email: string
  login_displayed: string
  is_admin?: boolean
}

export type LinkedAccount = {
  uuid: string
  username: string
  linked_at: string
}

export type AccountStats = {
  play_seconds: number
  blocks_placed: number
  blocks_broken: number
  mobs_killed: number
  deaths: number
  /** hundredths of a block; 100 = 1 block */
  distance_cm: number
  items_crafted: number
  fish_caught: number
  /** hundredths of a heart; 100 = 1 heart */
  damage_dealt: number
  damage_taken: number
  logins: number
  items_picked_up: number
  items_enchanted: number
  tools_broken: number
  animals_bred: number
  times_slept: number
  advancements: number
  first_seen_at: string
  last_seen_at: string
}

export type StatsAccount = {
  skin_hash: string | null
  coins: number
  uuid: string
  username: string
  linked_at: string
  /** null when the game server has not reported activity for this UUID yet */
  stats: AccountStats | null
}

export type StatsSummary = {
  coins: number
  accounts: number
  accounts_with_stats: number
  play_seconds: number
  blocks_placed: number
  blocks_broken: number
  mobs_killed: number
  deaths: number
  /** hundredths of a block; 100 = 1 block */
  distance_cm: number
  items_crafted: number
  fish_caught: number
  /** hundredths of a heart; 100 = 1 heart */
  damage_dealt: number
  damage_taken: number
  logins: number
  items_picked_up: number
  items_enchanted: number
  tools_broken: number
  animals_bred: number
  times_slept: number
  advancements: number
}

export type StatsView = {
  accounts: StatsAccount[]
  summary: StatsSummary
}

export type LinkCode = {
  code: string
  expires_in: number
}

export type Registration = {
  displayed_nickname: string
  login: string
  email: string
  password: string
}

/**
 * Every failure the UI has to talk about is either an HTTP status or "the request
 * never left the browser", so both travel as one error carrying a status. Status
 * `0` means the fetch itself was rejected and the server never answered.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`api ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}

/** The two failures every form shares, before a page adds its own statuses. */
export function sharedMessage(status: number): string | null {
  if (status === 0) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  if (status === 429) {
    return 'Too many attempts from here. Wait a minute, then try again.'
  }
  return null
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0)
  }
}

/** The current account, or null when there is no usable session. */
export async function getMe(): Promise<Me | null> {
  const response = await send('GET', '/api/me')
  if (response.status === 401) {
    return null
  }
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return (await response.json()) as Me
}

export async function logIn(identifier: string, password: string): Promise<void> {
  const response = await send('POST', '/api/login', { identifier, password })
  if (!response.ok) {
    throw new ApiError(response.status)
  }
}

export type RegistrationChallenge = { challenge: string; expires_in: number; email_delivery: 'preview' | 'smtp' | 'unavailable' }

export async function register(input: Registration): Promise<RegistrationChallenge> {
  const response = await send('POST', '/api/register', input)
  if (response.status !== 202) throw new ApiError(response.status)
  return await response.json() as RegistrationChallenge
}

export async function confirmRegistration(challenge: string, code: string): Promise<void> {
  const response = await send('POST', '/api/register/confirm', { challenge, code })
  if (!response.ok) throw new ApiError(response.status)
}

export async function logOut(): Promise<void> {
  const response = await send('POST', '/api/logout')
  if (!response.ok) {
    throw new ApiError(response.status)
  }
}

export async function listLinks(): Promise<LinkedAccount[]> {
  const response = await send('GET', '/api/link')
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  const body = (await response.json()) as { accounts: LinkedAccount[] }
  return body.accounts
}

export type SecurityView = { email_verified: boolean; email_delivery: 'preview' | 'smtp' | 'unavailable' }

export async function getSecurity(): Promise<SecurityView> {
  const response = await send('GET', '/api/security')
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as SecurityView
}

export async function changePassword(current_password: string, new_password: string): Promise<void> {
  const response = await send('POST', '/api/security/password', { current_password, new_password })
  if (!response.ok) throw new ApiError(response.status)
}

export async function requestEmailConfirmation(current_password: string, new_email: string): Promise<void> {
  const response = await send('POST', '/api/security/email', { current_password, new_email })
  if (!response.ok) throw new ApiError(response.status)
}

export async function confirmEmail(token: string): Promise<void> {
  const response = await send('POST', '/api/security/email/confirm', { token })
  if (!response.ok) throw new ApiError(response.status)
}

export async function getStats(): Promise<StatsView> {
  const response = await send('GET', '/api/stats')
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return (await response.json()) as StatsView
}

export async function startLink(): Promise<LinkCode> {
  const response = await send('POST', '/api/link/start')
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return (await response.json()) as LinkCode
}

export async function unlink(uuid: string): Promise<void> {
  const response = await send('DELETE', `/api/link/${encodeURIComponent(uuid)}`)
  if (!response.ok) {
    throw new ApiError(response.status)
  }
}

/** `2026-10-15T21:04:11.123456Z` reads as `15 Oct 2026`. */
export function formatDate(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Seconds as a compact duration: `2d 4h`, `58m`, or `45s`. Whole units only, so
 * a play time never reads as a countdown or a fraction.
 */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(safe / 86400)
  const hours = Math.floor((safe % 86400) / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (hours > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`)
  }
  if (parts.length === 0) {
    parts.push(`${seconds}s`)
  }
  return parts.join(' ')
}

/** Seconds as `4:58`, so a countdown never reads as an ambiguous number. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

export type SkinView = {
  texture_hash: string | null
  model: 'classic' | 'slim'
  observed_at: string | null
  upload: { status: 'queued' | 'signing' | 'ready' | 'saved' | 'failed'; error: string | null } | null
}

/** One inventory slot as the game holds it; null means the slot is empty. */
export type InventorySlot = {
  fingerprint: string | null
  /** registry key, e.g. `minecraft:diamond_sword` */
  key: string
  amount: number
  /** wear already taken; only present for damageable items, in a pair with max_damage */
  damage: number | null
  max_damage: number | null
  /** a renamed item's plain-text name, when the player renamed it */
  display_name: string | null
  /** enchantment key (without the `minecraft:` prefix for display) to level */
  enchantments: Record<string, number>
  /** data URL of the item texture from the server jar, or null when none is stored */
  icon: string | null
} | null

/**
 * The 41-slot layout the plugin reports: hotbar 0-8, main inventory 9-35,
 * armor (helmet, chest, legs, boots) 36-39, off hand 40.
 */
export type InventoryView = {
  marketplace: { id: string; status: 'pending' | 'active' | 'conflict' | 'closed' } | null
  deletion: { request_id: string; slot: number; status: 'pending' | 'deleted' | 'conflict' } | null
  username: string | null
  /** when the game server last reported this snapshot, or null when never */
  updated_at: string | null
  slots: InventorySlot[] | null
}

export type MarketListingInput = { expected_commission_bps: number; slot: number; fingerprint: string; quantity: number; unit_price: number | null; lot_price: number | null }
export type MarketListing = {
  id: string; seller: string; mine: boolean; item: NonNullable<InventorySlot>;
  commission_bps: number; gross_sold: number; fee_paid: number;
  quantity: number; remaining: number; unit_price: number | null; lot_price: number | null;
  status: 'pending' | 'active' | 'conflict' | 'closed'
}
export type MarketView = {
  commission_bps: number;
  next_cursor: string | null;
  listings: MarketListing[];
  deliveries: { id: string; username: string; quantity: number; status: 'pending' | 'done'; item: NonNullable<InventorySlot> }[]
}
export type MarketPurchase = { request_id: string; buyer_uuid: string; quantity: number; pricing: 'unit' | 'lot'; expected_total: number; expected_remaining: number }
async function marketWrite(path: string, body: unknown): Promise<void> {
  let response: Response
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Marketplace': 'trade' }, body: JSON.stringify(body) })
  } catch { throw new ApiError(0) }
  if (!response.ok) throw new ApiError(response.status)
}
export type MarketQuote = { commission_bps: number; unit: { gross: number; fee: number; proceeds: number } | null; lot: { gross: number; fee: number; proceeds: number } | null }
export async function getMarketQuote(input: { quantity: number; unit_price: number | null; lot_price: number | null }): Promise<MarketQuote> {
  const response = await send('POST', '/api/marketplace/quote', input)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as MarketQuote
}
export async function sendInventoryToMarket(uuid: string, body: MarketListingInput): Promise<void> {
  await marketWrite(`/api/players/${encodeURIComponent(uuid)}/inventory/marketplace`, body)
}
export async function getMarketplace(options: { mine?: boolean; q?: string; cursor?: string } = {}): Promise<MarketView> {
  const query = new URLSearchParams({ mine: String(options.mine ?? false), q: options.q ?? '' })
  if (options.cursor) query.set('cursor', options.cursor)
  const response = await send('GET', `/api/marketplace?${query}`)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as MarketView
}
export async function buyMarketListing(id: string, body: MarketPurchase): Promise<void> {
  await marketWrite(`/api/marketplace/${encodeURIComponent(id)}/buy`, body)
}
export async function cancelMarketListing(id: string): Promise<void> {
  await marketWrite(`/api/marketplace/${encodeURIComponent(id)}/cancel`, {})
}

export async function getPlayerInventory(uuid: string): Promise<InventoryView> {
  const response = await send('GET', `/api/players/${encodeURIComponent(uuid)}/inventory`)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as InventoryView
}

export interface PrivateBlockView {
  id: string
  block_index: number
  world: string
  x: number
  y: number
  z: number
  placed: boolean
  radius: number
  size: number
  fuel_seconds: number
  fuel_tier: number
  tier_1_seconds?: number
  tier_2_seconds?: number
  tier_3_seconds?: number
  tier_4_seconds?: number
  members: string[]
  updated_at: string
}

export interface DepositFuelResult {
  fuel_seconds: number
  fuel_tier: number
  tier_1_seconds?: number
  tier_2_seconds?: number
  tier_3_seconds?: number
  tier_4_seconds?: number
  radius: number
  size: number
  added_seconds: number
}

export interface WithdrawFuelResult {
  fuel_seconds: number
  fuel_tier: number
  tier_1_seconds: number
  tier_2_seconds: number
  tier_3_seconds: number
  tier_4_seconds: number
  radius: number
  size: number
  withdrawn_crystals: number
}

export async function getPlayerPrivates(uuid: string): Promise<PrivateBlockView[]> {
  const response = await send('GET', `/api/players/${encodeURIComponent(uuid)}/privates`)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as PrivateBlockView[]
}

export async function depositPrivateFuel(uuid: string, blockIndex: number, slot: number): Promise<DepositFuelResult> {
  const response = await send('POST', `/api/players/${encodeURIComponent(uuid)}/privates/${blockIndex}/fuel`, { slot })
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as DepositFuelResult
}

export async function withdrawPrivateFuel(
  uuid: string,
  blockIndex: number,
  tier: number,
  amount = 1
): Promise<WithdrawFuelResult> {
  const response = await send('POST', `/api/players/${encodeURIComponent(uuid)}/privates/${blockIndex}/withdraw`, { tier, amount })
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as WithdrawFuelResult
}
export async function getPlayerSkin(uuid: string): Promise<SkinView> {
  const response = await send('GET', `/api/players/${encodeURIComponent(uuid)}/skin`)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as SkinView
}
export async function uploadPlayerSkin(uuid: string, file: File, model: 'classic' | 'slim'): Promise<void> {
  const data = new FormData()
  data.append('file', file)
  data.append('model', model)
  let response: Response
  try { response = await fetch(`/api/players/${encodeURIComponent(uuid)}/skin`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Player-Skin': 'upload' }, body: data }) }
  catch { throw new ApiError(0) }
  if (!response.ok) throw new ApiError(response.status)
}

// --- Minigames -------------------------------------------------------------
//
// Every one of these speaks in the same coins as the game server and `/bal`. The
// browser never sends an outcome: it names the payer, the stake, the cell it
// wants open, or that it wants to cash out.

/** The server's paytable and stake limits. Public, and the same numbers it pays. */
export async function getMinigameRules(): Promise<MinigameRules> {
  const response = await send('GET', '/api/minigames/config')
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as MinigameRules
}

/** The Minesweeper round this user already paid for, so a reload resumes it. */
export async function getMinigameState(): Promise<MinesRound | null> {
  const response = await send('GET', '/api/minigames/state')
  if (!response.ok) throw new ApiError(response.status)
  const body = await response.json() as { active: MinesRound | null }
  return body.active
}

/**
 * Charges the stake and rolls the reels in one server-side transaction.
 * `client_id` identifies the spin rather than the round: sending it again after a
 * lost response returns the same spin and never charges twice.
 */
export async function spinChest(input: { uuid: string; bet: number; client_id: string; economy_level?: number }): Promise<ChestSpin> {
  const response = await send('POST', '/api/minigames/chest/spin', input)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as ChestSpin
}

export async function startMines(input: { uuid: string; bet: number; mines: number; economy_level?: number }): Promise<MinesRound> {
  const response = await send('POST', '/api/minigames/mines/start', input)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as MinesRound
}

/** Opening the same cell twice is not an error: the round comes back unchanged. */
export async function revealMines(roundId: string, cell: number): Promise<MinesRound> {
  const response = await send('POST', '/api/minigames/mines/reveal', { round_id: roundId, cell })
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as MinesRound
}

/** Repeating a successful cash-out returns the settled round and pays nothing more. */
export async function cashOutMines(roundId: string): Promise<MinesRound> {
  const response = await send('POST', '/api/minigames/mines/cashout', { round_id: roundId })
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as MinesRound
}

// --- Admin Endpoints --------------------------------------------------------

export type AdminAccount = {
  uuid: string
  username: string
  user_id: number | null
  coins: number
  is_self: boolean
}

export type AdminBalanceResult = {
  uuid: string
  username: string
  previous_coins: number
  new_coins: number
}

export async function getAdminAccounts(): Promise<AdminAccount[]> {
  const response = await fetch('/api/admin/accounts')
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as AdminAccount[]
}

export async function adjustAdminBalance(input: {
  uuid: string
  operation: 'set' | 'add' | 'subtract'
  amount: number
}): Promise<AdminBalanceResult> {
  const response = await send('POST', '/api/admin/balance', input)
  if (!response.ok) throw new ApiError(response.status)
  return await response.json() as AdminBalanceResult
}

// --- Live Chat Integration --------------------------------------------------

export type ChatMessage = {
  id: number
  sender_name: string
  sender_uuid: string | null
  text: string
  source: 'game' | 'web' | 'system'
  created_at: string
}

export async function getChatMessages(sinceId?: number, limit = 50): Promise<ChatMessage[]> {
  const params = new URLSearchParams()
  if (sinceId !== undefined) params.set('since_id', String(sinceId))
  if (limit !== 50) params.set('limit', String(limit))
  const url = `/api/chat/messages${params.toString() ? '?' + params.toString() : ''}`
  const response = await fetch(url)
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as ChatMessage[]
}

export async function sendChatMessage(text: string): Promise<ChatMessage> {
  const response = await send('POST', '/api/chat/messages', { text })
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as ChatMessage
}

// --- Hall of Fame & Leaderboards -------------------------------------------

export type LeaderboardEntry = {
  rank: number
  uuid: string
  username: string
  value: number
  formatted: string
  skin_hash: string | null
}

export type LeaderboardResponse = {
  category: string
  category_label: string
  entries: LeaderboardEntry[]
}

export async function getLeaderboards(category = 'balance', limit = 50): Promise<LeaderboardResponse> {
  const params = new URLSearchParams()
  if (category) params.set('category', category)
  if (limit !== 50) params.set('limit', String(limit))
  const url = `/api/leaderboards${params.toString() ? '?' + params.toString() : ''}`
  const response = await fetch(url)
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as LeaderboardResponse
}

// --- Offline Mail & Delivery Parcels --------------------------------------

export type Parcel = {
  id: string
  sender_uuid: string
  sender_username: string
  recipient_uuid: string
  recipient_username: string
  coins: number
  item: InventorySlot | null
  quantity: number
  message: string
  status: 'pending' | 'claimed' | 'cancelled'
  source: 'inventory' | 'marketplace' | 'direct'
  created_at: string
  claimed_at: string | null
}

export type SendParcelInput = {
  sender_uuid: string
  recipient_username: string
  coins?: number
  slot?: number
  fingerprint?: string
  quantity?: number
  message?: string
}

export type MarketGiftInput = {
  buyer_uuid: string
  recipient_username: string
  request_id: string
  quantity: number
  pricing: 'unit' | 'lot'
  expected_total: number
  expected_remaining: number
  message?: string
}

export async function sendParcel(input: SendParcelInput): Promise<Parcel> {
  const response = await send('POST', '/api/parcels/send', input)
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as Parcel
}

export async function getParcels(): Promise<{ received: Parcel[]; sent: Parcel[] }> {
  const response = await fetch('/api/parcels')
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as { received: Parcel[]; sent: Parcel[] }
}

export async function giftMarketListing(id: string, input: MarketGiftInput): Promise<void> {
  const response = await fetch(`/api/marketplace/${encodeURIComponent(id)}/gift`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-marketplace': 'trade' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new ApiError(response.status)
}

// --- Territory Defense Alerts ----------------------------------------------

export type TerritoryAlert = {
  id: string
  uuid: string
  kind: 'breach' | 'fuel_low'
  title: string
  message: string
  block_index?: number
  world?: string
  x?: number
  y?: number
  z?: number
  fuel_seconds?: number
  read: boolean
  created_at: string
}

export async function getTerritoryAlerts(): Promise<TerritoryAlert[]> {
  const response = await fetch('/api/territory/alerts')
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as TerritoryAlert[]
}

export async function markTerritoryAlertsRead(): Promise<void> {
  const response = await send('POST', '/api/territory/alerts/read', {})
  if (!response.ok) throw new ApiError(response.status)
}
