import { useEffect, useState } from 'react'
import { ApiError, getMinigameRules } from './api'
import { choosePayer, minigameFailure, type MinigameRules } from './minigames'
import type { StatsAccount } from './api'

/** Where the window remembers which linked account pays. */
const PAYER_KEY = 'minecraft-minigame-payer'

function readPayer(): string | null {
  try {
    return localStorage.getItem(PAYER_KEY)
  } catch {
    return null
  }
}

function storePayer(uuid: string): void {
  try {
    localStorage.setItem(PAYER_KEY, uuid)
  } catch {
    // Local storage is a convenience; the chosen account still holds for this visit.
  }
}

/**
 * One linked account pays for every round in the window, so the balance on screen
 * is always a balance the game server also knows. The choice survives a reload and
 * falls back to the oldest linked account when that UUID is unlinked.
 */
export function usePayer(accounts: StatsAccount[]) {
  const [preferred, setPreferred] = useState<string | null>(readPayer)
  const payer = choosePayer(accounts, preferred)
  const choose = (uuid: string) => {
    setPreferred(uuid)
    storePayer(uuid)
  }
  return { payer, choose }
}

/**
 * The paytable from the server, so the window can only ever show numbers that are
 * actually paid.
 */
export function useMinigameRules() {
  const [rules, setRules] = useState<MinigameRules | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void getMinigameRules().then((loaded) => { if (active) { setRules(loaded); setError('') } })
        .catch((failure: unknown) => { if (active) setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message) })
    }
    refresh()
    const timer = window.setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    window.addEventListener('economy-policy-changed', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('economy-policy-changed', refresh)
    }
  }, [attempt])
  return {
    rules,
    error,
    retry: () => {
      setError('')
      setAttempt((value) => value + 1)
    },
  }
}

/**
 * The balance being staked. A round's own answer is fresher than a statistics
 * snapshot that may already have been in flight when the round settled, so the
 * settled number wins until the snapshot moves off the value it had at that
 * moment. No timer: the next real snapshot change ends the override by itself.
 */
export function useStakedBalance(payerUuid: string | null, serverCoins: number | undefined) {
  const [settled, setSettled] = useState<{ payer: string | null; balance: number; stale: number } | null>(null)
  const superseded = settled !== null && settled.payer === payerUuid && serverCoins === settled.stale
  const balance = superseded ? settled.balance : serverCoins ?? 0
  const applySettled = (next: number, uuid = payerUuid, stale = serverCoins ?? 0) => {
    setSettled({ payer: uuid, balance: next, stale })
  }
  return { balance, applySettled }
}
