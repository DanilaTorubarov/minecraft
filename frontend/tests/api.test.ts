import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError, formatDuration, getStats, logIn, logOut, register, confirmRegistration, getMarketQuote, sendInventoryToMarket } from '../src/lib/api.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('logout rejects server failure so auth state cannot be cleared', async () => {
  globalThis.fetch = async () => new Response(null, { status: 500 })
  await assert.rejects(logOut(), (error) => error instanceof ApiError && error.status === 500)
})

test('logout rejects a lost connection', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(logOut(), (error) => error instanceof ApiError && error.status === 0)
})

test('logout completes only after a successful server response', async () => {
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/logout')
    assert.equal(options?.method, 'POST')
    assert.equal(options?.credentials, 'same-origin')
    return new Response(null, { status: 200 })
  }
  await logOut()
})

test('statistics are read from the session endpoint', async () => {
  const body = {
    accounts: [{ uuid: 'u', username: 'Notch', linked_at: 'l', stats: null }],
    summary: { accounts: 1, accounts_with_stats: 0, play_seconds: 0, blocks_placed: 0, blocks_broken: 0 },
  }
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/stats')
    assert.equal(options?.method, 'GET')
    assert.equal(options?.credentials, 'same-origin')
    return new Response(JSON.stringify(body), { status: 200 })
  }
  await assert.deepEqual(await getStats(), body)
})

test('statistics reject a lost connection like every other request', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(getStats(), (error) => error instanceof ApiError && error.status === 0)
})

test('play time renders as whole units, never as a countdown', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(59), '59s')
  assert.equal(formatDuration(60), '1m')
  assert.equal(formatDuration(5400), '1h 30m')
  // A remainder smaller than the smallest shown unit is dropped, never faked up.
  assert.equal(formatDuration(90061), '1d 1h 1m')
  assert.equal(formatDuration(86400), '1d')
  assert.equal(formatDuration(-12), '0s')
})


test('registration returns a pending challenge and never treats immediate account creation as confirmation', async () => {
  const challenge = { challenge: 'a'.repeat(64), expires_in: 900, email_delivery: 'preview' }
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/register')
    assert.equal(options?.method, 'POST')
    return new Response(JSON.stringify(challenge), { status: 202 })
  }
  const input = { displayed_nickname: 'Test', login: 'Tester', email: 'test@example.com', password: 'password' }
  assert.deepEqual(await register(input), challenge)
  globalThis.fetch = async () => new Response(null, { status: 201 })
  await assert.rejects(register(input), (error) => error instanceof ApiError && error.status === 201)
})

test('registration confirmation sends both the browser challenge and code and rejects expiry', async () => {
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/register/confirm')
    assert.deepEqual(JSON.parse(String(options?.body)), { challenge: 'challenge', code: '012345' })
    return new Response(null, { status: 201 })
  }
  await confirmRegistration('challenge', '012345')
  globalThis.fetch = async () => new Response(null, { status: 400 })
  await assert.rejects(confirmRegistration('challenge', '012345'), (error) => error instanceof ApiError && error.status === 400)
})

test('sign-in sends either email or login as the identifier and preserves authentication errors', async () => {
  for (const identifier of ['test@example.com', 'Test_Player']) {
    globalThis.fetch = async (path, options) => {
      assert.equal(path, '/api/login')
      assert.equal(options?.method, 'POST')
      assert.equal(options?.credentials, 'same-origin')
      assert.deepEqual(JSON.parse(String(options?.body)), { identifier, password: 'test-password' })
      return new Response(null, { status: 200 })
    }
    await logIn(identifier, 'test-password')
  }
  globalThis.fetch = async () => new Response(null, { status: 401 })
  await assert.rejects(logIn('missing', 'wrong'), (error) => error instanceof ApiError && error.status === 401)
})


test('sign-in network failure rejects instead of reporting success', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(logIn('Test_Player', 'password'),
    (error) => error instanceof ApiError && error.status === 0)
})

test('sign-in preserves rate-limit and server failures for user feedback', async () => {
  for (const status of [429, 500, 503]) {
    globalThis.fetch = async () => new Response(null, { status })
    await assert.rejects(logIn('Test_Player', 'password'),
      (error) => error instanceof ApiError && error.status === status)
  }
})


test('marketplace transfer sends quantity, independent prices and stack fingerprint', async () => {
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/players/player%2Fid/inventory/marketplace')
    assert.equal(options?.method, 'POST')
    assert.equal(options?.credentials, 'same-origin')
    assert.equal(new Headers(options?.headers).get('X-Marketplace'), 'trade')
    assert.deepEqual(JSON.parse(options?.body as string), { slot: 40, fingerprint: 'a'.repeat(64), quantity: 5, unit_price: 4, lot_price: 15, expected_commission_bps: 200 })
    return new Response(null, { status: 202 })
  }
  await sendInventoryToMarket('player/id', { slot: 40, fingerprint: 'a'.repeat(64), quantity: 5, unit_price: 4, lot_price: 15, expected_commission_bps: 200 })
})

test('marketplace transfer preserves conflicts and network failures for honest feedback', async () => {
  globalThis.fetch = async () => new Response(null, { status: 409 })
  await assert.rejects(sendInventoryToMarket('u', { slot: 0, fingerprint: 'a'.repeat(64), quantity: 1, unit_price: 1, lot_price: null, expected_commission_bps: 200 }), (e) => e instanceof ApiError && e.status === 409)
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(sendInventoryToMarket('u', { slot: 0, fingerprint: 'a'.repeat(64), quantity: 1, unit_price: 1, lot_price: null, expected_commission_bps: 200 }), (e) => e instanceof ApiError && e.status === 0)
})

test('market purchase preserves the exact quote and idempotency key across retries', async () => {
  const { buyMarketListing } = await import('../src/lib/api.ts')
  const quote = { request_id: 'purchase-id', buyer_uuid: 'player-id', quantity: 12, pricing: 'lot' as const, expected_total: 90, expected_remaining: 12 }
  let attempts = 0
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/marketplace/listing%2Fid/buy')
    assert.equal(new Headers(options?.headers).get('X-Marketplace'), 'trade')
    assert.deepEqual(JSON.parse(String(options?.body)), quote)
    if (++attempts === 1) throw new TypeError('lost response')
    return new Response(null, { status: 202 })
  }
  await assert.rejects(buyMarketListing('listing/id', quote), (e) => e instanceof ApiError && e.status === 0)
  await buyMarketListing('listing/id', quote)
})

test('market purchase rejects when pending delivery queue is full', async () => {
  const { buyMarketListing } = await import('../src/lib/api.ts')
  const quote = { request_id: 'full-id', buyer_uuid: 'player-id', quantity: 1, pricing: 'unit' as const, expected_total: 10, expected_remaining: 5 }
  globalThis.fetch = async () => new Response(null, { status: 429 })
  await assert.rejects(buyMarketListing('listing/id', quote), (e) => e instanceof ApiError && e.status === 429)
})

test('marketplace reads encode search and pagination and cancellation requires a confirmed response', async () => {
  const { getMarketplace, cancelMarketListing } = await import('../src/lib/api.ts')
  globalThis.fetch = async (path) => {
    const query = new URL(String(path), 'https://localhost').searchParams
    assert.equal(query.get('q'), 'stone & tools')
    assert.equal(query.get('mine'), 'true')
    assert.equal(query.get('cursor'), 'last-id')
    return new Response(JSON.stringify({ listings: [], deliveries: [], next_cursor: null }), { status: 200 })
  }
  assert.deepEqual(await getMarketplace({ mine: true, q: 'stone & tools', cursor: 'last-id' }), { listings: [], deliveries: [], next_cursor: null })
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/marketplace/listing%2Fid/cancel')
    assert.equal(options?.method, 'POST')
    return new Response(null, { status: 409 })
  }
  await assert.rejects(cancelMarketListing('listing/id'), (e) => e instanceof ApiError && e.status === 409)
})


test('seller proceeds are returned by the server and a changed fee requires a new quote', async () => {
  const quote = { commission_bps: 500, unit: { gross: 100, fee: 5, proceeds: 95 }, lot: null }
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/marketplace/quote')
    return new Response(JSON.stringify(quote), { status: 200 })
  }
  assert.deepEqual(await getMarketQuote({ quantity: 10, unit_price: 10, lot_price: null }), quote)
  globalThis.fetch = async () => new Response(null, { status: 412 })
  await assert.rejects(sendInventoryToMarket('player', { slot: 0, fingerprint: 'a'.repeat(64), quantity: 10, unit_price: 10, lot_price: null, expected_commission_bps: 200 }), (error) => error instanceof ApiError && error.status === 412)
})

test('marketplace listing with unit and lot pricing is loaded from api', async () => {
  const { getMarketplace } = await import('../src/lib/api.ts')
  const itemListing = {
    id: 'listing-123',
    seller: 'IngameSeller',
    mine: true,
    item: { key: 'minecraft:oak_planks', amount: 64, display_name: 'Oak Planks', enchantments: {}, damage: null, max_damage: null, icon: null },
    quantity: 64,
    remaining: 64,
    unit_price: 10,
    lot_price: 500,
    commission_bps: 200,
    gross_sold: 0,
    fee_paid: 0,
    status: 'active',
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ listings: [itemListing], deliveries: [], next_cursor: null, commission_bps: 200 }), { status: 200 })
  const result = await getMarketplace()
  assert.equal(result.listings.length, 1)
  assert.equal(result.listings[0].unit_price, 10)
  assert.equal(result.listings[0].lot_price, 500)
  assert.equal(result.listings[0].seller, 'IngameSeller')
})
