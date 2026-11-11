# Token design assertions

A maintainer runs the token verification suite to confirm `design/tokens.toml` matches generated types, color distance, and WCAG constraints the README advertises.

## Sub-features

- `verify-tokens-suite` — `tests/verify_tokens.test.ts` passes.

## How to get to it (user POV)

- Run `bun test tests/verify_tokens.test.ts` (README quick start step 3).

## Driving it with bun test

Preconditions:

- `doctor.sh` passes.
- `bun run gen:tokens` already run if generated files were stale (suite compares live TS to TOML).

- **Suite drive.** Run `bun test tests/verify_tokens.test.ts 2>&1 | tee $SPORTSDESK_VERIFY_EVIDENCE/verify-tokens/log.txt`. Exit code `0`.
- **Proof.** Log shows pass count with zero fail; uses shared `parseTokensToml` from `lib/gen_tokens/tokens_ssot.ts` when SSOT parser is wired.

## Gotchas

- Large assertion count; failures often mean drift between `design/tokens.toml` and committed `design/domain-branded-types.ts` — run `gen:tokens` then re-test.
