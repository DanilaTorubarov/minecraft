#!/usr/bin/env sh
# Install from a complete local copy. No network requests or service restarts.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'usage: scripts/install-local-purpur.sh /path/to/purpur-26.3-2652.jar' >&2
  exit 1
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
sh "$root/scripts/verify-purpur.sh" "$1"
dest="$root/mc/server-jars"
mkdir -p "$dest"
chmod 755 "$dest"
tmp="$(mktemp "$dest/.purpur-XXXXXX")"
trap 'rm -f "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$1" "$tmp"
sh "$root/scripts/verify-purpur.sh" "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$dest/purpur-26.3-2652.jar"
echo 'Installed. Set COMPOSE_FILE=compose.yaml:compose.purpur-local.yaml in .env.docker.'
echo 'Then: docker compose --env-file .env.docker up -d --no-deps --force-recreate purpur'
