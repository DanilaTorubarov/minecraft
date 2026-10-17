import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getMe, logIn, logOut, type Me } from './api'
import { AuthContext } from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    getMe()
      .then((me) => {
        if (active) {
          setUser(me)
        }
      })
      .catch(() => {
        // A panel that cannot be reached is indistinguishable from no session for
        // the purposes of what to show, so the page falls back to signed out.
        if (active) {
          setUser(null)
        }
      })
      .finally(() => {
        if (active) {
          setReady(true)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    await logIn(email, password)
    // Re-read rather than trusting the login response: the session cookie is
    // HttpOnly, so the server's own view of it is the only view that counts.
    setUser(await getMe())
  }, [])

  const signOut = useCallback(async () => {
    await logOut()
    setUser(null)
  }, [])

  const refresh = useCallback(async () => {
    try { setUser(await getMe()) } catch { setUser(null) }
  }, [])

  const value = useMemo(
    () => ({ user, ready, signIn, signOut, refresh }),
    [user, ready, signIn, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
