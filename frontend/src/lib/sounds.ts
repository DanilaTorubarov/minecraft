import { soundEnabled, subscribeSoundSetting } from './soundSetting'
import { createInterfaceAudio, type SoundName } from './interfaceAudio'
import clickSound from '../assets/sounds/click.mp3'
import closeSound from '../assets/sounds/close.mp3'
import doneSound from '../assets/sounds/done.mp3'
import openSound from '../assets/sounds/open.mp3'

export type { SoundName } from './interfaceAudio'

const SOURCES: Record<SoundName, string> = {
  click: clickSound,
  open: openSound,
  close: closeSound,
  copy: clickSound,
  done: doneSound,
}

const player = createInterfaceAudio((name) => {
  const audio = new Audio(SOURCES[name])
  audio.preload = 'auto'
  return audio
}, soundEnabled)

/**
 * Plays a short interface sound. Fails silently: a refused or unavailable
 * Audio object must never surface as an error to the user.
 */
export function playSound(name: SoundName) {
  player.play(name)
}

/** Install once at app boot. Native clicks include keyboard activation too.
 * Semantic data-ui-sound overrides replace the default rather than layering it.
 * Text entry, focus, dragging, and continuous range sliders remain silent.
 */
export function installInterfaceSounds(root: Document = document) {
  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return
    const control = event.target.closest('button, a[href], [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')
    if (control === null || control.matches(':disabled, [aria-disabled="true"]') || control.closest('[inert]')) return
    const sound = control.getAttribute('data-ui-sound') ?? 'click'
    if (Object.hasOwn(SOURCES, sound)) playSound(sound as SoundName)
  }
  const onChange = (event: Event) => {
    if (!(event.target instanceof Element)) return
    if (event.target.matches('select, input[type="checkbox"], input[type="radio"]') && !event.target.matches(':disabled')) {
      playSound('click')
    }
  }
  const onVisibility = () => {
    if (root.hidden) player.stop()
  }
  // Capture reads semantic overrides before React changes open/closed state.
  root.addEventListener('click', onClick, true)
  root.addEventListener('change', onChange)
  root.addEventListener('visibilitychange', onVisibility)
  const unsubscribe = subscribeSoundSetting(() => {
    if (!soundEnabled()) player.stop()
  })
  return () => {
    root.removeEventListener('click', onClick, true)
    root.removeEventListener('change', onChange)
    root.removeEventListener('visibilitychange', onVisibility)
    unsubscribe()
    player.stop()
  }
}
