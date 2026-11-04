# External-view guard canary

The `external-view` branch of `manager.js` `setAccountInfo` loads a module named by a URL parameter
with no auth check. The client overlay wraps that method with a guard behind a default-false flag;
this runbook is the only sanctioned way to turn it on.

## What is gated

- `flags.externalViewGuard` is latched at preload from `?external-view-guard=1` or an injected
  `window.__F402_EXTERNAL_VIEW_GUARD__ = true`; default `false`.
- `?no-seam` wins over `external-view-guard` by dependency: the guard calls `isAuthenticated()` and
  `isAllowedModule()`, so with the seam disabled the flag latches `false` and the guard cannot run.
- With the flag on, the branch requires `isAuthenticated()`; a disallowed or traversal `module` id is
  rejected before `require`; a guard evaluation error fails closed. Unauthenticated ends the session.
- With the flag off (normal), the wrapper delegates immediately — merging the code changes no
  behavior.

## Preconditions

1. **A logged-in Chrome profile.** `--login` requires the keychain (`secrets:f402`) or a TTY prompt;
   an unattended environment needs a profile that already has a live session. Provision one with
   `bun run session:login --from-profile <dir>` (from a real Chrome profile), or bootstrap it once
   with `bun run capture:f402-har -- --login --profile <dir>` on a machine that can authenticate.
   There are no credentials in CI; without a profile the probe exits 2 or 4, and the canary does not
   open.
2. **Active wagering.** The acceptance selector is `[data-wager-number]`, which matches zero nodes
   on an empty ticker. Run the canary while wagers are flowing; **an empty ticker is not a pass
   state**, and `exit 1` for a missing render target there is expected rather than a seam failure.
3. **Chrome backend.** Phase 1 is Chrome/CDP only. WebKit sessions are `covered: false` (exit 3) and
   are out of scope until the injection path exists.

## Run

```sh
bun run probe:client-seams \
  --profile <logged-in-profile> --login --guard \
  --expect-rendered '[data-wager-number]'
```

`--guard` appends `external-view-guard=1` to the probed URL, so the preload latches the canary flag
for that document. Without it the probe still runs but exercises the dead-by-default path.

## Acceptance

| Exit | Meaning                                                       | Action                                                                                                   |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 0    | structural pass, authenticated, `[data-wager-number]` matched | **canary passes** — keep the flag on for this instance, still confirm rows visually on the first session |
| 1    | structural failure, or render target absent                   | do not enable; on an empty ticker re-run during active wagering before treating it as a failure          |
| 2    | structural pass, authenticated unverified                     | session not exercised; do not enable                                                                     |
| 3    | not covered (WebKit)                                          | out of scope, phase 2                                                                                    |
| 4    | could not run (auth/profile)                                  | fix the profile, do not enable                                                                           |

The selector is the automated acceptance; a visual check that ticker rows populate is still
recommended for the first canary session because the selector proves the render target exists, not
that the data path is healthy.

## Scope and navigation

- **In scope:** the internal bet-ticker component opened inside `manager.html` (same document), so
  the preload latch persists across the `require("manager/module/bet-ticker")` call.
- **Out of scope:** a `window.open` popup or any new document that does not carry
  `?external-view-guard=1`; the preload runs again there and latches `false`. Manual reload without
  the parameter likewise loses the flag. Re-pass the parameter per navigation. If popup coverage is
  needed, persist the latch in `sessionStorage` on first read as a follow-up, with its own review.

## If a vendor update moves the branch

`pin:cdn` reports `guard_anchor_missing`, `pin:cdn:update` refuses to pin, and the preload logs
`external-view guard cannot install: setAccountInfo missing`. Do not open the canary: update the
overlay against the new `manager.js`, re-run its tests, then re-pin. A green probe with the flag on
is not sufficient if `managerGuardInstalled` is false — the structural gate already fails there.

## Rollback

Open the page without `?external-view-guard=1` (next navigation loses the latch) or with
`?no-seam` to disable the seam entirely. No redeploy and no code revert is required. If the guard
itself misfires, also report the probe's exit code and the `structural`/`authenticated` fields.

## Related

- [manager-portal-client-exposure-2026-11-03.md](../evidence/manager-portal-client-exposure-2026-11-03.md)
  — the seam, the exit-code contract, and the upstream items this does not fix.
- `scripts/probe/client_seams_probe.ts` — the runner.
