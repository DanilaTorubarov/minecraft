import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError, formatDuration, getStats, logOut, register, confirmRegistration } from '../src/lib/api.ts'

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
