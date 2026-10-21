import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapUrl, spawnView } from '../src/lib/mapViews.ts'

function fields(url: string): string[] {
  return url.slice('/map/#'.length).split(':')
}

test('the 2D map asks BlueMap for an orthographic top-down camera', () => {
  const url = mapUrl('2d', 'perspective')
  const parts = fields(url)
  assert.equal(parts.length, 10)
  assert.equal(parts[0], 'world')
  assert.equal(parts[8], '1', 'orthographic projection')
  assert.equal(parts[6], '0', 'no camera angle')
  assert.equal(parts[7], '0', 'no tilt')
  assert.equal(parts[9], 'flat')
  assert.equal(mapUrl('2d', 'free'), url, 'the 2D view ignores the 3D camera preset')
})

test('each 3D camera keeps its own perspective address', () => {
  const perspective = fields(mapUrl('3d', 'perspective'))
  assert.equal(perspective[8], '0', 'perspective projection')
  assert.equal(perspective[9], 'perspective')

  const free = fields(mapUrl('3d', 'free'))
  assert.equal(free[8], '0', 'perspective projection')
  assert.equal(free[9], 'free')
})

test('centering keeps the 2D map orthographic and the 3D map perspective', () => {
  assert.deepEqual(spawnView('2d'), { distance: 1200, angle: 0, tilt: 0, ortho: 1 })
  assert.deepEqual(spawnView('3d'), { distance: 450, angle: 0.45, tilt: 0, ortho: 0 })
})
