import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInterfaceAudio, SOUND_VOLUMES, type SoundName } from '../src/lib/interfaceAudio.ts'
import { setSoundEnabled, soundEnabled, subscribeSoundSetting } from '../src/lib/soundSetting.ts'

function fixture() {
  let enabled = true
  const created: { name: SoundName; voice: ReturnType<typeof voice> }[] = []
  function voice() {
    return {
      currentTime: 12,
      volume: 1,
      plays: 0,
      pauses: 0,
      play() { this.plays++; return Promise.resolve() },
      pause() { this.pauses++ },
    }
  }
  const player = createInterfaceAudio((name) => {
    const audio = voice()
    created.push({ name, voice: audio })
    return audio
  }, () => enabled)
  return { player, created, mute() { enabled = false } }
}

test('loud window and completion recordings have lower gain than the quiet click', () => {
  for (const name of ['open', 'close', 'copy', 'done'] as const) {
    const { player, created } = fixture()
    player.play(name)
    assert.ok(created[0].voice.volume > 0)
    assert.ok(created[0].voice.volume < SOUND_VOLUMES.click)
  }
  assert.ok(SOUND_VOLUMES.click <= 0.2)
})

test('a new interface sound stops the previous voice instead of stacking effects', () => {
  const { player, created } = fixture()
  player.play('open')
  player.play('close')
  assert.equal(created[0].voice.pauses, 1)
  assert.equal(created[1].voice.plays, 1)
  assert.equal(created[1].voice.currentTime, 0)
})

test('rapid repeated clicks reuse and restart one voice', () => {
  const { player, created } = fixture()
  player.play('click')
  created[0].voice.currentTime = 3
  player.play('click')
  assert.equal(created.length, 1)
  assert.equal(created[0].voice.plays, 2)
  assert.equal(created[0].voice.pauses, 1)
  assert.equal(created[0].voice.currentTime, 0)
})

test('muted feedback stops active sound and creates no new voice', () => {
  const { player, created, mute } = fixture()
  player.play('open')
  mute()
  player.play('done')
  assert.equal(created.length, 1)
  assert.equal(created[0].voice.pauses, 1)
})

test('blocked playback and unavailable audio never throw into the UI', async () => {
  const unavailable = createInterfaceAudio(() => { throw new Error('Audio unavailable') }, () => true)
  assert.doesNotThrow(() => unavailable.play('click'))
  const refused = createInterfaceAudio(() => ({
    currentTime: 0,
    volume: 1,
    pause() {},
    play() { return Promise.reject(new Error('Gesture required')) },
  }), () => true)
  assert.doesNotThrow(() => refused.play('click'))
  await new Promise((resolve) => setImmediate(resolve))
})

test('sound preference notifies every subscriber and unsubscribes cleanly', () => {
  const previous = soundEnabled()
  const observed: boolean[] = []
  const unsubscribe = subscribeSoundSetting(() => observed.push(soundEnabled()))
  try {
    setSoundEnabled(false)
    setSoundEnabled(true)
    assert.deepEqual(observed, [false, true])
    unsubscribe()
    setSoundEnabled(false)
    assert.deepEqual(observed, [false, true])
  } finally {
    unsubscribe()
    setSoundEnabled(previous)
  }
})
