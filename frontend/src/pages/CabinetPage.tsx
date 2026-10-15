import { useEffect, useState } from 'react'
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
  const [error, setError] = useState('')

  const [code, setCode] = useState<LinkCode | null>(null)
  const [expiresAt, setExpiresAt] = useState(0)
  const [now, setNow] = useState(0)
  const [issuing, setIssuing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linking, setLinking] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listLinks()
      .then((found) => {
        if (!active) {
          return
        }
        setAccounts(found)
        setError('')
      })
      .catch((problem) => {
        if (active) {
          setError(messageFor(problem, 'Could not load your linked accounts.'))
        }
      })
      .finally(() => {
        if (active) {
          setLoaded(true)
        }
      })
    return () => {
      active = false
    }
  }, [])

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
    try {
      const issued = await startLink()
      setCode(issued)
      setExpiresAt(Date.now() + issued.expires_in * 1000)
      setNow(Date.now())
      setError('')
    } catch (problem) {
      setError(messageFor(problem, 'Could not create a code. Try again.'))
    } finally {
      setIssuing(false)
    }
  }

  async function copyCode() {
    if (code === null) {
      return
    }
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(true)
    } catch {
      // Clipboard access can be refused; the code stays selectable either way.
      setCopied(false)
    }
  }

  async function remove(uuid: string) {
    setRemoving(uuid)
    try {
      await unlink(uuid)
      setAccounts(await listLinks())
    } catch (problem) {
      setError(messageFor(problem, 'Could not unlink that account. Try again.'))
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

      {loaded ? (
        <>
          <section className="entry" data-state={linked ? 'linked' : 'pending'}>
            <span className="lamp" aria-hidden="true" />
            <div>
              <h2 className="entry-name">
                {linked ? names.join(' · ') : 'No Minecraft account linked'}
              </h2>
              <p className="entry-motd">
                {linked
                  ? names.length === 1
                    ? `Linked since ${since}. This in-game name is yours.`
                    : `Linked since ${since}. All ${names.length} in-game names are yours.`
                  : 'Get a code below, then type it in the game with /link.'}
              </p>
            </div>
            <span className="entry-state">{linked ? 'Linked' : 'Not linked'}</span>
          </section>

          {(!linked || linking) && (
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
                  Create a code here, then type <code>/link &lt;code&gt;</code> in the game. A
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
                        onClick={copyCode}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="code-hint">
                      Type <code>/link {code.code}</code> in the game.
                    </p>
                  </>
                )}
              </div>
            </section>
          )}

          {linked && (
            <section className="section">
              <div className="section-head">
                <h2>Linked accounts</h2>
                <span className="count">{accounts.length}</span>
                {!linking && (
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

          <section className="section">
            <div className="section-head">
              <h2>Account details</h2>
            </div>
            <div className="panel">
              <dl className="fields">
                <div>
                  <dt>Name</dt>
                  <dd>
                    {user.name} {user.surname}
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
        </>
      ) : (
        <p className="loading">Loading your linked accounts…</p>
      )}
    </>
  )
}

export default CabinetPage
