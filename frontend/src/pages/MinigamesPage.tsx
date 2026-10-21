import { useState } from 'react'
import chestIcon from '../assets/icons/game-lucky-chest.png'
import minesIcon from '../assets/icons/game-minesweeper.png'
import LuckyChestGame from '../components/LuckyChestGame'
import MinesweeperGame from '../components/MinesweeperGame'
import PayerSelect from '../components/PayerSelect'
import { useAuth } from '../lib/auth-context'
import { useStatistics } from '../lib/useStatistics'
import { useMinigameRules, usePayer } from '../lib/useMinigames'
import { formatReturn, type Payer } from '../lib/minigames'

export default function MinigamesPage({ onGoToAccount }: { onGoToAccount?: () => void }) {
  const { user, ready } = useAuth()
  const { stats, loadError, retry } = useStatistics(user?.id)
  const { rules, error: rulesError, retry: retryRules } = useMinigameRules()
  const { payer, choose } = usePayer(stats?.accounts ?? [])
  const [game, setGame] = useState<'chest' | 'mines' | null>(null)
  if (!ready) return <p className="loading">Loading…</p>
  if (!user) return <><div className="page-head"><h1>Minigames</h1><p className="page-sub">A little luck, paid from your Minecraft coins.</p></div><div className="note"><p>Sign in and link a Minecraft player to play.</p><button className="btn btn-primary" onClick={onGoToAccount}>Sign in</button></div></>
  if (!stats) return loadError ? <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={retry}>Retry loading players</button></div> : <p className="loading">Loading your players…</p>
  if (!payer) return <><div className="page-head"><h1>Minigames</h1></div><div className="note"><p>Link a Minecraft player to use the coins earned in game. Check your balance with <code>/bal</code>.</p><button className="btn btn-primary" onClick={onGoToAccount}>Link an account</button></div></>
  if (!rules) return rulesError ? <div className="note" data-tone="error" role="alert"><p>{rulesError}</p><button className="btn" onClick={retryRules}>Retry loading rules</button></div> : <p className="loading">Loading game rules…</p>
  const accounts: Payer[] = stats.accounts.map(({ uuid, username, coins }) => ({ uuid, username, coins }))
  const props = { payer, accounts, onChoosePayer: choose, rules, onBack: () => setGame(null) }
  const rulesNotice = rulesError ? <div className="note" data-tone="error" role="alert"><p>Could not refresh economic rules. New stakes require the current paytable; paid rounds keep their rules.</p><button className="btn" onClick={retryRules}>Retry loading rules</button></div> : null
  if (game === 'chest') return <>{rulesNotice}<LuckyChestGame key={user.id} {...props} userId={user.id} /></>
  if (game === 'mines') return <>{rulesNotice}<MinesweeperGame key={user.id} {...props} /></>
  return <div className="minigame-workspace">
    <div className="page-head"><h1>Minigames</h1><p className="page-sub">Take a chance with the coins you earn in Minecraft.</p></div>
    {rulesNotice}
    <PayerSelect payer={payer} accounts={accounts} onChoose={choose} />
    <div className="game-library">
      <section className="game-library-entry"><img src={chestIcon} alt="" /><div><h2>Lucky Chest</h2><p>Spin three floating treasures. Match a pair, land three alike, or find a lone diamond.</p><p className="muted">Expected return: {formatReturn(rules.chest.rtp_x10000)}</p><button className="btn btn-primary" onClick={() => setGame('chest')}>Play Lucky Chest</button></div></section>
      <section className="game-library-entry"><img src={minesIcon} alt="" /><div><h2>Minesweeper</h2><p>Explore a field of hidden ore and TNT. Cash out your finds before your luck runs out.</p><p className="muted">Four difficulties · Find {rules.mines.min_safe} ores to unlock cash-out</p><button className="btn btn-primary" onClick={() => setGame('mines')}>Play Minesweeper</button></div></section>
    </div>
    <p className="game-rules">Stakes and payouts use your selected player’s Minecraft balance. Use /quests in game to open the visual contracts GUI and earn coins through hunting, fishing, farming, or mining. Economic adjustments apply equally to everyone; each round keeps the rules it starts with. These games do not use real money.</p>
  </div>
}
