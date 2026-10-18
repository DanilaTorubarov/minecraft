import { useState, type SubmitEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { ApiError, sharedMessage } from '../lib/api'
import { playSound } from '../lib/sounds'
import { useAuth } from '../lib/auth-context'

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    const shared = sharedMessage(error.status)
    if (shared !== null) {
      return shared
    }
    if (error.status === 401) {
      // The panel answers an unknown identifier and a wrong password identically, and so
      // does this copy: it must not hint at which accounts exist.
      return 'Those sign-in details do not match an account.'
    }
  }
  return 'Something went wrong. Try again.'
}

function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const securityNotice = typeof location.state?.securityNotice === 'string' ? location.state.securityNotice : ''
  const [params] = useSearchParams()
  const justRegistered = params.get('registered') === '1'

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(identifier, password)
      playSound('done')
      navigate('/cabinet', { replace: true })
    } catch (problem) {
      setError(messageFor(problem))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Log in</h1>
        <p className="page-sub">Sign in to see your linked Minecraft accounts.</p>
      </div>

      {justRegistered && (
        <p className="note" data-tone="ok">
          Account created. Log in to link your in-game name.
        </p>
      )}
      {securityNotice && <p className="note" data-tone="ok" role="status">{securityNotice}</p>}

      {error !== '' && (
        <p className="note" data-tone="error" role="alert">
          {error}
        </p>
      )}

      <form className="form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="identifier">Email or login</label>
          <input
            id="identifier"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </div>
      </form>

      <p className="form-foot">
        No account yet? <Link to="/register">Register</Link>, then link your in-game name.
      </p>
    </>
  )
}

export default LoginPage
