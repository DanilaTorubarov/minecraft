import { createContext, useContext } from 'react'
import type { Me } from './api'

export type Auth = {
  /** The signed-in account, or null. */
  user: Me | null
  /** False until the first `/api/me` has answered, so pages do not flash a redirect. */
  ready: boolean
  signIn: (identifier: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<Auth | null>(null)

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (auth === null) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return auth
}
