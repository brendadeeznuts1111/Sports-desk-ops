# Replay report: envelopes captured at 54d5fff

**Historical capture.** These envelopes pin the tree at 54d5fff, before the branch was rebased
onto a newer `main`. On the rebased tree `rerun.py verify-all` reports input DRIFT (worktree, and
the lock/node_modules inputs) for all six, which is the envelopes doing their job. Re-capture
them after merge, from a fresh `bun install --frozen-lockfile` (see docs/supply-chain.md §4 for
the install race that makes `install-repro` flaky on the current lockfile).

Captured with the pinned runtime (bun 1.4.4, binary sha256 `10702245…7ac235`) on 2026-11-15,
Linux x86_64 agent box. This directory is excluded from the envelopes' worktree digest, so
committing it does not invalidate them.

| Run                                                                                     | Result                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rerun.py verify-all`, pinned 1.4.4                                                     | 6/6 PASS (inputs ok, outputs byte-identical after normalization)                                                                                                                                                                     |
| `runtime_upgrade.sh --candidate` 1.4.5-canary.1 (`f4830704…`)                           | baseline 6/6 PASS. Candidate: 5 MATCH (regression-suite, lint-check, install-repro, sbom, verify-bun-fake-pin), 1 DIFF (dx-help: `bun run --help` 100 → 102 flags, adds `--aot` and `--aot-allow-code-from-disk`). Verdict **BLOCK** |
| same, with `--accept dx-help`                                                           | **PROMOTE-ELIGIBLE** (accepted diffs: dx-help)                                                                                                                                                                                       |
| `nix build .#regression` (Nix sandbox, patched bun)                                     | normalized sha256 `2c2b7c513361…` == the regression-suite envelope; `--rebuild` bit-identical                                                                                                                                        |
| Envelope copies DEMO-signed with a throwaway Ed25519 key (kept out of git)              | 6/6 signatures verify with openssl. A changed `exit_code` is rejected. `rerun.py verify --pubkey` → signature ok                                                                                                                     |
| Envelopes vs `schema/tool-step-envelope.schema.json` (python-jsonschema, draft 2020-12) | 6/6 VALID                                                                                                                                                                                                                            |

Nondeterminism found and normalized:

- bun test per-test timings and the "Ran … [2.94s]" total are stripped. Result lines are
  sorted, because file order is not a contract.
- The oxlint "Finished in Nms … using N threads" line keeps only the file and rule counts.
- `bun run` echoes the script line (`$ bun --bun run oxlint …`). It is dropped, because
  the script is already covered by the worktree digest.
- The verify-bun output masks the binary path and its sha256 and keeps the verdict.
- `recorded.at` and `recorded.duration_ms` are informational and never compared.

No other run-to-run variation showed up in any replay today (at least 6 per envelope, across both runtimes).
