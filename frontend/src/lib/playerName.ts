/**
 * Floodgate prefixes every Bedrock player's Java-visible name with "." (Geyser's
 * `bedrock.username-prefix`), so the one player named `Kokochi7232` arrives as
 * `.Kokochi7232`. That leading dot marks the authentication path, not the player,
 * so every surface renders the name without it.
 *
 * This is display-only: the UUID and the username in API payloads are never
 * rewritten, so lookups, comparisons and in-game identity keep working.
 */
export function displayPlayerName(name: string | null | undefined): string {
  if (name === null || name === undefined) return ''
  return name.replace(/^\.+/, '')
}
