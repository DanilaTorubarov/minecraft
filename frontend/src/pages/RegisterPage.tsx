import { useEffect, useState, type SubmitEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, confirmRegistration, register, sharedMessage, type RegistrationChallenge } from '../lib/api'
import { playSound } from '../lib/sounds'
import { useAuth } from '../lib/auth-context'

type FieldErrors = {
  login?: string
  password?: string
  confirm?: string
}

/** The panel counts characters the same way, so a pass here is a pass there. */
function codePointLength(value: string): number {
  return [...value].length
}

function validate(login: string, password: string, confirm: string): FieldErrors {
  const errors: FieldErrors = {}
  if (login !== '' && !/^[A-Za-z0-9_!@]+$/.test(login)) {
    errors.login = 'Letters, digits, and _ ! @ only.'
  }
  const length = codePointLength(password)
  if (password !== '' && length < 6) {
    errors.password = `At least 6 characters — ${length} so far.`
  }
  if (confirm !== '' && password !== confirm) {
    errors.confirm = 'The two passwords do not match.'
  }
  return errors
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    const shared = sharedMessage(error.status)
    if (shared !== null) {
      return shared
    }
    if (error.status === 503) return 'The confirmation email could not be sent. Please try again later.'
    if (error.status === 409) {
      return 'That email or login is already taken. Log in instead, or pick another.'
    }
    if (error.status === 400) {
      return 'The panel rejected those details. Check every field and try again.'
    }
  }
  return 'Something went wrong. Try again.'
}

function RegisterPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()

  const [displayedNickname, setDisplayedNickname] = useState('')
  const [login, setLogin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState<RegistrationChallenge | null>(null)
  const [code, setCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!challenge) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [challenge])
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const resendWait = Math.max(0, Math.ceil((resendAt - now) / 1000))

  async function sendCode() {
    setError('')
    setBusy(true)
    try {
      const result = await register({ displayed_nickname: displayedNickname, login, email, password })
      const sentAt = Date.now()
      setChallenge(result)
      setCode('')
      setExpiresAt(sentAt + result.expires_in * 1000)
      setResendAt(sentAt + 60_000)
      setNow(sentAt)
    } catch (problem) { setError(messageFor(problem)) }
    finally { setBusy(false) }
  }

  async function onConfirm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challenge) return
    setError('')
    setBusy(true)
    try {
      await confirmRegistration(challenge.challenge, code)
      playSound('done')
      try {
        await signIn(email, password)
        navigate('/cabinet', { replace: true })
      } catch {
        navigate('/login', { replace: true, state: { securityNotice: 'Email confirmed and account created. Log in to continue.' } })
      }
      setPassword('')
      setConfirm('')
    } catch (problem) {
      setError(problem instanceof ApiError && problem.status === 400
        ? 'That code is incorrect, expired, already used, or has too many attempts. Try again or request a new code.'
        : messageFor(problem))
    } finally { setBusy(false) }
  }

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')

    const found = validate(login, password, confirm)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      return
    }

    await sendCode()
  }

  if (challenge) return <>
    <div className="page-head"><h1>Confirm your email</h1>
      <p className="page-sub">Enter the six-digit code sent to {email.toLowerCase()}. Your account is created after confirmation.</p>
    </div>
    {challenge.email_delivery === 'preview' && <p className="note">Local email preview: open <a href="http://localhost:8025" target="_blank" rel="noreferrer">Mailpit</a> to read your code. It will not arrive in a real inbox.</p>}
    {error && <p className="note" data-tone="error" role="alert">{error}</p>}
    <form className="form" onSubmit={onConfirm}>
      <div className="field">
        <label htmlFor="registration-code">Confirmation code</label>
        <input id="registration-code" name="code" inputMode="numeric" autoComplete="one-time-code"
          pattern="[0-9]{6}" maxLength={6} value={code} required autoFocus
          aria-describedby="registration-code-hint" disabled={busy}
          onChange={event => setCode(event.target.value.replace(/\D/g, ''))} />
        <span className="field-hint" id="registration-code-hint">{secondsLeft > 0
          ? `Code expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}. Only the newest code works.`
          : 'This code has expired. Request a new code to continue.'}</span>
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6 || secondsLeft === 0}>{busy ? 'Please wait…' : 'Confirm email & create account'}</button>
        <button className="btn" type="button" disabled={busy || resendWait > 0} onClick={() => void sendCode()}>{resendWait > 0 ? `Resend code in ${resendWait}s` : 'Resend code'}</button>
      </div>
    </form>
    <p className="form-foot"><button className="btn btn-quiet" type="button" disabled={busy} onClick={() => { setChallenge(null); setCode(''); setError('') }}>Change registration details</button></p>
  </>

  return (
    <>
      <div className="page-head">
        <h1>Register</h1>
        <p className="page-sub">
          Confirm your email with a code valid for 15 minutes, then link your in-game name.
        </p>
      </div>

      {error !== '' && (
        <p className="note" data-tone="error" role="alert">
          {error}
        </p>
      )}

      <form className="form form-register" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="displayed-nickname">Displayed nickname</label>
          <input
            id="displayed-nickname"
            name="displayed_nickname"
            autoComplete="nickname"
            value={displayedNickname}
            onChange={(event) => setDisplayedNickname(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="login">Login</label>
          <input
            id="login"
            name="login"
            autoComplete="username"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            aria-invalid={errors.login !== undefined}
            aria-describedby={errors.login === undefined ? undefined : 'login-error'}
            required
          />
          {errors.login === undefined ? (
            <span className="field-hint">Letters, digits, and _ ! @</span>
          ) : (
            <span className="field-error" id="login-error">
              {errors.login}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password !== undefined}
            aria-describedby={errors.password === undefined ? undefined : 'password-error'}
            required
          />
          {errors.password === undefined ? (
            <span className="field-hint">At least 6 characters.</span>
          ) : (
            <span className="field-error" id="password-error">
              {errors.password}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="confirm">Repeat password</label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={errors.confirm !== undefined}
            aria-describedby={errors.confirm === undefined ? undefined : 'confirm-error'}
            required
          />
          {errors.confirm !== undefined && (
            <span className="field-error" id="confirm-error">
              {errors.confirm}
            </span>
          )}
        </div>

        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Sending confirmation…' : 'Send confirmation code'}
          </button>
        </div>
      </form>

      <p className="form-foot">
        Already registered? <Link to="/login">Log in</Link>.
      </p>
    </>
  )
}

export default RegisterPage
