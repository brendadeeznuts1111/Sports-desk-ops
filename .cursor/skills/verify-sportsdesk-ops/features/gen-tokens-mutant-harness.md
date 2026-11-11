# gen:tokens strict-failure harness

Proves the gate fails when the generator skips a registered emission (manifest + strict mode), matching CI safety expectations.

## Sub-features

- `mutant-skip-fails` — replay script expects non-zero gate exit.

## How to get to it (user POV)

- Run `bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh` after a clean checkout (local maintainer only; mutates then restores `scripts/generate_tokens.ts`).

## Driving it with shell + bun

Preconditions:

- `doctor.sh` passes.
- Clean generated outputs (same as gate preconditions).

- **Mutant drive.** Run `bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh` 2>&1 | tee `$SPORTSDESK_VERIFY_EVIDENCE/mutant/log.txt`. Script exit code `0`. Log contains `gate correctly failed when gen skips`.
- **Proof.** Inner gate must exit non-zero; log shows `gate mode: expected 4 emissions` or `gen:tokens exited with code 1`.

## Gotchas

- Never commit while the mutant patch is applied; the script uses `trap` to restore `scripts/generate_tokens.ts` and `design/domain-branded-types.ts`.
- After mutant, run `doctor.sh` and optionally `gen:tokens:gate` once to confirm tree is clean.
