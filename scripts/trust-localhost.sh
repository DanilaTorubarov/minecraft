#!/bin/sh
# Trust this stack's public Caddy CA for localhost SSL in the macOS user keychain.
set -eu

if [ "$(uname -s)" != Darwin ]; then
    echo 'This helper supports macOS. Import the Caddy public root CA into your OS/browser trust store on other systems.' >&2
    exit 1
fi

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cert_dir=$(mktemp -d)
trap 'rm -rf "$cert_dir"' EXIT HUP INT TERM
cert="$cert_dir/root.crt"

docker compose --env-file .env.docker cp \
    proxy:/data/caddy/pki/authorities/local/root.crt "$cert"
openssl x509 -in "$cert" -noout -subject -fingerprint -sha256
# Verify the running server before changing trust. Never copy the CA private key.
curl --fail --silent --show-error --cacert "$cert" --output /dev/null https://localhost/
security add-trusted-cert -r trustRoot -p ssl -s localhost \
    -k "$HOME/Library/Keychains/login.keychain-db" "$cert"
security verify-cert https://localhost/
echo 'localhost HTTPS verified. Reload your browser; restart it if it cached the old trust state.'
