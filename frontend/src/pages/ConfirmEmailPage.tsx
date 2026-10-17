import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ApiError, confirmEmail } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { playSound } from '../lib/sounds'

export default function ConfirmEmailPage() {
  const location = useLocation()
  const { refresh } = useAuth()
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '')
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setBusy(true); setError('')
    try {
      await confirmEmail(token)
      setComplete(true)
      playSound('done')
      await refresh()
    } catch (problem) {
      setError(problem instanceof ApiError && problem.status === 409
        ? 'This address is now used by another account. Request a different address from Security.'
        : 'This confirmation link is invalid, expired, or already used. Request a new one from Security.')
    } finally { setBusy(false) }
  }

  return <>
    <div className="page-head"><h1>{complete ? 'Email confirmed' : 'Confirm email'}</h1>
      <p className="page-sub">{complete ? 'Your address is verified. All website sessions were signed out.' : 'Confirm that you want to use this mailbox for your website account.'}</p>
    </div>
    {error && <p className="note" data-tone="error" role="alert">{error}</p>}
    {complete ? <Link className="btn btn-primary" to="/login">Log in</Link> :
      <button className="btn btn-primary" onClick={confirm} disabled={busy || token === ''}>{busy ? 'Confirming…' : 'Confirm email'}</button>}
    {!token && <p className="note">Open the complete link from your confirmation email.</p>}
  </>
}
