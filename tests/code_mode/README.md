# Code Mode profile-tool suite

Frozen-oracle, property-based, guest-boundary and mutation tests for
`lib/profile_query_tools.ts` (the `query_profiles` / `get_profile` / `get_profile_summary`
Code Mode tools).

## The oracle is frozen

[tests/code_mode/oracle.ts](oracle.ts) is the specification. It is derived from the committed
31-profile snapshot ([data/profile-snapshot.json](../../data/profile-snapshot.json)) and the
schema constants (`MAX_LIMIT = 500`, fields `clv` | `vol` | `sharp`), **not** from the
implementation. It throws at import when the profile count or sentinel ids drift. The snapshot
document is versioned: the parser rejects an unknown `schemaVersion`, an untrimmed id, duplicate
ids and non-finite values.

The committed snapshot is **synthetic** (27 pseudonymous `P###` profiles plus 4 `SYNTH_*`): no
customer login, agent id or P/L is in the repository. For a deployment that needs real profiles,
project the gitignored operator book locally and point the tool at it:

```sh
bun run scripts/generate_profile_snapshot.ts --from-book --out data/profile-snapshot.real.json
PROFILE_SNAPSHOT_PATH=data/profile-snapshot.real.json <entrypoint>
```

The tool loads the snapshot lazily, so importing it never fails on a host without one; using it
without `PROFILE_SNAPSHOT_PATH` reports the missing path.

The tracked argument contract is [lib/profile_query_schema.ts](../../lib/profile_query_schema.ts)
(the repository's `schema.ts`): the tool, the Code Mode registration and the tests import it, and
the freeze gate watches it (plus the snapshot). The oracle deliberately duplicates its constants.
On a push-to-main checkout, where `origin/main` equals `HEAD`, the gate falls back to
`GITHUB_EVENT_BEFORE` or `HEAD^` so the pushed commit is still compared with its parent.

To re-freeze deliberately after a contract change:

1. `bun run scripts/generate_profile_snapshot.ts` (writes the deterministic synthetic fixture).
   `bun run check:profile-snapshot` fails when the committed fixture is stale.
2. Update `EXPECTED_PROFILE_COUNT` / `EXPECTED_SENTINEL_IDS` in `oracle.ts` if they moved.
3. Run `bun run check:oracle-frozen` — a snapshot or argument-schema change without an oracle
   change fails the gate.

## Properties

Besides exact comparison with the reference query for arbitrary arguments, the suite asserts
metamorphic properties that hold independently of the oracle:

- a smaller `limit` is an exact prefix of a larger one, and `truncated` tracks `limit > MAX_LIMIT`;
- default rows are the sentinel-free subsequence of `includeSentinels: true` rows;
- repeated calls are deterministic and every row's `flags` equal `get_profile(row.id).flags`;
- `includeSentinels` is strict identity, so truthy non-booleans never opt in;
- sentinel state is the profile id (`SYNTH_*`), not the sort value — a real profile carrying the
  old sentinel numbers is not a sentinel row.

The pure core `querySnapshot(snapshot, args)` is tested over **generated snapshots** (0–40 rows,
duplicate values, ties, negatives, synthetic ids), against a separately written reference model —
so ordering, filtering, limits and freezing are exercised beyond the frozen 31 rows. A second
suite runs the same requests through **SQLite** (`ORDER BY value DESC, id ASC LIMIT ?`) and requires
both engines to agree row-for-row. The freeze gate itself is tested by spawning it against a
throwaway git repository: clean, schema-only, and paired-change cases.

## Gates

```sh
bun run ci:code-mode          # sequential: drift -> freeze -> tests -> mutation -> guest probe
bun run test:code-mode        # property/unit/parser/guest tests only
bun run mutation:code-mode    # Stryker, thresholds high 80 / low 60 / break 60
bun run probe:code-mode       # QuickJS guest probe as a standalone gate
bun run check:profile-snapshot
```

Property runs default to 100 cases; override with `FAST_CHECK_NUM_RUNS` and pin a failing run
with `FAST_CHECK_SEED`.

Mutation covers both `lib/profile_query_tools.ts` and the QuickJS bridge `lib/quickjs_code_mode.ts`
(host-to-guest marshalling, option normalization, budgets and deadlines). It runs under **Bun**
(`bunx stryker run`): Stryker's documented Node runtime cannot load the Bun runner in this repo
because the security override `ws: 5.2.5` breaks the runner's ESM named import; Bun's CJS interop
handles it. If the override is ever scoped for the runner, Node 22 can be used instead. It is in
place because the sandbox cannot resolve Stryker's TypeScript preprocessor under this repo's
isolated linker; the gate script restores the executable bits and symlinks that in-place restore
strips. The HTML
report is written to `reports/mutation/mutation.html` (force-added; `reports/` is gitignored).

## Bun reference and binary posture

Two Code Mode runtimes coexist:

| Path                            | Realm                                                 | Compile / trim                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/code_mode_host.ts`         | Host desk spine (`Bun.Transpiler`, `AsyncFunction`)   | Full Bun; see [Smaller executables](https://bun.com/docs/compiler/size). `--trim` drops unused APIs; **not** guest-safe. No profile tools.                                             |
| `lib/profile_code_mode_host.ts` | Profile tools on insecure host                        | Env `SPORTSDESK_PROFILE_CODE_MODE_HOST=1`; not mixed into desk host.                                                                                                                   |
| `lib/code_mode_profile.ts`      | Profile API (`PROFILE_CODE_MODE_DEFAULT_REALM=guest`) | `executeProfileCodeMode(code)` / `bun run code-mode:profile`.                                                                                                                          |
| `lib/quickjs_code_mode.ts`      | QuickJS WASM guest                                    | No `bun:ffi`; fits **`remove: ["native-code"]`** AOT profiles. FFI QuickJS (`@tanstack/ai-isolate-quickjs-bun`) is a separate, faster lane that **requires** `allow: ["native-code"]`. |

Reference URLs use the canonical form (`https://bun.com/reference/bun/<Symbol>` — not
`/reference/globals/bun/...`, which 404s). Local catalog: `lib/bun_shapes.ts`; docs MCP:
`bun run bun:docs-mcp search "compile standalone"`.

Audit (runtime + docs grep + `--explain=trim` when supported):

```sh
bun run code-mode:binary-reference
bun run code-mode:binary-reference --offline
```

Official trim feature name for FFI sandboxes: **`native-code`** (~0.7 MB) — see
`bun check --aot --explain=trim` on Bun builds that support it ([compiler/size](https://bun.com/docs/compiler/size)).

## Sandbox boundary

`lib/quickjs_code_mode.ts` runs cells in a QuickJS WASM realm whose only host capability is a
`tools` bridge. Cells may `await` (host promises are settled by pumping the guest job queue, with a
host deadline for promises that never settle). Every cell gets a fresh runtime with a wall-clock
timeout (5 s), a tool-call budget (100, per cell), a 64 MiB heap cap and a 1 MiB stack cap.
Arguments are packed to a bounded JSON string **in the guest** (1,000,000 characters) and only the
bounded text is parsed on the host, so a huge, cyclic or deeply nested guest object cannot exhaust
host memory through `ctx.dump`. The probe asserts `Bun`, `process`, `require` and `module` are not
reachable, that cells cannot see each other's globals, and that guest mutation of a tool result
cannot reach the host snapshot.
Stack overflow, heap exhaustion, runaway tool loops and awaited rejections are all pinned to guest
failures rather than host crashes. The broad MCP toolset runs through `createSportsdeskCodeModeHostRunner()` (`lib/code_mode_host.ts`).
Profile snapshot tools are **not** on that runner. Production uses the guest bridge (`code-mode:profile`
or `executeProfileCodeMode`). The **factory** `createProfileQueryHostRunner()` is env-gated
(`SPORTSDESK_PROFILE_CODE_MODE_HOST=1`); `registerProfileCodeModeHostTools()` is ungated so tests can
wire a bare runner via `tests/helpers/attachProfileHostTools.ts` (importable only from `*.test.ts`);
CI AST allowlist blocks new import sites (`bun run check:profile-code-mode-host-allowlist`, self-tested in
`scripts/ci/`).

**Control ordering:** the **env gate on `createProfileQueryHostRunner()` is primary**. The import allowlist is
**secondary** — legibility and accident prevention, not a security boundary. Computed `import(specifier)` cannot
be ruled out statically; re-exporting the factory from an allowed file is permitted and remains env-gated at
call time. The **ungated registrar** is why the allowlist also constrains who may import `attachProfileHostTools`.

**Interim seal vs. end state:** the AST allowlist (`check:profile-code-mode-host-seal`) is the cheap guard
**now** — not the destination. Capability-token sealing (only the gated factory holds the token; the
registrar requires it) is the intended end state. Expect to retire the allowlist when that refactor lands;
having a seal does not mean the host path is “done.”

**CI allowlist vs. package `exports`:** the allowlist governs _internal_ repo imports; a future `exports` map
governs _external_ consumers. Neither replaces the other — do not drop one when the other lands.

| Bypass option              | Outcome                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Env-gate the registrar     | Superseded by import allowlist (below) — tests use `attachProfileHostTools` instead. |
| Type-seal `CodeModeRunner` | Declined — desk/MCP legitimately constructs runners everywhere.                      |
| AST import allowlist (now) | Enforced in CI; registrar helper is the sole widen point for tests.                  |

### CLI vs library defaults

| Entry                          | Default realm | Why                                                                |
| ------------------------------ | ------------- | ------------------------------------------------------------------ |
| `bun run code-mode`            | `host`        | Operator orchestration over the desk MCP spine (superset tooling). |
| `bun run code-mode:profile`    | `guest`       | Hardened profile cells (matches production).                       |
| `executeProfileCodeMode(code)` | `guest`       | Same as production path; realm arg optional.                       |

`code-mode:profile` may pass `--realm profile-host` (gated) or `--realm host` (desk spine); defaults pick
the usual path, not a hard exclusion.

`qs` / `minimatch` overrides (audit gate): retire when MCP/Stryker bump — https://github.com/bw496915-cmyk/Sports-desk-ops/issues/228

Deprecated aliases (remove after **2026-06-01**, target **v0.2.0**): `createSportsdeskCodeModeRunner`,
`registerProfileQueryCodeModeTools`. Prefer `createSportsdeskCodeModeHostRunner` and
`registerProfileCodeModeHostTools`. Tracked: https://github.com/bw496915-cmyk/Sports-desk-ops/issues/227

the allowlist failure is the backstop, the issue is the reminder.

### CI

| Job              | Trigger                              | Blocks merge?                                                                                                  |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `verify-changed` | Every PR                             | **Yes** (branch protection) — `check:profile-code-mode-host-seal` immediately after `bun install`              |
| `code-mode`      | PR, `main` push, `workflow_dispatch` | No (team norm / latency; reversible) — `ci:code-mode` reuses the same seal script, then mutation + guest probe |

`attachProfileHostTools` may only be imported from `*.test.ts`; a non-`*.test.ts` helper under `tests/helpers/` must widen the allowlist deliberately.

When a public package `exports` map lands, stable entrypoints should be guest/profile API only
(`code_mode_profile`, `quickjs_code_mode`); desk and profile-host factories stay deep imports. That map
complements the internal import allowlist — it does not replace it.
