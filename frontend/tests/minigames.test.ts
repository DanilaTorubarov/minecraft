import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  CHEST_LABELS,
  ORE_LABELS,
  canAfford,
  choosePayer,
  clampBet,
  formatBoost,
  formatCoins,
  formatMultiplier,
  formatReturn,
  minigameFailure,
  newClientId,
  revealedCells,
  safeCellsOpened,
  type MinesRound,
} from '../src/lib/minigames.ts'
import { ApiError, cashOutMines, getMinigameRules, getMinigameState, spinChest } from '../src/lib/api.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('a stake is clamped to the table limits and to what the payer owns', () => {
  assert.equal(clampBet(500, 10, 100_000, 1_000), 500)
  assert.equal(clampBet(5, 10, 100_000, 1_000), 10, 'never below the minimum')
  assert.equal(clampBet(5_000, 10, 1_000, 50_000), 1_000, 'never above the table maximum')
  assert.equal(clampBet(5_000, 10, 100_000, 120), 120, 'never above the balance')
  assert.equal(clampBet(99.9, 10, 100_000, 1_000), 99, 'coins are whole')
})

test('a balance under the minimum leaves nothing to stake', () => {
  // There is no bet the payer can place, so the clamp returns the minimum and the
  // window disables play rather than inventing a smaller stake.
  assert.equal(clampBet(50, 10, 100_000, 4), 10)
  assert.equal(canAfford(clampBet(50, 10, 100_000, 4), 4), false)
  assert.equal(canAfford(10, 10), true)
  assert.equal(canAfford(11, 10), false)
})

test('a nonsensical stake falls back to the minimum instead of NaN', () => {
  assert.equal(clampBet(Number.NaN, 10, 100_000, 1_000), 10)
  assert.equal(clampBet(Number.POSITIVE_INFINITY, 10, 100_000, 1_000), 10)
})

test('multipliers and returns are shown exactly as the server pays them', () => {
  assert.equal(formatMultiplier(100), 'x1.00')
  assert.equal(formatMultiplier(170), 'x1.70')
  assert.equal(formatMultiplier(2_058), 'x20.58')
  assert.equal(formatMultiplier(0), 'x0.00')
  assert.equal(formatBoost(35), '+0.35x')
  assert.equal(formatBoost(1_080), '+10.80x')
  assert.equal(formatReturn(9_180), '91.8%')
  assert.equal(formatReturn(500), '5.0%')
})

test('coins are never shown negative or fractional', () => {
  assert.equal(formatCoins(0), '0')
  assert.equal(formatCoins(-50), '0')
  assert.equal(formatCoins(7.9), '7')
})

test('every status the window can meet becomes one sentence and one kind', () => {
  assert.equal(minigameFailure(0).kind, 'network')
  assert.equal(minigameFailure(401).kind, 'auth')
  assert.equal(minigameFailure(404).kind, 'unlinked')
  assert.equal(minigameFailure(409).kind, 'balance')
  assert.equal(minigameFailure(400).kind, 'invalid')
  assert.equal(minigameFailure(503).kind, 'unavailable')
  for (const status of [0, 400, 401, 404, 409, 500, 503]) {
    assert.ok(minigameFailure(status).message.length > 10, `status ${status} needs a real sentence`)
  }
  // A lost connection is not a refusal: the player is told to retry, not to pay.
  assert.notEqual(minigameFailure(0).message, minigameFailure(409).message)
})

test('a spin is identified by an id the browser can repeat safely', () => {
  const first = newClientId()
  const second = newClientId()
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a v4 UUID')
  assert.notEqual(first, second)
})

test('the remembered payer wins only while that account is still linked', () => {
  const accounts = [{ uuid: 'b' }, { uuid: 'a' }]
  assert.equal(choosePayer(accounts, 'a')?.uuid, 'a')
  assert.equal(choosePayer(accounts, 'gone')?.uuid, 'b', 'falls back to the oldest linked account')
  assert.equal(choosePayer(accounts, null)?.uuid, 'b')
  assert.equal(choosePayer([], 'a'), null, 'no linked account means nobody can pay')
})

test('a round names only the cells it has opened, and counts the safe ones', () => {
  const round: MinesRound = {
    round_id: 'x',
    bet: 100,
    mines: 8,
    min_safe: 2,
    multiplier_x100: 170,
    cashout: 170,
    status: 'active',
    outcome: null,
    payout: 0,
    balance: 900,
    revealed: [
      { cell: 3, content: 'iron' },
      { cell: 7, content: 'gold' },
      { cell: 11, content: 'tnt' },
    ],
  }
  const cells = revealedCells(round)
  assert.equal(cells.get(3), 'iron')
  assert.equal(cells.get(7), 'gold')
  assert.equal(cells.get(11), 'tnt')
  assert.equal(cells.get(12), undefined, 'an unrevealed cell stays unknown to the browser')
  assert.equal(safeCellsOpened(round), 2, 'TNT is not one of the safe cells')
})

test('the paytable and ore names cover every symbol the server can pay', () => {
  for (const id of [
    'diamond',
    'heart_of_the_sea',
    'trident',
    'nautilus_shell',
    'prismarine_crystals',
    'prismarine_shard',
    'pufferfish',
    'tropical_fish',
  ]) {
    assert.ok(CHEST_LABELS[id]?.ru, `${id} needs a Russian label`)
    assert.ok(CHEST_LABELS[id]?.en, `${id} needs an English label`)
  }
  for (const ore of ['iron', 'gold', 'diamond'] as const) {
    assert.ok(ORE_LABELS[ore].ru)
  }
})

test('a spin sends the stake, not an outcome, and reports what the server paid', async () => {
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/minigames/chest/spin')
    assert.equal(options?.method, 'POST')
    const body = JSON.parse(String(options?.body))
    assert.deepEqual(Object.keys(body).sort(), ['bet', 'client_id', 'uuid'])
    assert.equal(body.bet, 50)
    return new Response(
      JSON.stringify({
        round_id: 'round-1',
        bet: 50,
        reels: ['iron', 'gold', 'diamond'],
        multiplier_x100: 0,
        payout: 0,
        balance: 950,
      }),
      { status: 200 },
    )
  }
  const spin = await spinChest({ uuid: 'u', bet: 50, client_id: 'c' })
  assert.equal(spin.payout, 0, 'the payout is the server answer')
  assert.equal(spin.balance, 950, 'the balance is the server answer')
})

test('a refused bet surfaces the server status instead of a made-up result', async () => {
  globalThis.fetch = async () => new Response(null, { status: 409 })
  await assert.rejects(
    spinChest({ uuid: 'u', bet: 50, client_id: 'c' }),
    (error) => error instanceof ApiError && error.status === 409,
  )
  await assert.rejects(
    cashOutMines('round-1'),
    (error) => error instanceof ApiError && error.status === 409,
  )
})

test('a finished cash-out is the server round, never a locally computed payout', async () => {
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/minigames/mines/cashout')
    assert.deepEqual(JSON.parse(String(options?.body)), { round_id: 'round-9' })
    return new Response(
      JSON.stringify({
        round_id: 'round-9',
        bet: 100,
        mines: 8,
        min_safe: 2,
        multiplier_x100: 170,
        cashout: 170,
        status: 'settled',
        outcome: 'paid',
        payout: 170,
        balance: 1_070,
        revealed: [{ cell: 3, content: 'iron' }, { cell: 7, content: 'gold' }],
      }),
      { status: 200 },
    )
  }
  const round = await cashOutMines('round-9')
  assert.equal(round.payout, 170)
  assert.equal(round.status, 'settled')
})

test('the live round is unwrapped from its envelope, and rules come from the server', async () => {
  globalThis.fetch = async (path) => {
    if (path === '/api/minigames/state') {
      return new Response(JSON.stringify({ active: null }), { status: 200 })
    }
    assert.equal(path, '/api/minigames/config')
    return new Response(
      JSON.stringify({
        min_bet: 10,
        max_bet: 100_000,
        chest: {
          symbols: [],
          single_diamond_x100: 150,
          triple_chance_x10000: 500,
          pair_chance_x10000: 1_600,
          single_diamond_chance_x10000: 600,
          rtp_x10000: 9_180,
        },
        mines: { cells: 25, min_safe: 2, starting_x100: 100, presets: [] },
      }),
      { status: 200 },
    )
  }
  assert.equal(await getMinigameState(), null)
  const rules = await getMinigameRules()
  assert.equal(rules.chest.rtp_x10000, 9_180)
  assert.equal(rules.mines.cells, 25)
})
