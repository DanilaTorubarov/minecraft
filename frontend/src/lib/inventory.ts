import type { InventorySlot } from './api'

/** The plain name a bubble talks about: the rename, or the item key with `minecraft:` and underscores tidied. */
export function itemName(slot: NonNullable<InventorySlot>): string {
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

export function slotDescription(slot: NonNullable<InventorySlot>): string {
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

