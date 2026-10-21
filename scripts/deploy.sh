#!/usr/bin/env bash
# Run by GitHub over SSH: bash -s -- /absolute/checkout/path <tested commit>
set -euo pipefail

if [[ $# != 2 || ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'usage: deploy.sh /absolute/checkout/path <40-character commit SHA>' >&2
  exit 1
fi
cd "$1"
commit="$2"

# Also serialize manual invocations. The lock is outside the tracked checkout.
exec 9>.git/oasis-deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }

if [[ ! -f .env.docker ]]; then
  echo 'Configure the production .env.docker before deployment' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Tracked files have local changes; commit or resolve them before deployment' >&2
  exit 1
fi

# Never deploy a moving branch head in place of the commit that passed CI.
git fetch origin main
git merge-base --is-ancestor "$commit" origin/main

# An untracked file that the tested commit begins to track would abort the
# fast-forward. Move exactly those collisions into .git (nothing else needs
# them, and .git is never deployed) instead of overwriting or deleting them.
conflicts=.git/oasis-untracked-conflicts
git ls-tree -r --name-only "$commit" | while IFS= read -r path; do
  if [[ -e "$path" && -z "$(git ls-files -- "$path")" ]]; then
    printf '%s\n' "$path"
  fi
done > "$conflicts"
if [[ -s "$conflicts" ]]; then
  backup=".git/deploy-untracked-$(date -u +%Y%m%dT%H%M%SZ)"
  while IFS= read -r path; do
    mkdir -p "$backup/$(dirname -- "$path")"
    mv -- "$path" "$backup/$path"
    printf 'Preserved untracked %s at %s\n' "$path" "$backup/$path"
  done < "$conflicts"
fi
rm -f "$conflicts"

git switch main
git merge --ff-only "$commit"
if [[ "$(git rev-parse HEAD)" != "$commit" ]]; then
  echo 'Checkout is ahead of the tested commit; refusing to deploy another revision' >&2
  exit 1
fi

compose() { docker compose --env-file .env.docker "$@"; }

# Reclaim disk space from dangling images and builder cache before building
docker image prune -f || true
docker builder prune -f --keep-storage 2GB || true

# Build before replacing running services. Runtime data stays in mc/ and volumes.
compose build app
./scripts/build-plugin.sh
compose up -d db app proxy purpur velocity
# Plugin jars are bind-mounted; Compose does not detect changes to their contents.
compose restart purpur
compose ps

# Clean up replaced images
docker image prune -f || true
