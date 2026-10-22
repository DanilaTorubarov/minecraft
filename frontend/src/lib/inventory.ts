import type { InventorySlot } from './api'

/**
 * Strips Minecraft color codes (§0-§f, §k-§r) and clean up raw string brackets.
 */
export function cleanItemName(name: string): string {
  return name.replace(/§[0-9a-fk-or]/gi, '').replace(/^\[|\]$/g, '').trim()
}

/** The plain name a bubble talks about: the rename, or the item key with `minecraft:` and underscores tidied. */
export function itemName(slot: NonNullable<InventorySlot>): string {
  if (slot.display_name) {
    return cleanItemName(slot.display_name)
  }
  const bare = slot.key.replace(/^minecraft:/, '').replace(/_/g, ' ')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

function enchantmentNames(slot: NonNullable<InventorySlot>): string {
  return Object.entries(slot.enchantments)
    .map(([key, level]) => `${key.replace(/^minecraft:/, '').replace(/_/g, ' ')} ${level}`)
    .join(', ')
}

/**
 * Remaining uses out of the item's maximum wear, or null when the item cannot wear.
 * The exact pair is what a player trading a tool actually needs; a percentage rounded
 * to a whole number hides too much.
 */
export function durabilityParts(slot: NonNullable<InventorySlot>): { remaining: number; max: number } | null {
  if (slot.damage === null || slot.max_damage === null || slot.max_damage <= 0) {
    return null
  }
  return {
    remaining: Math.max(0, slot.max_damage - Math.max(0, slot.damage)),
    max: slot.max_damage,
  }
}

/** The same pair as text, e.g. `1171/1561`. */
export function durabilityText(slot: NonNullable<InventorySlot>): string | null {
  const parts = durabilityParts(slot)
  return parts === null ? null : `${parts.remaining}/${parts.max}`
}

export function slotDescription(slot: NonNullable<InventorySlot>): string {
  const parts = [itemName(slot)]
  if (slot.amount > 1) {
    parts.push(`× ${slot.amount}`)
  }
  const durability = durabilityText(slot)
  if (durability !== null) {
    parts.push(`${durability} durability`)
  }
  const enchantments = enchantmentNames(slot)
  if (enchantments !== '') {
    parts.push(enchantments)
  }
  return parts.join(' · ')
}

