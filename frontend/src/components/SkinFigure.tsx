import { useEffect, useRef, useState } from 'react'

/** Render the actual skin PNG's front texture and outer layer. */
export default function SkinFigure({ src, model, label }: { src: string; model: 'classic' | 'slim'; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failedSrc, setFailedSrc] = useState('')
  useEffect(() => {
    let active = true
    const image = new Image()
    image.onload = () => {
      if (!active) return
      const ctx = canvas.current?.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, 16, 32)
      if (image.width !== 64 || ![32,64].includes(image.height)) { setFailedSrc(src); return }
      const modern = image.height === 64
      const arm = model === 'slim' ? 3 : 4
      const draw = (sx: number, sy: number, w: number, h: number, x: number, y: number) => ctx.drawImage(image, sx, sy, w, h, x, y, w, h)
      draw(8,8,8,8,4,0); draw(20,20,8,12,4,8)
      draw(44,20,arm,12,4-arm,8); draw(4,20,4,12,4,20)
      if (modern) { draw(36,52,arm,12,12,8); draw(20,52,4,12,8,20) }
      else {
        ctx.save(); ctx.translate(16,0); ctx.scale(-1,1)
        draw(44,20,arm,12,4-arm,8); draw(4,20,4,12,4,20)
        ctx.restore()
      }
      draw(40,8,8,8,4,0)
      if (modern) {
        draw(20,36,8,12,4,8); draw(44,36,arm,12,4-arm,8); draw(52,52,arm,12,12,8)
        draw(4,36,4,12,4,20); draw(4,52,4,12,8,20)
      }
    }
    image.onerror = () => { if (active) setFailedSrc(src) }
    image.referrerPolicy = 'no-referrer'
    image.src = src
    return () => { active = false }
  }, [src, model])
  return failedSrc === src ? <p className="page-sub">Skin preview unavailable. Try refreshing.</p> : <canvas className="skin-figure" ref={canvas} width={16} height={32} role="img" aria-label={label} />
}
