import { useState } from 'react'
import chestIcon from '../assets/icons/game-lucky-chest.png'
import minesIcon from '../assets/icons/game-minesweeper.png'
import LuckyChestGame from '../components/LuckyChestGame'
import MinesweeperGame from '../components/MinesweeperGame'
import PayerSelect from '../components/PayerSelect'
import BankTransferCard from '../components/BankTransferCard'
import { useAuth } from '../lib/auth-context'
import { useStatistics } from '../lib/useStatistics'
import { useMinigameRules, usePayer } from '../lib/useMinigames'
import { formatCoins, formatReturn, type Payer } from '../lib/minigames'

export default function MinigamesPage({ onGoToAccount }: { onGoToAccount?: () => void }) {
  const { user, ready } = useAuth()
  const { stats, loadError, retry } = useStatistics(user?.id)
  const { rules, error: rulesError, retry: retryRules } = useMinigameRules()
  const { payer, choose } = usePayer(stats?.accounts ?? [])
  const [game, setGame] = useState<'chest' | 'mines' | null>(null)
  if (!ready) return <p className="loading">Loading…</p>
  if (!user) return <><div className="page-head"><h1>Minigames</h1><p className="page-sub">A little luck, paid from your Web Bank coins.</p></div><div className="note"><p>Sign in and link a Minecraft player to play.</p><button className="btn btn-primary" onClick={onGoToAccount}>Sign in</button></div></>
  if (!stats) return loadError ? <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={retry}>Retry loading players</button></div> : <p className="loading">Loading your players…</p>
  if (!payer) return <><div className="page-head"><h1>Minigames</h1></div><div className="note"><p>Link a Minecraft player to use the coins earned in game. Check your balance with <code>/bal</code> or <code>/bank</code>.</p><button className="btn btn-primary" onClick={onGoToAccount}>Link an account</button></div></>
  if (!rules) return rulesError ? <div className="note" data-tone="error" role="alert"><p>{rulesError}</p><button className="btn" onClick={retryRules}>Retry loading rules</button></div> : <p className="loading">Loading game rules…</p>
  const accounts: Payer[] = stats.accounts.map(({ uuid, username, coins }) => ({ uuid, username, coins }))
  const bankCoins = stats.bank_coins ?? user.bank_coins ?? 0
  const props = { payer, accounts, onChoosePayer: choose, rules, onBack: () => setGame(null), bankCoins }
  const rulesNotice = rulesError ? <div className="note" data-tone="error" role="alert"><p>Could not refresh economic rules. New stakes require the current paytable; paid rounds keep their rules.</p><button className="btn" onClick={retryRules}>Retry loading rules</button></div> : null
  if (game === 'chest') return <>{rulesNotice}<LuckyChestGame key={user.id} {...props} userId={user.id} /></>
  if (game === 'mines') return <>{rulesNotice}<MinesweeperGame key={user.id} {...props} /></>
  return <div className="minigame-workspace">
    <div className="page-head"><h1>Minigames</h1><p className="page-sub">Take a chance with your Web Bank coins.</p></div>
    {rulesNotice}
    <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' }}>
      <div className="chest-balance-pill casino-payer-pill" title="Web Bank Balance">
        <span style={{ fontSize: '0.85em', opacity: 0.8 }}>Bank:</span>
        <span className="chest-balance-num">{formatCoins(bankCoins)}</span>
        <span className="chest-balance-label">coins</span>
      </div>
      <PayerSelect payer={payer} accounts={accounts} onChoose={choose} />
    </div>
    <div className="game-library">
      <section className="game-library-entry"><img src={chestIcon} alt="" /><div><h2>Lucky Chest</h2><p>Spin three floating treasures. Match a pair, land three alike, or find a lone diamond.</p><p className="muted">Expected return: {formatReturn(rules.chest.rtp_x10000)}</p><button className="btn btn-primary" onClick={() => setGame('chest')}>Play Lucky Chest</button></div></section>
      <section className="game-library-entry"><img src={minesIcon} alt="" /><div><h2>Minesweeper</h2><p>Explore a field of hidden ore and TNT. Cash out your finds before your luck runs out.</p><p className="muted">Four difficulties · Find {rules.mines.min_safe} ores to unlock cash-out</p><button className="btn btn-primary" onClick={() => setGame('mines')}>Play Minesweeper</button></div></section>
    </div>
    <section className="section" style={{ marginTop: '24px' }}>
      <div className="section-head">
        <h2>Web Bank & Transfer</h2>
        <p className="muted">Transfer coins between your Minecraft player pocket and your Web Bank to play minigames.</p>
      </div>
      <BankTransferCard
        accounts={stats.accounts}
        bankCoins={bankCoins}
        compact
      />
    </section>
    <p className="game-rules">Stakes and payouts use your Web Bank balance. Deposit coins from any linked Minecraft player or withdraw winnings back into your in-game pocket. You can also use /bank in game to check balances and deposit/withdraw on the fly. Economic adjustments apply equally to everyone; each round keeps the rules it starts with. These games do not use real money.</p>
  </div>
}
