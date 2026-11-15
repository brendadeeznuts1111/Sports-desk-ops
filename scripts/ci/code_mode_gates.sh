#!/usr/bin/env bash
# Sequential Code Mode gates: snapshot drift -> oracle freeze -> property/unit/guest tests ->
# mutation -> guest probe.
# Each gate must pass before the next runs; a survived mutant below the break threshold fails the run.
set -euo pipefail

echo "== [0/7] snapshot drift (skipped when the operator book is absent) =="
if [ -f data/customer-profiles.json ]; then
  bun run check:profile-snapshot
else
  echo "skip: data/customer-profiles.json is absent (CI checkout)"
fi

echo "== [1/6] oracle freeze gate =="
bun run check:oracle-frozen

echo "== [2/7] profile code-mode host import allowlist (same entrypoint as verify-changed) =="
bun run check:profile-code-mode-host-seal

echo "== [3/7] bun test tests/code_mode/*.test.ts =="
bun test tests/code_mode/*.test.ts

echo "== [4/7] stryker run (thresholds: high 80 / low 60 / break 60) =="
stryker_rc=0
bunx stryker run || stryker_rc=$?
# In-place mutation restores files by content, dropping exec bits and symlink types. Put the
# tracked metadata back so the gate leaves the worktree as it found it — even when it fails.
bun run scripts/ci/restore_after_stryker.ts
[ "$stryker_rc" -eq 0 ] || exit "$stryker_rc"

echo "== [5/7] QuickJS guest probe =="
bun run tests/code_mode/guest_probe.ts

echo "code-mode gates: PASS"
