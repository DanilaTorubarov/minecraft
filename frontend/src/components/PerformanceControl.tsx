import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import { useLowPerformanceSetting } from '../lib/performanceSetting'

export default function PerformanceControl() {
  const [enabled, setEnabled] = useLowPerformanceSetting()

  return (
    <label className="theme-control">
      <img src={perfCenterIcon} alt="" aria-hidden="true" />
      <span>Low performance mode</span>
      <select
        value={enabled ? 'on' : 'off'}
        onChange={(event) => setEnabled(event.target.value === 'on')}
        aria-label="Low performance mode"
      >
        <option value="off">Off (Full Aero Glass & 3D Shaders)</option>
        <option value="on">On (Optimized for Gaming)</option>
      </select>
    </label>
  )
}
