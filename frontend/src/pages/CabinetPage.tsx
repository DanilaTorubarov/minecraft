import firewallOnIcon from '../assets/icons/vista-firewall-on.png'
import firewallOffIcon from '../assets/icons/vista-firewall-off.png'
import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  formatCountdown,
  formatDate,
  listLinks,
  sharedMessage,
  startLink,
  unlink,
  type LinkCode,
  type LinkedAccount,
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { invalidateServerData } from '../lib/serverData'
import { playSound } from '../lib/sounds'
import { linkCommand } from '../lib/linkCommand'

const ACCOUNT_LIMIT = 4

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const shared = sharedMessage(error.status)
    if (shared !== null) {
      return shared
    }
  }
  return fallback
}

function CabinetPage() {
  const { user } = useAuth()

  const [accounts, setAccounts] = useState<LinkedAccount[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [error, setError] = useState('')

  const [code, setCode] = useState<LinkCode | null>(null)
  const [expiresAt, setExpiresAt] = useState(0)
  const [now, setNow] = useState(0)
  const [issuing, setIssuing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [linking, setLinking] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const accountsBeforeCode = useRef(new Set<string>())

  useEffect(() => {
    let active = true
    let pending = false
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const found = await listLinks()
        if (!active) return
        setAccounts(found)
        setLoadError('')
        setLoaded(true)
        if (code !== null && found.some((account) => !accountsBeforeCode.current.has(account.uuid))) {
          setCode(null)
          setLinking(false)
          playSound('done')
          invalidateServerData('stats')
        }
      } catch (problem) {
        if (active) {
          setLoadError(messageFor(problem, 'Could not load your linked accounts. Try again.'))
        }
      } finally {
        pending = false
      }
    }
    void refresh()
    const onFocus = () => { void refresh() }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    const timer = code === null ? undefined : window.setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() <= expiresAt + 5000) void refresh()
    }, 3000)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [code, expiresAt, refreshVersion])

  // The code's life belongs to the server; this clock only shows it. The deadline is
  // stored rather than the remaining seconds, so the countdown can never drift away
  // from the moment the code was actually issued.
  useEffect(() => {
    if (code === null) {
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [code])

  async function issueCode() {
    setIssuing(true)
    setCopied(false)
    setCopyFailed(false)
    try {
      const issued = await startLink()
      accountsBeforeCode.current = new Set(accounts.map((account) => account.uuid))
      setCode(issued)
      setExpiresAt(Date.now() + issued.expires_in * 1000)
      setNow(Date.now())
      setError('')
    } catch (problem) {
      setError(problem instanceof ApiError && problem.status === 422 ? 'You can link up to four Minecraft accounts. Unlink one before adding another.' : messageFor(problem, 'Could not create a code. Try again.'))
    } finally {
      setIssuing(false)
    }
  }

  async function copyCommand() {
    if (code === null || Date.now() >= expiresAt) {
      return
    }
    try {
      await navigator.clipboard.writeText(linkCommand(code.code))
      playSound('copy')
      setCopied(true)
      setCopyFailed(false)
    } catch {
      // Clipboard access can be refused; the code stays selectable either way.
      setCopied(false)
      setCopyFailed(true)
    }
  }

  async function remove(uuid: string) {
    setRemoving(uuid)
    try {
      await unlink(uuid)
      playSound('done')
      setAccounts((current) => current.filter((account) => account.uuid !== uuid))
      invalidateServerData('stats')
      setRefreshVersion((version) => version + 1)
      setError('')
    } catch (problem) {
      setError(problem instanceof ApiError && problem.status === 409 ? 'Cancel this player’s Marketplace listings and wait for pending transfers and deliveries before unlinking.' : messageFor(problem, 'Could not unlink that account. Try again.'))
    } finally {
      setRemoving(null)
    }
  }

  // RequireAuth already guarantees a session; this keeps the types honest.
  if (user === null) {
    return null
  }

  const linked = accounts.length > 0
  const names = accounts.map((account) => account.username)
  const since = linked ? formatDate(accounts[0].linked_at) : ''
  const secondsLeft =
    code === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const expired = code !== null && secondsLeft === 0

  return (
    <>
      <div className="page-head">
        <h1>Your account</h1>
        <p className="page-sub">
          Signed in as <strong>{user.login_displayed}</strong>
        </p>
      </div>

      {error !== '' && (
        <p className="note" data-tone="error" role="alert">
          {error}
        </p>
      )}

      {loadError !== '' && (
        <div className="note" data-tone="error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={() => setRefreshVersion((version) => version + 1)}>
            Retry loading accounts
          </button>
        </div>
      )}

      {loaded ? (
        <div className="cabinet-grid">
          <section className="entry" data-state={linked ? 'linked' : 'pending'}>
            <img className="status-icon" src={linked ? firewallOnIcon : firewallOffIcon} alt="" aria-hidden="true" />
            <div>
              <h2 className="entry-name">
                {linked ? names.join(' · ') : 'No Minecraft account linked'}
              </h2>
              <p className="entry-motd">
                {linked
                  ? names.length === 1
                    ? `Linked since ${since}. This in-game name is yours.`
                    : `Linked since ${since}. All ${names.length} in-game names are yours.`
                  : 'Get a code below, then link it in the game with /website link.'}
              </p>
            </div>
            <span className="entry-state">{linked ? 'Linked' : 'Not linked'}</span>
          </section>

          {(!linked || linking) && accounts.length < ACCOUNT_LIMIT && (
            <section className="section">
              <div className="section-head">
                <h2>{linked ? 'Link another account' : 'Link an account'}</h2>
                {linked && (
                  <button
                    type="button"
                    className="btn btn-quiet section-action"
                    onClick={() => setLinking(false)}
                  >
                    Cancel
                  </button>
                )}
              </div>

              <div className="claim">
                <p className="lede">
                  Link up to four Minecraft accounts. Create a code here, then paste <code>/website link &lt;code&gt;</code> in the game. A
                  code works once, and only for five minutes.
                </p>

                {code === null || expired ? (
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={issueCode}
                      disabled={issuing}
                    >
                      {issuing ? 'Creating…' : expired ? 'Create a new code' : 'Create a link code'}
                    </button>
                    {expired && <span className="code-expiry">The last code expired.</span>}
                  </div>
                ) : (
                  <>
                    <div className="code">
                      <span className="code-label">Link code</span>
                      <span className="code-value">{code.code}</span>
                      <span className="code-expiry">
                        Expires in {formatCountdown(secondsLeft)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-quiet code-copy"
                        onClick={copyCommand}
                        data-ui-sound="none"
                      >
                        {copied ? 'Command copied' : 'Copy command'}
                      </button>
                    </div>
                    <p className="code-hint">
                      Paste <code>{linkCommand(code.code)}</code> in the game after logging in.
                    </p>
                    <p className="visually-hidden" role="status">{copied ? 'Link command copied to clipboard.' : ''}</p>
                    {copyFailed && <p className="code-hint" role="status">Could not copy automatically. Select the command above and copy it manually.</p>}
                  </>
                )}
              </div>
            </section>
          )}

          {accounts.length >= ACCOUNT_LIMIT && <p className="note">You have reached the four-account limit. Unlink an account before linking another.</p>}

          {linked && (
            <section className="section">
              <div className="section-head">
                <h2>Linked accounts</h2>
                <span className="count">{accounts.length} / {ACCOUNT_LIMIT}</span>
                {!linking && accounts.length < ACCOUNT_LIMIT && (
                  <button
                    type="button"
                    className="btn btn-quiet section-action"
                    onClick={() => setLinking(true)}
                  >
                    Link another
                  </button>
                )}
              </div>

              <div className="panel">
                <ul className="rows">
                  {accounts.map((account) => (
                    <li className="row" key={account.uuid}>
                      <div>
                        <span className="row-name">{account.username}</span>
                        <span className="row-id" title={account.uuid}>
                          {account.uuid}
                        </span>
                      </div>
                      <span className="row-date">Linked {formatDate(account.linked_at)}</span>
                      <button
                        type="button"
                        className="btn btn-quiet btn-danger"
                        onClick={() => remove(account.uuid)}
                        disabled={removing === account.uuid}
                      >
                        {removing === account.uuid ? 'Unlinking…' : 'Unlink'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="section account-details">
            <div className="section-head">
              <h2>Account details</h2>
            </div>
            <div className="panel">
              <dl className="fields">
                <div>
                  <dt>Displayed nickname</dt>
                  <dd>
                    {user.displayed_nickname}
                  </dd>
                </div>
                <div>
                  <dt>Login</dt>
                  <dd>{user.login_displayed}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{user.email}</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      ) : loadError === '' ? (
        <p className="loading">Loading your linked accounts…</p>
      ) : null}
    </>
  )
}

export default CabinetPage
