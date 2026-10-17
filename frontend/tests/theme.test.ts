import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTheme, readTheme, resolveTheme } from '../src/lib/theme.ts'

test('stored theme values are validated', () => {
  assert.equal(parseTheme('light'), 'light')
  assert.equal(parseTheme('dark'), 'dark')
  assert.equal(parseTheme('system'), 'system')
  assert.equal(parseTheme(null), 'light')
  assert.equal(parseTheme('invalid'), 'light')
})
test('system theme follows the device, explicit choices override it', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
})
test('unavailable browser storage falls back to light', () => {
  assert.equal(readTheme(), 'light')
})

test('early page theme agrees with runtime defaults, including a dark OS', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const boot = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(boot)
  for (const stored of [null, 'invalid', 'light', 'dark', 'system']) {
    for (const systemDark of [false, true]) {
      const document = { documentElement: { dataset: { theme: '' } } }
      runInNewContext(boot, {
        document,
        localStorage: { getItem: () => stored },
        matchMedia: () => ({ matches: systemDark }),
      })
      assert.equal(document.documentElement.dataset.theme, resolveTheme(parseTheme(stored), systemDark))
    }
  }
  const document = { documentElement: { dataset: { theme: '' } } }
  runInNewContext(boot, { document, localStorage: { getItem: () => { throw Error('blocked') } } })
  assert.equal(document.documentElement.dataset.theme, 'light')
})
