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
