/**
 * Display formatting and the metric catalog for the statistics window.
 * Pure and asset-free, so `node --test` can load it like the other `lib/`
 * modules. The server decides what was measured; this only decides how it
 * reads.
 */
import { formatDuration } from './api.ts'

/** Every counter the panel receives from the game server. */
export type StatMetricKey =
  | 'play_seconds'
  | 'blocks_placed'
  | 'blocks_broken'
  | 'mobs_killed'
  | 'deaths'
  | 'distance_cm'
  | 'items_crafted'
  | 'fish_caught'
  | 'damage_dealt'
  | 'damage_taken'
  | 'logins'
  | 'items_picked_up'
  | 'items_enchanted'
  | 'tools_broken'
  | 'animals_bred'
  | 'times_slept'
  | 'advancements'

/** The counters alone; both a summary and a per-account stats object fit it. */
export type StatCounters = Record<StatMetricKey, number>

/** Blocks walked, in hundredths of a block. One block is roughly one metre. */
export function formatDistance(distanceCm: number): string {
  const blocks = distanceCm / 100
  if (blocks < 1000) {
    return `${blocks.toLocaleString(undefined, { maximumFractionDigits: 1 })} blocks`
  }
  const kilometres = blocks / 1000
  return `${kilometres.toLocaleString(undefined, { maximumFractionDigits: 2 })} km`
}

/** Damage dealt or taken, in hundredths of a heart. */
export function formatDamage(centiHearts: number): string {
  const hearts = centiHearts / 100
  const value = hearts.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return `${value} ${hearts === 1 ? 'heart' : 'hearts'}`
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}

export type StatMetric = {
  key: StatMetricKey
  label: string
  format: (value: number) => string
}

export type StatGroup = {
  title: string
  metrics: StatMetric[]
}

const count = formatCount

/**
 * The catalog the window renders, in display order. Every metric comes from a
 * counter the game server reported; nothing here is an estimate.
 */
export const STAT_GROUPS: StatGroup[] = [
  {
    title: 'Play & travel',
    metrics: [
      { key: 'play_seconds', label: 'Play time', format: formatDuration },
      { key: 'distance_cm', label: 'Distance traveled', format: formatDistance },
      { key: 'logins', label: 'Logins', format: count },
    ],
  },
  {
    title: 'Building',
    metrics: [
      { key: 'blocks_placed', label: 'Blocks placed', format: count },
      { key: 'blocks_broken', label: 'Blocks broken', format: count },
      { key: 'items_crafted', label: 'Items crafted', format: count },
      { key: 'items_picked_up', label: 'Items picked up', format: count },
    ],
  },
  {
    title: 'Combat',
    metrics: [
      { key: 'mobs_killed', label: 'Mobs killed', format: count },
      { key: 'deaths', label: 'Deaths', format: count },
      { key: 'damage_dealt', label: 'Damage dealt', format: formatDamage },
      { key: 'damage_taken', label: 'Damage taken', format: formatDamage },
    ],
  },
  {
    title: 'The wild',
    metrics: [
      { key: 'fish_caught', label: 'Fish caught', format: count },
      { key: 'animals_bred', label: 'Animals bred', format: count },
      { key: 'items_enchanted', label: 'Items enchanted', format: count },
      { key: 'tools_broken', label: 'Tools broken', format: count },
      { key: 'times_slept', label: 'Times slept', format: count },
      { key: 'advancements', label: 'Advancements', format: count },
    ],
  },
]

/** Every metric key exactly once, so a test can check nothing is missed. */
export const STAT_METRIC_KEYS: StatMetricKey[] = STAT_GROUPS
  .flatMap((group) => group.metrics)
  .map((metric) => metric.key)

/**
 * Picks just the catalog's counters out of a full stats object, so the summary
 * and one account's stats render through the same cards. Missing or malformed
 * values read as zero — the panel never invents a number.
 */
export function countersOf(
  stats: { [key in StatMetricKey]?: number }
): StatCounters {
  const counters: Record<string, number> = {}
  for (const key of STAT_METRIC_KEYS) {
    const value = Number(stats[key])
    counters[key] = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  }
  return counters as StatCounters
}
