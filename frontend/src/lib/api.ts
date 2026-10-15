export type Me = {
  id: number
  name: string
  surname: string
  email: string
  login_displayed: string
}

export type LinkedAccount = {
  uuid: string
  username: string
  linked_at: string
}

export type LinkCode = {
  code: string
  expires_in: number
}

export type Registration = {
  name: string
  surname: string
  login: string
  email: string
  password: string
}

/**
 * Every failure the UI has to talk about is either an HTTP status or "the request
 * never left the browser", so both travel as one error carrying a status. Status
 * `0` means the fetch itself was rejected and the server never answered.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`api ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}

/** The two failures every form shares, before a page adds its own statuses. */
export function sharedMessage(status: number): string | null {
  if (status === 0) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  if (status === 429) {
    return 'Too many attempts from here. Wait a minute, then try again.'
  }
  return null
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0)
  }
}

/** The current account, or null when there is no usable session. */
export async function getMe(): Promise<Me | null> {
  const response = await send('GET', '/api/me')
  if (response.status === 401) {
    return null
  }
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return (await response.json()) as Me
}

export async function logIn(email: string, password: string): Promise<void> {
  const response = await send('POST', '/api/login', { email, password })
  if (!response.ok) {
    throw new ApiError(response.status)
  }
}

export async function register(input: Registration): Promise<void> {
  const response = await send('POST', '/api/register', input)
  if (!response.ok) {
    throw new ApiError(response.status)
  }
}

export async function logOut(): Promise<void> {
  await send('POST', '/api/logout')
}

export async function listLinks(): Promise<LinkedAccount[]> {
  const response = await send('GET', '/api/link')
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  const body = (await response.json()) as { accounts: LinkedAccount[] }
  return body.accounts
}

export async function startLink(): Promise<LinkCode> {
  const response = await send('POST', '/api/link/start')
  if (!response.ok) {
    throw new ApiError(response.status)
  }
  return (await response.json()) as LinkCode
}

export async function unlink(uuid: string): Promise<void> {
  const response = await send('DELETE', `/api/link/${encodeURIComponent(uuid)}`)
  if (!response.ok) {
    throw new ApiError(response.status)
  }
}

/** `2026-10-15T21:04:11.123456Z` reads as `15 Oct 2026`. */
export function formatDate(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Seconds as `4:58`, so a countdown never reads as an ambiguous number. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}
