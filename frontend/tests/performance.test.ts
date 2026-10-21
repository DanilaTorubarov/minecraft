import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  applyLowPerformanceClass,
  LOW_PERFORMANCE_KEY,
  lowPerformanceEnabled,
  parseLowPerformanceSetting,
  readLowPerformanceEnabled,
  setLowPerformanceEnabled,
  subscribeLowPerformanceSetting,
} from '../src/lib/performanceSetting.ts'

// Provide a mock document and localStorage environment for Node runner
const originalLocalStorage = globalThis.localStorage
const originalDocument = globalThis.document

beforeEach(() => {
  const store: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    length: 0,
  }

  const dataset: Record<string, string> = {}
  globalThis.document = {
    documentElement: {
      dataset,
    },
  } as unknown as Document
})

afterEach(() => {
  setLowPerformanceEnabled(false)
  globalThis.localStorage = originalLocalStorage
  globalThis.document = originalDocument
})

test('parseLowPerformanceSetting validates string values correctly', () => {
  assert.equal(parseLowPerformanceSetting('on'), true)
  assert.equal(parseLowPerformanceSetting('true'), true)
  assert.equal(parseLowPerformanceSetting('off'), false)
  assert.equal(parseLowPerformanceSetting('false'), false)
  assert.equal(parseLowPerformanceSetting(null), false)
  assert.equal(parseLowPerformanceSetting(''), false)
})

test('readLowPerformanceEnabled defaults to false on fresh visit', () => {
  assert.equal(readLowPerformanceEnabled(), false)
  assert.equal(lowPerformanceEnabled(), false)
})

test('setLowPerformanceEnabled updates state, storage, and dataset attribute', () => {
  setLowPerformanceEnabled(true)
  assert.equal(lowPerformanceEnabled(), true)
  assert.equal(localStorage.getItem(LOW_PERFORMANCE_KEY), 'on')
  assert.equal(document.documentElement.dataset.lowPerformance, 'true')

  setLowPerformanceEnabled(false)
  assert.equal(lowPerformanceEnabled(), false)
  assert.equal(localStorage.getItem(LOW_PERFORMANCE_KEY), 'off')
  assert.equal(document.documentElement.dataset.lowPerformance, undefined)
})

test('subscribeLowPerformanceSetting notifies subscribers on change and unsubscribes cleanly', () => {
  let callCount = 0
  const unsubscribe = subscribeLowPerformanceSetting(() => {
    callCount++
  })

  setLowPerformanceEnabled(true)
  assert.equal(callCount, 1)

  setLowPerformanceEnabled(false)
  assert.equal(callCount, 2)

  unsubscribe()
  setLowPerformanceEnabled(true)
  assert.equal(callCount, 2)
})

test('applyLowPerformanceClass sets or removes dataset attribute safely', () => {
  applyLowPerformanceClass(true)
  assert.equal(document.documentElement.dataset.lowPerformance, 'true')

  applyLowPerformanceClass(false)
  assert.equal(document.documentElement.dataset.lowPerformance, undefined)
})
