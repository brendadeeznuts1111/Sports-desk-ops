#!/usr/bin/env bash
# Run plugin smoke tests only when dsh-plugin* paths changed (PR/push vs base).
set -euo pipefail

ROOT=$(git -C "${BASH_SOURCE%/*}/../.." rev-parse --show-toplevel)
cd "$ROOT"

if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  git fetch origin "$GITHUB_BASE_REF" --depth=1 2>/dev/null || true
  RANGE="origin/${GITHUB_BASE_REF}...HEAD"
elif [[ -n "${GITHUB_REF_NAME:-}" && "${GITHUB_REF_NAME}" != "main" ]]; then
  RANGE="origin/main...HEAD"
else
  echo "test-changed-plugins: on main with no base; skipping"
  exit 0
fi

CHANGED=$(git diff --name-only "$RANGE" 2>/dev/null || true)

# Lockfile or workspace packages can break every plugin bundle; root package.json only when deps change.
shared_full_suite=false
if echo "$CHANGED" | grep -qE '^(bun\.lock|packages/)'; then
  shared_full_suite=true
elif echo "$CHANGED" | grep -qx 'package.json'; then
  if git diff "$RANGE" -- package.json 2>/dev/null \
    | grep -qE '^[+-].*"(dependencies|devDependencies|workspaces|catalog|trustedDependencies|overrides)"'; then
    shared_full_suite=true
  fi
fi

if [[ "$shared_full_suite" == true ]]; then
  echo "test-changed-plugins: shared dependency paths changed; running full plugin bundle suite"
  export CI=true
  bun test tests/plugin_bundles.test.ts
  exit 0
fi

mapfile -t BUNDLES < <(
  echo "$CHANGED" \
    | awk -F/ '/^dsh-plugin(-|$)/ {print $1}' \
    | sort -u
)

if [[ ${#BUNDLES[@]} -eq 0 ]]; then
  echo "test-changed-plugins: no dsh-plugin bundles in diff; skip"
  exit 0
fi

echo "test-changed-plugins: ${BUNDLES[*]}"
export CI=true
bun test tests/plugin_bundles.test.ts

for bundle in "${BUNDLES[@]}"; do
  if [[ -f "$bundle/verify-load.mjs" ]]; then
  echo "  verify-load $bundle"
    (cd "$bundle" && node verify-load.mjs)
  fi
done
