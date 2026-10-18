import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STAT_GROUPS,
  STAT_METRIC_KEYS,
  countersOf,
  formatDamage,
  formatDistance,
} from '../src/lib/statsFormat.ts'

test('distance renders blocks under a kilometre and kilometres beyond', () => {
  assert.equal(formatDistance(0), '0 blocks')
  assert.equal(formatDistance(150), '1.5 blocks')
  assert.equal(formatDistance(99900), '999 blocks')
  assert.equal(formatDistance(120000), '1.2 km')
  assert.equal(formatDistance(1234567), '12.35 km')
})

test('damage renders hearts with at most one decimal', () => {
  assert.equal(formatDamage(0), '0 hearts')
  assert.equal(formatDamage(50), '0.5 hearts')
  assert.equal(formatDamage(100), '1 heart')
  assert.equal(formatDamage(150), '1.5 hearts')
  assert.equal(formatDamage(123450), '1,234.5 hearts')
})

test('the catalog covers every reported counter exactly once', () => {
  assert.deepEqual(new Set(STAT_METRIC_KEYS).size, STAT_METRIC_KEYS.length, 'no metric listed twice')
  const expected = [
    'play_seconds', 'blocks_placed', 'blocks_broken',
    'mobs_killed', 'deaths', 'distance_cm', 'items_crafted', 'fish_caught',
    'damage_dealt', 'damage_taken', 'logins', 'items_picked_up',
    'items_enchanted', 'tools_broken', 'animals_bred', 'times_slept', 'advancements',
  ]
  assert.deepEqual([...STAT_METRIC_KEYS].sort(), [...expected].sort())
  for (const group of STAT_GROUPS) {
    assert.ok(group.title.length > 0, 'every group has a heading')
    for (const metric of group.metrics) {
      assert.ok(metric.label.length > 0, 'every metric has a label')
      assert.doesNotThrow(() => metric.format(123))
    }
  }
})

test('countersOf keeps only reported numbers and never invents one', () => {
  const stats = countersOf({
    play_seconds: 3600,
    blocks_placed: 10,
    blocks_broken: 7,
    mobs_killed: 3,
    deaths: 1,
    distance_cm: 1234,
    items_crafted: 5,
    fish_caught: 2,
    damage_dealt: 250,
    damage_taken: 400,
    logins: 2,
    items_picked_up: 11,
    items_enchanted: 1,
    tools_broken: 0,
    animals_bred: 0,
    times_slept: 4,
    advancements: 2,
  })
  assert.equal(stats.play_seconds, 3600)
  assert.equal(stats.mobs_killed, 3)
  assert.equal(stats.distance_cm, 1234)
  // A counter the server omitted stays a real zero, not a guess.
  const empty = countersOf({})
  for (const key of STAT_METRIC_KEYS) {
    assert.equal(empty[key], 0, `${key} defaults to zero`)
  }
  // Fractions from a future payload are truncated, not rounded up.
  assert.equal(countersOf({ play_seconds: 59.9 }).play_seconds, 59)
  assert.equal(countersOf({ play_seconds: Number.NaN }).play_seconds, 0)
  assert.equal(countersOf({ play_seconds: -3 }).play_seconds, 0)
})
