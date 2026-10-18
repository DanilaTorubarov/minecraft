import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { fitWindow, initialWindow, type WindowKind, type WindowRect } from '../lib/windowGeometry'

type Props = {
  id: string; title: string; icon: string | ReactNode; open: boolean; activation: number; active: boolean; kind?: WindowKind
  onFocus: () => void; onClose: () => void; onMinimize: () => void
  /** Optional controls that sit in the title bar, just left of Reset. */
  titlebarExtra?: ReactNode
  children: ReactNode
}
const desktopSize = () => ({ width: window.innerWidth, height: Math.max(280, window.innerHeight - 148) })
const FOOTER: Record<WindowKind, [string, string]> = {
  account: ['Minecraft account portal', 'No game passwords shared'],
  settings: ['Website preferences', 'Saved on this device'],
  stats: ['Server-measured activity', 'No invented numbers'],
  player: ['Minecraft player', 'Statistics & skin'],
}

type Gesture = {
  startX: number
  startY: number
  lastX: number
  lastY: number
  rect: WindowRect
  resize: boolean
  wobbleX: number
  wobbleY: number
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

function wobbleTransform(x: number, y: number, scale = 1.001): string {
  const rotate = clamp(x * 0.28, -1.8, 1.8)
  return `perspective(1100px) rotateX(${-y * 0.32}deg) rotateY(${x * 0.26}deg) rotate(${rotate}deg) skew(${x}deg, ${y * 0.58}deg) scale(${scale})`
}

export default function DesktopWindow({ id, title, icon, open, activation, active, kind = 'account', onFocus, onClose, onMinimize, titlebarExtra, children }: Props) {
  const [area, setArea] = useState(desktopSize)
  const [rect, setRect] = useState(() => initialWindow(desktopSize(), kind))
  const [maximized, setMaximized] = useState(false)
  const [dragging, setDragging] = useState(false)
  const windowRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const settleAnimation = useRef<Animation | null>(null)
  const moved = useRef(false)
  const minimum = kind === 'settings' ? 380 : 520
  const fitted = fitWindow(maximized ? { x: 12, y: 8, width: area.width, height: area.height } : rect, area, minimum)

  useEffect(() => {
    const resize = () => setArea(desktopSize())
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    if (open && activation > 0) {
      titleRef.current?.focus({ preventScroll: true })
      if (window.innerWidth <= 760) titleRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [open, activation])
  useEffect(() => () => settleAnimation.current?.cancel(), [])

  function playWobble(x: number, y: number, duration = 900) {
    const node = windowRef.current
    if (node === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    settleAnimation.current?.cancel()
    settleAnimation.current = node.animate([
      { transform: wobbleTransform(x, y, 1.003) },
      { transform: wobbleTransform(-x * 0.62, -y * 0.62, 0.997) },
      { transform: wobbleTransform(x * 0.37, y * 0.37, 1.002) },
      { transform: wobbleTransform(-x * 0.21, -y * 0.21, 0.999) },
      { transform: wobbleTransform(x * 0.105, y * 0.105, 1.001) },
      { transform: wobbleTransform(-x * 0.035, -y * 0.035, 1) },
      { transform: 'none' },
    ], {
      duration,
      easing: 'cubic-bezier(.14, .82, .22, 1)',
    })
    settleAnimation.current.onfinish = () => { settleAnimation.current = null }
  }

  function toggleMaximized() {
    setMaximized((value) => !value)
    playWobble(maximized ? -3.2 : 3.2, maximized ? 1.4 : -1.4, 820)
  }

  function resetWindow() {
    setRect(initialWindow(area, kind))
    setMaximized(false)
    playWobble(-3.6, 1.7, 880)
  }

  function begin(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (event.button !== 0 || maximized || window.innerWidth <= 760) return
    // The lights and any title-bar controls belong to the control, not the drag.
    if (!resize && (event.target as HTMLElement).closest('button, select')) return
    onFocus()
    settleAnimation.current?.cancel()
    windowRef.current?.getAnimations().forEach((animation) => animation.cancel())
    if (windowRef.current !== null) windowRef.current.style.transform = ''
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      rect: fitted,
      resize,
      wobbleX: 0,
      wobbleY: 0,
    }
    moved.current = false
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function move(event: PointerEvent<HTMLElement>) {
    const start = gesture.current
    if (!start) return
    const dx = event.clientX - start.startX
    const dy = event.clientY - start.startY
    if (!start.resize && Math.abs(dx) + Math.abs(dy) > 6) moved.current = true
    if (!start.resize && windowRef.current !== null) {
      const velocityX = event.clientX - start.lastX
      const velocityY = event.clientY - start.lastY
      start.wobbleX = start.wobbleX * 0.44 + clamp(velocityX * 0.26, -5.8, 5.8) * 0.56
      start.wobbleY = start.wobbleY * 0.44 + clamp(velocityY * 0.21, -4.2, 4.2) * 0.56
      start.lastX = event.clientX
      start.lastY = event.clientY
      windowRef.current.style.transformOrigin = `${event.clientX - fitted.x}px ${event.clientY - fitted.y}px`
      windowRef.current.style.transform = wobbleTransform(start.wobbleX, start.wobbleY)
    }
    setRect(fitWindow(start.resize
      ? { ...start.rect, width: start.rect.width + dx, height: start.rect.height + dy }
      : { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy }, area, minimum))
  }
  function end() {
    const start = gesture.current
    if (start === null) return
    gesture.current = null
    setDragging(false)
    const node = windowRef.current
    if (node !== null) node.style.transform = ''
    if (
      node !== null && !start.resize && moved.current &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      const x = start.wobbleX || clamp((start.lastX - start.startX) * 0.032, -4.8, 4.8)
      const y = start.wobbleY || clamp((start.lastY - start.startY) * 0.026, -3.5, 3.5)
      playWobble(x, y)
    }
  }
  function keyboard(event: KeyboardEvent<HTMLElement>, resize: boolean) {
    if (event.target !== event.currentTarget || maximized || window.innerWidth <= 760) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 40 : 10
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    setRect(fitWindow(resize
      ? { ...fitted, width: fitted.width + dx, height: fitted.height + dy }
      : { ...fitted, x: fitted.x + dx, y: fitted.y + dy }, area, minimum))
  }

  const [footerLeft, footerRight] = FOOTER[kind]

  return (
    <section ref={windowRef} id={id} className={`desktop-window ${kind}-window${dragging ? ' dragging' : ''}`}
      aria-label={`${title} window`} hidden={!open} data-active={active}
      onPointerDownCapture={onFocus} onFocusCapture={onFocus}
      style={{ left: fitted.x, top: fitted.y, width: fitted.width, height: fitted.height }}>
      <div className="window-titlebar" ref={titleRef} tabIndex={0} role="toolbar"
        aria-label={`${title} window controls`} aria-describedby={`${id}-help`}
        onPointerDown={(event) => begin(event, false)} onPointerMove={move}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onKeyDown={(event) => keyboard(event, false)}
        onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) toggleMaximized() }}>
        <div className="window-lights">
          <button className="window-light light-close" data-ui-sound="close" aria-label={`Close ${title}`} onClick={onClose} />
          <button className="window-light light-minimize" data-ui-sound="close" aria-label={`Minimize ${title}`} onClick={onMinimize} />
          <button className="window-light light-maximize" aria-label={`${maximized ? 'Restore' : 'Maximize'} ${title}`} onClick={toggleMaximized} />
        </div>
        <span className="window-title">{typeof icon === 'string' ? <img src={icon} alt="" /> : icon}{title}</span>
        {titlebarExtra !== undefined && <div className="window-titlebar-extra">{titlebarExtra}</div>}
        <button className="window-reset" onClick={resetWindow}>Reset</button>
      </div>
      <p id={`${id}-help`} className="visually-hidden">Drag this title bar or use arrow keys to move the window. Shift moves further. Double-click to maximize. Reset restores the original position and size.</p>
      <div className="window-body">{children}</div>
      <footer className="window-footer"><span>{footerLeft}</span><span>{footerRight}</span></footer>
      <button className="window-resize" data-ui-sound="none" aria-label={`Resize ${title} window. Use arrow keys; Shift resizes further.`}
        onPointerDown={(event) => begin(event, true)} onPointerMove={move}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onKeyDown={(event) => keyboard(event, true)} />
    </section>
  )
}
