import type { InventorySlot } from './api'

export interface FuelCrystalInfo {
  tier: number
  name: string
  hours: number
  addedSeconds: number
  footprint: string
}

export const FUEL_CRYSTAL_TYPES: Record<number, FuelCrystalInfo> = {
  1: { tier: 1, name: 'Ember Shard', hours: 2, addedSeconds: 7200, footprint: '3×3' },
  2: { tier: 2, name: 'Cobalt Crystal', hours: 3, addedSeconds: 10800, footprint: '7×7' },
  3: { tier: 3, name: 'Crimson Core', hours: 4, addedSeconds: 14400, footprint: '11×11' },
  4: { tier: 4, name: 'Astral Void Crystal', hours: 6, addedSeconds: 21600, footprint: '15×15' },
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
  return 2 * radius + 1
}

export const PRIVATE_BLOCK_PRICES: Record<number, number> = {
  1: 500,
  2: 20000,
  3: 50000,
}
