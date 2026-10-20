import { useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useAuth } from '../lib/auth-context'
import ThemeControl from './ThemeControl'
import SoundControl from './SoundControl'
import MusicPlayer from './MusicPlayer'
import DesktopWindow from './DesktopWindow'
import LiveWallpaper from './LiveWallpaper'
import ClickWaves from './ClickWaves'
import PlayerApp from './PlayerApp'
import PlayerHead from './PlayerHead'
import { useStatistics } from '../lib/useStatistics'
import MarketplacePage from '../pages/MarketplacePage'
import StatisticsPage from '../pages/StatisticsPage'
import globeIcon from '../assets/icons/vista-search-globe.png'
import personalizationIcon from '../assets/icons/vista-personalization.png'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import firewallOnIcon from '../assets/icons/vista-firewall-on.png'
import minigamesIcon from '../assets/icons/minigames-gamepad.png'
import MinigamesPage from '../pages/MinigamesPage'
import AdminPage from '../pages/AdminPage'
import ChatPage from '../pages/ChatPage'
import MapPage from '../pages/MapPage'

function Shell() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const authPage = location.pathname === '/login' || location.pathname === '/register'
  const [leaving, setLeaving] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [accountOpen, setAccountOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [marketOpen, setMarketOpen] = useState(false)
  const [marketActivation, setMarketActivation] = useState(0)
  const marketDock = useRef<HTMLButtonElement>(null)
  const [inventoryLaunch, setInventoryLaunch] = useState<{ uuid: string; activation: number } | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [casinoOpen, setCasinoOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const [active, setActive] = useState('account')
  const [accountActivation, setAccountActivation] = useState(0)
  const [settingsActivation, setSettingsActivation] = useState(0)
  const [statsActivation, setStatsActivation] = useState(0)
  const [casinoActivation, setCasinoActivation] = useState(0)
  const [adminActivation, setAdminActivation] = useState(0)
  const [chatActivation, setChatActivation] = useState(0)
  const [mapActivation, setMapActivation] = useState(0)
  const { stats, loadError, retry } = useStatistics(user?.id)
  const statsAccounts = stats?.accounts ?? []
  const [playerOpen, setPlayerOpen] = useState(false)
  const [playerActivation, setPlayerActivation] = useState(0)
  const [playerSelection, setPlayerSelection] = useState<{ userId: number; uuid: string } | null>(null)
  const selectedPlayer = statsAccounts.find((account) => playerSelection?.userId === user?.id && account.uuid === playerSelection?.uuid) ?? statsAccounts[0]
  const accountDock = useRef<HTMLButtonElement>(null)
  const settingsDock = useRef<HTMLButtonElement>(null)
  const statsDock = useRef<HTMLButtonElement>(null)
  const playerDock = useRef<HTMLButtonElement>(null)
  const casinoDock = useRef<HTMLButtonElement>(null)
  const adminDock = useRef<HTMLButtonElement>(null)
  const chatDock = useRef<HTMLButtonElement>(null)
  const mapDock = useRef<HTMLButtonElement>(null)
  function openPlayer(uuid?: string) {
    if (uuid === 'all') { openStats(); return }
    if (uuid && user) setPlayerSelection({ userId: user.id, uuid })
    setPlayerOpen(true)
    setPlayerActivation((value) => value + 1)
    setActive('player')
  }
  function hidePlayer() {
    setPlayerOpen(false)
    setActive('account')
    playerDock.current?.focus()
  }

  function openMarket() { setMarketOpen(true); setActive('market'); setMarketActivation((value) => value + 1) }
  function hideMarket() { setMarketOpen(false); setActive('account'); marketDock.current?.focus() }
  function openInventory(uuid: string) { openPlayer(uuid); setInventoryLaunch((current) => ({ uuid, activation: (current?.activation ?? 0) + 1 })) }

  function openAccount() { setAccountOpen(true); setActive('account'); setAccountActivation((value) => value + 1) }
  function openSettings() { setSettingsOpen(true); setActive('settings'); setSettingsActivation((value) => value + 1) }
  function openStats() { setStatsOpen(true); setActive('stats'); setStatsActivation((value) => value + 1) }
  function openCasino() { setCasinoOpen(true); setActive('casino'); setCasinoActivation((value) => value + 1) }
  function openAdmin() { setAdminOpen(true); setActive('admin'); setAdminActivation((value) => value + 1) }
  function openChat() { setChatOpen(true); setActive('chat'); setChatActivation((value) => value + 1) }
  function openMap() { setMapOpen(true); setActive('map'); setMapActivation((value) => value + 1) }
  function hideAccount() { setAccountOpen(false); setActive('settings'); accountDock.current?.focus() }
  function hideSettings() { setSettingsOpen(false); setActive('account'); settingsDock.current?.focus() }
  function hideStats() { setStatsOpen(false); setActive('account'); statsDock.current?.focus() }
  function hideCasino() { setCasinoOpen(false); setActive('account'); casinoDock.current?.focus() }
  function hideAdmin() { setAdminOpen(false); setActive('account'); adminDock.current?.focus() }
  function hideChat() { setChatOpen(false); setActive('account'); chatDock.current?.focus() }
  function hideMap() { setMapOpen(false); setActive('account'); mapDock.current?.focus() }

  async function handleSignOut() {
    setLeaving(true)
    setLogoutError('')
    try {
      await signOut()
      openAccount()
      navigate('/login', { replace: true })
    } catch {
      setLogoutError('Could not log out. Your session may still be active. Try again.')
      openAccount()
    } finally { setLeaving(false) }
  }

  return (
    <div className="shell desktop-shell">
      <LiveWallpaper />
      <ClickWaves />
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault()
        setAccountOpen(true)
        setActive('account')
        requestAnimationFrame(() => document.getElementById('main-content')?.focus())
      }}>Skip to content</a>
      <header className="desktop-menubar">
        <button className="desktop-brand" data-ui-sound={accountOpen ? 'click' : 'open'} onClick={openAccount}><img src={globeIcon} alt="" /><strong className="brand-wordmark">Oasis <span>Aero</span></strong></button>
        <nav className="desktop-menu" aria-label="Applications">
          <button onClick={openAccount} data-ui-sound={accountOpen ? 'click' : 'open'} aria-controls="account-window">Account</button>
          <button onClick={openStats} data-ui-sound={statsOpen ? 'click' : 'open'} aria-controls="stats-window">Global Statistics</button>
          <button onClick={openCasino} data-ui-sound={casinoOpen ? 'click' : 'open'} aria-controls="casino-window">Minigames</button>
          <button onClick={openMarket} data-ui-sound={marketOpen ? 'click' : 'open'} aria-controls="marketplace-window">Marketplace</button>
          <button onClick={openChat} data-ui-sound={chatOpen ? 'click' : 'open'} aria-controls="chat-window">Chat</button>
          <button onClick={openMap} data-ui-sound={mapOpen ? 'click' : 'open'} aria-controls="map-window">Live 3D Map</button>
          <button onClick={() => openPlayer()} data-ui-sound={playerOpen ? 'click' : 'open'} aria-controls="player-controls-window">Player Controls</button>
          <button onClick={openSettings} data-ui-sound={settingsOpen ? 'click' : 'open'} aria-controls="settings-window">Settings</button>
          {user?.is_admin && (
            <button onClick={openAdmin} data-ui-sound={adminOpen ? 'click' : 'open'} aria-controls="admin-window">Admin Panel</button>
          )}
        </nav>
        <span className="desktop-menu-caption">Your world, connected.</span>
        {user !== null && <button className="menu-logout" onClick={handleSignOut} disabled={leaving}>{leaving ? 'Logging out…' : 'Log out'}</button>}
      </header>

      <div className="desktop-stage">
        <DesktopWindow id="account-window" title="Account" icon={globeIcon} open={accountOpen} activation={accountActivation} active={active === 'account'} onFocus={() => setActive('account')} onClose={hideAccount} onMinimize={hideAccount}>
          <div className="account-toolbar">
            <span>{user === null ? 'Welcome to your account' : 'Your Minecraft identity'}</span>
            <nav className="nav" aria-label="Account">
              {user === null ? <><NavLink to="/register" className="btn btn-quiet">Register</NavLink><NavLink to="/login" className="btn btn-quiet">Log in</NavLink></> : <><NavLink to="/cabinet" end className="btn btn-quiet">Overview</NavLink><NavLink to="/cabinet/security" className="btn btn-quiet">Security</NavLink></>}
            </nav>
          </div>
          <div className={`workspace ${authPage ? 'workspace-auth' : ''}`}>
            {authPage && <aside className="welcome-scene" aria-label="Welcome">
              <img className="welcome-icon" src={globeIcon} alt="" />
              <div><h2>Welcome to Oasis Aero.</h2><p>Connect your Minecraft account. Keep your next adventure close.</p></div>
              <div className="scene-caption"><img src={firewallOnIcon} alt="" /><div><strong>Your game password stays in the game.</strong><span>Link securely with a single-use code.</span></div></div>
            </aside>}
            <main className="main" id="main-content" tabIndex={-1}>
              {logoutError !== '' && <p className="note" data-tone="error" role="alert">{logoutError}</p>}
              <Outlet />
            </main>
          </div>
        </DesktopWindow>
        <DesktopWindow id="stats-window" title="Global Statistics" icon={perfCenterIcon} kind="stats" open={statsOpen} activation={statsActivation} active={active === 'stats'} onFocus={() => setActive('stats')} onClose={hideStats} onMinimize={hideStats}>
          <div className="workspace stats-workspace">
            <main className="main" id="stats-content">
              {user === null ? (
                <div className="note">
                  <p>Log in to see the statistics for your linked accounts.</p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => { navigate('/login', { replace: true }); openAccount() }}
                  >
                    Log in
                  </button>
                </div>
              ) : (
                <StatisticsPage
                  onGoToAccount={() => { navigate('/cabinet', { replace: true }); openAccount() }}
                  scope="all"
                  onSelectAccount={openPlayer}
                  stats={stats}
                  loadError={loadError}
                  onRetry={retry}
                />
              )}
            </main>
          </div>
        </DesktopWindow>
        <DesktopWindow id="marketplace-window" title="Marketplace" icon={globeIcon} kind="marketplace" open={marketOpen} activation={marketActivation} active={active === 'market'} onFocus={() => setActive('market')} onClose={hideMarket} onMinimize={hideMarket}>
          <div className="workspace stats-workspace"><main className="main">
            {user === null ? <div className="note"><p>Log in to browse Marketplace and trade with your linked players.</p><button className="btn" onClick={() => { navigate('/login'); openAccount() }}>Log in</button></div>
              : <MarketplacePage key={user.id} visible={marketOpen} accounts={statsAccounts} onOpenInventory={openInventory} />}
          </main></div>
        </DesktopWindow>
        <DesktopWindow id="casino-window" title="Minigames" icon={minigamesIcon} kind="casino" open={casinoOpen} activation={casinoActivation} active={active === 'casino'} onFocus={() => setActive('casino')} onClose={hideCasino} onMinimize={hideCasino}>
          <div className="workspace stats-workspace">
            <main className="main" id="casino-content">
              <MinigamesPage onGoToAccount={() => { navigate('/login', { replace: true }); openAccount() }} />
            </main>
          </div>
        </DesktopWindow>
        <DesktopWindow key={`player-controls-${user?.id ?? 'guest'}`} id="player-controls-window" title="Player Controls" icon={perfCenterIcon} kind="player"
          titleContent={selectedPlayer ? <span className="player-account-picker"><PlayerHead username={selectedPlayer.username} textureHash={selectedPlayer.skin_hash} /><select aria-label="Player account" value={selectedPlayer.uuid} onChange={(event) => { if (user) setPlayerSelection({ userId: user.id, uuid: event.target.value }) }}>
            {statsAccounts.map((account) => <option key={account.uuid} value={account.uuid}>{account.username}</option>)}
          </select></span> : undefined}
          open={playerOpen} activation={playerActivation} active={active === 'player'}
          onFocus={() => setActive('player')} onClose={hidePlayer} onMinimize={hidePlayer}>
          {user === null ? <div className="workspace stats-workspace"><main className="main"><div className="note"><p>Log in to control your linked Minecraft accounts.</p><button className="btn" onClick={() => { navigate('/login'); openAccount() }}>Log in</button></div></main></div>
            : selectedPlayer ? statsAccounts.map((account) => <div key={`${user.id}-${account.uuid}`} className="player-account-content" hidden={account.uuid !== selectedPlayer.uuid}>
              <PlayerApp inventoryLaunch={inventoryLaunch?.uuid === account.uuid ? inventoryLaunch.activation : 0} account={account} stats={stats} loadError={loadError} onRetry={retry} onSelectAccount={openPlayer} open={playerOpen && account.uuid === selectedPlayer.uuid}
                onGoToAccount={() => { navigate('/cabinet', { replace: true }); openAccount() }}
                onOpenMarketplace={openMarket} />
            </div>)
            : <div className="workspace stats-workspace"><main className="main">{loadError ? <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={retry}>Retry loading players</button></div>
              : stats === null ? <p className="loading">Loading your linked players…</p>
              : <div className="note"><p>Link a Minecraft account to use Player Controls. You can link up to four accounts.</p><button className="btn" onClick={() => { navigate('/cabinet'); openAccount() }}>Link an account</button></div>}</main></div>}
        </DesktopWindow>
        <DesktopWindow id="settings-window" title="Settings" icon={personalizationIcon} kind="settings" open={settingsOpen} activation={settingsActivation} active={active === 'settings'} onFocus={() => setActive('settings')} onClose={hideSettings} onMinimize={hideSettings}>
          <div className="settings-content">
            <div className="settings-heading"><img src={personalizationIcon} alt="" /><div><h1>Settings</h1><p>Make this desktop yours.</p></div></div>
            <section className="settings-appearance" aria-labelledby="appearance-heading"><h2 id="appearance-heading">Appearance</h2><p>Choose a theme for the website. System follows your device’s appearance.</p><ThemeControl /></section>
            <section className="settings-appearance" aria-labelledby="sound-heading"><h2 id="sound-heading">Sound</h2><p>Small interface sounds for windows, buttons, and confirmations. The music player beside the dock keeps its own volume.</p><SoundControl /></section>
            <p className="settings-footnote">Your choices are saved automatically in this browser.</p>
          </div>
        </DesktopWindow>
        {user?.is_admin && (
          <DesktopWindow id="admin-window" title="Admin Panel" icon={firewallOnIcon} kind="admin" open={adminOpen} activation={adminActivation} active={active === 'admin'} onFocus={() => setActive('admin')} onClose={hideAdmin} onMinimize={hideAdmin}>
            <AdminPage visible={adminOpen} />
          </DesktopWindow>
        )}
        <DesktopWindow id="chat-window" title="Server Chat" icon={globeIcon} kind="chat" open={chatOpen} activation={chatActivation} active={active === 'chat'} onFocus={() => setActive('chat')} onClose={hideChat} onMinimize={hideChat}>
          <ChatPage visible={chatOpen} onOpenAccount={openAccount} />
        </DesktopWindow>
        <DesktopWindow id="map-window" title="Live 3D World Map" icon={globeIcon} kind="map" open={mapOpen} activation={mapActivation} active={active === 'map'} onFocus={() => setActive('map')} onClose={hideMap} onMinimize={hideMap}>
          <MapPage visible={mapOpen} />
        </DesktopWindow>
      </div>
      <nav className="desktop-dock" aria-label="Dock">
        <button ref={accountDock} className="dock-app" data-ui-sound={accountOpen ? active === 'account' ? 'close' : 'click' : 'open'} onClick={accountOpen && active === 'account' ? hideAccount : openAccount} aria-controls="account-window" aria-expanded={accountOpen} data-open={accountOpen}><img src={globeIcon} alt="" /><span>Account</span></button>
        <button ref={statsDock} className="dock-app" data-ui-sound={statsOpen ? active === 'stats' ? 'close' : 'click' : 'open'} onClick={statsOpen && active === 'stats' ? hideStats : openStats} aria-controls="stats-window" aria-expanded={statsOpen} data-open={statsOpen}><img src={perfCenterIcon} alt="" /><span>Global Statistics</span></button>
        <button ref={casinoDock} className="dock-app" data-ui-sound={casinoOpen ? active === 'casino' ? 'close' : 'click' : 'open'} onClick={casinoOpen && active === 'casino' ? hideCasino : openCasino} aria-controls="casino-window" aria-expanded={casinoOpen} data-open={casinoOpen}><img src={minigamesIcon} alt="" /><span>Minigames</span></button>
        <button ref={marketDock} className="dock-app" data-ui-sound={marketOpen ? active === 'market' ? 'close' : 'click' : 'open'} onClick={marketOpen && active === 'market' ? hideMarket : openMarket} aria-controls="marketplace-window" aria-expanded={marketOpen} data-open={marketOpen}><img src={globeIcon} alt="" /><span>Marketplace</span></button>
        <button ref={chatDock} className="dock-app" data-ui-sound={chatOpen ? active === 'chat' ? 'close' : 'click' : 'open'} onClick={chatOpen && active === 'chat' ? hideChat : openChat} aria-controls="chat-window" aria-expanded={chatOpen} data-open={chatOpen}><img src={globeIcon} alt="" /><span>Chat</span></button>
        <button ref={mapDock} className="dock-app" data-ui-sound={mapOpen ? active === 'map' ? 'close' : 'click' : 'open'} onClick={mapOpen && active === 'map' ? hideMap : openMap} aria-controls="map-window" aria-expanded={mapOpen} data-open={mapOpen}><img src={globeIcon} alt="" /><span>Live 3D Map</span></button>
        <button ref={playerDock} className="dock-app" onClick={playerOpen && active === 'player' ? hidePlayer : () => openPlayer()} aria-controls="player-controls-window" aria-expanded={playerOpen} data-open={playerOpen} data-ui-sound={playerOpen ? active === 'player' ? 'close' : 'click' : 'open'}>{selectedPlayer ? <PlayerHead username={selectedPlayer.username} textureHash={selectedPlayer.skin_hash} /> : <img src={perfCenterIcon} alt="" />}<span>Player Controls</span></button>
        {user?.is_admin && (
          <button ref={adminDock} className="dock-app" data-ui-sound={adminOpen ? active === 'admin' ? 'close' : 'click' : 'open'} onClick={adminOpen && active === 'admin' ? hideAdmin : openAdmin} aria-controls="admin-window" aria-expanded={adminOpen} data-open={adminOpen}><img src={firewallOnIcon} alt="" /><span>Admin Panel</span></button>
        )}
        <span className="dock-divider" />
        <button ref={settingsDock} className="dock-app" data-ui-sound={settingsOpen ? active === 'settings' ? 'close' : 'click' : 'open'} onClick={settingsOpen && active === 'settings' ? hideSettings : openSettings} aria-controls="settings-window" aria-expanded={settingsOpen} data-open={settingsOpen}><img src={personalizationIcon} alt="" /><span>Settings</span></button>
      </nav>
      <MusicPlayer />
    </div>
  )
}
export default Shell
