import { useState, useRef, useEffect } from 'react'

type Props = {
  visible: boolean
}

export default function MapPage({ visible }: Props) {
  const [iframeKey, setIframeKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [cameraMode, setCameraMode] = useState<'perspective' | 'free' | 'flat'>('perspective')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Map URL with view anchors:
  // #world:0:50:-50:500:0:0.5:0:0:perspective
  // #world:0:30:-30:300:0:0:0:0:free
  // #world:0:0:0:1500:0:0:0:0:flat
  const getMapUrl = (mode: 'perspective' | 'free' | 'flat') => {
    switch (mode) {
      case 'perspective':
        return '/map/#world:0:60:-60:450:0:0.45:0:0:perspective'
      case 'free':
        return '/map/#world:0:30:-30:300:0:0:0:0:free'
      case 'flat':
        return '/map/#world:0:0:0:1200:0:0:0:0:flat'
    }
  }

  const setView = (mode: 'perspective' | 'free' | 'flat') => {
    setCameraMode(mode)
    if (iframeRef.current) {
      iframeRef.current.src = getMapUrl(mode)
    }
  }

  const handleRefresh = () => {
    setLoading(true)
    setIframeKey((k) => k + 1)
  }

  const handleCenter = () => {
    setView(cameraMode)
  }

  const handlePopout = () => {
    window.open(getMapUrl(cameraMode), '_blank', 'noopener,noreferrer')
  }

  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => setLoading(false), 3000)
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
            🎯 Center Spawn
          </button>
          <button
            type="button"
            className="map-hud-btn"
            onClick={handleRefresh}
            title="Reload live map tiles and player markers"
          >
            🔄 Refresh
          </button>
          <button
            type="button"
            className="map-hud-btn popout"
            onClick={handlePopout}
            title="Open 3D map in full browser window"
          >
            ↗ Full Window
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
