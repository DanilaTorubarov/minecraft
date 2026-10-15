import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { useAuth } from '../lib/auth-context'

/**
 * The bars are the server list's own signal glyph. They stand in for a wordmark,
 * because the server has no name yet and inventing one would be a claim the
 * operator never made.
 */
function SignalMark() {
  return (
    <svg className="brand-mark" width="14" height="15" viewBox="0 0 13 14" aria-hidden="true">
      <rect x="0" y="9" width="3" height="5" fill="currentColor" opacity="0.45" />
      <rect x="5" y="5" width="3" height="9" fill="currentColor" opacity="0.7" />
      <rect x="10" y="1" width="3" height="13" fill="currentColor" />
    </svg>
  )
}

function Shell() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)

  async function handleSignOut() {
    setLeaving(true)
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <SignalMark />
            Minecraft account
          </Link>

          <nav className="nav" aria-label="Account">
            {user === null ? (
              <>
                <NavLink to="/register" className="nav-link">
                  Register
                </NavLink>
                <NavLink to="/login" className="nav-link">
                  Log in
                </NavLink>
              </>
            ) : (
              <>
                <NavLink to="/cabinet" className="nav-link">
                  Account
                </NavLink>
                <button
                  type="button"
                  className="nav-link"
                  onClick={handleSignOut}
                  disabled={leaving}
                >
                  Log out
                </button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

export default Shell
