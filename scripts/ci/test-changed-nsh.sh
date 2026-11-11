#!/usr/bin/env bash
# Run pinned NSH v0.4.0 (e626a8d) doctor + verify-loop on PRs only when NSH-relevant paths changed.
set -euo pipefail

ROOT=$(git -C "${BASH_SOURCE%/*}/../.." rev-parse --show-toplevel)
cd "$ROOT"

if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  git fetch origin "$GITHUB_BASE_REF" --depth=1 2>/dev/null || true
  RANGE="origin/${GITHUB_BASE_REF}...HEAD"
elif [[ -n "${GITHUB_REF_NAME:-}" && "${GITHUB_REF_NAME}" != "main" ]]; then
  RANGE="origin/main...HEAD"
else
  echo "test-changed-nsh: on main with no base; skipping"
  exit 0
fi

CHANGED=$(git diff --name-only "$RANGE" 2>/dev/null || true)

if ! echo "$CHANGED" | grep -qE '^(packages/nsh-desk/|scripts/nsh_desk_cli\.ts$|tests/nsh_desk_contract\.test\.ts$|scripts/ci/(install|test-changed)-nsh\.sh$|\.agents/skills/nsh|\.github/workflows/ci\.yml$)'; then
  echo "test-changed-nsh: no NSH desk paths in diff; skip"
  exit 0
fi

echo "test-changed-nsh: NSH desk paths changed; bootstrapping pinned nsh v0.4.0 (e626a8d)..."
bash scripts/ci/install-nsh.sh
bun run nsh:doctor
bun run nsh:verify
