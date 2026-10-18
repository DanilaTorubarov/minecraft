import { useEffect, useState, type SubmitEvent } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, changePassword, getSecurity, requestEmailConfirmation, sharedMessage, type SecurityView } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { playSound } from '../lib/sounds'

function problemMessage(problem: unknown): string {
  if (problem instanceof ApiError) {
    return sharedMessage(problem.status) ?? ({
      400: 'Check the email address and password requirements.',
      401: 'Your session expired. Log in again.',
      403: 'The current password is incorrect.',
      409: 'That email address is already used by another account.',
      503: 'Email delivery is not configured or is unavailable. Your email has not changed.',
    } as Record<number, string>)[problem.status] ?? 'Could not save the change. Try again.'
  }
  return 'Could not save the change. Try again.'
}

export default function SecurityPage() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const [security, setSecurity] = useState<SecurityView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [password, setPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [email, setEmail] = useState(user?.email ?? '')
  const [passwordError, setPasswordError] = useState('')
  const [emailError, setEmailError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<'password' | 'email' | null>(null)

  useEffect(() => {
    let active = true
    getSecurity().then((result) => { if (active) setSecurity(result) })
      .catch(() => { if (active) setLoadError('Could not load your email verification status. Reopen Security to retry.') })
    return () => { active = false }
  }, [])

  async function savePassword(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasswordError('')
    if ([...nextPassword].length < 6) { setPasswordError('Use at least 6 characters.'); return }
    if (nextPassword !== repeat) { setPasswordError('The new passwords do not match.'); return }
    if (nextPassword === password) { setPasswordError('Choose a password different from your current one.'); return }
    setBusy('password')
    try {
      await changePassword(password, nextPassword)
      setPassword(''); setNextPassword(''); setRepeat('')
      playSound('done')
      await refresh()
      navigate('/login', { replace: true, state: { securityNotice: 'Password changed. All website sessions were signed out. Log in with your new password.' } })
    } catch (problem) { setPasswordError(problemMessage(problem)) }
    finally { setBusy(null) }
  }

  async function saveEmail(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setEmailError(''); setNotice(''); setBusy('email')
    try {
      await requestEmailConfirmation(emailPassword, email)
      setEmailPassword('')
      setNotice('Confirmation sent. Open the email and confirm within 15 minutes. Your current address stays active until then.')
      playSound('done')
    } catch (problem) { setEmailError(problemMessage(problem)) }
    finally { setBusy(null) }
  }

  return <>
    <div className="page-head"><h1>Security</h1><p className="page-sub">Manage your website password and email. Your Minecraft password stays separate.</p></div>
    <div className="security-grid">
      <section className="section">
        <div className="section-head"><h2>Change password</h2></div>
        <p className="security-help">Changing your password signs out every website session and cancels pending email changes.</p>
        {passwordError && <p className="note" data-tone="error" role="alert">{passwordError}</p>}
        <form className="form" onSubmit={savePassword}>
          <div className="field"><label htmlFor="security-current-password">Current password</label><input id="security-current-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <div className="field"><label htmlFor="security-new-password">New password</label><input id="security-new-password" type="password" autoComplete="new-password" value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} required /><span className="field-hint">At least 6 characters.</span></div>
          <div className="field"><label htmlFor="security-repeat-password">Repeat new password</label><input id="security-repeat-password" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></div>
          <div className="btn-row"><button className="btn btn-primary" disabled={busy !== null}>{busy === 'password' ? 'Changing…' : 'Change password'}</button></div>
        </form>
      </section>
      <section className="section">
        <div className="section-head"><h2>Email address</h2></div>
        <p className="security-help">Current email: <strong>{user?.email}</strong><br />{security ? (security.email_verified ? 'Verified' : 'Not verified yet') : loadError || 'Checking verification…'}</p>
        {security?.email_delivery === 'preview' && <p className="note">Local preview mode: messages go to the <a href="http://localhost:8025" target="_blank" rel="noreferrer">email preview inbox</a>, not to a real mailbox.</p>}
        {security?.email_delivery === 'unavailable' && <p className="note">Email delivery is not configured. The server operator needs to connect an email provider before confirmations can be sent.</p>}
        <p className="security-help">Keep your current address to verify it, or enter a new one. We confirm the destination mailbox before changing your login email.</p>
        {emailError && <p className="note" data-tone="error" role="alert">{emailError}</p>}
        {notice && <p className="note" data-tone="ok" role="status">{notice}</p>}
        <form className="form" onSubmit={saveEmail}>
          <div className="field"><label htmlFor="security-email">Email to confirm</label><input id="security-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="security-email-password">Current password</label><input id="security-email-password" type="password" autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required /></div>
          <div className="btn-row"><button className="btn btn-primary" disabled={busy !== null || security === null || security.email_delivery === 'unavailable'}>{busy === 'email' ? 'Sending…' : 'Send confirmation'}</button></div>
        </form>
      </section>
    </div>
  </>
}
