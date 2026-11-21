# Bun docs & `bun-types` (upstream canonical index)

Canonical commit links for the pinned runtime (`Bun 1.4.4`, `a7733435cf40429e3b35c36072769df2052b80f1`) and its TypeScript declarations. Do not hand-maintain symbol counts or API prose here — derive them from the binary and `bun-types` with `./bin/dx bun --types`, `bun run probe:bun`, and `bun scripts/bun_shape_contracts.ts --check`.

## Runtime & `bun-types` SSOT

| Surface           | Canonical pin                                                                                                                                     | Local verification                                                                 |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------- |
| Release tag       | [`bun-v1.4.4`](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (`2026-10-22`)                                                             | `package.json` `engines.bun` / `.bun-version`                                      |
| Release commit    | [`a7733435cf40429e3b35c36072769df2052b80f1`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/package.json)           | `Bun.revision` (`bun run probe:bun` vs `tests/bun_baseline.json`)                  |
| `bun-types` root  | [`packages/bun-types` @ `38afee6c84`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/index.d.ts) | `@types/bun@1.4.4` (`./bin/dx bun --types --strict`)                               |
| Shape catalog     | [`docs/runbooks/bun_shape_contracts_runbook.md`](./runbooks/bun_shape_contracts_runbook.md)                                                       | `bun scripts/bun_shape_contracts.ts --check` (`tests/bun_shapes_coverage.test.ts`) |
| Docs MCP baseline | `bun.sh/docs/mcp` (scheme-less; transport endpoint, not a `bun-types` blob)                                                                       | `bun run bun:docs-mcp surfaces --check tests/bun_docs_surface_baseline.json`       |

## Canonical `bun-types` files (`a7733435cf40429e3b35c36072769df2052b80f1`)

| Declaration file     | Canonical upstream link                                                                                                                                       | Scope                                                                                                                                                                          |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.d.ts`         | [`packages/bun-types/index.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/index.d.ts)                 | Entry reference order                                                                                                                                                          |
| `bun.d.ts`           | [`packages/bun-types/bun.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/bun.d.ts)                     | `Bun.*` namespace, `serve`, `spawn`, `file`, `write`, `build`, `TOML`, `YAML`, `JSONL`, `JSON5`, `JSONC`, `XML`, `markdown`, `cron`, `secrets`, `Image`, `WebView`, `Terminal` |
| `globals.d.ts`       | [`packages/bun-types/globals.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/globals.d.ts)             | Global constructors (`WebSocket`, `Worker`, `Blob`, `Request`, `Response`, `ImportMeta`)                                                                                       |
| `extensions.d.ts`    | [`packages/bun-types/extensions.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/extensions.d.ts)       | Module loader wildcards (`*.toml`, `*.yaml`, `*.yml`, `*.jsonc`, `*.json5`, `*.xml`, `*/bun.lock`, `*.html`, `*.txt`)                                                          |
| `overrides.d.ts`     | [`packages/bun-types/overrides.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/overrides.d.ts)         | `ReadableStream` / `Blob` consumer methods, `NodeJS.Process` (`memoryPressure`), `node:fs/promises` `exists`, `node:tls`                                                       |
| `s3.d.ts`            | [`packages/bun-types/s3.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/s3.d.ts)                       | `Bun.S3Client`, `Bun.s3`, `S3File`, `S3Options`, `S3Stats`                                                                                                                     |
| `sqlite.d.ts`        | [`packages/bun-types/sqlite.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/sqlite.d.ts)               | `bun:sqlite` (`Database`, `Statement`, `Changes`)                                                                                                                              |
| `sql.d.ts`           | [`packages/bun-types/sql.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/sql.d.ts)                     | `Bun.SQL`, `Bun.sql` tagged template                                                                                                                                           |
| `redis.d.ts`         | [`packages/bun-types/redis.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/redis.d.ts)                 | `Bun.RedisClient`, `Bun.redis`                                                                                                                                                 |
| `shell.d.ts`         | [`packages/bun-types/shell.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/shell.d.ts)                 | `Bun.$`, `ShellPromise`, `ShellOutput`, `ShellError`                                                                                                                           |
| `test.d.ts`          | [`packages/bun-types/test.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/test.d.ts)                   | `bun:test` (`describe`, `test`, `expect`, `expectTypeOf`, `mock`, `spyOn`, `onTestFinished`, `setSystemTime`)                                                                  |
| `ffi.d.ts`           | [`packages/bun-types/ffi.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/ffi.d.ts)                     | `bun:ffi` (`dlopen`, `ptr`, `CString`, `FFIType`)                                                                                                                              |
| `jsc.d.ts`           | [`packages/bun-types/jsc.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/jsc.d.ts)                     | `bun:jsc` heap/GC diagnostics                                                                                                                                                  |
| `security.d.ts`      | [`packages/bun-types/security.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/security.d.ts)           | `Bun.Security` scanner hooks                                                                                                                                                   |
| `html-rewriter.d.ts` | [`packages/bun-types/html-rewriter.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/html-rewriter.d.ts) | `HTMLRewriter`                                                                                                                                                                 |

### Declaration vs runtime drift (`./bin/dx bun --types`)

Do not hardcode member counts; run `./bin/dx bun --types` (or `./bin/dx bun --json`) to diff `bun-types@1.4.4` against the active binary. The two pinned drift IDs asserted in [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts) are:

- **`dns-resolve`**: `bun-types` and [`dns` namespace](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/bun.d.ts#L2503) declare only `lookup`, `prefetch`, and `getCacheStats`, while the 1.4.4 binary also exposes the 15 `node:dns/promises` resolver methods (`resolve`, `resolve4`, `resolve6`, `resolveSrv`, `resolveTxt`, `resolveSoa`, `resolveNaptr`, `resolveMx`, `resolveCaa`, `resolveNs`, `resolvePtr`, `resolveCname`, `resolveAny`, `getServers`, `setServers`, `reverse`, `lookupService`).
- **`websocket-global`**: [`WebSocket`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/bun.d.ts#L5178) and [`Worker`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/bun.d.ts#L714) are filed under the `bun` module page, but `Bun.WebSocket` and `Bun.Worker` are `undefined` at runtime — the constructors live on `globalThis`.

## `Bun.XML`, `bun x` and package catalogs (measured 2026-11-18)

Three Bun 1.4.4 surfaces that a `Bun.*` shape row cannot express on its own. Local claims were
read from the pinned tree; the release-note claims are external and dated, not re-measured here.
Each subsection below carries a `<!-- bun-behavior: <id> -->` marker, its contract test carries a
`// @bun-behavior: <id>` tag, and `lib/bun_release_behaviors.ts` derives the registry from both —
so this list is not maintained by hand.

<!-- bun-behavior: xml-parse -->

### `Bun.XML` — parse only; validate the tree yourself

| Surface               | Where                                          | What it does                                                                                                     |
| :-------------------- | :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `Bun.XML.parse`       | `src/lib/xml_ingest_preflight.ts`              | HTML-on-200 rejection and entity-bomb classification, then the compact tree                                      |
| `XML.stringify`       | `packages/sportsdesk-ops/src/bin/xml-parse.ts` | Serializes the hydrated SoA feed into the canonical `chunks/<sha256>.bin` XML                                    |
| `POST /api/parse-xml` | `services/sportsdesk_webview_server.ts`        | Parses one body with `Bun.XML.parse`; the daemon's 1 MiB `maxRequestBodySize` bounds it, and OpenAPI declares it |

- `Bun.XML` is a parser, not a schema validator. The feed root and its event collection are
  resolved by **local name**, so `<feed>` and `<m:feed>` hydrate the same rows; a document
  with no feed root fails closed with `ERR_XML_FEED_ROOT_MISSING` instead of reading as a
  healthy zero-row feed. Rows are hydrated into typed SoA columns (`eventId32` /
  `packedComboKey15` / `lineHundredthsI32`), the whole frame is capacity-checked before the
  first row is written, and the written count is asserted against the returned count
  (`ERR_DOD_CSR_CONSERVATION_BREACH`).
- A zero-row frame is refused with `ERR_XML_FEED_EMPTY` and writes no chunk, generation or
  manifest; `--allow-empty` opts into publishing a deliberate empty generation. The manifest
  body and the `--json` summary both carry `row_count`.
- The HTML-login-page guard runs **before** parsing and reports a 200 HTML body as
  `ERR_GSLIVE_SESSION_EXPIRED`. Entity-shaped parse failures map to `ERR_XML_ENTITY_BOMB`;
  every other `SyntaxError` maps to `ERR_XML_PARSE_FAILED`, so a truncated tag is not
  misreported as an entity bomb and no raw `SyntaxError` leaks through.
- Docs coverage: `tests/bun_docs_surface_baseline.json` marks `XML` documented — the docs
  page is `bun.com/docs/runtime/xml`, pinned upstream at
  [`docs/runtime/xml.mdx`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/runtime/xml.mdx)
  — and the generated row is `#### Bun.XML` in the
  [shape catalog](./runbooks/bun_shape_contracts_runbook.md).
- Evidence: `bun test tests/xml_feed_spine_hydrator.test.ts tests/xml_parse_sportsdesk_ops_cli.test.ts`.

<!-- bun-behavior: bun-x-catalog -->

### `bun x` — the bin catalogue

`bun x <bin>` resolves workspace bins declared in `packages/sportsdesk-ops/package.json`;
`./bin/dx scripts --bins` renders the full `bun x` ↔ `bun run` ↔ target catalog, and
`cli/README.md` carries the operator-facing table.

| `bun x`                    | `bun run`           | Target                                         |
| :------------------------- | :------------------ | :--------------------------------------------- |
| `bun x xml-parse`          | `bun run xml:parse` | `packages/sportsdesk-ops/src/bin/xml-parse.ts` |
| `bun x sportsdesk-catalog` | `bun run catalog`   | `cli/sportsdesk_catalog_cli.ts`                |

- `bun run cli:bins:verify` checks the declaration/target pairs; a declared bin without its
  shim target fails the gate. It derives its bin list from the root `package.json` map — there is
  no hand-kept list to update.
- `cli/README.md`'s table is generated from the same map: `bun run cli:readme` writes the
  marker-delimited block and `bun run cli:readme:check` (also
  `tests/bun_x_catalog_docs.test.ts`) fails on drift. Descriptions come from each target's
  header comment, so a new bin documents itself.
- Every bin in the catalog answers `-h` / `--help` with exit 0. `tests/bun_x_cli_help.test.ts`
  spawns all of them, so a bin that treats `--help` as an input filename fails the gate
  (`xml-parse` and `blob-formdata` were fixed on 2026-11-18).
- Bun 1.4.4 `bunx` additions (release-note, external): `--cwd`, `--env-file`,
  `--minimum-release-age`, `--trust`. Do not assume them on an older pin.

<!-- bun-behavior: package-catalogs -->

### Package catalogs — `catalog:` ranges

- Measured: the root `package.json` `catalog` map pins `@types/bun`, `@types/react`,
  `@types/react-dom`, `react`, `react-dom` and `typescript`. `packages/api`,
  `packages/backend`, `packages/contracts`, `packages/sportsdesk-ops` and `packages/ui`
  reference them as `"catalog:"`. The tree contains no `.yarnrc.yml` and no `yarn.lock`.
- The pinned [bun-v1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) notes
  (`bun.com/blog/bun-v1.4.4`, _bun install_ section) state that during Yarn Berry lockfile
  migration, `catalog:` ranges are read from `.yarnrc.yml` and the catalogs are copied into
  `package.json`. That migration path is inactive here — the root `catalog` map is the SSOT, and
  a `catalog:` reference without an entry is an install failure.
- Gates: `tests/pm_policy_workspaces.test.ts` (missing and named catalog entries),
  `bun run test:pm-contracts`, `bun run pm:doctor`, `bun run check:pm-state`.

<!-- bun-behavior: install-flags -->

## `bun install` flag compatibility (measured 2026-11-18)

The pinned [bun-v1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) _bun install_
notes describe three classes: Bun translates npm/Yarn/pnpm flags when it has an equivalent, ignores a
foreign flag together with its value when it has none, and exits non-zero for a flag none of those
tools supports. The last class is the CI hazard — before 1.4.4, `bun install --frozen-lockfil` ran a
plain mutable install instead of failing.

| Origin            | Flag                                                                                 | Bun behavior                                                |
| :---------------- | :----------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| npm               | `--package-lock-only`                                                                | `--lockfile-only`                                           |
| npm / Yarn / pnpm | `--immutable`                                                                        | `--frozen-lockfile`                                         |
| npm               | `--save-dev` / `--save-exact` / `--save-optional` / `--save-peer` / `--save-catalog` | `--dev` / `--exact` / `--optional` / `--peer` / `--catalog` |
| npm               | `--no-optional` / `--ignore-optional`                                                | `--omit=optional`                                           |
| npm               | `--only=production`                                                                  | `--omit=dev`                                                |
| npm               | `--location=global`                                                                  | `--global`                                                  |
| pnpm              | `--shamefully-hoist` / `--node-linker=hoisted` / `--install-strategy=hoisted`        | `--linker=hoisted`                                          |
| pnpm              | `--node-linker=isolated` / `--install-strategy=linked`                               | `--linker=isolated`                                         |
| npm               | `--no-package-lock`, `--network-timeout <ms>`                                        | ignored together with the value                             |
| none              | e.g. `--frozen-lockfil`                                                              | exit 1, `bun install has no --frozen-lockfil flag.`         |

- Measured on the pinned runtime: an empty fixture exits 1 with
  `bun install has no --frozen-lockfil flag.` and writes nothing.
- This repo's CI invokes only native flags: `.github/workflows/*.yml` runs
  `bun install --frozen-lockfile --no-env-file`, and `check:pm-state` runs
  `bun install --frozen-lockfile` then `bun prune --check`. `tests/bun_upstream_reference.test.ts`
  re-derives the native flag set from `bun install --help` and fails if a workflow adds a flag
  outside it.
- `scripts/bun-1.4.4-probe.sh` (P8) deliberately exercises the rejection and asserts the error
  text; do not "fix" that invocation.
- Evidence: `tests/bun_pm_behaviors.test.ts` covers unknown-flag rejection, `--immutable` against
  a dirty lockfile, the ignored `--network-timeout` value, `--env-file`, and the `--save-dev`
  dependency-group move.

<!-- bun-behavior: semver-wildcards -->

## `Bun.semver.satisfies` — wildcards and the 2^64 ceiling (measured 2026-11-18)

Pinned docs: [`docs/runtime/semver.mdx`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/runtime/semver.mdx).
The API exposes two functions — `satisfies(version, range)` and `order(a, b)` — and `satisfies`
takes no options object: a third argument is ignored, so node-semver's
`{ includePrerelease: true }` has no effect. Use the npm `semver` dependency where that option
matters (`tests/market_index.test.ts` does).

| Case                                                               | Result  | Rule                                                                                 |
| :----------------------------------------------------------------- | :------ | :----------------------------------------------------------------------------------- |
| `satisfies("1.0.0", "1.0.x")`, `"1.x.x"`, `"x.x.x"`, `"*"`         | `true`  | wildcards fill the missing parts                                                     |
| `satisfies("1.0.0", "")`, `"not-a-range"`                          | `true`  | a range with no parseable part behaves like `*`                                      |
| `satisfies("1.0.0", "1.x.18446744073709551616")`                   | `true`  | a numeric part after a wildcard is not compared                                      |
| `satisfies("1.0.0", "18446744073709551616.x")`                     | `false` | a major/minor/patch above 2^64-1 **before** a wildcard makes the range unsatisfiable |
| `satisfies("1.0.0", "18446744073709551616")`                       | `false` | the same ceiling applies to a bare number                                            |
| `satisfies("1.0.0", "1.0.0-é")`                                    | `false` | non-ASCII input returns false                                                        |
| `satisfies("1.0.0-beta.1", "^1.0.0")`                              | `false` | a prerelease needs a prerelease in the range                                         |
| `satisfies("1.0.0-beta.1", "^1.0.0-beta.0")`                       | `true`  |                                                                                      |
| `satisfies("1.0.0-beta.1", "^1.0.0", { includePrerelease: true })` | `false` | the options object is inert                                                          |

- Repo use: `scripts/nsh_desk_cli.ts` gates the NSH runtime with
  `Bun.semver.satisfies(version.semver, ">=0.5.0")`, and the pinned probe is `data.semver` in
  `scripts/probe_bun.ts`.
- `tests/bun_semver_wildcards.test.ts` re-measures this table on every run, so a Bun bump that
  changes any row fails instead of drifting the prose.

<!-- bun-behavior: bun-fmt -->

## `bun fmt` — check/edit contract (measured 2026-11-18)

The pinned [bun-v1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) adds
`bun fmt`, a Prettier/oxfmt-compatible formatter. Measured on the pinned runtime in an otherwise
empty directory:

| Command                               | Result                                       |
| :------------------------------------ | :------------------------------------------- |
| `bun fmt --check a.ts` on `const x=1` | exit 1; lists the file as needing formatting |
| `bun fmt a.ts`                        | exit 0; rewrites it to `const x = 1;`        |
| `bun fmt --check a.ts` afterwards     | exit 0                                       |

- The repo drives this through `bun fmt` (write path), `bun fmt --check --changed` in
  `verify:fast`, and the CI `format:check` step.
- `bun fmt` is not `bun lint`: linting stays oxlint (`bun run lint:check`), because bare
  `bun lint` still resolves to the package `lint` script that rewrites files.
- Docs: the docs MCP search for `bun fmt check` returns `/guides/format/migrate-from-oxfmt`;
  `docs/cli/fmt.mdx` does not exist at the audited commit (checked 2026-11-18), so there is no
  pinned blob to cite for the command page yet.
- `tests/bun_fmt_contract.test.ts` re-measures the three rows above.

<!-- bun-behavior: publish-recursive -->

## `bun publish --recursive` (measured 2026-11-18)

The pinned [bun-v1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) adds
workspace publishing. Measured against a local mock registry (`tests/bun_publish_recursive.test.ts`,
no network, fake bearer token):

| Claim                                           | Measured                                                    |
| :---------------------------------------------- | :---------------------------------------------------------- |
| `--recursive` publishes workspace packages      | public packages uploaded; `private: true` skipped           |
| `--filter <pattern>` narrows the set            | only matching package names uploaded                        |
| Versions already on the registry are skipped    | a second run exits 0 and uploads nothing                    |
| Every package is packed before the first upload | both `prepack` markers existed when the first `PUT` arrived |

- Re-running after a failure is safe for the same reason: already-published versions are skipped,
  while the remaining ones are retried.
- In this repo the only publishable workspace is `@sportsdesk-ops/contracts` (`private` unset,
  `publishConfig.access=public`); the other seven manifests are private and are skipped by
  `--recursive`. Publishing needs registry auth — without an `.npmrc`/`NPM_TOKEN` the command exits
  1 with `missing authentication`.
- The mock registry test is the evidence: it starts `Bun.serve`, spawns the real CLI asynchronously,
  and records the `PUT` order, so the pack-before-publish claim is checked rather than assumed.

<!-- bun-behavior: link-paths -->

## `link:` paths (measured 2026-11-18)

The pinned [bun-v1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) makes
`link:` accept a path. Measured in a fixture whose `package.json` declares
`"linked": "link:./vendor/linked"`: `bun install` creates
`node_modules/linked -> ../vendor/linked` (a real symlink; `bun link` is not required first).
The path is relative to the `package.json` that declares it. `tests/bun_link_paths.test.ts`
re-measures the symlink target.

<!-- bun-behavior: bunx-cwd-env-file -->

## `bunx --cwd` and `--env-file` (measured 2026-11-18)

The same release adds the package-manager `--env-file` and `bunx` flags. Measured with a local
`node_modules/.bin/probe-cli` shim, invoked from a different working directory:

```
bunx --cwd <fixture> --env-file <fixture>/ci.env probe-cli
→ {"cwd":"<fixture>","token":"abc123"}
```

So both flags reach the executed tool (`process.cwd()` and the loaded variable), not just the
installer. `tests/bunx_flags.test.ts` re-measures it without the network.

<!-- bun-behavior: deprecated-packages -->

## Deprecated packages (measured 2026-11-18)

Measured against a mock registry that serves a deprecated `1.0.0` and a clean `1.0.1`:

| Invocation                                | Result                                                                     |
| :---------------------------------------- | :------------------------------------------------------------------------- |
| `bun add dep-probe@1.0.0`                 | warns once: `warn: deprecated dep-probe@1.0.0: use 1.0.1`; records `1.0.0` |
| `bun add dep-probe` (deprecated `latest`) | resolves `^1.0.1` — the deprecated latest is skipped                       |

The release notes also say `--verbose` lists transitive deprecations and that versions already in
`bun.lock` do not change until `bun update`; those two are not re-measured here.
`tests/bun_deprecated_add.test.ts` owns the measured rows.

<!-- bun-behavior: package-extensions -->

## `packageExtensions` (measured 2026-11-18)

The repo's existing contract test resolves an undeclared import under `--linker=isolated` by
declaring it in the root `packageExtensions` block (`tests/bun_pm_behaviors.test.ts`,
"packageExtensions resolves an undeclared import under isolated installs"). The block uses the
pnpm/Yarn format; the release notes add that Bun copies it across when migrating a
`pnpm-lock.yaml` or `yarn.lock` (not re-measured here).

<!-- bun-behavior: minimum-release-age -->

## `minimumReleaseAge` units and exclusions (measured 2026-11-18)

`tests/bun_pm_behaviors.test.ts` accepts the unit forms and the exclusions flag on the pinned
runtime (`--minimum-release-age`, `--minimum-release-age-excludes`), including a plain number
interpreted as seconds. The per-version exclusion (`typescript@5.9.3`) and the "security fix
today, rest of the package waits" semantics are release-note statements, not re-measured here.

<!-- bun-behavior: install-resolution-and-lockb -->

## `bun install` version-selection edge cases and mutated `bun.lockb` resilience (measured 2026-11-19)

- **Release-note statements (external, not re-run at upstream scale here):** the
  [`bun-v1.4.4` release notes (`#133-bun-install-issues-closed`)](https://bun.com/blog/release-notes/bun-v1.4.4#133-bun-install-issues-closed)
  and [`bun-v1.4.4` release tag](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) report
  133 `bun install` issues closed, equivalence testing across 600 generated projects (all
  dependency types, both linkers, both lockfile formats), 7 commands across 90,000 mutated
  `bun.lockb` files without a crash or hang, and 200,000 generated `npm-pick-manifest`
  version-selection comparisons differing in two cases: a `latest` tag pointing to a missing
  version, and `^1.0.0-a.0`.
- **Measured locally** (`tests/bun_install_resolution_resilience.test.ts`, measured 2026-11-19
  against an in-process `Bun.serve` mock registry and mutated binary `bun.lockb` fixtures):

| Surface / Case                                                                         | Input / Packument                                                                                                         | Measured Result                                                                                                                   |
| :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- |
| Missing `latest` dist-tag target (`latest`, `*`, `^1.0.0`)                             | `dist-tags.latest = "9.9.9"`, `versions = ["1.0.0", "1.0.1"]`                                                             | Exit `0`, resolves fallback highest version `"1.0.1"`                                                                             |
| `^1.0.0` vs `dist-tags.latest` (control)                                               | `dist-tags.latest = "1.0.0"`, `versions = ["1.0.0-a.0", "1.0.0", "1.0.1"]`                                                | Exit `0`, installs `"1.0.0"` (`dist-tags.latest` honored)                                                                         |
| `^1.0.0-a.0` with stable `latest`                                                      | `dist-tags.latest = "1.0.0"`, `versions = ["1.0.0-a.0", "1.0.0", "1.0.1"]`                                                | Exit `0`, skips `latest = "1.0.0"` and installs `"1.0.1"`                                                                         |
| `^1.0.0-a.0` on prerelease-only packument                                              | `dist-tags.latest = "1.0.0-a.1"`, `versions = ["1.0.0-a.0", "1.0.0-a.1", "1.0.0-b.0"]`                                    | Exit `0`, skips `latest = "1.0.0-a.1"` and installs `"1.0.0-b.0"`                                                                 |
| `^1.0.0-a.0` with exact lower-bound `latest`                                           | `dist-tags.latest = "1.0.0-a.0"`, `versions = ["1.0.0-a.0", "1.0.0-a.1", "1.0.0", "1.0.1"]`                               | Exit `0`, installs `"1.0.0-a.0"`                                                                                                  |
| `^1.0.0-a.0` tuple-bound exclusion                                                     | `dist-tags.latest = "2.0.0"`, `versions = ["1.0.1-a.0", "2.0.0"]`                                                         | Exit `1`, `No version matching "^1.0.0-a.0"`                                                                                      |
| Synthetic & real mutated `bun.lockb` (`install --frozen-lockfile`, `pm ls`, `pm hash`) | Empty, truncated magic, garbage, zeroed 4 KiB, half-truncated, header byte-40 XOR, plus 12 deterministic slices/bit-flips | Zero crash signals (`signalCode === null`) and bounded clean exits (`InvalidLockfile`, `EndOfStream`, `Lockfile is missing data`) |

<!-- bun-behavior: serve-static-vs-file-routes -->

## `Bun.serve` static buffered (`.bytes()`) vs file-backed (`Bun.file()`) routes (measured 2026-11-19)

`tests/bun_serve_static_vs_file_routes.test.ts` measures the differences between passing a
startup-buffered `new Response(await Bun.file(p).bytes())` vs a lazy `new Response(Bun.file(p))`
in `Bun.serve({ routes })`:

| Behavior                 | Static buffered (`new Response(await Bun.file(p).bytes())`)          | File-backed (`new Response(Bun.file(p))`)                                                                                     |
| :----------------------- | :------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type`           | Omitted (`null`) unless explicitly passed in `Response` headers      | Inferred from extension (e.g. `application/zip` for `.zip`)                                                                   |
| `ETag` & `If-None-Match` | Strong quoted `ETag`; matching `If-None-Match` returns `304`         | No `ETag` (`null`)                                                                                                            |
| `Range` requests         | Ignored (`200` full payload, no `Accept-Ranges` / `Content-Range`)   | `206` with `Accept-Ranges: bytes` + `Content-Range`; `416` (`bytes */len`) when out of range                                  |
| `HEAD` & `POST`          | `200` (`HEAD` empty body with `Content-Length`; `POST` returns body) | `200` (`HEAD` empty body with `Content-Length`; `POST` returns body)                                                          |
| Live disk edit           | Serves original startup-buffered bytes and unchanged `ETag`          | Serves updated bytes, updated `Content-Length`, and updated `Range` slices                                                    |
| File deletion (`unlink`) | Continues serving `200` from memory                                  | Falls through to `fetch()` if configured (returning `fetch()`'s response), or returns `404` when no `fetch()` fallback exists |

- For `/static/*` directories needing strong `ETag`, `Range`, and symlink containment, this repo uses
  `lib/serve_file.ts` (see [`docs/runbooks/bun_server_runtime_shapes_runbook.md`](./runbooks/bun_server_runtime_shapes_runbook.md)).

<!-- bun-behavior: serve-directory-routes -->

## `Bun.serve` directory routes (`{ dir, statCache }`) (measured 2026-11-19)

Reference: [`bun.sh/docs/runtime/http/routing#directory-routes`](https://bun.sh/docs/runtime/http/routing#directory-routes).
`tests/bun_serve_directory_routes.test.ts` measures `{ dir }` and `{ dir, statCache: false }` on
the active runtime (`darwin` and `linux` branches):

| Surface / Case                                         | Input / Probe                                                                                                                                         | Measured Behavior                                                                                                                                                                                                                                                                                          |
| :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount path constraint                                  | `routes: { "/static": { dir } }`                                                                                                                      | Throws `TypeError`: `To mount a directory, make sure the path ends in \`/*\``                                                                                                                                                                                                                              |
| Decoded path, MIME, `ETag` & `Last-Modified`           | `GET /static/hello.txt`, `GET /static/my%20file.txt`                                                                                                  | `200`, extension `Content-Type`, weak `ETag` (`W/"<size>-<mtime>"`), `Last-Modified`, `Accept-Ranges: bytes`                                                                                                                                                                                               |
| Non-canonical wire paths                               | `/static/./hello.txt`, `/static/../outside.txt`, `/static//hello.txt`, `/static/sub%2Findex.html`, `/static/%68ello.txt`                              | Rejected with `404` on raw wire requests                                                                                                                                                                                                                                                                   |
| Directory without/with `/` & missing files             | `GET /static/sub`, `GET /static/sub/`, `GET /static/missing.txt`                                                                                      | `301` (`Location: /static/sub/`), `200` (`sub/index.html`), and `404`                                                                                                                                                                                                                                      |
| Conditional GET (`304`)                                | `If-None-Match: <weak ETag>` or `If-Modified-Since: <Last-Modified>`                                                                                  | `304 Not Modified` with empty body                                                                                                                                                                                                                                                                         |
| `Range` & `If-Range`                                   | `Range: bytes=0-4`, `bytes=999-1000`, `If-Range` (`Last-Modified` vs stale date vs weak `ETag`)                                                       | `206` (`bytes 0-4/21`), `416` (`bytes */21`); `If-Range` matches `Last-Modified` (`206`) and falls back to full `200` on stale dates or weak `ETag`                                                                                                                                                        |
| `statCache: false`                                     | `routes: { "/nocache/*": { dir, statCache: false } }` + disk edit                                                                                     | Serves `200` and reflects live edits with updated weak `ETag`                                                                                                                                                                                                                                              |
| Case-sensitive routing vs FS                           | `/static/admin/*` (`403`) + `/static/*` (`{ dir }`), requesting `/static/Admin/secret.txt`                                                            | Route match is case-sensitive (`Admin` misses `/static/admin/*`), returning `200` on case-insensitive APFS (`darwin`) or `404` on case-sensitive FS                                                                                                                                                        |
| Symlink containment (`RESOLVE_IN_ROOT` drift on macOS) | `rel-escape.txt -> ../outside.txt`, `abs-escape.txt -> <outsidePath>`, `rel-clamp.txt -> ../../../inside.txt`, `abs-inroot.txt -> /var/data/logo.txt` | **Measured macOS drift:** contrary to the docs' macOS `RESOLVE_IN_ROOT` claim, `darwin` follows escaping symlinks (`200` `"SECRET-OUTSIDE"`) and returns `404` on in-root-clamped targets; `lib/asset_path.ts` (`containedAssetPath`) + `lib/serve_file.ts` enforce `realpath` containment for `/static/*` |

<!-- bun-behavior: websocket-client-options -->

## `WebSocket` client options (`Bun.WebSocketOptions`) (measured 2026-11-19)

Reference: [`bun.sh/reference/bun/WebSocketOptions`](https://bun.sh/reference/bun/WebSocketOptions).
`tests/bun_websocket_options.test.ts` measures the second-argument options object against local
`ws://`/`wss://` echo servers and HTTP/HTTPS `CONNECT` tunnel proxies (targeting
`ws-target.local` via local proxies so host `NO_PROXY="localhost,127.0.0.1,::1"` does not bypass
explicit proxy tests):

| Option / Surface                                              | Probe / Input                                                                                                                                          | Measured Behavior                                                                                                                                                                                                                           |
| :------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocols` / `protocol`                                      | `new URL(wsUrl)` + `{ protocols: ["p1", "p2"] }`, `{ protocols: "single-p" }`, `{ protocol: "solo-p" }`, `{ protocols: ["arr-p"], protocol: "str-p" }` | Sends `Sec-WebSocket-Protocol` and populates `ws.protocol`; when both are supplied at runtime, `protocols` wins (`"arr-p"`)                                                                                                                 |
| `headers`                                                     | Plain object (`OutgoingHttpHeaders` incl. string arrays), `Headers` instance, and `[string, string][]` tuple list                                      | All three forward on the upgrade request (`X-Arr` joins with `,`, duplicate tuple names join with `, `)                                                                                                                                     |
| `perMessageDeflate`                                           | Omitted, `{}`, `true` vs falsy `false`, `null`, `0`, `""`, and explicit `undefined`                                                                    | Default/`{}`/`true` send `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits`; all five falsy values omit `Sec-WebSocket-Extensions` entirely                                                                             |
| `tls` (`ca`, `rejectUnauthorized`, `servername`/`serverName`) | `Bun.file()`, `Buffer`, PEM string, `rejectUnauthorized: false`, and SAN-mismatched cert with `servername` / `serverName`                              | Rejects untrusted cert (`unable to verify the first certificate`) and SAN mismatch (`does not match certificate's altnames`); both `servername` and `serverName` pass SNI verification                                                      |
| `tls.checkServerIdentity`                                     | Sync `undefined`, `new Error(...)`, `async () => undefined`, and `rejectUnauthorized: false` + valid `ca`                                              | Receives `(hostname, leafCert)` with `subject`/`subjectaltname` and **no** `issuerCertificate`; async Promise return is truthy and rejects; with `rejectUnauthorized: false` it still runs but its error is not enforced                    |
| HTTP `proxy` (`CONNECT`)                                      | String URL, `new URL(...)`, `http://user:pass@...`, and `{ url, headers }` (`OutgoingHttpHeaders` / `Headers`) for `ws://` & `wss://`                  | Issues `CONNECT host:port HTTP/1.1` with `Proxy-Connection: Keep-Alive`; emits Basic `Proxy-Authorization` or custom `headers` to proxy only (not leaked to origin); host `NO_PROXY` overrides explicit `proxy` for matching loopback hosts |
| HTTPS `proxy.tls` isolation                                   | Separate `proxy.tls` + `tls`, omitted `proxy.tls` + shared `tls.ca` array, and `proxy.tls: {}` or `true`                                               | Separate `proxy.tls` runs proxy `checkServerIdentity` before target; omitted `proxy.tls` shares `tls.ca` across both hops while running top-level `checkServerIdentity` only for target; `{}`/`true` isolates proxy from top-level `tls.ca` |

<!-- bun-behavior: terminal-write-buffer-source -->

## `Bun.Terminal.write` & `BufferSource` (measured 2026-11-20)

References: [`bun.sh/reference/bun/BufferSource`](https://bun.sh/reference/bun/BufferSource) and [`bun.sh/reference/bun/Terminal/write`](https://bun.sh/reference/bun/Terminal/write). Covered by `tests/bun_terminal_write_buffer_source.test.ts` and `lib/bun_terminal.ts` (`terminalInputByteLength`, `requireSubprocessTerminal`):

| Input / Surface                         | Probe / Input                                                                           | Measured Behavior                                                                                                                                                          |
| :-------------------------------------- | :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strings (UTF-8 byte length)             | `""`, `"hello"`, `"€🚀"` (`.length === 3`), lone surrogate `"\uD800"` (`.length === 1`) | Returns UTF-8 byte count (`0`, `5`, `7`, and `3` for U+FFFD replacement), not UTF-16 `.length`                                                                             |
| `ArrayBufferView` & `Buffer` slices     | `Uint8Array` / `Buffer` `.subarray(offset, end)` and `DataView(ab, 2, 3)`               | Returns exact `view.byteLength` and writes only `[byteOffset, byteOffset + byteLength)` with zero adjacent sentinel leakage                                                |
| Raw `ArrayBuffer` & `SharedArrayBuffer` | `ArrayBuffer`, `SharedArrayBuffer`, `Uint8Array(sab)`, and `DataView(sab, 1, 2)`        | All four are accepted and return exact `byteLength`                                                                                                                        |
| Multi-byte `TypedArray`s                | `Uint16Array`, `Int32Array`, `Float64Array`, `BigInt64Array`                            | Return `byteLength` (not element `.length`) and transmit raw native-endian bytes                                                                                           |
| Internal buffering & `drain`            | Single 128 KiB (`131072` B) write exceeding kernel PTY ring capacity                    | Returns full `131072` immediately (no partial write), buffers internally, invokes `drain`, and delivers all 131,072 bytes with matching SHA-256 in raw mode                |
| Detached buffers                        | Transferred `ArrayBuffer` and `Uint8Array` view over detached buffer                    | Both return `0` without throwing                                                                                                                                           |
| Invalid inputs & closed terminal        | `null`/`undefined`, `42`/`{}`, and `write()` after `close()`                            | Throws `Error: write() requires data argument` (`null`/`undefined`), `Error: write() argument must be a string or ArrayBuffer` (`42`/`{}`), or `Error: Terminal is closed` |

<!-- bun-behavior: formats-and-utilities -->

## Built-in Formats & 40+ Utilities (measured 2026-11-20)

Reference: [`bun.sh/#:~:text=Formats,40+%20utilities`](https://bun.sh/#:~:text=Formats,40+%20utilities). Covered by `tests/bun_formats_and_utilities.test.ts`:

| Area / Surface                          | Probe / Input                                                                                                               | Measured Behavior                                                                                                                                                                           |
| :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Bun.YAML`                              | Multi-doc `---`, anchors (`&b` / `<<: *b`), `stringify(v)` vs `stringify(v, null, 2)`                                       | Multi-doc `parse()` returns an array; anchors/merge keys resolve; `stringify(v)` defaults to flow syntax (`{a: 1,b: [2,3]}`), while `space: 2` emits block YAML                             |
| `Bun.TOML` & native config imports      | `Bun.TOML.parse` / `stringify`; `import()` on `.yaml`, `.toml`, `.json5`, `.jsonc`                                          | `Bun.TOML` parses and serializes tables; dynamic `import()` resolves all four formats onto `.default`                                                                                       |
| `Bun.JSON5` / `Bun.JSONC` / `Bun.JSONL` | Comments, trailing commas, unquoted keys, hex `0x10`, `Infinity`, `-Infinity`, `NaN`; partial JSONL chunk                   | `JSON5` parses extended literals (`Infinity`/`-Infinity`/`NaN`/`0x10`); `JSONL.parseChunk` returns complete objects with `{ done: false, error: null }` on trailing incomplete line         |
| `Bun.markdown`                          | GFM (`tables`, `strikethrough`, `tasklists`, `autolinks`), raw `<script>` default vs `{ tagFilter: true }`, `render()`      | Raw `<script>` passes through verbatim by default unless `{ tagFilter: true }` escapes it (`&lt;script>`); `render()` invokes AST callbacks                                                 |
| `Bun.escapeHTML`, ANSI & `Bun.color`    | HTML chars, emoji width, SGR strip/slice/wrap, `rgb(...)` → `hex` / `ansi-16m`                                              | `escapeHTML` escapes 5 chars (`'` → `&#x27;`); `stringWidth` counts wide emoji as `2` ignoring ANSI; `sliceAnsi`/`wrapAnsi` close/reopen SGR across cuts                                    |
| `Bun.deepEquals` & `Bun.deepMatch`      | `{ a: 1, b: undefined }` vs `{ a: 1 }` (`strict` false/true); subset/object/array order                                     | `deepEquals` distinguishes `strict: true`; `deepMatch(subset, object)` expects `(subset, object)` (reversing returns `false`), and arrays require equal length                              |
| `Bun.peek` & `Bun.peek.status`          | Fulfilled, pending, rejected promises + primitive value                                                                     | Synchronous state (`fulfilled`/`pending`/`rejected`) and value/`Error` access without `await`; non-promises pass through unchanged                                                          |
| `Bun.randomUUIDv7` & `Bun.randomUUIDv5` | Fixed timestamp repeated `hex`/`base64url`/`buffer`; `dns`/`url`/custom UUID namespace                                      | UUIDv7 is lexicographically monotonic within the same millisecond (`buffer` = 16 bytes); UUIDv5 is deterministic per namespace                                                              |
| Zstd, Binary & Stream helpers           | `zstdCompressSync`/`zstdCompress`, `concatArrayBuffers`, `ArrayBufferSink`, `readableStreamTo*`, `readableStreamToFormData` | Zstd roundtrips losslessly; `readableStreamToFormData(stream, boundary)` expects raw boundary token (full `Content-Type` header throws `boundary is too long`), omitting parses URL-encoded |
| URL, Cookies & Timing                   | `pathToFileURL`/`fileURLToPath`, `Cookie`/`CookieMap`, `nanoseconds()`, `hash.crc32`                                        | Spaces percent-encode and roundtrip cleanly; `Cookie`/`CookieMap` parse & serialize flags; `nanoseconds()` is monotonic numeric                                                             |

<!-- bun-behavior: bun-test-api -->

## `bun:test` API surface (measured 2026-11-18)

The pinned declaration is
[`packages/bun-types/test.d.ts`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/test.d.ts);
the live reference section is `reference/bun/test`.

- Measured exports (`import * as bunTest from "bun:test"`): `afterAll`, `afterEach`, `beforeAll`,
  `beforeEach`, `default`, `describe`, `expect`, `expectTypeOf`, `it`, `jest`, `mock`,
  `onTestFinished`, `setDefaultTimeout`, `setSystemTime`, `spyOn`, `test`, `vi`, `xdescribe`,
  `xit`, `xtest`.
- `test` statics: `each`, `skipIf`, `todo`, `failing`, `serial`, `only`, `skip`, `if`.
  `describe` statics: `each`, `skipIf`, `only`, `skip`.
- `expect` statics measured: `extend`, `assertions`, `hasAssertions`, `any`, `anything`,
  `closeTo` (`expect.poll` and `expect.soft` are absent on this pin).
- The live reference lists `aroundAll` and `aroundEach`; the pinned 1.4.4 runtime does not export
  them, so they are recorded as absent rather than assumed.
- `tests/bun_test_api.test.ts` re-measures the table, including `describe.each`, `test.each`,
  `test.skipIf`, `test.failing` (an expected failure counts as passing), `test.serial`, `test.if`,
  `jest.fn`, asymmetric matchers (`any`, `anything`, `closeTo`), `spyOn`, `setSystemTime`, and
  `onTestFinished` (callbacks run after the body, in registration order).

<!-- bun-behavior: bun-test-runner -->

## `bun test` runner knobs (measured 2026-11-18)

Measured on the pin with throwaway suites (`tests/bun_test_runner_cli.test.ts`):

| Knob                          | Measured                                                                        |
| :---------------------------- | :------------------------------------------------------------------------------ |
| `--test-name-pattern`         | only matching test names run                                                    |
| `--bail=1`                    | exits after the first failure; the second failing case does not run             |
| `--retry=1`                   | retries a failed test and passes when the retry succeeds                        |
| `--rerun-each=2`              | evaluates each file twice                                                       |
| `--shard=1/2` + `--shard=2/2` | four files split disjointly; rerunning a shard yields the same set              |
| `--parallel=2 --no-isolate`   | every file runs in worker processes                                             |
| `--update-timings`            | writes `{version: 1, files: {path: ms}}`; a later run reads it with `--timings` |
| `--reporter=junit`            | writes `<testsuites>`/`<testcase>` to `--reporter-outfile`                      |
| `CLAUDECODE=1`                | hides `(pass)`/`(todo)` lines, keeps failure detail and summary counts          |

Not re-measured here: `--randomize`/`--seed`, `--concurrent`, `--max-concurrency`, `--aot`,
`--check`, and `--environment`/`--globals` (coverage and snapshot `--update-snapshots --bail=1`
safety are measured below under `bun test` coverage accuracy, LCOV `DA:` counts & snapshot
safety).

<!-- bun-behavior: bun-test-writing -->

## Writing tests: timeouts, retries and modifiers (measured 2026-11-18)

Measured with throwaway suites (`tests/bun_test_writing.test.ts`):

| Feature                                          | Measured                                                                                   |
| :----------------------------------------------- | :----------------------------------------------------------------------------------------- |
| per-test timeout (third argument)                | a 100 ms test with `10` fails: `this test timed out after 10ms`                            |
| `--timeout=10`                                   | applies to tests without their own timeout and fails the same way                          |
| `{ retry: 1 }`                                   | retries the failed test, output `(pass) flaky (attempt 2)`                                 |
| `{ repeats: 2 }`                                 | runs the test three times, output `(pass) repeat (run 3)`                                  |
| `done` callback                                  | completing it finishes the async test                                                      |
| `test.only`                                      | runs only the marked test (no `--only` flag needed on this pin)                            |
| `test.todo` + `--todo`                           | plain run reports `(todo)`; `--todo` exits 1 with `this test is marked as todo but passes` |
| `test.todoIf(true)`                              | reported as todo                                                                           |
| `test.each` object row                           | one object argument; `$a`/`$b`/`$expected` interpolate                                     |
| `expect.assertions(2)`, `expect.hasAssertions()` | enforce the assertion count                                                                |

The live writing docs also describe `test.fails`, `test.for`, `test.extend`, `test.override`,
`describe.for`, `expect.soft`, `expect.poll`, `expect.toSatisfy`, `expect.addEqualityTesters`,
`expect.getState` and `expect.setState`; the pinned 1.4.4 runtime does **not** expose them, and
the contract asserts their absence. The zombie-process killer and snapshot matchers are not
re-measured here.

<!-- bun-behavior: bun-test-config -->

## Test configuration: `bunfig.toml [test]` (measured 2026-11-18)

Measured with throwaway projects (`tests/bun_test_config.test.ts`):

| Option                                | Measured                                                                                                     |
| :------------------------------------ | :----------------------------------------------------------------------------------------------------------- |
| `root = "src"`                        | only files under `src/` are discovered                                                                       |
| `preload = ["./preload.ts"]`          | the preload runs before the test file and can set env                                                        |
| `pathIgnorePatterns = ["ignored/**"]` | matching files are pruned; the CLI `--path-ignore-patterns` **replaces** the config list rather than merging |
| `retry = 1`                           | retries a flaky test (`attempt 2`); `--retry=0` did **not** disable it on this pin                           |
| `rerunEach = 2`                       | each file is evaluated twice                                                                                 |
| `randomize = true` + `seed = 42`      | reruns produce the same file order                                                                           |
| `[test.reporter] junit = "junit.xml"` | writes the JUnit XML (the parent directory must already exist)                                               |
| `.env.test`                           | loaded automatically by `bun test`                                                                           |

Not re-measured here: `environment` (jsdom/happy-dom), `globals = "vitest"`, `reactCompiler`,
`concurrentTestGlob`, `smol`, the mock-cleanup options, and `[install]` inheritance (`coverageDir`,
`coverageReporter`, `coverageSkipTestFiles`, `lcov`, and `coverageThreshold` are measured below
under `bun test` coverage accuracy, LCOV `DA:` counts & snapshot safety).

<!-- bun-behavior: bun-test-runtime -->

## Test runtime integration (measured 2026-11-18)

Measured with throwaway suites (`tests/bun_test_runtime.test.ts`):

| Behavior                                | Measured                                                                                                                     |
| :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV` default                      | `"test"`; an explicit `NODE_ENV=development` wins                                                                            |
| `TZ` default                            | UTC (`getTimezoneOffset() === 0`); `TZ=America/New_York` wins                                                                |
| `import.meta.env`                       | passes through `process.env` (`NODE_ENV`, `MODE` when set); `DEV`, `PROD`, `SSR` and `BASE_URL` are **undefined** on the pin |
| per-test timeout `0`                    | disables `--timeout=10`; a 50 ms test passes                                                                                 |
| unhandled error/rejection between tests | exit 1 with `Unhandled error between tests`; the probe ran 0 tests, not the file's tests                                     |
| top-level throw                         | the file fails to load and reports `0 pass`                                                                                  |
| globals                                 | `test`, `describe`, `expect`, `jest`, `vi` are available without imports                                                     |
| `console.timeStamp`                     | **defined** (a function) on the pin, despite the docs saying tests omit it                                                   |
| `--define "process.env.X='v'"`          | the constant is substituted in the test file                                                                                 |

Drift: the live runtime docs describe Vite-style `import.meta.env` variables and an undefined
`console.timeStamp`; the pinned 1.4.4 runtime does neither. The unsettled top-level await guard was
not encoded: a probe with `await new Promise(() => {})` did not exit within 120 s, so there is no
bounded failure to assert. Timers, watch/hot mode, signal handling, and the `vitest` unhandled-error
listener difference are also not re-measured here.

<!-- bun-behavior: bun-test-coverage-and-snapshots -->

## `bun test` coverage accuracy, LCOV `DA:` counts & snapshot safety (measured 2026-11-19)

Reference: [`bun.com/blog/release-notes/bun-v1.4.4#bun-test`](https://bun.com/blog/release-notes/bun-v1.4.4#bun-test).
`tests/bun_test_coverage_and_snapshots.test.ts` measures the v1.4.4 fixes against throwaway
projects with `bunfig.toml` / CLI coverage options and isolated git worktrees:

| Behavior / Case                                                        | Probe / Input                                                                                        | Measured Behavior                                                                                                                           |
| :--------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `--update-snapshots --bail=1` on early failure                         | Pre-populated 2-snapshot file; 2nd test fails under `--update-snapshots --bail=1`                    | Exits non-zero while preserving the prior `.snap` contents byte-for-byte instead of truncating the file                                     |
| `--changed=HEAD` module graph scoping                                  | Isolated git repo with `a.ts` -> `a.test.ts` and `b.ts` -> `b.test.ts`; touch only `a.ts`            | Runs `a.test.ts` and skips `b.test.ts`                                                                                                      |
| Skipped short-circuit, optional, logical-assign, default & break lines | Multiline `\|\|`, `&&`, `??`, `?:`, `?.`, `\|\|=`, `&&=`, `??=`, unused default, untaken `break`     | Every skipped subexpression line stays uncovered (`65.62%` lines; `DA:<line>,0` in `lcov.info`)                                             |
| Lines after unresumed `await` / `yield`                                | Rejected `await`, never-resolving pending `await`, and single-stepped generator `yield`              | Statements after the suspension point remain uncovered (`50.00%` lines; `3-4,8-9,13-14`)                                                    |
| Uncalled function `Uncovered Line #s` bounds                           | Uncalled function after a `//` comment and immediately adjacent to a called function                 | Reports exact declaration-to-body lines (`5-8` skipping comment line 4; `4-6` with no two-line lead-in shift)                               |
| Executed block `break` & `import` above `class extends`                | `import { Base }` above `export class Derived extends Base() {}` plus `{ count += 1; break; }`       | Reports `100.00%` lines with `DA:1,1` and `DA:8,1`                                                                                          |
| Switch `default:` and multiline `case` value lines                     | Executed and unexecuted `case\n  1:` and standalone `default:` branches                              | Executed branch lines record `DA:<line>,1`; unexecuted `case`/value/`default:` lines show uncovered (`6-10` / `3-5`)                        |
| Allman-style `else` on its own line                                    | `else` on line 6, `{` on line 7, body on line 8                                                      | Uncovered `else` is attributed to line `6` and body `8` (`Uncovered Line #s`: `6,8`), not `{` on line 7                                     |
| Top-of-file comments with non-empty `--define` object/array            | Leading `//` and `/* */` comments plus `--define CFG_OBJ={"mode":"prod"}` / `--define CFG_ARR=[...]` | Top comments and `declare` lines are excluded from `LF`/`LH`; `defined.ts` reports `100.00%` (`LF:2`/`LH:2`) and `def_top.ts` `LF:1`/`LH:1` |
| Class `% Funcs` accounting                                             | Class with implicit constructor, field initializers, `static {}`, `async`, and generator methods     | Counts only explicit methods (`FNF:2`/`FNH:2` for 2 methods, `FNF:1`/`FNH:1` for 1 method), reporting `100.00%` `% Funcs`                   |
| `lcov.info` `DA:` execution counts                                     | Multi-op single-shot line (`once.ts`), inline `.map()` line (`complex_hit.ts`), and 4x `for` loop    | Single-execution multi-op line records `DA:2,1`; loop body records `DA:5,4`; inline 3-element `.map()` callback records `DA:2,3`            |
| `coverageThreshold` enforcement & defaults                             | Numeric `0.5`/`0.51`, `{ lines = 0.5 }`/`0.8`, typo `{ line = 0.8 }`, and partial `{ functions }`    | Enforces exact bounds (`0.5` pass / `0.51` fail), silently ignores unknown keys (`line`), and defaults omitted keys in a table to `0.90`    |

<!-- bun-behavior: bunx-minimum-release-age -->

## `bunx --minimum-release-age` (measured 2026-11-18)

Measured against a mock registry whose only version is brand new:

```
bunx --minimum-release-age 3600 age-probe
→ error: Package "age-probe" with tag "latest" not found
  (all versions blocked by minimum-release-age: 3600 seconds), exit 1
bunx --minimum-release-age 0 age-probe
→ runs the bin, exit 0
```

So the flag applies to packages `bunx` downloads, not just `bun install` resolution.
`tests/bunx_download_flags.test.ts` owns both rows.

<!-- bun-behavior: bunx-trust -->

## `bunx --trust` (measured 2026-11-18)

Measured with a package whose `postinstall` writes a marker file: without `--trust` the bin still
runs but the marker is absent; with `--trust` the marker is written. The release note extends the
trust to the package's dependencies; only the package's own lifecycle script is re-measured here.
`tests/bunx_download_flags.test.ts` owns both runs.

## Named `bun` exports: `s3`, `$`, and `sql` (measured 2026-11-20)

Declared in `bun-types@1.4.4` (`s3.d.ts`, `shell.d.ts`, and `sql.d.ts` pinned above); the
offline/in-memory contracts below were re-measured on `2026-11-20` on the local Bun binary
(`1.4.5`). Each named export from `"bun"` is identical by reference to the corresponding `Bun.*`
property (`s3 === Bun.s3`, `S3Client === Bun.S3Client`, `$ === Bun.$`, `sql === Bun.sql`,
`SQL === Bun.SQL`).

| Export            | Underlying Primitive                           | Primary Use                                                                 | Bun Env / Config Source                                                             | Repo Adapter / Policy                                                                                                                                                                                                  |
| :---------------- | :--------------------------------------------- | :-------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3` / `S3Client` | Default `Bun.s3` (`S3Client`) / `Bun.S3Client` | S3 / Cloudflare R2 object read, write, presign, stat                        | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_ENDPOINT` (or `AWS_*`) | [`lib/r2_s3_client.ts`](../lib/r2_s3_client.ts) (`R2S3Client`)                                                                                                                                                         |
| `$`               | `Bun.$`                                        | Cross-platform shell scripting with auto-escaped interpolation & streaming  | Inherits `process.env`; override via `.env({...})` / `.cwd(...)`                    | Tooling-only (`scripts/`, `bin/`, e.g. [`scripts/compute_dump_lag.ts`](../scripts/compute_dump_lag.ts)); argv-only `Bun.spawn` for credentials ([`lib/f402_credentials_policy.ts`](../lib/f402_credentials_policy.ts)) |
| `sql` / `SQL`     | Default `Bun.sql` (`SQL`) / `Bun.SQL`          | Native PostgreSQL, MySQL, and SQLite client with automatic parameterization | `DATABASE_URL` / `POSTGRES_URL` (or `new SQL(url)`)                                 | [`lib/db.ts`](../lib/db.ts) (PostgreSQL TLS/pool) & [`bin/sql-query.ts`](../bin/sql-query.ts) (read-only inspector)                                                                                                    |

<!-- bun-behavior: bun-s3-globals -->

### `s3` and `S3Client` — S3 / Cloudflare R2

The default `s3` export reads credentials from `S3_*` / `AWS_*` environment variables; instantiate
`new S3Client(...)` when targeting multiple buckets or explicit R2 endpoints.

```ts
import { s3, S3Client } from "bun";

// Default client (reads S3_* / AWS_* env vars)
const file = s3.file("snapshots/latest.json");
const exists = await file.exists();
const data = exists ? await file.json() : null;

// Explicit Cloudflare R2 client
const r2 = new S3Client({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: "sportsdesk-ops-reports",
  endpoint: process.env.S3_ENDPOINT,
});

await r2.write("manifests/2026-11-20.yaml", Bun.YAML.stringify({ ok: true }), {
  type: "application/yaml",
});

// Presigned URL (offline SigV4 signing, no network call)
const url = r2.presign("manifests/2026-11-20.yaml", { expiresIn: 300 });
```

- **Lazy `S3File` handle:** Like `Bun.file()`, `s3.file()` performs no I/O until `.text()`,
  `.bytes()`, `.json()`, `.exists()`, `.stat()`, `.write()`, or `.delete()` is awaited.
  Synchronous `file.size` on an unhydrated `S3File` is `NaN` (not `0`); only `stat()` / `bytes()`
  resolves object length.
- **Repo adapter ([`lib/r2_s3_client.ts`](../lib/r2_s3_client.ts)):** Production R2 I/O uses
  `resolveR2S3Options` / `resolveR2CredentialsAsync` and `R2S3Client`. Credential precedence is
  `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` → `CLOUDFLARE_R2_TOKEN_ID`/`CLOUDFLARE_R2_API_TOKEN`
  (secret derived as `sha256Hex`) → `S3_*` → `AWS_*` → `Bun.secrets` (`com.bookdeskops.sportsdesk`
  with legacy `sportsdesk-ops` fallback); bucket precedence is `R2_BUCKET_NAME` → `S3_BUCKET` →
  `AWS_BUCKET`; endpoint precedence is `S3_ENDPOINT` → `AWS_ENDPOINT` → `AWS_ENDPOINT_URL_S3` →
  derived `https://<accountId>.r2.cloudflarestorage.com` from `CLOUDFLARE_ACCOUNT_ID` /
  `R2_ACCOUNT_ID` (`R2_ENDPOINT` in [`runbooks/cloudflare_r2_and_api_runbook.md`](./runbooks/cloudflare_r2_and_api_runbook.md)
  is an operator reference value and is not read by `resolveR2S3Options`).
- **R2-specific edges:** `R2S3Client.writeWithMetadata` signs direct PUT requests for `x-amz-meta-*`
  headers that Bun's writer does not expose, and `R2S3Client.stat` recovers `size` via a body read
  when R2 HEAD omits `Content-Length`. Inline `fetch("s3://...", { s3: { accessKeyId, secretAccessKey } })`
  credentials are forbidden (`BUN-FETCH-S3-INLINE-CREDENTIALS`).
- **Evidence:** [`tests/bun_s3client_contract.test.ts`](../tests/bun_s3client_contract.test.ts),
  [`tests/r2_s3_client.test.ts`](../tests/r2_s3_client.test.ts),
  [`tests/bun_runtime_contracts.test.ts`](../tests/bun_runtime_contracts.test.ts).

<!-- bun-behavior: bun-shell-globals -->

### `$` (`Bun.$`) — Bun Shell

`$` (`Bun.$`) is lazy (starts no process until awaited). Interpolated expressions are escaped
automatically to prevent shell injection. Output methods (`.text()`, `.json()`, `.bytes()`,
`.arrayBuffer()`, `.blob()`, `.lines()`) implicitly quiet echoing, whereas a bare `await` echoes to
parent stdout; use `.quiet()` when discarding output and `.nothrow()` to inspect non-zero exits
without throwing `ShellError` (`exitCode` + `Buffer` `stdout`/`stderr`).

```ts
import { $ } from "bun";

const branch = "main";
const sha = (await $`git rev-parse ${branch}`.quiet().text()).trim();

// Stream directly from JS objects (Response, Buffer, Blob) without temp files
const input = new Response("alpha\nbeta\ngamma\n");
const lines = await $`grep beta < ${input}`.quiet().text();

// Non-throwing exit inspection
const res = await $`git diff --quiet`.nothrow().quiet();
if (res.exitCode !== 0) {
  console.error("Working tree dirty");
}

// Raw interpolation for intentional flags (never pass untrusted input here)
const flags = "-n hello";
const out = await $`echo ${{ raw: flags }}`.quiet().text();
```

- **Gotchas:** Passing a multi-token string as `${flags}` quotes the entire string as one argument;
  wrap intentional flags or raw shell syntax with `${{ raw: "..." }}` (never with untrusted
  input). `Bun.$.escape()` coerces non-strings (`null` → `"null"`, `true` → `"true"`) and is not
  an input validator.
- **Repo policy:** `Bun.$` / `$` is **tooling-only** (`scripts/`, `bin/`, e.g.
  [`scripts/compute_dump_lag.ts`](../scripts/compute_dump_lag.ts)) and every call site must capture
  output or call `.quiet()`. Library and daemon code (`lib/`, `services/`, `cli/`) and any code path
  touching credentials, cookies, or sessions must use argv-only `Bun.spawn([argv…])` — see
  [`lib/f402_credentials_policy.ts`](../lib/f402_credentials_policy.ts) and the credential audit
  section below.
- **Evidence:** [`tests/bun_shell_contract.test.ts`](../tests/bun_shell_contract.test.ts),
  [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts).

<!-- bun-behavior: bun-sql-globals -->

### `sql` and `SQL` — Native SQL client

`sql` (`Bun.sql`) resolves `DATABASE_URL` with a `POSTGRES_URL` fallback (both verified against
`sqlite://:memory:` on Bun `1.4.5`); `new SQL(url)` connects explicitly to PostgreSQL, MySQL, or
SQLite. Tagged template interpolation binds `${val}` as a prepared-statement parameter—never string
concatenation.

```ts
import { sql, SQL } from "bun";

// Default connection (DATABASE_URL / POSTGRES_URL)
const active = await sql`
  SELECT id, status FROM wagers
  WHERE status = ${"OPEN"} AND stake_cents >= ${10000}
`;

// Explicit connection + transaction + dynamic identifier / bulk insert
const db = new SQL(process.env.DATABASE_URL ?? "sqlite://:memory:");
const col = "status";
await db`INSERT INTO wagers ${db([{ id: 1, status: "OPEN", stake_cents: 15000 }])}`;
const rows = await db`SELECT id, ${db(col)} FROM wagers`;
await db.begin(async (tx) => {
  await tx`UPDATE balances SET cents = cents - ${500} WHERE id = ${1}`;
  await tx`UPDATE balances SET cents = cents + ${500} WHERE id = ${2}`;
});
```

- **Gotcha (`sql(ident)` vs `${val}`):** Standard `${val}` interpolation is always bound as a
  parameter (preventing SQL injection); use `db(columnName)` for table/column identifiers or
  `INSERT INTO t ${db(rows)}` for bulk row objects, and allowlist any dynamic identifier before
  passing it to `db(...)`.
- **Repo adapters:** Application PostgreSQL queries import `sql` from [`lib/db.ts`](../lib/db.ts)
  rather than raw `import { sql } from "bun"`. `lib/db.ts` reads `DATABASE_URL` (reusing default
  `Bun.sql` only for local plaintext when `SPORTSDESK_DB_TLS !== "1"`) or `PGHOST`/`PGPORT`/
  `PGUSER`/`PGPASSWORD`/`PGDATABASE` (it does **not** read `POSTGRES_URL`), rejects empty passwords
  on non-local hosts, enforces TLS 1.3 only (`rejectUnauthorized: true`, optional
  `SPORTSDESK_DB_CERT_FINGERPRINT` and `SPORTSDESK_DB_CA_FILE`), channel binding (`prefer`), pool
  limits, and connect timeout (`10 s` default). Operator ad-hoc inspection uses
  [`bin/sql-query.ts`](../bin/sql-query.ts) (`bun x sql-query` / `bun run sql:query`), which
  enforces single-statement read-only `SELECT`/`WITH`/`EXPLAIN` queries and `--timeout` query
  cancellation via `query.cancel()`.
- **Evidence:** [`tests/bun_sql_contract.test.ts`](../tests/bun_sql_contract.test.ts),
  [`tests/sql_query_cli.test.ts`](../tests/sql_query_cli.test.ts),
  [`tests/db_tls_options.test.ts`](../tests/db_tls_options.test.ts),
  [`tests/db_pool_options.test.ts`](../tests/db_pool_options.test.ts),
  [`tests/db_connection_timeout.test.ts`](../tests/db_connection_timeout.test.ts).

<!-- bun-behavior: blob-image-pipeline -->

## `FileBlob.image()` — lazy decode, resize, encode, write (measured 2026-11-21)

`Bun.file(path).image()` wraps the file in a `Bun.Image` pipeline. The reference documents the
constructor as synchronous with the read deferred to an awaited terminal; measured here, the
undecoded fields confirm it: `image.width` and `image.height` report `-1` until `metadata()` (or
another terminal) decodes, after which they report the real dimensions.

Measured on the pinned `Bun 1.4.5+a7733435c`:

- **Chain:** `Bun.file(src).image().resize(400).webp().write(dest)` writes a WebP and returns a
  positive byte count; the target is `image/webp` with the resized dimensions
  ([`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts),
  [`tests/bun_file_blob_contract.test.ts`](../tests/bun_file_blob_contract.test.ts)).
- **Shape:** a one-dimension resize preserves aspect ratio (measured: 10×5 at width 4 → 4×2);
  `write()` returns the encoded byte count, equal to the target's size and `bytes().byteLength`;
  an existing target is replaced, missing parent directories are created, and a regular file in
  the path rejects `ENOTDIR`.
- **Laziness:** deleting the source after `image()` but before a terminal rejects `ENOENT` — the
  deferred read happens at the terminal, not at construction.
- **Terminals:** `bytes()` returns the encoded `Uint8Array` when the caller needs the payload — a
  `Response` or a content ETag (`services/sportsdesk_webview_server.ts`, `scripts/optimize_assets.ts`) —
  while `write(path)` is the file terminal and needs no separate `Bun.write`.
- **Failure:** a non-image body rejects with a `Bun.Image` code, classified as `AvatarImageError` at
  the boundary ([`src/lib/terminal_avatar.ts`](../src/lib/terminal_avatar.ts),
  [`tests/terminal_avatar.test.ts`](../tests/terminal_avatar.test.ts),
  [`lib/image_errors.test.ts`](../lib/image_errors.test.ts)).

- **Evidence:** [`tests/bun_file_blob_contract.test.ts`](../tests/bun_file_blob_contract.test.ts),
  [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts).

## Upstream doc commit pins

| Pin                                                                                                                      | Tree                               | Use                                                                       |
| :----------------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :------------------------------------------------------------------------ |
| [`38afee6c`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/README.md)                | `oven-sh/bun/docs` at `bun-v1.4.4` | Baseline runtime docs for the pinned binary                               |
| [`6cdb3835`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/project/contributing.mdx) | `docs#contributing`                | MDX voice (same audited commit; tag `6cdb3835` is historical metadata)    |
| [`6a380492`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/snippets)                 | `docs/snippets`                    | `guides.jsx` (guide index), `cli/*.mdx` (CLI flag blocks)                 |
| [`b6e7b9cd`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/runtime/s3.mdx)           | `docs/runtime/s3.mdx`              | `Bun.S3Client`, `S3File`, `new Response(s3file)` 302 redirect, `ERR_S3_*` |

## Related runbooks in this repo

- Package manager policy: [`runbooks/bun-pm-policy.md`](./runbooks/bun-pm-policy.md)
- Generated `Bun.*` shape catalog: [`runbooks/bun_shape_contracts_runbook.md`](./runbooks/bun_shape_contracts_runbook.md)
- Server & WebView runtime shapes: [`runbooks/bun_server_runtime_shapes_runbook.md`](./runbooks/bun_server_runtime_shapes_runbook.md)
- Eval one-liner pitfalls: [`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md)

## Hardened `Bun.*` refusals confirmed in v1.4.4 (2026-10-22)

The v1.4.4 Bun APIs changelog confirms the refusal behaviour the Pass-2 sweep targeted. The
runtime floor is `>=1.4.4`; [`tests/bun_v144_hardened_surfaces.test.ts`](../tests/bun_v144_hardened_surfaces.test.ts)
and [`tests/bun_runtime_contracts.test.ts`](../tests/bun_runtime_contracts.test.ts) pin it.

| Surface                                                  | Confirmed v1.4.4 behaviour                                                                                                                                    | Refusal class   | Contract                                                                        |
| :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------- | :------------------------------------------------------------------------------ |
| `Bun.hash` / `crypto.hash` / `Bun.SHA*` / `CryptoHasher` | `Bun.file()`, S3 file and build-output blobs now throw; `null`, `undefined` and the no-argument call throw instead of hashing `""` / `"undefined"` / `"null"` | `TypeError`     | `bun_v144_hardened_surfaces`, `bun_runtime_contracts`                           |
| `Bun.indexOfLine`                                        | Non-buffer first argument throws                                                                                                                              | `TypeError`     | [`bun_index_of_line.test.ts`](../tests/bun_index_of_line.test.ts)               |
| `Bun.Glob.match`                                         | `**` inside `{...}` matches recursively; patterns with >10 brace groups or nesting depth now work (the old silent `false` threshold was 10/10)                | —               | `bun_v144_hardened_surfaces`                                                    |
| `Glob.scan` / `scanSync`                                 | Truthy non-`true` options are honoured: `{ dot: 1 }` includes dotfiles, `{ onlyFiles: 1 }` lists files only                                                   | —               | `bun_v144_hardened_surfaces`                                                    |
| `gzipSync` / `deflateSync`                               | `memLevel` (1..9) and `strategy` (0..4) are honoured; out-of-range values throw                                                                               | `RangeError`    | [`bun_compression_contract.test.ts`](../tests/bun_compression_contract.test.ts) |
| `dns.prefetch`                                           | A `NaN` port throws                                                                                                                                           | `RangeError`    | [`bun_dns.test.ts`](../tests/bun_dns.test.ts)                                   |
| `Bun.CSRF.generate` / `verify`                           | `expiresIn: NaN` / `maxAge: NaN` throw; `generate(undefined, options)` keeps the default secret                                                               | `RangeError`    | [`bun_csrf_contract.test.ts`](../tests/bun_csrf_contract.test.ts)               |
| `Bun.$.escape`                                           | Non-string arguments are coerced: `null` → `"null"`, `true` → `"true"`, boxed strings → contents                                                              | string coercion | `bun_v144_hardened_surfaces`                                                    |
| `Bun.TOML.parse` / `Bun.YAML.parse`                      | Unhydrated `Bun.file()`/S3 file handles throw instead of returning `{}`/`null`                                                                                | `TypeError`     | `bun_runtime_contracts`                                                         |

### Refusal taxonomy

Do not collapse these into one class:

- **`TypeError`** — the argument is the wrong type (hash inputs, parser inputs, `indexOfLine`).
- **`RangeError`** — the type is acceptable but the value is out of range or `NaN` (CSRF options, DNS port, compression levels).
- **String coercion** — `$.escape` guarantees the output is a string; it does **not** validate the input. `$.escape(null)` returns `"null"`, a valid shell token for the wrong value. Validate types first; credentials remain argv-only (`Bun.spawn([argv…])`). The audit emits this taxonomy as `errorClass` on each finding.
- **`SyntaxError`** — JSON5 invalid-input fixes (e.g. `"1\0 2"`, escaped-colon keys) are parser errors, not refusals. `Bun.JSONL.parseChunk().error` is also a `SyntaxError`.
- **`SystemError`** — a failed system call (`errno`, `code`, `path`, `syscall`); an I/O failure, not a refusal. Never let `errorMode: "skip"` swallow it; rethrow it unchanged so its metadata survives.

### Stored-evidence sweeps

Two pre-1.4.4 shapes can poison evidence recorded through the old behaviour:

1. **Blob-input hashes.** A pre-fix blob/S3/build-output hash is the empty-input digest (SHA-256
   `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; `Bun.hash("")` for the
   no-argument form). Re-derive any stored artifact/evidence hash that matches those values; do
   not treat the digest as proof the blob was read.

   The current repo has three such references: the `getPending` response in
   `docs/evidence/captures/2026-10-31/getPending.post.json` (`bytes: 0`) and two 500 responses in
   `docs/evidence/captures/manifest.json` (`responseBytes: 0`). All three are legitimate empty
   bodies, not blob-handle laundering. The poisoned shape requires a nonzero or unknown byte
   count, or a producer that hashed a handle. Query the digest **and** the byte length; the digest
   alone is insufficient.

2. **Deep brace globs.** Pre-fix scans with more than 10 brace groups, or nesting deeper than 10,
   could miss matches silently. Regenerate machine-generated glob inventories and compare the
   result; the v1.4.4 matcher now handles them.

### Corrections to the earlier ledger

- `Bun.indexOfLine` has **two distinct fixes**: v1.4.3 fixed missed line breaks in invalid UTF-8;
  v1.4.4 added the non-buffer `TypeError`. Both are pinned; neither replaces the other.
- `Bun.JSONL.parseChunk` hardening is **not confirmed** in the v1.4.4 Bun APIs section. The
  blank-line/stray-delimiter behaviour exercised in `jsonl_stream_replay.test.ts` is measured on
  the pinned build, but no fix version is recorded. The API surface is documented; the hardening is not.
- CSRF default `expiresIn` (86,400,000 ms) and `$.escape` prose are doc-cited, not re-measured here.

## Reference symbol baseline (2026-11-18)

[`tests/fixtures/bun-reference-symbols.json`](../tests/fixtures/bun-reference-symbols.json) records the
`data-symbol` inventory from the bun.com reference page data for `bun`, `bun.$` and `node:crypto`
(observed 2026-11-18; runtime pin `Bun 1.4.4`). [`tests/bun_reference_symbols.test.ts`](../tests/bun_reference_symbols.test.ts)
checks every named `node:crypto` import and every `Bun.$` member access in the repo against it.

This is a deliberate one-time pin, not an MCP transport. `.props.json` is Next.js page data, not the
docs MCP protocol; the payloads (264 KB / 178 KB / 161 KB) are not committed and are not fetched in
CI. Refresh the fixture only when the docs surface changes.

The `bun.$` page documents `escape(input: string): string`; non-string coercion is measured runtime
behaviour, not a docs guarantee. Do not use it as an input validator.

## Fetch options that are not W3C

- `fetch(url, { timeout: ms })` is Bun's **idle** timeout, not a whole-request deadline. Use
  `AbortSignal.timeout(ms)` when the deadline must cover connection, headers and body.
- `fetch("s3://…", { s3: { accessKeyId, secretAccessKey } })` places credentials in source. Use
  the environment/secret manager or the repo S3 client; inline `s3` credentials are forbidden by
  the `BUN-FETCH-S3-INLINE-CREDENTIALS` audit rule, while `BUN-FETCH-TIMEOUT-IDLE` flags the
  idle-only timeout.

## When NOT to migrate to `Bun.JSONL` (2026-11-04 audit)

The repo uses `Bun.JSONL.parse()` / `Bun.JSONL.parseChunk()` by default on JSONL inputs. The six sites below intentionally keep hand-rolled per-line `JSON.parse` loops because they require semantics `Bun.JSONL` does not provide. The v1.4.4 Bun APIs section has no JSONL hardening entry; do not attribute the blank-line/stray-delimiter behaviour to a fix version.

| File:line                                        | Pattern                                     | Semantic `Bun.JSONL` does not provide                                                       |
| :----------------------------------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------ |
| `lib/execution_paper.ts:161`                     | per-line try/catch, skip malformed          | Ledger reads skip malformed lines; `parse()` stops at the first bad line and drops the rest |
| `lib/f402_bet_ticker_jsonl.ts:101` (zst/gz path) | per-line try/catch + `skippedLines` counter | Per-line skip count; `parseChunk` reports one aggregate `error`, not a per-row tally        |
| `scripts/live_positions_cron.ts:355`             | chunked streaming + per-line skip           | Crash-tolerant reader for a 16 MB chunked stream (writer may truncate mid-line on signal)   |
| `scripts/audit_tool_calls.ts:109`                | per-line try/catch                          | DSH session files can have bad **middle** lines, not just a partial trailing one            |
| `scripts/ingestion_replay_xml_golden_gate.ts:45` | strict parse + original-text passthrough    | Gate must throw on malformed; preserves the exact original line text when `xml` is absent   |
| `lib/stale_line_cohort.ts:256`                   | strict parse in a `catch` fallback          | Must throw on malformed input; `parse()` returns the parsed prefix silently                 |

## `Bun.$` — available, but argv-only for credentials (2026-11-04 audit)

[`Bun.$`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/shell.d.ts#L23) is pinned in [`bin/bun_surface.ts`](../bin/bun_surface.ts) and [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts), but [`lib/f402_credentials_policy.ts`](../lib/f402_credentials_policy.ts) enforces **argv-only (`Bun.spawn([argv…])`) for anything that touches a credential**:

| Scenario                                                              | Use                                                   | Why                                                                                             |
| :-------------------------------------------------------------------- | :---------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Anything reading/writing a credential, API key, cookie, or session ID | `Bun.spawn([argv…], { env: buildMinimalSpawnEnv() })` | Argv array bypasses the shell parser; minimal env allowlist denies `LD_PRELOAD`-class injection |
| Static dev/test command with no untrusted interpolation               | `Bun.$\`…\`.text()`                                   | Safe only when no secrets or untrusted inputs are interpolated                                  |
| Production daemon reading stdout/stderr streams                       | `Bun.spawn(argv, { stdout: "pipe" })`                 | Explicit `proc.exited` / `proc.stdout` / `proc.stderr` lifecycle                                |

`Bun.$.escape()` guarantees a string, not a correct value: `$.escape(null)` is the valid shell
token `"null"`. Validate the type before escaping, and never use escape as a credential sanitizer.

## When to use `Bun.allocUnsafe` (and when NOT to) — 2026-11-04 audit

[`Bun.allocUnsafe(size)`](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/packages/bun-types/bun.d.ts#L4954) returns an unzeroed `Uint8Array`. Every call site must guarantee that only written bytes are exposed to callers (pinned in [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts)):

| File:line                            | Fill pattern                                    | Why it is safe                                                                                  |
| :----------------------------------- | :---------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `lib/f402_bet_ticker_jsonl.ts:169`   | `handle.read(buffer, read, length - read, …)`   | `writtenUint8Prefix(buffer, read)` exposes only the written prefix                              |
| `scripts/live_positions_cron.ts:375` | `bytesRead = readSync(fd, buf, 0, len, offset)` | `decoder.decode(buf.subarray(0, bytesRead))` slices to `bytesRead`                              |
| `lib/gslive_tally_rollup.ts:432-679` | SoA `Uint8Array` columns                        | Only indices `0..groupCount-1` / `0..cellCount-1` are read after insert paths write every field |
