import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import { useSoundSetting } from '../lib/soundSetting'

export default function SoundControl() {
  const [enabled, setEnabled] = useSoundSetting()

  return (
    <label className="theme-control">
      <img src={perfCenterIcon} alt="" aria-hidden="true" />
      <span>Interface sounds</span>
      <select
        value={enabled ? 'on' : 'off'}
        onChange={(event) => setEnabled(event.target.value === 'on')}
      >
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  )
}
