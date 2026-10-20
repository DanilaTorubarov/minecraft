import { useState, useRef, useEffect } from 'react'

type CameraMode = 'perspective' | 'free' | 'flat'

interface BlueMapBridge {
  setPerspectiveView?: (animationDuration: number) => void
  setFreeFlight?: (animationDuration: number, startDistance?: number) => void
  setFlatView?: (animationDuration: number) => void
  resetCamera?: () => void
  loadPageAddress?: () => void
  updatePageAddress?: () => void
  mapViewer?: {
    controlsManager?: {
      position?: { set: (x: number, y: number, z: number) => void }
      distance?: number
      rotation?: number
      angle?: number
      tilt?: number
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
  const [loading, setLoading] = useState(true)
  const [cameraMode, setCameraMode] = useState<CameraMode>('perspective')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const getMapUrl = (mode: CameraMode) => {
    switch (mode) {
      case 'perspective':
        return '/map/#world:0:70:0:450:0:0.45:0:0:perspective'
      case 'free':
        return '/map/#world:0:40:0:300:0:0:0:0:free'
      case 'flat':
        return '/map/#world:0:0:0:1200:0:0:0:0:flat'
    }
  }

  const setView = (mode: CameraMode) => {
    setCameraMode(mode)
    try {
      const win = iframeRef.current?.contentWindow as BlueMapWindow | null
      if (win?.bluemap) {
        if (mode === 'perspective' && typeof win.bluemap.setPerspectiveView === 'function') {
          win.bluemap.setPerspectiveView(0)
          return
        }
        if (mode === 'free' && typeof win.bluemap.setFreeFlight === 'function') {
          win.bluemap.setFreeFlight(0, 40)
          return
        }
        if (mode === 'flat' && typeof win.bluemap.setFlatView === 'function') {
          win.bluemap.setFlatView(0)
          return
        }
      }
    } catch {
      /* cross-origin fallback */
    }
    if (iframeRef.current) {
      iframeRef.current.src = getMapUrl(mode)
    }
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
          cm.position.set(0, 70, 0)
          cm.distance = 450
          cm.rotation = 0
          cm.angle = 0.45
          cm.tilt = 0
          win.bluemap.updatePageAddress?.()
          win.bluemap.mapViewer?.updateLoadedMapArea?.()
        }
        return
      }
      if (win?.location) {
        win.location.hash = `#world:0:70:0:450:0:0.45:0:0:${cameraMode}`
        if (typeof win.bluemap?.loadPageAddress === 'function') {
          win.bluemap.loadPageAddress()
        }
        return
      }
    } catch {
      /* cross-origin fallback */
    }
    if (iframeRef.current) {
      iframeRef.current.src = getMapUrl(cameraMode)
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
    setIframeKey((k) => k + 1)
  }

  const handlePopout = () => {
    window.open(getMapUrl(cameraMode), '_blank', 'noopener,noreferrer')
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
        <div className="map-hud-group">
          <span className="map-hud-label">Camera:</span>
          <button
            type="button"
            className={`map-hud-btn ${cameraMode === 'perspective' ? 'active' : ''}`}
            onClick={() => setView('perspective')}
            title="3D Perspective View (Standard 3D terrain with horizon)"
          >
            3D Perspective
          </button>
          <button
            type="button"
            className={`map-hud-btn ${cameraMode === 'free' ? 'active' : ''}`}
            onClick={() => setView('free')}
            title="Free-Flight 3D View (Fly camera around world)"
          >
            3D Free-Flight
          </button>
          <button
            type="button"
            className={`map-hud-btn ${cameraMode === 'flat' ? 'active' : ''}`}
            onClick={() => setView('flat')}
            title="Isometric Flat View (Top-down view)"
          >
            Flat
          </button>
        </div>

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
            title="Open 3D map in full browser window"
          >
            Full Window
          </button>
        </div>

        <div className="map-hud-badges">
          <span className="map-badge" title="BlueMap renders the central 2000x2000 blocks">
            <span className="badge-dot" /> 3D Area: 2000×2000
          </span>
          <span className="map-badge secondary" title="Server world border limit">
            World: 5000×5000
          </span>
        </div>
      </div>

      {/* Embedded 3D Map Iframe Container */}
      <div className="map-frame-wrapper">
        {loading && (
          <div className="map-loading-overlay">
            <div className="map-spinner" />
            <div className="map-loading-text">
              <h3>Connecting to Live 3D World…</h3>
              <p>Streaming terrain chunks, block geometry, and territory markers.</p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={iframeKey}
          src={getMapUrl(cameraMode)}
          className="map-iframe"
          title="Minecraft Live 3D World Map"
          allow="fullscreen; accelerometer; gyroscope; xr-spatial-tracking"
          onLoad={() => setLoading(false)}
        />
      </div>

      {/* Bottom Aero Status Footnote */}
      <div className="map-hud-footer">
        <span>Active Private Territories are automatically outlined in cyan/blue on the map radar.</span>
        <span>Drag left click to rotate · Right click to pan · Scroll to zoom</span>
      </div>
    </div>
  )
}
