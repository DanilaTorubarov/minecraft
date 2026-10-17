// Asset-free playback engine so volume, mute, and overlap behavior can be tested.
export type SoundName = 'click' | 'open' | 'close' | 'copy' | 'done'

export const SOUND_VOLUMES: Record<SoundName, number> = {
  click: 0.16,
  open: 0.09,
  close: 0.07,
  copy: 0.10,
  done: 0.10,
}

type AudioVoice = {
  currentTime: number
  volume: number
  play: () => Promise<void>
  pause: () => void
}

export function createInterfaceAudio(
  createVoice: (name: SoundName) => AudioVoice,
  isEnabled: () => boolean,
) {
  const voices = new Map<SoundName, AudioVoice>()
  let active: AudioVoice | undefined

  function stop() {
    try { active?.pause() } catch { /* Audio is optional. */ }
    active = undefined
  }

  function play(name: SoundName) {
    if (!isEnabled()) {
      stop()
      return
    }
    try {
      let voice = voices.get(name)
      if (voice === undefined) {
        voice = createVoice(name)
        voices.set(name, voice)
      }
      // Only one UI effect at a time: fast actions cannot build a loud chorus.
      stop()
      voice.volume = SOUND_VOLUMES[name]
      voice.currentTime = 0
      active = voice
      void voice.play().catch(() => { /* Autoplay policy or interrupted playback. */ })
    } catch {
      // Unavailable Audio, seeking, and synchronous playback errors stay silent.
    }
  }

  return { play, stop }
}
