# Ambient TypeScript

`env.d.ts` merges SportsDesk credential keys into `Bun.Env` and `NodeJS.ProcessEnv` (verified by `tests/env_types.test-d.ts`).
`bundle.d.ts` augments `Registry` in `bun:bundle` with compile-time feature flags (verified by `tests/bundle_types.test-d.ts` and `tests/bundle_runtime.test.ts`).

### Feature Flags (`bun:bundle`)

<!-- FLAGS:START -->

| Flag           | Purpose                                  |
| :------------- | :--------------------------------------- |
| `DEBUG`        | Verbose logging and dev-only assertions. |
| `PROD`         | Production-only code paths.              |
| `TEST`         | Test-harness hooks; stripped in prod.    |
| `ANALYTICS`    | Telemetry emission.                      |
| `EXPERIMENTAL` | Unstable features behind opt-in.         |

<!-- FLAGS:END -->
