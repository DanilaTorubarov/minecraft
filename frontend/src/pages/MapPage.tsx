import { useState, useRef, useEffect } from 'react'
import { mapUrl, spawnView, type MapCamera as CameraMode, type MapViewMode as ViewMode } from '../lib/mapViews'

interface BlueMapBridge {
  setPerspectiveView?: (animationDuration: number) => void
  setFreeFlight?: (animationDuration: number, startDistance?: number) => void
  setFlatView?: (animationDuration: number) => void
  resetCamera?: () => void
  loadPageAddress?: () => void
  updatePageAddress?: () => void
  mapViewer?: {
    map?: unknown
    controlsManager?: {
      position?: { set: (x: number, y: number, z: number) => void }
      distance?: number
      rotation?: number
      angle?: number
      tilt?: number
      ortho?: number
    }
    clearTileCache?: () => void
    updateLoadedMapArea?: () => void
  }
}

type BlueMapWindow = Window & {
  bluemap?: BlueMapBridge
}

type Props = {
  visible: boolean
}

export default function MapPage({ visible }: Props) {
  const [iframeKey, setIframeKey] = useState(0)
  const [src, setSrc] = useState(mapUrl('3d', 'perspective'))
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewMode>('3d')
  const [camera, setCamera] = useState<CameraMode>('perspective')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const applyView = (nextView: ViewMode, nextCamera: CameraMode = camera) => {
    const leaving2d = view === '2d'
    setView(nextView)
    setCamera(nextCamera)
    try {
      const win = iframeRef.current?.contentWindow as BlueMapWindow | null
      const ready = Boolean(win?.bluemap?.mapViewer?.map)
      if (ready && win?.bluemap) {
        if (nextView === '2d' && typeof win.bluemap.setFlatView === 'function') {
          win.bluemap.setFlatView(0)
          return
        }
        if (nextView === '3d' && nextCamera === 'free' && typeof win.bluemap.setFreeFlight === 'function') {
          win.bluemap.setFreeFlight(0, 40)
          return
        }
        if (nextView === '3d' && nextCamera === 'perspective' && typeof win.bluemap.setPerspectiveView === 'function') {
          win.bluemap.setPerspectiveView(0)
          // BlueMap keeps the flat camera's zero angle, which would look top-down in 3D again.
          if (leaving2d) {
            const cm = win.bluemap.mapViewer?.controlsManager
            if (cm) {
              const spawn = spawnView('3d')
              cm.angle = spawn.angle
              cm.tilt = spawn.tilt
              cm.ortho = spawn.ortho
            }
            win.bluemap.updatePageAddress?.()
            win.bluemap.mapViewer?.updateLoadedMapArea?.()
          }
          return
        }
      }
    } catch {
      /* cross-origin fallback */
    }
    setSrc(mapUrl(nextView, nextCamera))
  }

  const handleCenter = () => {
    try {
      const win = iframeRef.current?.contentWindow as BlueMapWindow | null
      if (win?.bluemap) {
        if (typeof win.bluemap.resetCamera === 'function') {
          win.bluemap.resetCamera()
        }
        const cm = win.bluemap.mapViewer?.controlsManager
        if (cm && cm.position) {
          const spawn = spawnView(view)
          cm.position.set(0, 70, 0)
          cm.distance = spawn.distance
          cm.rotation = 0
          cm.angle = spawn.angle
          cm.tilt = spawn.tilt
          cm.ortho = spawn.ortho
          win.bluemap.updatePageAddress?.()
          win.bluemap.mapViewer?.updateLoadedMapArea?.()
        }
        return
      }
      if (win?.location) {
        win.location.hash = mapUrl(view, camera).replace('/map/', '')
        if (typeof win.bluemap?.loadPageAddress === 'function') {
          win.bluemap.loadPageAddress()
        }
        return
      }
    } catch {
      /* cross-origin fallback */
    }
    if (iframeRef.current) {
      setSrc(mapUrl(view, camera))
    }
  }

  const handleRefresh = () => {
    try {
      const win = iframeRef.current?.contentWindow as BlueMapWindow | null
      if (win?.bluemap?.mapViewer) {
        if (typeof win.bluemap.mapViewer.clearTileCache === 'function') {
          win.bluemap.mapViewer.clearTileCache()
        }
        if (typeof win.bluemap.mapViewer.updateLoadedMapArea === 'function') {
          win.bluemap.mapViewer.updateLoadedMapArea()
        }
        return
      }
    } catch {
      /* cross-origin fallback */
    }
    setLoading(true)
    setSrc(mapUrl(view, camera))
    setIframeKey((k) => k + 1)
  }

  const handlePopout = () => {
    window.open(mapUrl(view, camera), '_blank', 'noopener,noreferrer')
  }

  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => setLoading(false), 2500)
    return () => clearTimeout(timer)
  }, [visible, iframeKey])

  return (
    <div className="map-page-shell">
      {/* Top Aero HUD Toolbar */}
      <div className="map-hud-bar">
        <div className="map-hud-group" role="group" aria-label="Map view">
          <span className="map-hud-label">View:</span>
          <button
            type="button"
            className={`map-hud-btn ${view === '3d' ? 'active' : ''}`}
            aria-pressed={view === '3d'}
            onClick={() => applyView('3d')}
            title="3D map with terrain relief and a horizon"
          >
            3D
          </button>
          <button
            type="button"
            className={`map-hud-btn ${view === '2d' ? 'active' : ''}`}
            aria-pressed={view === '2d'}
            onClick={() => applyView('2d')}
            title="2D map, a flat top-down plan of the same world"
          >
            2D
          </button>
        </div>

        {view === '3d' && (
          <>
            <div className="map-hud-divider" />
            <div className="map-hud-group" role="group" aria-label="3D camera">
              <span className="map-hud-label">Camera:</span>
              <button
                type="button"
                className={`map-hud-btn ${camera === 'perspective' ? 'active' : ''}`}
                aria-pressed={camera === 'perspective'}
                onClick={() => applyView('3d', 'perspective')}
                title="3D perspective view with a horizon"
              >
                Perspective
              </button>
              <button
                type="button"
                className={`map-hud-btn ${camera === 'free' ? 'active' : ''}`}
                aria-pressed={camera === 'free'}
                onClick={() => applyView('3d', 'free')}
                title="Fly the camera freely around the world"
              >
                Free-Flight
              </button>
            </div>
          </>
        )}

        <div className="map-hud-divider" />

        <div className="map-hud-group">
          <button
            type="button"
            className="map-hud-btn"
            onClick={handleCenter}
            title="Reset camera to world spawn (0, 0)"
          >
            Center Spawn
          </button>
          <button
            type="button"
            className="map-hud-btn"
            onClick={handleRefresh}
            title="Reload live map tiles and player markers"
          >
            Refresh
          </button>
          <button
            type="button"
            className="map-hud-btn popout"
            onClick={handlePopout}
            title="Open the current map view in a full browser window"
          >
            Full Window
          </button>
        </div>

        <div className="map-hud-badges">
          <span className="map-badge" title="BlueMap renders the central 2000x2000 blocks">
            <span className="badge-dot" /> {view === '2d' ? '2D' : '3D'} Area: 2000×2000
          </span>
          <span className="map-badge secondary" title="Server world border limit">
            World: 5000×5000
          </span>
        </div>
      </div>

      {/* Embedded map iframe container */}
      <div className="map-frame-wrapper">
        {loading && (
          <div className="map-loading-overlay">
            <div className="map-spinner" />
            <div className="map-loading-text">
              <h3>Connecting to Live {view === '2d' ? '2D' : '3D'} World…</h3>
              <p>Streaming terrain chunks, block geometry, and territory markers.</p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={iframeKey}
          src={src}
          className="map-iframe"
          title={`Minecraft Live ${view === '2d' ? '2D' : '3D'} World Map`}
          allow="fullscreen; accelerometer; gyroscope; xr-spatial-tracking"
          onLoad={() => setLoading(false)}
        />
      </div>

      {/* Bottom Aero Status Footnote */}
      <div className="map-hud-footer">
        <span>Active Private Territories are automatically outlined in cyan/blue on the map radar.</span>
        <span>
          {view === '2d'
            ? 'Drag left click to pan · Scroll to zoom · Top-down orthographic plan'
            : 'Drag left click to rotate · Right click to pan · Scroll to zoom'}
        </span>
      </div>
    </div>
  )
}
