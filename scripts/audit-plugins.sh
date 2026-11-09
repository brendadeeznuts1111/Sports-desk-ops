#!/usr/bin/env bash
# Manifest/surface audit: index.json vs package.json at the pinned commit.
set -euo pipefail

ROOT=$(git -C "${BASH_SOURCE%/*}/.." rev-parse --show-toplevel)
INDEX="${ROOT}/market/index.json"
PIN=$(jq -r '.plugins[0].versions[0].source.commit' "$INDEX")

declare -A PATHS=(
  [dsh-plugin-sportsdesk-ops]=dsh-plugin
  [dsh-plugin-sportsdesk-security]=dsh-plugin-security
  [dsh-plugin-sportsdesk-desk-status]=dsh-plugin-ui
  [dsh-plugin-sportsdesk-desk-panel]=dsh-plugin-sidebar
  [dsh-plugin-watchlist-autobet]=dsh-plugin-watchlist-autobet
)

failed=0

echo "audit-plugins: pin=${PIN}"
echo "index: ${INDEX}"
echo

for name in "${!PATHS[@]}"; do
  p="${PATHS[$name]}"
  echo "========== ${name} (${p}) =========="

  index_ver=$(jq -r --arg n "$name" '.plugins[] | select(.name==$n) | ."dist-tags".latest' "$INDEX")
  manifest_ver=$(git -C "$ROOT" show "${PIN}:${p}/package.json" | jq -r .version)

  if [[ "$index_ver" != "$manifest_ver" ]]; then
    echo "FAIL version: index latest=${index_ver} manifest@${PIN}=${manifest_ver}"
    failed=1
  else
    echo "OK   version: ${index_ver}"
  fi

  manifest_name=$(git -C "$ROOT" show "${PIN}:${p}/package.json" | jq -r .name)
  if [[ "$manifest_name" != "$name" ]]; then
    echo "FAIL name: index=${name} manifest=${manifest_name}"
    failed=1
  else
    echo "OK   name: ${name}"
  fi

  echo "-- manifest (summary) --"
  git -C "$ROOT" show "${PIN}:${p}/package.json" \
    | jq '{name, version, exports: .exports["."], bin, dsh: {bundle: .dsh.bundle}}'

  echo "-- tree (sample) --"
  git -C "$ROOT" ls-tree -r --name-only "$PIN" -- "$p" | grep -vE '/(node_modules|/dist/)' | head -15

  dist_count=$(git -C "$ROOT" ls-tree -r --name-only "$PIN" -- "$p/dist" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$dist_count" != "0" ]]; then
    echo "WARN committed dist/: ${dist_count} file(s) under ${p}/dist"
  else
    echo "OK   no committed dist/"
  fi

  echo
done

if jq -e '.metadata.categories | to_entries[] | select(.value.title.en == null)' "$INDEX" >/dev/null 2>&1; then
  echo "FAIL metadata.categories missing title.en"
  failed=1
fi

if jq -e '.metadata.labels | to_entries[] | select(.value.title.en == null)' "$INDEX" >/dev/null 2>&1; then
  echo "FAIL metadata.labels missing title.en"
  failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  echo "audit-plugins: FAILED"
  exit 1
fi

echo "audit-plugins: OK"
