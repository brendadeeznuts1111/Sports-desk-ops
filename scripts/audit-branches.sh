#!/usr/bin/env bash
# Local branch hygiene: prune remotes, list locals without upstream.
set -euo pipefail

git fetch --prune
echo "=== Local branches without upstream ==="
git branch -vv | grep -v '\[origin/' || true
echo "=== Merged into main (candidates to delete) ==="
git branch --merged main | grep -v '^\* main$' || true
