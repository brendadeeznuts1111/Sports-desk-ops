# SportsDesk Feature Flags & IPC Showcase

Demonstrates compile-time dead-code elimination, TypeScript `Registry` augmentation, and cross-process IPC in `sportsdesk-ops`.

## Architecture

1. **`types/features.ts` (SSOT)**:
   - Declares known flags (`FEATURES`): `"DEBUG" | "PROD" | "TEST" | "ANALYTICS" | "EXPERIMENTAL"`.
   - Defines target selections (`BUILD_FEATURES`):
     - `dev`: `["DEBUG", "ANALYTICS", "EXPERIMENTAL"]`
     - `prod`: `["PROD"]` (strictly excludes debug, test, and experimental code)
     - `test`: `["TEST", "DEBUG"]`
2. **`types/bundle.d.ts`**:
   - Augments Bun's `Registry` interface using `Feature` so `feature()` rejects unknown flags at compile time.
3. **`scripts/gen_feature_flags.ts` & `scripts/gen_type_tests.ts`**:
   - Generates `types/README.md` documentation table and `tests/bundle_types.test-d.ts`.
   - `DESCRIPTIONS` map ensures adding a flag to `FEATURES` fails to compile until a description is provided.
4. **`examples/feature_flags/risk_engine.ts`**:
   - SportsDesk wager risk assessment logic using compile-time gated features (`EXPERIMENTAL`, `DEBUG`, `ANALYTICS`).
5. **`examples/feature_flags/ipc_worker.ts`**:
   - Background risk scoring worker receiving wagers and returning assessments over Bun IPC (`serialization: "json"`).

## Running the Showcase

```bash
bun run examples/feature_flags/demo.ts
```

## Running Generators & Drift Verification

```bash
bun run gen:features
bun run check:features
```
