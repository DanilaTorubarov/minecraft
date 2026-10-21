// Minefall minigame rules, wire types and pure simulation helpers.
// Deliberately asset-free so `node --test` can import it directly.

export type PickaxeTier = 'wooden' | 'stone' | 'iron' | 'golden' | 'diamond' | 'netherite'

export type BlockType =
  | 'air'
  | 'stone'
  | 'deepslate'
  | 'obsidian'
  | 'bedrock'
  | 'tnt'
  | 'crafting_table'
  | 'coal_ore'
  | 'copper_ore'
  | 'iron_ore'
  | 'gold_ore'
  | 'redstone_ore'
  | 'lapis_ore'
  | 'diamond_ore'
  | 'emerald_ore'
  | 'ancient_debris'

export type PickaxeConfig = {
  id: PickaxeTier
  name: string
  durability: number
  oreBonus: number
  scaleX1000: number
  description: string
}

export type BlockConfig = {
  id: BlockType
  name: string
  hitsNeeded: number
  multiplierX100: number
  isOre: boolean
  isTnt: boolean
  isCraftingTable: boolean
  isBedrock: boolean
}

export const PICKAXE_CONFIGS: Record<PickaxeTier, PickaxeConfig> = {
  wooden: {
    id: 'wooden',
    name: 'Wooden Pickaxe',
    durability: 6,
    oreBonus: 1.0,
    scaleX1000: 2620,
    description: 'High Volatility · 6 durability. Fragile wood, but rare ore finds yield massive 2.6x rewards!',
  },
  stone: {
    id: 'stone',
    name: 'Stone Pickaxe',
    durability: 10,
    oreBonus: 1.0,
    scaleX1000: 1430,
    description: 'Medium Volatility · 10 durability. Reliable stone tool with balanced risk.',
  },
  iron: {
    id: 'iron',
    name: 'Iron Pickaxe',
    durability: 16,
    oreBonus: 1.0,
    scaleX1000: 660,
    description: 'Balanced · 16 durability. Standard miner pickaxe with smooth depth.',
  },
  golden: {
    id: 'golden',
    name: 'Golden Pickaxe',
    durability: 5,
    oreBonus: 2.0,
    scaleX1000: 1570,
    description: 'Midas Rush · 5 durability. Extremely brittle, but 2x gold value and huge vein payouts!',
  },
  diamond: {
    id: 'diamond',
    name: 'Diamond Pickaxe',
    durability: 24,
    oreBonus: 1.0,
    scaleX1000: 380,
    description: 'Deep Explorer · 24 durability. High endurance to reach diamond and emerald layers.',
  },
  netherite: {
    id: 'netherite',
    name: 'Netherite Pickaxe',
    durability: 32,
    oreBonus: 1.0,
    scaleX1000: 260,
    description: 'Abyss Master · 32 durability. Maximum resilience to break through ancient debris.',
  },
}

export const BLOCK_CONFIGS: Record<BlockType, BlockConfig> = {
  air: { id: 'air', name: 'Air', hitsNeeded: 0, multiplierX100: 0, isOre: false, isTnt: false, isCraftingTable: false, isBedrock: false },
  stone: { id: 'stone', name: 'Stone', hitsNeeded: 1, multiplierX100: 0, isOre: false, isTnt: false, isCraftingTable: false, isBedrock: false },
  deepslate: { id: 'deepslate', name: 'Deepslate', hitsNeeded: 2, multiplierX100: 0, isOre: false, isTnt: false, isCraftingTable: false, isBedrock: false },
  obsidian: { id: 'obsidian', name: 'Obsidian', hitsNeeded: 3, multiplierX100: 0, isOre: false, isTnt: false, isCraftingTable: false, isBedrock: false },
  bedrock: { id: 'bedrock', name: 'Bedrock', hitsNeeded: 9999, multiplierX100: 0, isOre: false, isTnt: false, isCraftingTable: false, isBedrock: true },
  tnt: { id: 'tnt', name: 'TNT', hitsNeeded: 1, multiplierX100: 0, isOre: false, isTnt: true, isCraftingTable: false, isBedrock: false },
  crafting_table: { id: 'crafting_table', name: 'Crafting Table', hitsNeeded: 1, multiplierX100: 0, isOre: false, isTnt: false, isCraftingTable: true, isBedrock: false },
  coal_ore: { id: 'coal_ore', name: 'Coal Ore', hitsNeeded: 1, multiplierX100: 8, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  copper_ore: { id: 'copper_ore', name: 'Copper Ore', hitsNeeded: 1, multiplierX100: 12, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  iron_ore: { id: 'iron_ore', name: 'Iron Ore', hitsNeeded: 1, multiplierX100: 25, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  gold_ore: { id: 'gold_ore', name: 'Gold Ore', hitsNeeded: 1, multiplierX100: 45, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  redstone_ore: { id: 'redstone_ore', name: 'Redstone Ore', hitsNeeded: 1, multiplierX100: 35, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  lapis_ore: { id: 'lapis_ore', name: 'Lapis Ore', hitsNeeded: 1, multiplierX100: 40, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  diamond_ore: { id: 'diamond_ore', name: 'Diamond Ore', hitsNeeded: 1, multiplierX100: 90, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  emerald_ore: { id: 'emerald_ore', name: 'Emerald Ore', hitsNeeded: 1, multiplierX100: 150, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
  ancient_debris: { id: 'ancient_debris', name: 'Ancient Debris', hitsNeeded: 2, multiplierX100: 300, isOre: true, isTnt: false, isCraftingTable: false, isBedrock: false },
}

export const MINEFALL_COLS = 9
export const MINEFALL_ROWS = 120
export const CRAFTING_TABLE_REPAIR = 2

export type MinefallEvent = {
  type: 'hit' | 'break' | 'tnt_blast' | 'repair' | 'collect_ore' | 'pickaxe_break' | 'reach_bottom'
  row: number
  col: number
  block: BlockType
  durabilityLeft: number
  boostX100?: number
  affected?: Array<{ row: number; col: number; block: BlockType; isOre?: boolean; boostX100?: number }>
}

export type MinefallRound = {
  round_id: string
  payer_uuid: string
  bet: number
  pickaxe: PickaxeTier
  column: number
  grid: BlockType[][]
  events: MinefallEvent[]
  ores_collected: Record<string, number>
  multiplier_x100: number
  payout: number
  balance: number
  economy_level: number
  rtp_x10000: number
}

export type MinefallRules = {
  grid_cols: number
  grid_rows: number
  pickaxes: Record<PickaxeTier, { durability: number; ore_bonus_x100: number }>
  rtp_x10000: number
}

export function isValidPickaxe(value: unknown): value is PickaxeTier {
  return typeof value === 'string' && value in PICKAXE_CONFIGS
}

export function getPickaxeConfig(tier: PickaxeTier): PickaxeConfig {
  return PICKAXE_CONFIGS[tier]
}

export function getBlockConfig(type: BlockType): BlockConfig {
  return BLOCK_CONFIGS[type] ?? BLOCK_CONFIGS.stone
}

export function calculateSummary(events: MinefallEvent[]): {
  ores: Record<string, number>
  tntCount: number
  repairCount: number
  maxRow: number
} {
  const ores: Record<string, number> = {}
  let tntCount = 0
  let repairCount = 0
  let maxRow = 0

  for (const ev of events) {
    if (ev.row > maxRow) maxRow = ev.row
    if (ev.type === 'collect_ore') {
      ores[ev.block] = (ores[ev.block] ?? 0) + 1
    } else if (ev.type === 'repair') {
      repairCount += 1
    } else if (ev.type === 'tnt_blast') {
      tntCount += 1
      if (ev.affected) {
        for (const aff of ev.affected) {
          if (aff.isOre) {
            ores[aff.block] = (ores[aff.block] ?? 0) + 1
          }
        }
      }
    }
  }

  return { ores, tntCount, repairCount, maxRow }
}

