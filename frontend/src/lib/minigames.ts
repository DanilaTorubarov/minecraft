// Minigame rules, wire types and the small decisions the window has to make.
//
// Deliberately imports nothing: `node --test` loads this file directly, and the
// project's tests may only touch asset-free modules. Icons and React live in the
// components; the numbers and the messages live here.
//
// Balances and stakes are whole coins; multipliers are integer hundredths.

export type ChestSymbolRules = {
  id: string
  triple_x100: number
  pair_x100: number
}

export type ChestRules = {
  symbols: ChestSymbolRules[]
  single_diamond_x100: number
  triple_chance_x10000: number
  pair_chance_x10000: number
  single_diamond_chance_x10000: number
  /** Expected return per coin staked, in hundredths of a percent: 9180 = 91.8%. */
  rtp_x10000: number
}

export type MinesPresetRules = {
  mines: number
  min_safe: number
  boost_iron: number
  boost_gold: number
  boost_diamond: number
  rtp_x10000: number
}

export type MinesRules = {
  cells: number
  min_safe: number
  starting_x100: number
  presets: MinesPresetRules[]
}

export type MinigameRules = {
  min_bet: number
  max_bet: number
  chest: ChestRules
  mines: MinesRules
}

/** One paid-for chest spin. The reels are the server's roll, not the browser's. */
export type ChestSpin = {
  round_id: string
  bet: number
  reels: string[]
  multiplier_x100: number
  payout: number
  balance: number
}

export type OreContent = 'tnt' | 'iron' | 'gold' | 'diamond'

export type MinesCell = {
  cell: number
  content: OreContent
}

/** The Minesweeper round as the server describes it; only revealed cells are named. */
export type MinesRound = {
  round_id: string
  payer_uuid: string
  bet: number
  mines: number
  min_safe: number
  /** hundredths: 170 = x1.70 */
  multiplier_x100: number
  /** what cashing out now would pay */
  cashout: number
  status: 'active' | 'settled'
  outcome: 'paid' | 'lost' | 'expired' | null
  payout: number
  balance: number
  revealed: MinesCell[]
}

/** Who is paying: one linked Minecraft account and the coins on its UUID. */
export type Payer = {
  uuid: string
  username: string
  coins: number
}

export const CHEST_LABELS: Record<string, string> = {
  diamond: 'Diamond', heart_of_the_sea: 'Heart of the Sea', trident: 'Trident',
  nautilus_shell: 'Nautilus Shell', prismarine_crystals: 'Prismarine Crystals',
  prismarine_shard: 'Prismarine Shard', pufferfish: 'Pufferfish', tropical_fish: 'Tropical Fish',
}

export const ORE_LABELS: Record<Exclude<OreContent, 'tnt'>, string> = {
  iron: 'Iron', gold: 'Gold', diamond: 'Diamond',
}

export function formatCoins(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US')
}

/** `170` reads as `x1.70`; a multiplier is never shown with a hidden remainder. */
export function formatMultiplier(x100: number): string {
  return `x${(Math.max(0, x100) / 100).toFixed(2)}`
}

/** `35` reads as `+0.35x`: one ore's contribution to the running multiplier. */
export function formatBoost(x100: number): string {
  return `+${(Math.max(0, x100) / 100).toFixed(2)}x`
}

/** `9180` reads as `91.8%`. */
export function formatReturn(x10000: number): string {
  return `${(x10000 / 100).toFixed(1)}%`
}

/**
 * A stake the server would accept and the payer can cover. When the balance is
 * below the table minimum there is nothing to clamp to, so the minimum comes
 * back and `canAfford` stays false: the window disables play rather than showing
 * a bet that cannot be placed.
 */
export function clampBet(value: number, minBet: number, maxBet: number, balance: number): number {
  const ceiling = Math.max(minBet, Math.min(maxBet, Math.floor(balance)))
  if (!Number.isFinite(value)) {
    return Math.min(minBet, ceiling)
  }
  return Math.max(minBet, Math.min(ceiling, Math.floor(value)))
}

export function canAfford(bet: number, balance: number): boolean {
  return bet <= balance
}

export type MinigameFailure = {
  kind: 'network' | 'auth' | 'unlinked' | 'balance' | 'invalid' | 'unavailable'
  message: string
}

/**
 * One status, one sentence. Every 409 from the minigames means the same thing —
 * the balance does not cover the stake — so the player gets advice they can act on.
 */
export function minigameFailure(status: number): MinigameFailure {
  if (status === 0) {
    return { kind: 'network', message: 'Connection lost. Retry to recover the same request.' }
  }
  if (status === 401) {
    return { kind: 'auth', message: 'Your session expired. Sign in again.' }
  }
  if (status === 404) {
    return { kind: 'unlinked', message: 'This Minecraft player is no longer linked to your account.' }
  }
  if (status === 409) {
    return { kind: 'balance', message: 'This player does not have enough coins for that stake.' }
  }
  if (status === 400) {
    return { kind: 'invalid', message: 'The request was refused. Check the stake and difficulty.' }
  }
  return { kind: 'unavailable', message: 'The server could not complete the request. Please retry.' }
}

/**
 * The id a spin is charged under, so a retried request returns the same spin
 * instead of buying a second one. `randomUUID` needs a secure context, so a LAN
 * visit over plain http falls back to `getRandomValues`.
 */
export function newClientId(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The remembered payer if that account is still linked, otherwise the oldest
 * linked one. Never invents an account: no links means nobody can pay.
 */
export function choosePayer<T extends { uuid: string }>(accounts: T[], preferred: string | null): T | null {
  if (accounts.length === 0) {
    return null
  }
  return accounts.find((account) => account.uuid === preferred) ?? accounts[0]
}

/** The cells a finished round shows in full, or the ones opened so far. */
export function revealedCells(round: MinesRound): Map<number, OreContent> {
  return new Map(round.revealed.map((cell) => [cell.cell, cell.content]))
}

/** Cleared safe cells so far; the auto-complete win happens when this reaches cells - mines. */
export function safeCellsOpened(round: MinesRound): number {
  return round.revealed.filter((cell) => cell.content !== 'tnt').length
}

/** A pause the reel animation can await; works in the browser and under `node --test`. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
