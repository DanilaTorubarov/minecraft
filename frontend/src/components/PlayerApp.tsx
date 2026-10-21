import { useState } from 'react'
import type { StatsAccount, StatsView } from '../lib/api'
import { usePresence } from '../lib/usePresence'
import StatusBadge from './StatusBadge'
import StatisticsPage from '../pages/StatisticsPage'
import InventoryPage from '../pages/InventoryPage'
import SkinPage from '../pages/SkinPage'
import PrivatesPage from '../pages/PrivatesPage'
import MailPage from '../pages/MailPage'

type Props = { account: StatsAccount; stats: StatsView | null; loadError: string; onRetry: () => void; onSelectAccount: (uuid: string) => void; onGoToAccount: () => void; open: boolean; inventoryLaunch?: number; onOpenMarketplace?: () => void }
export default function PlayerApp({ account, stats, loadError, onRetry, onSelectAccount, onGoToAccount, open, inventoryLaunch = 0, onOpenMarketplace }: Props) {
  const { presence } = usePresence(open)
  const accPresence = presence?.accounts.find((a) => a.uuid.toLowerCase() === account.uuid.toLowerCase())
  const [seenLaunch, setSeenLaunch] = useState(inventoryLaunch)
  const [page, setPage] = useState<'statistics' | 'inventory' | 'privates' | 'mail' | 'skin'>(inventoryLaunch > 0 ? 'inventory' : 'statistics')
  const [inventoryVisited, setInventoryVisited] = useState(inventoryLaunch > 0)
  const [skinVisited, setSkinVisited] = useState(false)
  const [privatesVisited, setPrivatesVisited] = useState(false)
  const [mailVisited, setMailVisited] = useState(false)
  if (inventoryLaunch !== seenLaunch) {
    setSeenLaunch(inventoryLaunch)
    if (inventoryLaunch > 0) { setPage('inventory'); setInventoryVisited(true) }
  }
  return <>
    <div className="account-toolbar player-toolbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span>{account.username}</span>
        {accPresence && (
          <StatusBadge
            status={accPresence.status}
            label={accPresence.status_label}
            ping={accPresence.ping}
            world={accPresence.world}
            compact
          />
        )}
      </div>
      <nav className="nav" aria-label={`${account.username} pages`}>
      <button className="btn btn-quiet" aria-current={page === 'statistics' ? 'page' : undefined} onClick={() => setPage('statistics')}>Statistics</button>
      <button className="btn btn-quiet" aria-current={page === 'inventory' ? 'page' : undefined} onClick={() => { setPage('inventory'); setInventoryVisited(true) }}>Inventory</button>
      <button className="btn btn-quiet" aria-current={page === 'privates' ? 'page' : undefined} onClick={() => { setPage('privates'); setPrivatesVisited(true) }}>Privates</button>
      <button className="btn btn-quiet" aria-current={page === 'mail' ? 'page' : undefined} onClick={() => { setPage('mail'); setMailVisited(true) }}>Mail</button>
      <button className="btn btn-quiet" aria-current={page === 'skin' ? 'page' : undefined} onClick={() => { setPage('skin'); setSkinVisited(true) }}>Skin</button>
    </nav></div>
    <div className="workspace stats-workspace"><main className="main">
      <div hidden={page !== 'statistics'}><StatisticsPage scope={account.uuid} stats={stats} loadError={loadError} onRetry={onRetry} onSelectAccount={onSelectAccount} onGoToAccount={onGoToAccount} /></div>
      {inventoryVisited && <div hidden={page !== 'inventory'}><InventoryPage uuid={account.uuid} username={account.username} visible={open && page === 'inventory'} /></div>}
      {privatesVisited && <div hidden={page !== 'privates'}><PrivatesPage uuid={account.uuid} username={account.username} visible={open && page === 'privates'} onOpenMarketplace={onOpenMarketplace} /></div>}
      {mailVisited && <div hidden={page !== 'mail'}><MailPage uuid={account.uuid} username={account.username} visible={open && page === 'mail'} onOpenInventory={() => { setPage('inventory'); setInventoryVisited(true) }} /></div>}
      {skinVisited && <div hidden={page !== 'skin'}><SkinPage uuid={account.uuid} username={account.username} visible={open && page === 'skin'} /></div>}
    </main></div>
  </>
}
