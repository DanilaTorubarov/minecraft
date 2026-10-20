import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectFuelCrystal,
  formatFuelTime,
  radiusToSize,
  PRIVATE_BLOCK_PRICES,
  FUEL_CRYSTAL_TYPES,
} from '../src/lib/fuel.ts'

test('detectFuelCrystal recognizes all 4 crystal tiers by display_name', () => {
  assert.deepEqual(
    detectFuelCrystal({ key: 'minecraft:raw_copper', amount: 1, damage: null, max_damage: null, display_name: '[Tier 1 Fuel: Ember Shard]', enchantments: {} }),
    FUEL_CRYSTAL_TYPES[1]
  )
  assert.deepEqual(
    detectFuelCrystal({ key: 'minecraft:prismarine_crystals', amount: 1, damage: null, max_damage: null, display_name: '§b[Tier 2 Fuel: Cobalt Crystal]', enchantments: {} }),
    FUEL_CRYSTAL_TYPES[2]
  )
  assert.deepEqual(
    detectFuelCrystal({ key: 'minecraft:redstone', amount: 4, damage: null, max_damage: null, display_name: 'Crimson Core', enchantments: {} }),
    FUEL_CRYSTAL_TYPES[3]
  )
  assert.deepEqual(
    detectFuelCrystal({ key: 'minecraft:echo_shard', amount: 1, damage: null, max_damage: null, display_name: 'Astral Void Crystal', enchantments: {} }),
    FUEL_CRYSTAL_TYPES[4]
  )
})

test('detectFuelCrystal rejects normal vanilla items without fuel names', () => {
  assert.equal(detectFuelCrystal(null), null)
  assert.equal(detectFuelCrystal(undefined), null)
  assert.equal(
    detectFuelCrystal({ key: 'minecraft:raw_copper', amount: 16, damage: null, max_damage: null, display_name: 'Raw Copper', enchantments: {} }),
    null
  )
  assert.equal(
    detectFuelCrystal({ key: 'minecraft:redstone', amount: 64, damage: null, max_damage: null, display_name: null, enchantments: {} }),
    null
  )
  assert.equal(
    detectFuelCrystal({ key: 'minecraft:diamond', amount: 1, damage: null, max_damage: null, display_name: 'Diamond', enchantments: {} }),
    null
  )
})

test('formatFuelTime renders depleted state and formatted hours, minutes, seconds', () => {
  assert.equal(formatFuelTime(0), '00:00:00 (Depleted)')
  assert.equal(formatFuelTime(-10), '00:00:00 (Depleted)')
  assert.equal(formatFuelTime(45), '0h 00m 45s')
  assert.equal(formatFuelTime(3665), '1h 01m 05s')
  assert.equal(formatFuelTime(7200), '2h 00m 00s')
  assert.equal(formatFuelTime(36000), '10h 00m 00s')
})

test('radiusToSize accurately maps protection radius to square block diameter', () => {
  assert.equal(radiusToSize(1), 3) // Tier 1: 3x3
  assert.equal(radiusToSize(3), 7) // Tier 2: 7x7
  assert.equal(radiusToSize(5), 11) // Tier 3: 11x11
  assert.equal(radiusToSize(7), 15) // Tier 4: 15x15
})

test('PRIVATE_BLOCK_PRICES matches the server prices for cores 1, 2, and 3', () => {
  assert.equal(PRIVATE_BLOCK_PRICES[1], 500)
  assert.equal(PRIVATE_BLOCK_PRICES[2], 20000)
  assert.equal(PRIVATE_BLOCK_PRICES[3], 50000)
})
