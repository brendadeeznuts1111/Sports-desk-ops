# Bun docs & `bun-types` (upstream canonical index)

Canonical commit links for the pinned runtime (`Bun 1.4.4`, `38afee6c84fcf48c0edb2466aa4b27d287a59c30`) and its TypeScript declarations. Do not hand-maintain symbol counts or API prose here — derive them from the binary and `bun-types` with `./bin/dx bun --types`, `bun run probe:bun`, and `bun scripts/bun_shape_contracts.ts --check`.

## Runtime & `bun-types` SSOT

| Surface           | Canonical pin                                                                                                                          | Local verification                                                                 |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| Release tag       | [`bun-v1.4.4`](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (`2026-10-22`)                                                  | `package.json` `engines.bun` / `.bun-version`                                      |
| Release commit    | [`38afee6c84fcf48c0edb2466aa4b27d287a59c30`](https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30)             | `Bun.revision` (`bun run probe:bun` vs `tests/bun_baseline.json`)                  |
| `bun-types` root  | [`packages/bun-types` @ `38afee6c84`](https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types) | `@types/bun@1.4.4` (`./bin/dx bun --types --strict`)                               |
| Shape catalog     | [`docs/runbooks/bun_shape_contracts_runbook.md`](./runbooks/bun_shape_contracts_runbook.md)                                            | `bun scripts/bun_shape_contracts.ts --check` (`tests/bun_shapes_coverage.test.ts`) |
| Docs MCP baseline | [`https://bun.sh/docs/mcp`](https://bun.com/docs/mcp)                                                                                  | `bun run bun:docs-mcp surfaces --check tests/bun_docs_surface_baseline.json`       |

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

- **`dns-resolve`**: `bun-types` and [`/reference/bun/dns`](https://bun.com/reference/bun/dns) declare only `lookup`, `prefetch`, and `getCacheStats`, while the 1.4.4 binary also exposes the 15 `node:dns/promises` resolver methods (`resolve`, `resolve4`, `resolve6`, `resolveSrv`, `resolveTxt`, `resolveSoa`, `resolveNaptr`, `resolveMx`, `resolveCaa`, `resolveNs`, `resolvePtr`, `resolveCname`, `resolveAny`, `getServers`, `setServers`, `reverse`, `lookupService`).
- **`websocket-global`**: [`/reference/bun/WebSocket`](https://bun.com/reference/bun/WebSocket) and [`/reference/bun/Worker`](https://bun.com/reference/bun/Worker) are filed under the `bun` module page, but `Bun.WebSocket` and `Bun.Worker` are `undefined` at runtime — the constructors live on `globalThis`.

## Upstream doc commit pins

| Pin                                                                                                            | Tree                               | Use                                                                       |
| :------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :------------------------------------------------------------------------ |
| [`38afee6c`](https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30/docs)                | `oven-sh/bun/docs` at `bun-v1.4.4` | Baseline runtime docs for the pinned binary                               |
| [`6cdb3835`](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing)   | `docs#contributing`                | MDX [voice](https://bun.com/docs/project/contributing#voice)              |
| [`6a380492`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets)       | `docs/snippets`                    | `guides.jsx` (guide index), `cli/*.mdx` (CLI flag blocks)                 |
| [`b6e7b9cd`](https://github.com/oven-sh/bun/blob/b6e7b9cdc4e7e1720b65f2e43a62debb3ab61283/docs/runtime/s3.mdx) | `docs/runtime/s3.mdx`              | `Bun.S3Client`, `S3File`, `new Response(s3file)` 302 redirect, `ERR_S3_*` |

## Related runbooks in this repo

- Package manager policy: [`runbooks/bun-pm-policy.md`](./runbooks/bun-pm-policy.md)
- Generated `Bun.*` shape catalog: [`runbooks/bun_shape_contracts_runbook.md`](./runbooks/bun_shape_contracts_runbook.md)
- Server & WebView runtime shapes: [`runbooks/bun_server_runtime_shapes_runbook.md`](./runbooks/bun_server_runtime_shapes_runbook.md)
- Eval one-liner pitfalls: [`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md)

## When NOT to migrate to `Bun.JSONL` (2026-11-04 audit)

The repo uses `Bun.JSONL.parse()` / `Bun.JSONL.parseChunk()` by default on JSONL inputs. The six sites below intentionally keep hand-rolled per-line `JSON.parse` loops because they require semantics `Bun.JSONL` does not provide:

| File:line                                        | Pattern                                     | Semantic `Bun.JSONL` does not provide                                                       |
| :----------------------------------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------ |
| `lib/execution_paper.ts:161`                     | per-line try/catch, skip malformed          | Ledger reads skip malformed lines; `parse()` stops at the first bad line and drops the rest |
| `lib/f402_bet_ticker_jsonl.ts:101` (zst/gz path) | per-line try/catch + `skippedLines` counter | Per-line skip count; `parseChunk` reports one aggregate `error`, not a per-row tally        |
| `scripts/live_positions_cron.ts:355`             | chunked streaming + per-line skip           | Crash-tolerant reader for a 16 MB chunked stream (writer may truncate mid-line on signal)   |
| `scripts/audit_tool_calls.ts:109`                | per-line try/catch                          | DSH session files can have bad **middle** lines, not just a partial trailing one            |
| `scripts/ingestion_replay_xml_golden_gate.ts:45` | strict parse + original-text passthrough    | Gate must throw on malformed; preserves the exact original line text when `xml` is absent   |
| `lib/stale_line_cohort.ts:256`                   | strict parse in a `catch` fallback          | Must throw on malformed input; `parse()` returns the parsed prefix silently                 |

## `Bun.$` — available, but argv-only for credentials (2026-11-04 audit)

[`Bun.$`](https://bun.com/reference/bun/$) is pinned in [`bin/bun_surface.ts`](../bin/bun_surface.ts) and [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts), but [`lib/f402_credentials_policy.ts`](../lib/f402_credentials_policy.ts) enforces **argv-only (`Bun.spawn([argv…])`) for anything that touches a credential**:

| Scenario                                                              | Use                                                   | Why                                                                                             |
| :-------------------------------------------------------------------- | :---------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Anything reading/writing a credential, API key, cookie, or session ID | `Bun.spawn([argv…], { env: buildMinimalSpawnEnv() })` | Argv array bypasses the shell parser; minimal env allowlist denies `LD_PRELOAD`-class injection |
| Static dev/test command with no untrusted interpolation               | `Bun.$\`…\`.text()`                                   | Safe only when no secrets or untrusted inputs are interpolated                                  |
| Production daemon reading stdout/stderr streams                       | `Bun.spawn(argv, { stdout: "pipe" })`                 | Explicit `proc.exited` / `proc.stdout` / `proc.stderr` lifecycle                                |

## When to use `Bun.allocUnsafe` (and when NOT to) — 2026-11-04 audit

[`Bun.allocUnsafe(size)`](https://bun.com/reference/bun/allocUnsafe) returns an unzeroed `Uint8Array`. Every call site must guarantee that only written bytes are exposed to callers (pinned in [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts)):

| File:line                            | Fill pattern                                    | Why it is safe                                                                                  |
| :----------------------------------- | :---------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `lib/f402_bet_ticker_jsonl.ts:169`   | `handle.read(buffer, read, length - read, …)`   | `writtenUint8Prefix(buffer, read)` exposes only the written prefix                              |
| `scripts/live_positions_cron.ts:375` | `bytesRead = readSync(fd, buf, 0, len, offset)` | `decoder.decode(buf.subarray(0, bytesRead))` slices to `bytesRead`                              |
| `lib/gslive_tally_rollup.ts:432-679` | SoA `Uint8Array` columns                        | Only indices `0..groupCount-1` / `0..cellCount-1` are read after insert paths write every field |
