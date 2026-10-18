import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitWindow, initialWindow } from '../src/lib/windowGeometry.ts'

test('dragging cannot lose the title bar or window outside the desktop', () => {
  const area = { width: 1440, height: 752 }
  assert.deepEqual(fitWindow({ x: -500, y: -800, width: 800, height: 500 }, area), { x: 12, y: 8, width: 800, height: 500 })
  assert.deepEqual(fitWindow({ x: 2000, y: 1000, width: 800, height: 500 }, area), { x: 628, y: 244, width: 800, height: 500 })
})
test('resizing respects usable minimums and shrinks to a smaller viewport', () => {
  assert.deepEqual(fitWindow({ x: 10, y: 10, width: 20, height: 20 }, { width: 1000, height: 700 }), { x: 12, y: 10, width: 520, height: 240 })
  const fitted = fitWindow({ x: 400, y: 300, width: 1100, height: 800 }, { width: 390, height: 500 })
  assert.equal(fitted.width, 366)
  assert.equal(fitted.height, 484)
  assert.equal(fitted.x, 12)
  assert.equal(fitted.y, 8)
})
test('initial windows reserve space for the menu and dock', () => {
  const area = { width: 1280, height: 620 }
  for (const kind of ['account', 'settings', 'stats', 'casino'] as const) {
    const rect = initialWindow(area, kind)
    assert.ok(rect.x >= 12 && rect.y >= 8)
    assert.ok(rect.x + rect.width <= area.width - 12)
    assert.ok(rect.y + rect.height <= area.height - 8)
  }
})

test('each app window starts at its own place on the desktop', () => {
  const area = { width: 1280, height: 620 }
  const account = initialWindow(area, 'account')
  const settings = initialWindow(area, 'settings')
  const stats = initialWindow(area, 'stats')
  // Account is the wide centered work window, Settings the small right-hand one.
  assert.ok(account.width >= settings.width)
  assert.ok(settings.x > account.x)
  // Statistics sits between them in height and starts below Account's title bar.
  assert.ok(stats.height >= settings.height && stats.height <= account.height)
  assert.ok(stats.y > account.y)
})
