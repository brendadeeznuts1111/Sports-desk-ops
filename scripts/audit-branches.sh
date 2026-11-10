#!/usr/bin/env bash
# Worktree + local/remote branch hygiene (delegates to scripts/dx_worktrees.ts).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bun run "$REPO_ROOT/scripts/dx_worktrees.ts" --fetch "$@"
