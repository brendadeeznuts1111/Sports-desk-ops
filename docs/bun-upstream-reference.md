# Bun docs & `bun-types` (upstream canonical index)

Canonical commit links for the pinned runtime (`Bun 1.4.4`, `38afee6c84fcf48c0edb2466aa4b27d287a59c30`) and its TypeScript declarations. Do not hand-maintain symbol counts or API prose here — derive them from the binary and `bun-types` with `./bin/dx bun --types`, `bun run probe:bun`, and `bun scripts/bun_shape_contracts.ts --check`.

## Runtime & `bun-types` SSOT

| Surface           | Canonical pin                                                                                                                                     | Local verification                                                                 |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------- |
| Release tag       | [`bun-v1.4.4`](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (`2026-10-22`)                                                             | `package.json` `engines.bun` / `.bun-version`                                      |
| Release commit    | [`38afee6c84fcf48c0edb2466aa4b27d287a59c30`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/package.json)           | `Bun.revision` (`bun run probe:bun` vs `tests/bun_baseline.json`)                  |
| `bun-types` root  | [`packages/bun-types` @ `38afee6c84`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/index.d.ts) | `@types/bun@1.4.4` (`./bin/dx bun --types --strict`)                               |
| Shape catalog     | [`docs/runbooks/bun_shape_contracts_runbook.md`](./runbooks/bun_shape_contracts_runbook.md)                                                       | `bun scripts/bun_shape_contracts.ts --check` (`tests/bun_shapes_coverage.test.ts`) |
| Docs MCP baseline | `bun.sh/docs/mcp` (scheme-less; transport endpoint, not a `bun-types` blob)                                                                       | `bun run bun:docs-mcp surfaces --check tests/bun_docs_surface_baseline.json`       |

## Canonical `bun-types` files (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`)

| Declaration file     | Canonical upstream link                                                                                                                                       | Scope                                                                                                                                                                          |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.d.ts`         | [`packages/bun-types/index.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/index.d.ts)                 | Entry reference order                                                                                                                                                          |
| `bun.d.ts`           | [`packages/bun-types/bun.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/bun.d.ts)                     | `Bun.*` namespace, `serve`, `spawn`, `file`, `write`, `build`, `TOML`, `YAML`, `JSONL`, `JSON5`, `JSONC`, `XML`, `markdown`, `cron`, `secrets`, `Image`, `WebView`, `Terminal` |
| `globals.d.ts`       | [`packages/bun-types/globals.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/globals.d.ts)             | Global constructors (`WebSocket`, `Worker`, `Blob`, `Request`, `Response`, `ImportMeta`)                                                                                       |
| `extensions.d.ts`    | [`packages/bun-types/extensions.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/extensions.d.ts)       | Module loader wildcards (`*.toml`, `*.yaml`, `*.yml`, `*.jsonc`, `*.json5`, `*.xml`, `*/bun.lock`, `*.html`, `*.txt`)                                                          |
| `overrides.d.ts`     | [`packages/bun-types/overrides.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/overrides.d.ts)         | `ReadableStream` / `Blob` consumer methods, `NodeJS.Process` (`memoryPressure`), `node:fs/promises` `exists`, `node:tls`                                                       |
| `s3.d.ts`            | [`packages/bun-types/s3.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/s3.d.ts)                       | `Bun.S3Client`, `Bun.s3`, `S3File`, `S3Options`, `S3Stats`                                                                                                                     |
| `sqlite.d.ts`        | [`packages/bun-types/sqlite.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/sqlite.d.ts)               | `bun:sqlite` (`Database`, `Statement`, `Changes`)                                                                                                                              |
| `sql.d.ts`           | [`packages/bun-types/sql.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/sql.d.ts)                     | `Bun.SQL`, `Bun.sql` tagged template                                                                                                                                           |
| `redis.d.ts`         | [`packages/bun-types/redis.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/redis.d.ts)                 | `Bun.RedisClient`, `Bun.redis`                                                                                                                                                 |
| `shell.d.ts`         | [`packages/bun-types/shell.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/shell.d.ts)                 | `Bun.$`, `ShellPromise`, `ShellOutput`, `ShellError`                                                                                                                           |
| `test.d.ts`          | [`packages/bun-types/test.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/test.d.ts)                   | `bun:test` (`describe`, `test`, `expect`, `expectTypeOf`, `mock`, `spyOn`, `onTestFinished`, `setSystemTime`)                                                                  |
| `ffi.d.ts`           | [`packages/bun-types/ffi.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/ffi.d.ts)                     | `bun:ffi` (`dlopen`, `ptr`, `CString`, `FFIType`)                                                                                                                              |
| `jsc.d.ts`           | [`packages/bun-types/jsc.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/jsc.d.ts)                     | `bun:jsc` heap/GC diagnostics                                                                                                                                                  |
| `security.d.ts`      | [`packages/bun-types/security.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/security.d.ts)           | `Bun.Security` scanner hooks                                                                                                                                                   |
| `html-rewriter.d.ts` | [`packages/bun-types/html-rewriter.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/html-rewriter.d.ts) | `HTMLRewriter`                                                                                                                                                                 |

### Declaration vs runtime drift (`./bin/dx bun --types`)

Do not hardcode member counts; run `./bin/dx bun --types` (or `./bin/dx bun --json`) to diff `bun-types@1.4.4` against the active binary. The two pinned drift IDs asserted in [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts) are:

- **`dns-resolve`**: `bun-types` and [`dns` namespace](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/bun.d.ts#L2503) declare only `lookup`, `prefetch`, and `getCacheStats`, while the 1.4.4 binary also exposes the 15 `node:dns/promises` resolver methods (`resolve`, `resolve4`, `resolve6`, `resolveSrv`, `resolveTxt`, `resolveSoa`, `resolveNaptr`, `resolveMx`, `resolveCaa`, `resolveNs`, `resolvePtr`, `resolveCname`, `resolveAny`, `getServers`, `setServers`, `reverse`, `lookupService`).
- **`websocket-global`**: [`WebSocket`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/bun.d.ts#L5178) and [`Worker`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/bun.d.ts#L714) are filed under the `bun` module page, but `Bun.WebSocket` and `Bun.Worker` are `undefined` at runtime — the constructors live on `globalThis`.

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

- `Bun.XML` is a parser, not a schema validator. The XML feed is hydrated into typed SoA
  columns (`eventId32` / `packedComboKey15` / `lineHundredthsI32`) and the written count is
  asserted against the returned count (`ERR_DOD_CSR_CONSERVATION_BREACH`).
- The HTML-login-page guard runs **before** parsing; parse failures are classified into
  `ERR_XML_ENTITY_BOMB` rather than leaking a raw `SyntaxError`.
- Docs coverage: `tests/bun_docs_surface_baseline.json` marks `XML` documented — the docs
  page is `bun.com/docs/runtime/xml`, pinned upstream at
  [`docs/runtime/xml.mdx`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs/runtime/xml.mdx)
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

Pinned docs: [`docs/runtime/semver.mdx`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs/runtime/semver.mdx).
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

<!-- bun-behavior: bun-test-api -->

## `bun:test` API surface (measured 2026-11-18)

The pinned declaration is
[`packages/bun-types/test.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/test.d.ts);
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
`--check`, coverage, snapshots, and `--environment`/`--globals`.

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
`concurrentTestGlob`, `smol`, the mock-cleanup options, coverage options, and `[install]`
inheritance.

## Upstream doc commit pins

| Pin                                                                                                                      | Tree                               | Use                                                                       |
| :----------------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :------------------------------------------------------------------------ |
| [`38afee6c`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs/README.md)                | `oven-sh/bun/docs` at `bun-v1.4.4` | Baseline runtime docs for the pinned binary                               |
| [`6cdb3835`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs/project/contributing.mdx) | `docs#contributing`                | MDX voice (same audited commit; tag `6cdb3835` is historical metadata)    |
| [`6a380492`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs/snippets)                 | `docs/snippets`                    | `guides.jsx` (guide index), `cli/*.mdx` (CLI flag blocks)                 |
| [`b6e7b9cd`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs/runtime/s3.mdx)           | `docs/runtime/s3.mdx`              | `Bun.S3Client`, `S3File`, `new Response(s3file)` 302 redirect, `ERR_S3_*` |

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

[`Bun.$`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/shell.d.ts#L23) is pinned in [`bin/bun_surface.ts`](../bin/bun_surface.ts) and [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts), but [`lib/f402_credentials_policy.ts`](../lib/f402_credentials_policy.ts) enforces **argv-only (`Bun.spawn([argv…])`) for anything that touches a credential**:

| Scenario                                                              | Use                                                   | Why                                                                                             |
| :-------------------------------------------------------------------- | :---------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Anything reading/writing a credential, API key, cookie, or session ID | `Bun.spawn([argv…], { env: buildMinimalSpawnEnv() })` | Argv array bypasses the shell parser; minimal env allowlist denies `LD_PRELOAD`-class injection |
| Static dev/test command with no untrusted interpolation               | `Bun.$\`…\`.text()`                                   | Safe only when no secrets or untrusted inputs are interpolated                                  |
| Production daemon reading stdout/stderr streams                       | `Bun.spawn(argv, { stdout: "pipe" })`                 | Explicit `proc.exited` / `proc.stdout` / `proc.stderr` lifecycle                                |

`Bun.$.escape()` guarantees a string, not a correct value: `$.escape(null)` is the valid shell
token `"null"`. Validate the type before escaping, and never use escape as a credential sanitizer.

## When to use `Bun.allocUnsafe` (and when NOT to) — 2026-11-04 audit

[`Bun.allocUnsafe(size)`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/bun.d.ts#L4954) returns an unzeroed `Uint8Array`. Every call site must guarantee that only written bytes are exposed to callers (pinned in [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts)):

| File:line                            | Fill pattern                                    | Why it is safe                                                                                  |
| :----------------------------------- | :---------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `lib/f402_bet_ticker_jsonl.ts:169`   | `handle.read(buffer, read, length - read, …)`   | `writtenUint8Prefix(buffer, read)` exposes only the written prefix                              |
| `scripts/live_positions_cron.ts:375` | `bytesRead = readSync(fd, buf, 0, len, offset)` | `decoder.decode(buf.subarray(0, bytesRead))` slices to `bytesRead`                              |
| `lib/gslive_tally_rollup.ts:432-679` | SoA `Uint8Array` columns                        | Only indices `0..groupCount-1` / `0..cellCount-1` are read after insert paths write every field |
