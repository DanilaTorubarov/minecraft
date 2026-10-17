import assert from 'node:assert/strict'
import test from 'node:test'
import { invalidateServerData, onServerDataInvalidated } from '../src/lib/serverData.ts'

test('server data invalidation only notifies matching subscribers', () => {
  let linkRefreshes = 0
  let statsRefreshes = 0
  const stopLinks = onServerDataInvalidated('links', () => { linkRefreshes += 1 })
  const stopStats = onServerDataInvalidated('stats', () => { statsRefreshes += 1 })

  invalidateServerData('stats')
  assert.equal(linkRefreshes, 0)
  assert.equal(statsRefreshes, 1)

  invalidateServerData('links', 'stats')
  assert.equal(linkRefreshes, 1)
  assert.equal(statsRefreshes, 2)

  stopLinks()
  stopStats()
})

test('unsubscribed views stop receiving invalidations', () => {
  let refreshes = 0
  const unsubscribe = onServerDataInvalidated('stats', () => { refreshes += 1 })
  unsubscribe()

  invalidateServerData('stats')
  assert.equal(refreshes, 0)
})
