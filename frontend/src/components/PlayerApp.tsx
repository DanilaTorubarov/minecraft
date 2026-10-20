import { useState } from 'react'
import type { StatsAccount, StatsView } from '../lib/api'
import StatisticsPage from '../pages/StatisticsPage'
import InventoryPage from '../pages/InventoryPage'
import SkinPage from '../pages/SkinPage'
import PrivatesPage from '../pages/PrivatesPage'

type Props = { account: StatsAccount; stats: StatsView | null; loadError: string; onRetry: () => void; onSelectAccount: (uuid: string) => void; onGoToAccount: () => void; open: boolean; inventoryLaunch?: number; onOpenMarketplace?: () => void }
export default function PlayerApp({ account, stats, loadError, onRetry, onSelectAccount, onGoToAccount, open, inventoryLaunch = 0, onOpenMarketplace }: Props) {
  const [seenLaunch, setSeenLaunch] = useState(inventoryLaunch)
  const [page, setPage] = useState<'statistics' | 'inventory' | 'skin' | 'privates'>(inventoryLaunch > 0 ? 'inventory' : 'statistics')
  const [inventoryVisited, setInventoryVisited] = useState(inventoryLaunch > 0)
  const [skinVisited, setSkinVisited] = useState(false)
  const [privatesVisited, setPrivatesVisited] = useState(false)
  if (inventoryLaunch !== seenLaunch) {
    setSeenLaunch(inventoryLaunch)
    if (inventoryLaunch > 0) { setPage('inventory'); setInventoryVisited(true) }
  }
  return <>
    <div className="account-toolbar player-toolbar"><span>{account.username}</span><nav className="nav" aria-label={`${account.username} pages`}>
      <button className="btn btn-quiet" aria-current={page === 'statistics' ? 'page' : undefined} onClick={() => setPage('statistics')}>Statistics</button>
      <button className="btn btn-quiet" aria-current={page === 'inventory' ? 'page' : undefined} onClick={() => { setPage('inventory'); setInventoryVisited(true) }}>Inventory</button>
      <button className="btn btn-quiet" aria-current={page === 'privates' ? 'page' : undefined} onClick={() => { setPage('privates'); setPrivatesVisited(true) }}>Privates</button>
      <button className="btn btn-quiet" aria-current={page === 'skin' ? 'page' : undefined} onClick={() => { setPage('skin'); setSkinVisited(true) }}>Skin</button>
    </nav></div>
    <div className="workspace stats-workspace"><main className="main">
      <div hidden={page !== 'statistics'}><StatisticsPage scope={account.uuid} stats={stats} loadError={loadError} onRetry={onRetry} onSelectAccount={onSelectAccount} onGoToAccount={onGoToAccount} /></div>
      {inventoryVisited && <div hidden={page !== 'inventory'}><InventoryPage uuid={account.uuid} username={account.username} visible={open && page === 'inventory'} /></div>}
      {privatesVisited && <div hidden={page !== 'privates'}><PrivatesPage uuid={account.uuid} username={account.username} visible={open && page === 'privates'} onOpenMarketplace={onOpenMarketplace} /></div>}
      {skinVisited && <div hidden={page !== 'skin'}><SkinPage uuid={account.uuid} username={account.username} visible={open && page === 'skin'} /></div>}
    </main></div>
  </>
}
