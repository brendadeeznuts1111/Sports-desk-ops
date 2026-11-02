#!/usr/bin/env bash
# Fetch pinned portal bundles and print SHA-256 (no credentials).
set -euo pipefail
BASE="${F402_BASE_URL:-https://www.fantasy402.com}"
BUST="${F402_PINNED_MANAGER_BUST:-1.0.280}"
DIR="$(cd "$(dirname "$0")" && pwd)"
fetch() {
  local path="$1"
  local out="$2"
  curl -fsSL "${BASE}/${path}?bust=${BUST}" -o "$out"
  shasum -a 256 "$out"
}
fetch "app/setting/version.js" "$DIR/version.js"
fetch "app/manager/manager.js" "$DIR/manager.js"
fetch "app/util/util.js" "$DIR/util.js"
fetch "app/system/security.js" "$DIR/security.js"
# Request-composition modules: score.js builds the Scores call, pending.js the Pending call.
# Not in manifest.json yet — the printed hashes are what pins them.
fetch "app/sports/score/score.js" "$DIR/score.js"
fetch "app/sports/report/pending.js" "$DIR/pending.js"
echo "Compare hashes to pinned/manifest.json"
echo "Bun fetch (TLS vs bundle-byte drift): bun run fetch:pinned-portal"
