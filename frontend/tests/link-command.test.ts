import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkCommand } from '../src/lib/linkCommand.ts'

test('link command contains the new subcommand and the displayed code', () => {
  assert.equal(linkCommand('A1B2C3D4'), '/website link A1B2C3D4')
})
