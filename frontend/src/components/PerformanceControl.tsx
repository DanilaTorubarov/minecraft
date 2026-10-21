import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import { useLowPerformanceSetting } from '../lib/performanceSetting'

export default function PerformanceControl() {
  const [effective, setManual, autoInGame, setAutoInGame, isAutoActive] = useLowPerformanceSetting()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <label className="theme-control">
        <img src={perfCenterIcon} alt="" aria-hidden="true" />
        <span>Manual low performance mode</span>
        <select
          value={effective && !isAutoActive ? 'on' : 'off'}
          onChange={(event) => setManual(event.target.value === 'on')}
          aria-label="Low performance mode"
        >
          <option value="off">Off (Full Aero Glass & 3D Shaders)</option>
          <option value="on">On (Always Optimized for Gaming)</option>
        </select>
      </label>

      <label className="theme-control">
        <img src={perfCenterIcon} alt="" aria-hidden="true" />
        <span>Auto low quality when in game</span>
        <select
          value={autoInGame ? 'on' : 'off'}
          onChange={(event) => setAutoInGame(event.target.value === 'on')}
          aria-label="Auto low quality when in game"
        >
          <option value="on">Enabled (Auto-switch when playing)</option>
          <option value="off">Disabled (Keep current graphics)</option>
        </select>
      </label>

      {isAutoActive && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(34, 197, 94, 0.12)',
            border: '1px solid rgba(34, 197, 94, 0.3)',
            color: '#16a34a',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <span style={{ fontSize: 14 }}>🎮</span>
          <span>In-Game Active: Low performance mode is automatically engaged to maximize Minecraft FPS.</span>
        </div>
      )}
    </div>
  )
}
