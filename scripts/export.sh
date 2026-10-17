#!/usr/bin/env sh
#
# Bundles the whole stack into one archive so it can be moved to another Docker
# host with a single command.
#
#   ./scripts/export.sh [output.tar.gz]
#
# Includes: the repo (compose, Caddyfile, source, migrations, mc-config), the
# .env.docker secrets, the Minecraft data directories (worlds, plugins, the
# forwarding secret), and a database dump. Writers are stopped during the snapshot.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/project-export-$(date +%Y%m%d-%H%M%S).tar.gz}"
tmp="$(mktemp -d)"
running=""
compose() {
  docker compose -f "$root/compose.yaml" --env-file "$root/.env.docker" "$@"
}
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$running" ]; then
    echo "restarting services..."
    # Intentional word splitting: these are service names returned by Compose.
    compose start $running || result=1
  fi
  rm -rf "$tmp"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Leave services that were already stopped alone. Stop both panel and game
# writers so the Postgres dump and Minecraft files describe the same pause.
running="$(compose ps --status running --services | awk '$0 == "app" || $0 == "velocity" || $0 == "purpur"')"
if [ -n "$running" ]; then
  echo "stopping writers for a consistent snapshot..."
  compose stop --timeout 120 $running
  # A forced kill can leave unsaved world changes. Refuse to publish that backup.
  for service in $running; do
    container="$(compose ps --all --quiet "$service")"
    if [ -z "$container" ]; then
      echo "export: $service did not stop cleanly; no archive created" >&2
      exit 1
    fi
    case "$(docker inspect --format '{{.State.ExitCode}}' "$container")" in
      0|143) ;; # Normal exit or graceful SIGTERM (including JVM shutdown hooks).
      *) echo "export: $service did not stop cleanly; no archive created" >&2; exit 1 ;;
    esac
  done
fi

echo "dumping the database..."
compose exec -T db \
  pg_dump -U postgres -d project_db > "$tmp/db.sql"

echo "archiving to $out ..."
tar czf "$tmp/archive.tar.gz" \
  -C "$root" \
  --exclude='./.git' \
  --exclude='./target' \
  --exclude='./frontend/node_modules' \
  --exclude='./frontend/dist' \
  --exclude='./.plugin-build' \
  --exclude='./plugin/build' \
  --exclude='./plugin/.gradle' \
  --exclude='*.tar.gz' \
  --exclude='./mc/*/logs' \
  . \
  -C "$tmp" db.sql
mv "$tmp/archive.tar.gz" "$out"

echo
echo "done: $out"
echo
echo "to restore on the new host:"
echo "  tar xzf $(basename "$out") && cd <dir>"
echo "  docker compose --env-file .env.docker up -d --build"
echo "  docker compose --env-file .env.docker exec -T db \\"
echo "    psql -U postgres -d project_db < db.sql"
