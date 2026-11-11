---
name: verify-sportsdesk-ops
description: >-
  Drive Sports-desk-ops CLI gates the way CI and maintainers do: gen:tokens:gate,
  replay-mutant, verify_tokens tests, and optional TLC verify. Use when changing
  token SSOT, gate scripts, or CI verify steps; pair with verify-gen-tokens-zero-drift
  for formal model upkeep.
---

# Verify Sports-desk-ops (CLI gates)

**Surface.** Bun CLI scripts and test suites (no long-lived server). Primary user is a maintainer or CI job proving token SSOT and related gates.

**Feature map.** [features/README.md](./features/README.md)

## Launch

From repo root:

```sh
cd ~/code/sportsdesk-ops
bun install --frozen-lockfile
source .cursor/skills/verify-sportsdesk-ops/bin/launch-env.sh
```

Each **drive** uses a new shell or re-sources `launch-env.sh`. Teardown: remove only processes you started (none for CLI); keep evidence under `$SPORTSDESK_VERIFY_EVIDENCE`.

## Doctor

```sh
.cursor/skills/verify-sportsdesk-ops/bin/doctor.sh
```

Run before the first drive and after any failed drive. Requires Bun **1.4.4**, `design/tokens.toml`, and `bun.lock`.

## Drive

Follow one feature file under `features/`. Capture stdout/stderr to `$SPORTSDESK_VERIFY_EVIDENCE/<feature-id>/`.

| Feature                    | Command                                                         |
| -------------------------- | --------------------------------------------------------------- |
| gen-tokens-zero-drift-gate | `bun run gen:tokens:gate`                                       |
| gen-tokens-mutant-harness  | `bash verification/gen-tokens-zero-drift-gate/replay-mutant.sh` |
| formal-gen-tokens-model    | `bun run verify:gen-tokens-gate --no-render`                    |
| token-design-assertions    | `bun test tests/verify_tokens.test.ts`                          |
| operator-surfaces          | `./bin/dx help` (see `features/operator-surfaces.md`)           |

Formal properties: use project skill **verify-gen-tokens-zero-drift** and pstack **/statechart**.

## Evidence

- Path: `scratch/verify-sportsdesk-ops/<run-id>/` (gitignored except you copy summaries into PR notes).
- Each drive stores `log.txt` or `report.txt` with exit code in `status.txt`. When using `tee`, capture the command exit, not `tee`'s: `(set -o pipefail; cmd 2>&1 | tee log.txt); echo $? > status.txt`.
- Proof = user command + observable exit/log lines cited in the feature file.

## Cleanup

- Do not delete `$SPORTSDESK_VERIFY_EVIDENCE` until notes are copied; safe to `rm -rf scratch/verify-sportsdesk-ops/*` after the maintain pass.
- Never `git checkout` generated token files unless a feature explicitly requires it.

## Helpers

```sh
.cursor/skills/verify-sportsdesk-ops/bin/doctor.sh
source .cursor/skills/verify-sportsdesk-ops/bin/launch-env.sh
.cursor/skills/verify-sportsdesk-ops/bin/capture-drive.sh "$SPORTSDESK_VERIFY_EVIDENCE/gate-clean" log -- bun run gen:tokens:gate
```

## Maintenance

Run **/maintain-verification-skill** when CI steps, gate scripts, or user-facing CLI behavior changes. Run **/maintain-formal-verification-skill** on **verify-gen-tokens-zero-drift** when TLA+ or gate semantics change.
