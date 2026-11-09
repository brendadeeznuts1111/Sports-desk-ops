#!/usr/bin/env bash
# Fail if one dsh-plugin bundle imports another bundle's tree (keep plugins modular).
set -euo pipefail

ROOT=$(git -C "${BASH_SOURCE%/*}/.." rev-parse --show-toplevel)
failed=0

for bundle in "$ROOT"/dsh-plugin "$ROOT"/dsh-plugin-*; do
  [[ -d "$bundle" ]] || continue
  name=$(basename "$bundle")
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    echo "cross-bundle import in $name: $hit"
    failed=1
  done < <(
    rg -n "from ['\"]\\.\\./dsh-plugin" "$bundle" --glob '*.js' --glob '*.mjs' 2>/dev/null || true
  )
done

if [[ "$failed" -ne 0 ]]; then
  echo "check-plugin-boundaries: FAILED"
  exit 1
fi

echo "check-plugin-boundaries: OK"
