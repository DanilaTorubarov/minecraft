import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTime, parsePlayerSettings, TRACKS } from '../src/lib/player.ts'
import { parseSoundSetting } from '../src/lib/soundSetting.ts'

test('missing or unreadable player storage falls back to quiet defaults', () => {
  assert.deepEqual(parsePlayerSettings(null), { track: 0, volume: 0.3, muted: false })
  assert.deepEqual(parsePlayerSettings('not json'), { track: 0, volume: 0.3, muted: false })
  assert.deepEqual(parsePlayerSettings('"just a string"'), { track: 0, volume: 0.3, muted: false })
})

test('stored player settings are validated, not trusted', () => {
  assert.deepEqual(parsePlayerSettings('{"track":1,"volume":0.5,"muted":true}'), { track: 1, volume: 0.5, muted: true })
  // Out-of-range values are clamped into the real track list and volume.
  assert.equal(parsePlayerSettings('{"track":99}').track, TRACKS.length - 1)
  assert.equal(parsePlayerSettings('{"track":-4}').track, 0)
  assert.equal(parsePlayerSettings('{"volume":7}').volume, 1)
  assert.equal(parsePlayerSettings('{"volume":-2}').volume, 0)
  // Wrong types fall back field by field.
  assert.deepEqual(parsePlayerSettings('{"track":"one","volume":"loud"}'), { track: 0, volume: 0.3, muted: false })
  // A track index that will never exist must not be preserved.
  assert.equal(parsePlayerSettings(`{"track":${TRACKS.length}}`).track, TRACKS.length - 1)
})

test('the sound setting is on unless explicitly stored as off', () => {
  assert.equal(parseSoundSetting(null), true)
  assert.equal(parseSoundSetting('on'), true)
  assert.equal(parseSoundSetting('off'), false)
  assert.equal(parseSoundSetting('garbage'), true)
})

test('player time renders whole minutes and seconds', () => {
  assert.equal(formatTime(0), '0:00')
  assert.equal(formatTime(75), '1:15')
  assert.equal(formatTime(193.9), '3:13')
  assert.equal(formatTime(NaN), '0:00')
  assert.equal(formatTime(-5), '0:00')
})
