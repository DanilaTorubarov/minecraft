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
import StatisticsPage from '../pages/StatisticsPage'
import globeIcon from '../assets/icons/vista-search-globe.png'
import personalizationIcon from '../assets/icons/vista-personalization.png'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import firewallOnIcon from '../assets/icons/vista-firewall-on.png'

function Shell() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const authPage = location.pathname === '/login' || location.pathname === '/register'
  const [leaving, setLeaving] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [accountOpen, setAccountOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [active, setActive] = useState('account')
  const [accountActivation, setAccountActivation] = useState(0)
  const [settingsActivation, setSettingsActivation] = useState(0)
  const [statsActivation, setStatsActivation] = useState(0)
  const { stats, loadError, retry } = useStatistics(user?.id)
  const statsAccounts = stats?.accounts ?? []
  const [playerApps, setPlayerApps] = useState<Record<string, { open: boolean; activation: number }>>({})
  const accountDock = useRef<HTMLButtonElement>(null)
  const settingsDock = useRef<HTMLButtonElement>(null)
  const statsDock = useRef<HTMLButtonElement>(null)
  const playerDocks = useRef(new Map<string, HTMLButtonElement>())
  const playerAppKey = (uuid: string) => `${user?.id}:${uuid}`
  function openPlayer(uuid: string) {
    if (uuid === 'all') { openStats(); return }
    setPlayerApps((apps) => ({ ...apps, [playerAppKey(uuid)]: { open: true, activation: (apps[playerAppKey(uuid)]?.activation ?? 0) + 1 } }))
    setActive(uuid)
  }
  function hidePlayer(uuid: string) {
    setPlayerApps((apps) => ({ ...apps, [playerAppKey(uuid)]: { ...apps[playerAppKey(uuid)], open: false } }))
    setActive('account')
    playerDocks.current.get(uuid)?.focus()
  }

  function openAccount() { setAccountOpen(true); setActive('account'); setAccountActivation((value) => value + 1) }
  function openSettings() { setSettingsOpen(true); setActive('settings'); setSettingsActivation((value) => value + 1) }
  function openStats() { setStatsOpen(true); setActive('stats'); setStatsActivation((value) => value + 1) }
  function hideAccount() { setAccountOpen(false); setActive('settings'); accountDock.current?.focus() }
  function hideSettings() { setSettingsOpen(false); setActive('account'); settingsDock.current?.focus() }
  function hideStats() { setStatsOpen(false); setActive('account'); statsDock.current?.focus() }

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
          {statsAccounts.map((account) => <button key={account.uuid} className="player-menu-app" onClick={() => openPlayer(account.uuid)} aria-controls={`player-${account.uuid}`} data-ui-sound={playerApps[playerAppKey(account.uuid)]?.open ? 'click' : 'open'}><PlayerHead username={account.username} textureHash={account.skin_hash} />{account.username}</button>)}
          <button onClick={openSettings} data-ui-sound={settingsOpen ? 'click' : 'open'} aria-controls="settings-window">Settings</button>
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
        {statsAccounts.map((account) => (
          <DesktopWindow key={`${user?.id}-${account.uuid}`} id={`player-${account.uuid}`} title={account.username} icon={<PlayerHead username={account.username} textureHash={account.skin_hash} />} kind="player"
            open={playerApps[playerAppKey(account.uuid)]?.open ?? false} activation={playerApps[playerAppKey(account.uuid)]?.activation ?? 0} active={active === account.uuid}
            onFocus={() => setActive(account.uuid)} onClose={() => hidePlayer(account.uuid)} onMinimize={() => hidePlayer(account.uuid)}>
            <PlayerApp account={account} stats={stats} loadError={loadError} onRetry={retry} onSelectAccount={openPlayer} open={playerApps[playerAppKey(account.uuid)]?.open ?? false}
              onGoToAccount={() => { navigate('/cabinet', { replace: true }); openAccount() }} />
          </DesktopWindow>
        ))}
        <DesktopWindow id="settings-window" title="Settings" icon={personalizationIcon} kind="settings" open={settingsOpen} activation={settingsActivation} active={active === 'settings'} onFocus={() => setActive('settings')} onClose={hideSettings} onMinimize={hideSettings}>
          <div className="settings-content">
            <div className="settings-heading"><img src={personalizationIcon} alt="" /><div><h1>Settings</h1><p>Make this desktop yours.</p></div></div>
            <section className="settings-appearance" aria-labelledby="appearance-heading"><h2 id="appearance-heading">Appearance</h2><p>Choose a theme for the website. System follows your device’s appearance.</p><ThemeControl /></section>
            <section className="settings-appearance" aria-labelledby="sound-heading"><h2 id="sound-heading">Sound</h2><p>Small interface sounds for windows, buttons, and confirmations. The music player beside the dock keeps its own volume.</p><SoundControl /></section>
            <p className="settings-footnote">Your choices are saved automatically in this browser.</p>
          </div>
        </DesktopWindow>
      </div>
      <nav className="desktop-dock" aria-label="Dock">
        <button ref={accountDock} className="dock-app" data-ui-sound={accountOpen ? 'close' : 'open'} onClick={accountOpen ? hideAccount : openAccount} aria-controls="account-window" aria-expanded={accountOpen} data-open={accountOpen}><img src={globeIcon} alt="" /><span>Account</span></button>
        <button ref={statsDock} className="dock-app" data-ui-sound={statsOpen ? 'close' : 'open'} onClick={statsOpen ? hideStats : openStats} aria-controls="stats-window" aria-expanded={statsOpen} data-open={statsOpen}><img src={perfCenterIcon} alt="" /><span>Global Statistics</span></button>
        {statsAccounts.map((account) => <button key={account.uuid} ref={(node) => { if (node) playerDocks.current.set(account.uuid, node); else playerDocks.current.delete(account.uuid) }} className="dock-app" title={`${account.username} player app`} onClick={() => playerApps[playerAppKey(account.uuid)]?.open ? hidePlayer(account.uuid) : openPlayer(account.uuid)} aria-controls={`player-${account.uuid}`} aria-expanded={playerApps[playerAppKey(account.uuid)]?.open ?? false} data-open={playerApps[playerAppKey(account.uuid)]?.open ?? false} data-ui-sound={playerApps[playerAppKey(account.uuid)]?.open ? 'close' : 'open'}><PlayerHead username={account.username} textureHash={account.skin_hash} /><span>{account.username}</span></button>)}
        <span className="dock-divider" />
        <button ref={settingsDock} className="dock-app" data-ui-sound={settingsOpen ? 'close' : 'open'} onClick={settingsOpen ? hideSettings : openSettings} aria-controls="settings-window" aria-expanded={settingsOpen} data-open={settingsOpen}><img src={personalizationIcon} alt="" /><span>Settings</span></button>
      </nav>
      <MusicPlayer />
    </div>
  )
}
export default Shell
