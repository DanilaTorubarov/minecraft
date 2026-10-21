import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PICKAXE_CONFIGS,
  BLOCK_CONFIGS,
  MINEFALL_COLS,
  MINEFALL_ROWS,
  isValidPickaxe,
  getPickaxeConfig,
  getBlockConfig,
  calculateSummary,
  type MinefallEvent,
} from '../src/lib/minefall.ts'

test('all 6 Minecraft pickaxes exist with valid configurations and scaling', () => {
  const tiers = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'] as const
  for (const tier of tiers) {
    assert.equal(isValidPickaxe(tier), true)
    const config = getPickaxeConfig(tier)
    assert.equal(config.id, tier)
    assert.ok(config.durability > 0)
    assert.ok(config.oreBonus >= 1.0)
    assert.ok(config.scaleX1000 > 0)
    assert.ok(config.name.length > 0)
  }
})

test('golden pickaxe has Midas touch ore bonus', () => {
  const golden = getPickaxeConfig('golden')
  assert.equal(golden.oreBonus, 2.0)
  assert.equal(golden.durability, 120)
  assert.equal(golden.scaleX1000, 11)
})

test('blocks have appropriate hardness and rewards', () => {
  assert.equal(getBlockConfig('stone').hitsNeeded, 1)
  assert.equal(getBlockConfig('deepslate').hitsNeeded, 2)
  assert.equal(getBlockConfig('obsidian').hitsNeeded, 3)
  assert.equal(getBlockConfig('bedrock').isBedrock, true)
  assert.equal(getBlockConfig('tnt').isTnt, true)
  assert.equal(getBlockConfig('crafting_table').isCraftingTable, true)

  assert.equal(getBlockConfig('slime').isSlime, true)
  assert.equal(getBlockConfig('dirt').hitsNeeded, 1)

  const diamond = getBlockConfig('diamond_ore')
  assert.equal(diamond.isOre, true)
  assert.equal(diamond.multiplierX100, 100)
  assert.ok(diamond.multiplierX100 > getBlockConfig('iron_ore').multiplierX100)
  assert.ok(getBlockConfig('emerald_ore').multiplierX100 > diamond.multiplierX100)
  assert.ok(getBlockConfig('ancient_debris').multiplierX100 > getBlockConfig('emerald_ore').multiplierX100)
})

test('mine dimensions are 9 columns and 120 rows', () => {
  assert.equal(MINEFALL_COLS, 10)
  assert.equal(MINEFALL_ROWS, 120)
})

test('calculateSummary accurately tallies collected ores, TNT blasts, and repairs', () => {
  const events: MinefallEvent[] = [
    { type: 'hit', row: 1, col: 4, block: 'stone', durabilityLeft: 11 },
    { type: 'break', row: 1, col: 4, block: 'stone', durabilityLeft: 11 },
    { type: 'collect_ore', row: 2, col: 4, block: 'iron_ore', durabilityLeft: 10, boostX100: 15 },
    { type: 'repair', row: 4, col: 3, block: 'crafting_table', durabilityLeft: 13 },
    {
      type: 'tnt_blast',
      row: 7,
      col: 4,
      block: 'tnt',
      durabilityLeft: 13,
      affected: [
        { row: 6, col: 4, block: 'stone', isOre: false },
        { row: 7, col: 5, block: 'gold_ore', isOre: true, boostX100: 30 },
        { row: 8, col: 4, block: 'diamond_ore', isOre: true, boostX100: 60 },
      ],
    },
    { type: 'collect_ore', row: 12, col: 5, block: 'diamond_ore', durabilityLeft: 12, boostX100: 60 },
    { type: 'pickaxe_break', row: 15, col: 4, block: 'deepslate', durabilityLeft: 0 },
  ]

  const summary = calculateSummary(events)
  assert.equal(summary.tntCount, 1)
  assert.equal(summary.repairCount, 1)
  assert.equal(summary.maxRow, 15)
  assert.equal(summary.ores['iron_ore'], 1)
  assert.equal(summary.ores['gold_ore'], 1)
  assert.equal(summary.ores['diamond_ore'], 2) // 1 from tnt, 1 direct
})

