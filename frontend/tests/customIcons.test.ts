import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isProtectionCoreItem,
  getCustomItemIcon,
  getFuelTierIcon,
  PROTECTION_CORE_ICON,
  FUEL_TIER_1_ICON,
  FUEL_TIER_2_ICON,
  FUEL_TIER_3_ICON,
  FUEL_TIER_4_ICON,
} from '../src/lib/customIcons.ts'
import type { InventorySlot } from '../src/lib/api.ts'

describe('custom item and fuel crystal icons', () => {
  it('identifies protection core item by display_name or key', () => {
    const coreSlot: InventorySlot = {
      key: 'minecraft:lodestone',
      amount: 1,
      damage: null,
      max_damage: null,
      display_name: '§6§l[Protection Core]',
      enchantments: {},
      icon: null,
      fingerprint: 'core-1',
    }
    assert.equal(isProtectionCoreItem(coreSlot), true)
    assert.equal(getCustomItemIcon(coreSlot), PROTECTION_CORE_ICON)

    const vanillaLodestone: InventorySlot = {
      key: 'minecraft:lodestone',
      amount: 1,
      damage: null,
      max_damage: null,
      display_name: null,
      enchantments: {},
      icon: null,
      fingerprint: null,
    }
    assert.equal(isProtectionCoreItem(vanillaLodestone), true)
    assert.equal(getCustomItemIcon(vanillaLodestone), PROTECTION_CORE_ICON)
  })

  it('resolves dedicated crystal icons for all 4 fuel tiers', () => {
    const tier1: InventorySlot = {
      key: 'minecraft:raw_copper',
      amount: 5,
      damage: null,
      max_damage: null,
      display_name: '§6[Tier 1 Fuel: Ember Shard]',
      enchantments: {},
      icon: null,
      fingerprint: 'fuel-1',
    }
    assert.equal(getCustomItemIcon(tier1), FUEL_TIER_1_ICON)
    assert.equal(getFuelTierIcon(1), FUEL_TIER_1_ICON)

    const tier2: InventorySlot = {
      key: 'minecraft:prismarine_crystals',
      amount: 2,
      damage: null,
      max_damage: null,
      display_name: '§b[Tier 2 Fuel: Cobalt Crystal]',
      enchantments: {},
      icon: null,
      fingerprint: 'fuel-2',
    }
    assert.equal(getCustomItemIcon(tier2), FUEL_TIER_2_ICON)
    assert.equal(getFuelTierIcon(2), FUEL_TIER_2_ICON)

    const tier3: InventorySlot = {
      key: 'minecraft:redstone',
      amount: 10,
      damage: null,
      max_damage: null,
      display_name: '§c[Tier 3 Fuel: Crimson Core]',
      enchantments: {},
      icon: null,
      fingerprint: 'fuel-3',
    }
    assert.equal(getCustomItemIcon(tier3), FUEL_TIER_3_ICON)
    assert.equal(getFuelTierIcon(3), FUEL_TIER_3_ICON)

    const tier4: InventorySlot = {
      key: 'minecraft:echo_shard',
      amount: 1,
      damage: null,
      max_damage: null,
      display_name: '§d[Tier 4 Fuel: Astral Void Crystal]',
      enchantments: {},
      icon: null,
      fingerprint: 'fuel-4',
    }
    assert.equal(getCustomItemIcon(tier4), FUEL_TIER_4_ICON)
    assert.equal(getFuelTierIcon(4), FUEL_TIER_4_ICON)
  })

  it('returns null custom icon for vanilla items', () => {
    const vanillaDiamond: InventorySlot = {
      key: 'minecraft:diamond_sword',
      amount: 1,
      damage: 10,
      max_damage: 1561,
      display_name: null,
      enchantments: {},
      icon: 'data:image/png;base64,...',
      fingerprint: 'sword-1',
    }
    assert.equal(isProtectionCoreItem(vanillaDiamond), false)
    assert.equal(getCustomItemIcon(vanillaDiamond), null)
  })
})
