export type MapViewMode = '2d' | '3d'
export type MapCamera = 'perspective' | 'free'

// BlueMap addresses are map:x:y:z:distance:rotation:angle:tilt:ortho:controls.
// A 2D map is the same terrain on an orthographic, top-down camera (ortho 1, angle and tilt 0);
// a 3D map keeps the perspective camera (ortho 0).
const MAP_URLS: Record<MapViewMode, Record<MapCamera, string>> = {
  '2d': {
    perspective: '/map/#world:0:70:0:1200:0:0:0:1:flat',
    free: '/map/#world:0:70:0:1200:0:0:0:1:flat',
  },
  '3d': {
    perspective: '/map/#world:0:70:0:450:0:0.45:0:0:perspective',
    free: '/map/#world:0:40:0:300:0:0:0:0:free',
  },
}

export function mapUrl(view: MapViewMode, camera: MapCamera): string {
  return MAP_URLS[view][camera]
}

/** Camera state that centers the current view on world spawn (0, 0). */
export function spawnView(view: MapViewMode): { distance: number; angle: number; tilt: number; ortho: number } {
  if (view === '2d') return { distance: 1200, angle: 0, tilt: 0, ortho: 1 }
  return { distance: 450, angle: 0.45, tilt: 0, ortho: 0 }
}
