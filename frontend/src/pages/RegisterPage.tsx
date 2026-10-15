import { useState, type SubmitEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, register, sharedMessage } from '../lib/api'
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
  if (password !== '' && length < 15) {
    errors.password = `At least 15 characters — ${length} so far.`
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

  const [name, setName] = useState('')
  const [surname, setSurname] = useState('')
  const [login, setLogin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')

    const found = validate(login, password, confirm)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      return
    }

    setBusy(true)
    try {
      await register({ name, surname, login, email, password })
      // Registering does not mint a session, so sign straight in and continue to the
      // page the player actually came for.
      await signIn(email, password)
      navigate('/cabinet', { replace: true })
    } catch (problem) {
      setError(messageFor(problem))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Register</h1>
        <p className="page-sub">
          Create an account, then link your in-game name from your account page.
        </p>
      </div>

      {error !== '' && (
        <p className="note" data-tone="error" role="alert">
          {error}
        </p>
      )}

      <form className="form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="name">First name</label>
          <input
            id="name"
            name="name"
            autoComplete="given-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="surname">Surname</label>
          <input
            id="surname"
            name="surname"
            autoComplete="family-name"
            value={surname}
            onChange={(event) => setSurname(event.target.value)}
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
            <span className="field-hint">At least 15 characters.</span>
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
            {busy ? 'Creating your account…' : 'Create account'}
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
