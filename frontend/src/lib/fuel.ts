import type { InventorySlot } from './api'

export interface FuelCrystalInfo {
  tier: number
  name: string
  hours: number
  addedSeconds: number
  footprint: string
}

export const FUEL_CRYSTAL_TYPES: Record<number, FuelCrystalInfo> = {
  1: { tier: 1, name: 'Ember Shard', hours: 2, addedSeconds: 7200, footprint: '2×2 chunks (32×32)' },
  2: { tier: 2, name: 'Cobalt Crystal', hours: 3, addedSeconds: 10800, footprint: '5×5 chunks (80×80)' },
  3: { tier: 3, name: 'Crimson Core', hours: 4, addedSeconds: 14400, footprint: '10×10 chunks (160×160)' },
  4: { tier: 4, name: 'Astral Void Crystal', hours: 6, addedSeconds: 21600, footprint: '16×16 chunks (256×256)' },
}

export function detectFuelCrystal(slot: InventorySlot | null | undefined): FuelCrystalInfo | null {
  if (!slot) return null
  const display = slot.display_name ?? ''
  if (display.includes('Tier 1 Fuel') || display.includes('Ember Shard')) {
    return FUEL_CRYSTAL_TYPES[1]
  }
  if (display.includes('Tier 2 Fuel') || display.includes('Cobalt Crystal')) {
    return FUEL_CRYSTAL_TYPES[2]
  }
  if (display.includes('Tier 3 Fuel') || display.includes('Crimson Core')) {
    return FUEL_CRYSTAL_TYPES[3]
  }
  if (display.includes('Tier 4 Fuel') || display.includes('Astral Void Crystal')) {
    return FUEL_CRYSTAL_TYPES[4]
  }
  return null
}

export function formatFuelTime(seconds: number): string {
  if (seconds <= 0) return '00:00:00 (Depleted)'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${h}h ${pad(m)}m ${pad(s)}s`
}

export function radiusToSize(radius: number): number {
  switch (radius) {
    case 16: return 32
    case 40: return 80
    case 80: return 160
    case 128: return 256
    default: return radius * 2
  }
}

export function radiusToChunks(radius: number): number {
  switch (radius) {
    case 16: return 2
    case 40: return 5
    case 80: return 10
    case 128: return 16
    default: return Math.max(1, Math.floor((radius * 2) / 16))
  }
}

export const PRIVATE_BLOCK_PRICES: Record<number, number> = {
  1: 500,
  2: 20000,
  3: 50000,
}

export function canWithdrawFuel(tierSeconds: number, tier: number, count = 1): boolean {
  const crystal = FUEL_CRYSTAL_TYPES[tier]
  if (!crystal || count <= 0) return false
  return tierSeconds >= crystal.addedSeconds * count
}

export function crystalsAvailable(tierSeconds: number, tier: number): number {
  const crystal = FUEL_CRYSTAL_TYPES[tier]
  if (!crystal || tierSeconds <= 0) return 0
  return Math.floor(tierSeconds / crystal.addedSeconds)
}
