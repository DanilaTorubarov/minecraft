#!/bin/sh
# Deterministic, test-only world. Never load .env.docker or join its network.
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "${1:-}" in
  '') ECONOMY_SIM_STRICT=0 ;;
  --strict) ECONOMY_SIM_STRICT=1 ;;
  *) echo 'Usage: scripts/simulate-economy.sh [--strict]' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo 'Too many arguments' >&2; exit 2; }
export ECONOMY_SIM_STRICT
cd "$root"
# Keep the report directory host-owned so CI can render charts after Docker exits.
mkdir -p reports/economy
# No dependencies and no production secrets are passed into this service.
docker compose -p oasis-economy-sim -f compose.economy-sim.yaml run --rm --no-deps simulation
