# gen:tokens zero-drift gate

A maintainer or CI job runs the token SSOT gate so generated TypeScript, CSS, and dashboard HTML match `design/tokens.toml` and committed HEAD bytes after regen.

## Sub-features

- `gate-clean-pass` — clean tree, gate exits 0.
- `gate-dirty-block` — uncommitted generated outputs block before reset.

## How to get to it (user POV)

- Run `bun run gen:tokens:gate` from the repo root (same as CI step "Token SSOT Zero-Drift Gate").
- Indirectly: open a PR; GitHub Actions runs the same script on Ubuntu.

## Driving it with shell + bun

Preconditions:

- `doctor.sh` passes.
- No uncommitted changes under `design/domain-branded-types.ts`, `src/dashboard/tokens.generated.css`, `static/customer-churn-simulation-dashboard.html`, `static/telegram-miniapp-dashboard.html`.
- `SPORTSDESK_VERIFY_EVIDENCE` exists.

- **Clean pass.** Run `bun run gen:tokens:gate` and tee to `$SPORTSDESK_VERIFY_EVIDENCE/gate-clean/log.txt`. Exit code `0`. Log contains `Generation completed successfully`.
- **Proof.** Run `git diff --quiet -- design/domain-branded-types.ts src/dashboard/tokens.generated.css static/customer-churn-simulation-dashboard.html static/telegram-miniapp-dashboard.html`. Exit code `0` after gate.

## Gotchas

- Gate deletes `scratch/gen-tokens-emitted.json` before gen; do not rely on a stale manifest from a prior run.
- `design/domain-branded-types.ts` and `src/dashboard/tokens.generated.css` use `rm-before-gen`; a failed gen can leave those files missing until you regen or checkout.
- Formal TLC property lives in `verify-gen-tokens-zero-drift` skill, not this drive alone.
