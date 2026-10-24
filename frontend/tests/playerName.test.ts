import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayPlayerName } from '../src/lib/playerName.ts'

test('Bedrock names lose the Floodgate dot and nothing else', () => {
  assert.equal(displayPlayerName('.Kokochi7232'), 'Kokochi7232')
})

test('Java names are rendered exactly as stored', () => {
  assert.equal(displayPlayerName('Danila_Teenager'), 'Danila_Teenager')
  assert.equal(displayPlayerName('polka920'), 'polka920')
})

test('only the leading dot marker is removed', () => {
  assert.equal(displayPlayerName('..Kokochi7232'), 'Kokochi7232')
  assert.equal(displayPlayerName('Kokochi.7232'), 'Kokochi.7232')
  assert.equal(displayPlayerName('.'), '')
})

test('a missing name degrades to an empty label instead of "null"', () => {
  assert.equal(displayPlayerName(null), '')
  assert.equal(displayPlayerName(undefined), '')
  assert.equal(displayPlayerName(''), '')
})
