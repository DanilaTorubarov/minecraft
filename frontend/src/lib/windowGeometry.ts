export type WindowRect = { x: number; y: number; width: number; height: number }
export type DesktopSize = { width: number; height: number }
export type WindowKind = 'account' | 'settings' | 'stats' | 'player' | 'casino' | 'marketplace' | 'admin' | 'chat'

export function fitWindow(rect: WindowRect, area: DesktopSize, minWidth = 520): WindowRect {
  const width = Math.max(1, Math.min(area.width - 24, Math.max(minWidth, rect.width)))
  const height = Math.max(1, Math.min(area.height - 16, Math.max(240, rect.height)))
  return {
    width, height,
    x: Math.max(12, Math.min(rect.x, area.width - width - 12)),
    y: Math.max(8, Math.min(rect.y, area.height - height - 8)),
  }
}

export function initialWindow(area: DesktopSize, kind: WindowKind = 'account'): WindowRect {
  if (kind === 'settings') {
    const width = 440
    return fitWindow({
      width, height: 410,
      x: area.width - width - 64,
      y: 62,
    }, area, 380)
  }
  if (kind === 'casino') {
    const width = Math.min(880, area.width - 96)
    return fitWindow({
      width, height: Math.min(580, area.height - 40),
      x: (area.width - width) / 2 + 24,
      y: 36,
    }, area, 520)
  }
  if (kind === 'chat') {
    const width = Math.min(680, area.width - 96)
    return fitWindow({
      width, height: Math.min(540, area.height - 40),
      x: (area.width - width) / 2 + 30,
      y: 45,
    }, area, 480)
  }
  if (kind === 'stats' || kind === 'player' || kind === 'marketplace' || kind === 'admin') {
    const width = Math.min(900, area.width - 96)
    return fitWindow({
      width, height: Math.min(560, area.height - 40),
      x: (area.width - width) / 2,
      y: 42,
    }, area, 520)
  }
  const width = Math.min(1000, area.width - 96)
  return fitWindow({
    width, height: Math.min(650, area.height - 40),
    x: (area.width - width) / 2,
    y: 20,
  }, area, 520)
}
