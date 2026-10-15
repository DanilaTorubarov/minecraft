#!/usr/bin/env sh
#
# Bundles the whole stack into one archive so it can be moved to another Docker
# host with a single command.
#
#   ./scripts/export.sh [output.tar.gz]
#
# Includes: the repo (compose, Caddyfile, source, migrations, mc-config), the
# .env.docker secrets, the Minecraft data directories (worlds, plugins, the
# forwarding secret), and a live database dump.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/project-export-$(date +%Y%m%d-%H%M%S).tar.gz}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "dumping the database..."
docker compose --env-file "$root/.env.docker" exec -T db \
  pg_dump -U postgres -d project_db > "$tmp/db.sql"

echo "archiving to $out ..."
tar czf "$out" \
  -C "$root" \
  --exclude='./.git' \
  --exclude='./target' \
  --exclude='./frontend/node_modules' \
  --exclude='./frontend/dist' \
  --exclude='./mc/*/logs' \
  . \
  -C "$tmp" db.sql

echo
echo "done: $out"
echo
echo "to restore on the new host:"
echo "  tar xzf $(basename "$out") && cd <dir>"
echo "  docker compose --env-file .env.docker up -d --build"
echo "  docker compose --env-file .env.docker exec -T db \\"
echo "    psql -U postgres -d project_db < db.sql"
