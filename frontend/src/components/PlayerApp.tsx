import { useState } from 'react'
import type { StatsAccount, StatsView } from '../lib/api'
import StatisticsPage from '../pages/StatisticsPage'
import SkinPage from '../pages/SkinPage'

type Props = { account: StatsAccount; stats: StatsView | null; loadError: string; onRetry: () => void; onSelectAccount: (uuid: string) => void; onGoToAccount: () => void; open: boolean }
export default function PlayerApp({ account, stats, loadError, onRetry, onSelectAccount, onGoToAccount, open }: Props) {
  const [page, setPage] = useState<'statistics' | 'skin'>('statistics')
  const [skinVisited, setSkinVisited] = useState(false)
  return <>
    <div className="account-toolbar player-toolbar"><span>{account.username}</span><nav className="nav" aria-label={`${account.username} pages`}>
      <button className="btn btn-quiet" aria-current={page === 'statistics' ? 'page' : undefined} onClick={() => setPage('statistics')}>Statistics</button>
      <button className="btn btn-quiet" aria-current={page === 'skin' ? 'page' : undefined} onClick={() => { setPage('skin'); setSkinVisited(true) }}>Skin</button>
    </nav></div>
    <div className="workspace stats-workspace"><main className="main">
      <div hidden={page !== 'statistics'}><StatisticsPage scope={account.uuid} stats={stats} loadError={loadError} onRetry={onRetry} onSelectAccount={onSelectAccount} onGoToAccount={onGoToAccount} /></div>
      {skinVisited && <div hidden={page !== 'skin'}><SkinPage uuid={account.uuid} username={account.username} visible={open && page === 'skin'} /></div>}
    </main></div>
  </>
}
