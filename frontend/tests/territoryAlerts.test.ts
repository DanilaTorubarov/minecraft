import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DISMISSED_ALERTS_KEY,
  DISMISSED_ALERT_TTL_MS,
  dismissAlert,
  isAlertDismissed,
  parseDismissedAlerts,
  readDismissedAlerts,
  writeDismissedAlerts,
} from '../src/lib/territoryAlerts.ts'

const NOW = 1_800_000_000_000

test('a dismissed alert stays dismissed across a reload', () => {
  const stored = dismissAlert({}, 'fuel-block-1', NOW)
  assert.equal(isAlertDismissed(stored, 'fuel-block-1', NOW + 60_000), true)
  assert.deepEqual(parseDismissedAlerts(JSON.stringify(stored), NOW + 60_000), stored)
})

test('a different alert is never hidden by another dismissal', () => {
  const stored = dismissAlert({}, 'alert-a', NOW)
  assert.equal(isAlertDismissed(stored, 'alert-b', NOW), false)
})

test('the dismissal expires so a still-critical core warns again', () => {
  const stored = dismissAlert({}, 'fuel-block-1', NOW)
  assert.equal(isAlertDismissed(stored, 'fuel-block-1', NOW + DISMISSED_ALERT_TTL_MS), false)
  assert.deepEqual(parseDismissedAlerts(JSON.stringify(stored), NOW + DISMISSED_ALERT_TTL_MS), {})
})

test('broken storage never traps an alert permanently', () => {
  assert.deepEqual(parseDismissedAlerts(null, NOW), {})
  assert.deepEqual(parseDismissedAlerts('not json', NOW), {})
  assert.deepEqual(parseDismissedAlerts('[]', NOW), {})
  assert.deepEqual(parseDismissedAlerts('{"a":"yesterday","b":12}', NOW), {})
})

function withStorage(store: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
}

test('storage keeps only fresh entries', () => {
  const written: Record<string, string> = {}
  withStorage({
    getItem: (key) => written[key] ?? null,
    setItem: (key, value) => { written[key] = value },
  }, () => {
    const stored = { old: NOW - DISMISSED_ALERT_TTL_MS, fresh: NOW }
    writeDismissedAlerts(stored, NOW)
    assert.deepEqual(JSON.parse(written[DISMISSED_ALERTS_KEY]), { fresh: NOW })
    assert.deepEqual(readDismissedAlerts(NOW + 1), { fresh: NOW })
  })
})

test('unavailable storage fails quietly instead of blocking the window', () => {
  withStorage({
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }, () => {
    assert.deepEqual(readDismissedAlerts(NOW), {})
    assert.doesNotThrow(() => writeDismissedAlerts({ fresh: NOW }, NOW))
  })
})
