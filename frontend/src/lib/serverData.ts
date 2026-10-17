export type ServerDataScope = 'links' | 'stats'

type Listener = (scope: ServerDataScope) => void

const listeners = new Set<Listener>()

/**
 * Tell mounted views that server-owned data changed. Mutations call this after
 * the server accepts them; subscribers then re-read the authoritative state.
 */
export function invalidateServerData(...scopes: ServerDataScope[]): void {
  for (const scope of scopes) {
    for (const listener of listeners) {
      listener(scope)
    }
  }
}

/** Subscribe to one server-data scope. The returned cleanup is React-friendly. */
export function onServerDataInvalidated(
  scope: ServerDataScope,
  listener: () => void,
): () => void {
  const scopedListener: Listener = (changedScope) => {
    if (changedScope === scope) {
      listener()
    }
  }
  listeners.add(scopedListener)
  return () => listeners.delete(scopedListener)
}
