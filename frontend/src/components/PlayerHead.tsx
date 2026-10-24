import { useState } from 'react'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import { displayPlayerName } from '../lib/playerName'

/** Use the server-selected texture, never a nickname guess from another provider. */
export default function PlayerHead({ username, textureHash }: { username: string; textureHash?: string | null }) {
  const [failedHash, setFailedHash] = useState<string | null>(null)
  const src = textureHash && failedHash !== textureHash ? `https://mc-heads.net/avatar/${textureHash}/64` : perfCenterIcon
  return <img className="player-head" src={src} alt="" title={`${displayPlayerName(username)} player app`} referrerPolicy="no-referrer" onError={() => setFailedHash(textureHash ?? null)} />
}
