import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFuelCriticallyLow,
  formatFuelRemaining,
  parcelSummary,
  isBreachAlert,
  isLowFuelAlert,
} from '../src/lib/parcels.ts'

test('fuel is critically low when under 2 hours (7200 seconds) and above zero', () => {
  assert.equal(isFuelCriticallyLow(7200), true)
  assert.equal(isFuelCriticallyLow(7199), true)
  assert.equal(isFuelCriticallyLow(3600), true)
  assert.equal(isFuelCriticallyLow(1), true)
  assert.equal(isFuelCriticallyLow(0), false)
  assert.equal(isFuelCriticallyLow(-10), false)
  assert.equal(isFuelCriticallyLow(7201), false)
  assert.equal(isFuelCriticallyLow(14400), false)
})

test('formatFuelRemaining formats hours and minutes properly', () => {
  assert.equal(formatFuelRemaining(0), 'Depleted')
  assert.equal(formatFuelRemaining(-5), 'Depleted')
  assert.equal(formatFuelRemaining(60), '1m')
  assert.equal(formatFuelRemaining(3600), '1h 0m')
  assert.equal(formatFuelRemaining(7140), '1h 59m')
  assert.equal(formatFuelRemaining(7200), '2h 0m')
})

test('parcelSummary describes coins, items, and mixed bundles', () => {
  assert.equal(
    parcelSummary({ coins: 500, quantity: 0, item: null }),
    '500 coins'
  )
  assert.equal(
    parcelSummary({ coins: 1, quantity: 0, item: null }),
    '1 coin'
  )
  assert.equal(
    parcelSummary({
      coins: 0,
      quantity: 5,
      item: { key: 'minecraft:diamond', amount: 5, display_name: 'Shiny Diamond' },
    }),
    '5x Shiny Diamond'
  )
  assert.equal(
    parcelSummary({
      coins: 250,
      quantity: 1,
      item: { key: 'minecraft:iron_sword', amount: 1, display_name: null },
    }),
    '250 coins + 1x iron sword'
  )
})

test('alert classification identifies breach and fuel alert kinds', () => {
  const breach = { kind: 'breach' as const }
  const fuel = { kind: 'fuel_low' as const }

  assert.equal(isBreachAlert(breach), true)
  assert.equal(isLowFuelAlert(breach), false)
  assert.equal(isBreachAlert(fuel), false)
  assert.equal(isLowFuelAlert(fuel), true)
})
