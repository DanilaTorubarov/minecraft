import { useEffect, useRef } from 'react'

export default function ClickWaves() {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const clear = () => layer.replaceChildren()
    const click = (event: MouseEvent) => {
      if (motion.matches || document.hidden || event.button !== 0) return
      let x = event.clientX
      let y = event.clientY
      if (event.detail === 0 && event.target instanceof Element) {
        const bounds = event.target.getBoundingClientRect()
        x = bounds.x + bounds.width / 2
        y = bounds.y + bounds.height / 2
      }
      const wave = document.createElement('span')
      wave.className = 'cursor-click-wave'
      wave.style.left = x + 'px'
      wave.style.top = y + 'px'
      // Bound DOM work during rapid clicking; animation end owns cleanup.
      if (layer.childElementCount >= 8) layer.firstElementChild?.remove()
      layer.append(wave)
      wave.addEventListener('animationend', () => wave.remove(), { once: true })
    }
    document.addEventListener('click', click, true)
    document.addEventListener('visibilitychange', clear)
    motion.addEventListener('change', clear)
    return () => {
      document.removeEventListener('click', click, true)
      document.removeEventListener('visibilitychange', clear)
      motion.removeEventListener('change', clear)
      clear()
    }
  }, [])

  return <div ref={layerRef} className="cursor-click-waves" aria-hidden="true" />
}
