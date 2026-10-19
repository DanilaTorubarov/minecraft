#!/usr/bin/env sh
# SHA-256 of the provider-checksummed recovery copy recorded in STATE.md.
# Used both on the host during installation and inside the container before Java.
set -eu

jar="${1:-${CUSTOM_SERVER:-}}"
if [ -z "$jar" ] || [ ! -f "$jar" ] || [ ! -r "$jar" ]; then
  echo 'Purpur: expected a readable 26.3 build 2652 jar; run scripts/install-local-purpur.sh' >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum < "$jar")"
else
  actual="$(shasum -a 256 < "$jar")"
fi
actual="${actual%% *}"
if [ "$actual" != '893bf450c86117b1e872e992f874fca5e7f1f51b8dcc910eb2e646076c58e42a' ]; then
  echo 'Purpur: checksum mismatch; refusing to use a corrupt or different build. Reinstall a verified 26.3 build 2652 jar.' >&2
  exit 1
fi
echo 'Purpur: verified 26.3 build 2652 (SHA-256)'
