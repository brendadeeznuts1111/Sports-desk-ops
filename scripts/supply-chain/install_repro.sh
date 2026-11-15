#!/bin/sh
# Clean, cache-less `bun install --frozen-lockfile` of HEAD in a temp dir; prints one
# "<dir> <tree-manifest sha256>" line per node_modules tree. Two runs (or two machines, or two
# Bun versions) that print the same lines installed the same bytes at the same paths.
#   sh scripts/supply-chain/install_repro.sh [bun-binary]
set -eu
bun=${1:-bun}
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git -C "$repo" archive HEAD | tar -x -C "$work/" 
cd "$work"
BUN_INSTALL_CACHE_DIR="$work/.cache" "$bun" install --frozen-lockfile --no-progress >install.log 2>&1 || { cat install.log >&2; exit 1; }
for d in node_modules packages/*/node_modules; do
  [ -d "$d" ] && echo "$d $(python3 "$repo/scripts/supply-chain/tree_manifest.py" --digest "$d")"
done
cmp -s "$repo/bun.lock" bun.lock && echo "bun.lock unchanged" || echo "bun.lock CHANGED by install"
