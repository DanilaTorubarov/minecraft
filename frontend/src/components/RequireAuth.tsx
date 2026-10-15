import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useAuth } from '../lib/auth-context'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()

  // Waiting for the first answer beats redirecting a signed-in player to the login
  // page just because the session had not been read yet.
  if (!ready) {
    return <p className="loading">Loading your account…</p>
  }

  if (user === null) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

export default RequireAuth
