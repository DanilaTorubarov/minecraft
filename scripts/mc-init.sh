#!/usr/bin/env sh
#
# One-time (and repeatable) setup for the Minecraft stack.
#
#   - creates .env.docker from the example if it is missing
#   - generates the secrets it needs, once each:
#       VELOCITY_SECRET      proxy <-> backend player-info forwarding
#       LINK_SERVICE_TOKEN   in-game plugin -> panel /internal/link/claim
#   - writes the forwarding secret where Velocity reads it
#   - creates the data directories
#
# Safe to run repeatedly: an existing secret is never overwritten.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$root/.env.docker"

if [ ! -f "$env_file" ]; then
  cp "$root/.env.docker.example" "$env_file"
  echo "created .env.docker from the example — set POSTGRES_PASSWORD before starting"
fi

# ensure_secret NAME — echoes the existing value, or generates and stores one.
ensure_secret() {
  name="$1"
  value="$(grep -E "^${name}=." "$env_file" | head -n1 | cut -d= -f2- || true)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return
  fi
  value="$(openssl rand -hex 32)"
  tmp="$(mktemp)"
  awk -v k="$name" -v v="$value" '
    $0 ~ "^" k "=" { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
  echo "generated $name in .env.docker" >&2
  printf '%s' "$value"
}

secret="$(ensure_secret VELOCITY_SECRET)"
ensure_secret LINK_SERVICE_TOKEN > /dev/null

mkdir -p "$root/mc/velocity" "$root/mc/purpur"
# Velocity reads the secret from this file; the same value reaches the backend
# through CFG_VELOCITY_SECRET. World-readable so the container's uid 1000 can
# read it after a bind mount on a Linux host.
printf '%s' "$secret" > "$root/mc/velocity/forwarding.secret"
chmod 644 "$root/mc/velocity/forwarding.secret"

echo "data directories ready under mc/"
echo
echo "next: docker compose --env-file .env.docker up -d --build"
