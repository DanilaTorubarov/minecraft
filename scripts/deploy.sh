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
git switch main
git merge --ff-only "$commit"
if [[ "$(git rev-parse HEAD)" != "$commit" ]]; then
  echo 'Checkout is ahead of the tested commit; refusing to deploy another revision' >&2
  exit 1
fi

compose() { docker compose --env-file .env.docker "$@"; }

# Build before replacing running services. Runtime data stays in mc/ and volumes.
compose build app
./scripts/build-plugin.sh
compose up -d db app proxy purpur velocity
# Plugin jars are bind-mounted; Compose does not detect changes to their contents.
compose restart purpur
compose ps
