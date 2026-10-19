export type ChestRequest = { uuid: string; bet: number; client_id: string }
type RequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** An unresolved stake survives navigating away or reloading this tab. */
export function readChestRequest(storage: RequestStorage | null, key: string): ChestRequest | null {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as Partial<ChestRequest> | null
    return value && typeof value.uuid === 'string' && typeof value.client_id === 'string'
      && Number.isSafeInteger(value.bet) && value.bet! > 0 ? value as ChestRequest : null
  } catch { return null }
}

export function writeChestRequest(storage: RequestStorage | null, key: string, request: ChestRequest | null) {
  try {
    if (request) storage?.setItem(key, JSON.stringify(request))
    else storage?.removeItem(key)
  } catch { /* The in-memory request still permits retries when storage is unavailable. */ }
}
