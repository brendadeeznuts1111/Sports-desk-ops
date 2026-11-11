#!/usr/bin/env bash
# Read-only preflight for verify-sportsdesk-ops drives.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../" && pwd)"
cd "$root"

host_home="${HOME%%/.gemini/users/*}"
export PATH="$root/bin:$HOME/.local/bin:$HOME/.bun/bin:$host_home/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail=0
want_bun="1.4.4"
got="$(bun --version 2>/dev/null || true)"
if [[ "$got" != "$want_bun" ]]; then
  echo "doctor: bun version want $want_bun got ${got:-missing}"
  fail=1
fi
if [[ ! -f bun.lock ]]; then
  echo "doctor: missing bun.lock (run from repo root)"
  fail=1
fi
if [[ ! -f design/tokens.toml ]]; then
  echo "doctor: missing design/tokens.toml"
  fail=1
fi
exit "$fail"
