# Bun shape contracts — the 79 shapes this repository calls

The single source of truth is layered, and nothing here restates upstream text: **declarations** come from `bun-types@1.4.4` (the surface the reference site renders), **behaviour** from probes against the local `Bun 1.4.4` binary (`tests/bun_baseline.json`), **property attributes** from the pinned Bun commit `38afee6c84`. When they disagree: declarations win on names and signatures, the Bun source wins on attributes, and the measured binary wins on behaviour.

Each entry names its declaration, what the binary says about the member (kind and descriptor), the files that call it, the local evidence, and — where one exists — the deep dive that already owns the detail. Call sites are bare paths, never line numbers: `check:spec-citations` does not audit runbooks, so a line number here would rot silently.

Adding a `Bun.*` call without an entry in `lib/bun_shapes.ts` fails `tests/bun_shapes_coverage.test.ts`; the same test fails when an entry goes stale, loses its heading, or cites evidence that no longer exists.

## Upgrading

When upstream moves: bump `packageManager`, `engines.bun`, `.bun-version` and `@types/bun` together, run `bun run probe:bun` (baseline drift is the behaviour diff), then re-derive the declared surface with `./bin/dx bun --types`. Regenerate the member snapshot with `bun scripts/bun_shape_members.ts --baseline tests/bun_shape_members.json` and the catalog with `bun scripts/bun_shape_contracts.ts --write` (`--refresh-links` re-checks the permalinks), then review the diff. The coverage test reports the name diff before any prose is touched. Canary builds are out of scope.

---

## Process, filesystem and shell

- `Bun.argv` is an array, `Bun.env` an object, `Bun.main` a string — `proc.shell`.
- `Bun.stdin` / `Bun.stdout` are Blob-like with `text()`; nothing here reads them — `proc.stdio`.
- `Bun.nanoseconds()` is monotonic and `Bun.sleepSync(5)` blocks for at least 5 ms — `proc.timing`.
- `Bun.spawnSync(["echo","ok"])` returns `stdout` + `exitCode`; `Bun.gc(false)` returns a value that is `undefined` — `proc.spawn`.
- `Bun.which` honours a `PATH` override; `Bun.resolveSync` resolves against a directory; `Bun.fileURLToPath("file:///tmp/x.ts")` → `/tmp/x.ts`; `Bun.openInEditor` is a 1-arity function — `proc.paths`.
- `Bun.Terminal` is a constructor; `Bun.FileSink` has no runtime value — `proc.terminal`.

#### Bun.FileSink (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/FileSink)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/f402_hierarchy_redact_log.ts`
- **Evidence:** `probe:proc.terminal`, `test:tests/bun_capabilities.test.ts`

#### Bun.Terminal

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Terminal)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:Terminal`, `probe:proc.terminal`

#### Bun.argv

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/argv)
- **Shape:** value: `object` · writable true · enumerable true
- **Here:** `scripts/audit_bun_surface.ts`, `scripts/probe/parse-tree-only.ts`
- **Evidence:** `probe:proc.shell`

#### Bun.$

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (9):** `Shell`, `ShellError`, `ShellPromise`, `braces`, `cwd`, `env`, `escape`, `nothrow`, `throws`
- **Here:** `dsh-plugin/verify-load.mjs`
- **Evidence:** `test:tests/bun_shapes_coverage.test.ts`

#### Bun.file

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/file)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `dsh-plugin/verify-load.mjs`, `lib/fraud_logs.ts`
- **Evidence:** `surface:file`

#### Bun.fileURLToPath

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/fileURLToPath)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/local_path.ts`, `scripts/capture/f402_hierarchy_probe.ts`
- **Evidence:** `probe:proc.paths`

#### Bun.gc

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/gc)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scratch/bench_dod6_into.ts`, `scripts/probe/parse-tree-only.ts`
- **Evidence:** `probe:proc.spawn`

#### Bun.main

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/main)
- **Shape:** value: `undefined` · writable undefined · enumerable true
- **Here:** `scripts/capture/f402_hierarchy_probe.ts`
- **Evidence:** `probe:proc.shell`

#### Bun.nanoseconds

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/nanoseconds)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scratch/bench_dod6.ts`, `scripts/probe/parse-tree-only.ts`
- **Evidence:** `probe:proc.timing`

#### Bun.openInEditor

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/openInEditor)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_cli_errors.ts`
- **Evidence:** `probe:proc.paths`

#### Bun.resolveSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/resolveSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_agent_graph_layouts.ts`
- **Evidence:** `probe:proc.paths`

#### Bun.sleep

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/sleep)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/evidence_capture.ts`, `scripts/capture/batch_pending_delete_session.ts`
- **Evidence:** `surface:sleep`, `probe:proc.timing`

#### Bun.sleepSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/sleepSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_profile_lock.ts`
- **Evidence:** `probe:proc.timing`

#### Bun.spawn

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/spawn)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `cli/sportsdesk_cli.ts`, `lib/bun_terminal.ts`
- **Evidence:** `surface:spawn`

#### Bun.spawnSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/spawnSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/artifacts_cron.ts`, `scripts/catalog_probe.ts`
- **Evidence:** `probe:proc.spawn`

#### Bun.stdin

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/stdin)
- **Shape:** value: `object` · writable true · enumerable true
- **Here:** `bin/blob-formdata.ts`, `bin/image-meta.ts`
- **Evidence:** `probe:proc.stdio`

#### Bun.stdout

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/stdout)
- **Shape:** value: `object` · writable true · enumerable true
- **Here:** `cli/sportsdesk_replay_cli.ts`, `scripts/capture/f402_hierarchy_probe.ts`
- **Evidence:** `probe:proc.stdio`

#### Bun.which

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/which)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/agent_env_doctor.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:which`, `probe:proc.paths`

#### Bun.write

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/write)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `dsh-plugin/verify-load.mjs`, `scripts/capture/f402_probe.ts`
- **Evidence:** `surface:write`

#### Bun.isStandaloneExecutable

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** value: `boolean` · writable false · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:isStandaloneExecutable`

## Text and terminal rendering

- `Bun.stringWidth("漢")` → 2 and ANSI escape codes are ignored by default; `Bun.wrapAnsi` wraps at the given column width — `text.width`.
- `Bun.color("red", "hex")` → `#ff0000`; `Bun.enableANSIColors` is a boolean; `Bun.escapeHTML` escapes `&`, `<`, `>` — `text.ansi`.
- `Bun.inspect({a:[1]})` renders a stable multi-line form — `text.inspect`; `Bun.markdown` is exercised by the `markdown` surface check.

#### Bun.color

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/color)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `cli/sportsdesk_cli.ts`, `services/sportsdesk_ingestion_replay.ts`
- **Evidence:** `probe:text.ansi`

#### Bun.enableANSIColors

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/enableANSIColors)
- **Shape:** value: `boolean` · writable true · enumerable true
- **Here:** `lib/wagers_report.ts`, `scripts/render_tasks.ts`
- **Evidence:** `probe:text.ansi`

#### Bun.escapeHTML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/escapeHTML)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `services/sportsdesk_telegram_bot.ts`, `lib/dashboard_render.ts`
- **Evidence:** `probe:text.ansi`

#### Bun.inspect

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/inspect)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (2):** `custom`, `table`
- **Here:** `lib/wagers_report.ts`, `lib/cli_inspect.ts`
- **Evidence:** `surface:inspect.table`, `probe:text.inspect`

#### Bun.markdown

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/markdown)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (4):** `ansi`, `html`, `react`, `render`
- **Here:** `lib/markdown_react_ssr.ts`, `scripts/render_tasks.ts`
- **Evidence:** `surface:markdown` · deep dive: [§12](./bun_server_runtime_shapes_runbook.md)

#### Bun.stringWidth

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/stringWidth)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/wagers_report.ts`, `scripts/render_tasks.ts`
- **Evidence:** `probe:text.width`

#### Bun.wrapAnsi

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/wrapAnsi)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/render_docs.ts`, `scripts/render_tasks.ts`
- **Evidence:** `probe:text.width`

#### Bun.sliceAnsi

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:sliceAnsi`

## Data formats and parsing

- `Bun.JSON5` / `Bun.TOML` / `Bun.YAML` / `Bun.XML` / `Bun.JSONL` each parse a tiny document in-process — `data.parse`; `Bun.JSONC` also accepts comments — `data.json`.
- `new Bun.Glob("*.ts").match("a.ts")` → true, `"a.js"` → false — `data.glob`.
- `Bun.deepEquals` compares structure, not identity — `data.compare`.
- `new Bun.Cookie("a","b")` and `new Bun.CookieMap("a=b").get("a")` agree on the pair — `data.cookies`.
- `Bun.semver.satisfies("1.2.3", "^1.0.0")` → true and `Bun.semver.order("1.0.0", "1.0.1")` → -1 — `data.semver`.

#### Bun.Cookie

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Cookie)
- **Shape:** value: `function` · writable false · enumerable true
- **Members (2):** `from`, `parse`
- **Here:** `lib/cookie_jar.ts`
- **Evidence:** `probe:data.cookies`

#### Bun.CookieMap

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/CookieMap)
- **Shape:** value: `function` · writable false · enumerable true
- **Here:** `lib/cookie_jar.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:CookieMap`, `test:tests/bun_capabilities.test.ts`

#### Bun.Glob

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Glob)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/pm_policy.ts`, `scripts/audit_data_handling.ts`
- **Evidence:** `probe:data.glob`

#### Bun.JSON5

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/JSON5)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `bin/bun_surface.ts`, `lib/bun_xml_golden_ast.ts`
- **Evidence:** `surface:JSON5`, `probe:data.parse`

#### Bun.JSONC

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/JSONC)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (1):** `parse`
- **Here:** `lib/pm_policy.ts`
- **Evidence:** `probe:data.json`

#### Bun.JSONL

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/JSONL)
- **Shape:** value: `object` · writable false · enumerable true
- **Members (2):** `parse`, `parseChunk`
- **Here:** `lib/cron_journal.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:JSONL.parse`, `surface:JSONL.parseChunk`, `test:tests/bun_capabilities.test.ts`, `probe:data.parse` · deep dive: [§8.4](./bun_server_runtime_shapes_runbook.md)

#### Bun.TOML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/TOML)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `bin/bun_surface.ts`, `lib/config_file.ts`
- **Evidence:** `surface:TOML`, `probe:data.parse`

#### Bun.XML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/XML)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `lib/bun_xml_golden_ast.ts`, `lib/customer_profile.ts`
- **Evidence:** `surface:XML`, `probe:data.parse`

#### Bun.YAML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/YAML)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `bin/bun_surface.ts`, `lib/config_file.ts`
- **Evidence:** `surface:YAML`, `probe:data.parse`

#### Bun.deepEquals

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/deepEquals)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `dsh-plugin/verify-load.mjs`, `dsh-plugin-sidebar/verify-load.mjs`
- **Evidence:** `probe:data.compare`

#### Bun.semver

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/semver)
- **Shape:** value: `object` · writable false · enumerable true
- **Members (2):** `order`, `satisfies`
- **Here:** `bin/bun_surface.ts`, `lib/manager_fetch.ts`
- **Evidence:** `surface:semver.satisfies`, `probe:data.semver`

#### Bun.ImportKind (type, declared-only)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/ImportKind)
- **Shape:** type-only: declared, no runtime value
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_shapes_types.test-d.ts`

## Storage and scheduling

- `Bun.SQL`, `Bun.S3Client`, `Bun.RedisClient` are constructors; `Bun.Archive` round-trips in memory — write `{"a.txt":"hi"}`, read `files()` back to the same key — `storage.archive`.
- `Bun.cron` returns a `CronJob`; `Bun.CronController` is a type (no runtime value).
- `Bun.secrets.get` is covered by the `secrets.get` surface check.

#### Bun.Archive

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Archive)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (1):** `write`
- **Here:** `lib/eod_archive.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:Archive`, `probe:storage.archive`

#### Bun.CronController (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/CronController)
- **Shape:** type-only: declared, no runtime value
- **Here:** `scripts/wagers_by_state_capture.ts`, `lib/bun_cron.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`

#### Bun.RedisClient

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/RedisClient)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:RedisClient`, `test:tests/bun_capabilities.test.ts`

#### Bun.S3Client

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/S3Client)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (9):** `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`, `unlink`, `write`
- **Here:** `bin/bun_surface.ts`, `lib/r2_s3_client.ts`
- **Evidence:** `surface:S3Client`

#### Bun.s3

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (9):** `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`, `unlink`, `write`
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:s3`, `test:tests/bun_s3client_contract.test.ts`

#### Bun.S3File (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** type-only: declared, no runtime value
- **Here:** `types/bun-api.d.ts`
- **Evidence:** `test:tests/bun_s3client_contract.test.ts`

#### Bun.S3Options (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`, `types/bun-api.d.ts`
- **Evidence:** `test:tests/bun_s3client_contract.test.ts`

#### Bun.S3Stats (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** type-only: declared, no runtime value
- **Here:** `types/bun-api.d.ts`
- **Evidence:** `test:tests/bun_s3client_contract.test.ts`

#### Bun.SQL

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/SQL)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (13):** snapshot in tests/bun_shape_members.json
- **Here:** `lib/customer_index.ts`, `lib/probe_index.ts`
- **Evidence:** `surface:SQL`, `test:tests/bun_capabilities.test.ts`

#### Bun.cron

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/cron)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (2):** `parse`, `remove`
- **Here:** `lib/bun_cron.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:cron`, `test:tests/bun_capabilities.test.ts`

#### Bun.secrets

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/secrets)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (3):** `delete`, `get`, `set`
- **Here:** `scripts/secrets_r2.ts`, `lib/github_token.ts`
- **Evidence:** `surface:secrets.get`, `test:tests/bun_capabilities.test.ts`

## Crypto, hashing and compression

- `new Bun.CryptoHasher("sha256").update("x").digest("hex")` is 64 hex chars; `Bun.hash("x")` returns a bigint while `Bun.hash.crc32`/`adler32` return numbers; `Bun.randomUUIDv7()` is 36 chars with version nibble `7` — `crypto.hash`.
- zstd and gzip round-trip: compress → decompress returns the input; `new Bun.ArrayBufferSink()` and `Bun.concatArrayBuffers` exist — `crypto.compress`.

#### Bun.CSRF

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `generate`, `verify`
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:CSRF`

#### Bun.ArrayBufferSink

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/ArrayBufferSink)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`
- **Evidence:** `probe:crypto.compress`

#### Bun.CryptoHasher

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/CryptoHasher)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (2):** `algorithms`, `hash`
- **Here:** `lib/r2_s3_client.ts`, `lib/bun_xml_golden_ast.ts`
- **Evidence:** `probe:crypto.hash`

#### Bun.concatArrayBuffers

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/concatArrayBuffers)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/jsonl_stream_replay.ts`, `lib/schema_binary.ts`
- **Evidence:** `probe:crypto.compress`

#### Bun.readableStreamToArrayBuffer

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_credentials_policy.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`

#### Bun.gunzipSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/gunzipSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`
- **Evidence:** `probe:crypto.compress`

#### Bun.gzipSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/gzipSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`, `lib/http_compression.ts`
- **Evidence:** `probe:crypto.compress`

#### Bun.hash

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/hash)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (12):** `adler32`, `cityHash32`, `cityHash64`, `crc32`, `murmur32v2`, `murmur32v3`, `murmur64v2`, `rapidhash`, `wyhash`, `xxHash3`, `xxHash32`, `xxHash64`
- **Here:** `lib/manager_fetch.ts`, `lib/f402_agent_graph_views.ts`
- **Evidence:** `probe:crypto.hash`

#### Bun.randomUUIDv7

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/randomUUIDv7)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_hierarchy_trace.ts`, `scripts/capture/shot.ts`
- **Evidence:** `probe:crypto.hash`

#### Bun.zstdCompress

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/zstdCompress)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_hierarchy_pack.ts`
- **Evidence:** `probe:crypto.compress`

#### Bun.zstdCompressSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/zstdCompressSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`, `lib/docs_render_cache.ts`
- **Evidence:** `probe:crypto.compress`

#### Bun.zstdDecompressSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/zstdDecompressSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_weblog.ts`, `lib/schema_binary.ts`
- **Evidence:** `probe:crypto.compress`

## Network and serving

- `Bun.fetch`, `Bun.serve`, `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.FetchSession` are functions (surface checks + capabilities test).
- `Bun.dns` is an object; the reference documents only `lookup`/`prefetch`/`getCacheStats` while the binary also has 15 resolver methods — see the drift section in ../bun-upstream-reference.md.
- `Bun.Server` and `Bun.FetchProxyOption` are types (`Server<WebSocketData>` takes a type argument).

#### Bun.FetchProxyOption (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/FetchProxyOption)
- **Shape:** type-only: declared, no runtime value
- **Here:** `scripts/capture/session.ts`, `scripts/catalog_probe.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts` · deep dive: [§7.2](./bun_server_runtime_shapes_runbook.md)

#### Bun.FetchSession

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/FetchSession)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `services/sportsdesk_telegram_bot.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:FetchSession`, `test:tests/bun_capabilities.test.ts` · deep dive: [§7.3](./bun_server_runtime_shapes_runbook.md)

#### Bun.Server (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Server)
- **Shape:** type-only: declared, no runtime value
- **Here:** `services/sportsdesk_webview_server.ts`, `services/blob_and_live_bets_server.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts` · deep dive: [§2](./bun_server_runtime_shapes_runbook.md)

#### Bun.connect

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/connect)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/tls_provenance.ts`
- **Evidence:** `surface:connect`, `test:tests/bun_capabilities.test.ts` · deep dive: [§8.2](./bun_server_runtime_shapes_runbook.md)

#### Bun.dns

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/dns)
- **Shape:** value: `object` · writable false · enumerable true
- **Members (21):** snapshot in tests/bun_shape_members.json
- **Here:** `lib/preflight.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:dns.lookup`

#### Bun.fetch

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/fetch)
- **Shape:** value: `function` · writable false · enumerable true
- **Members (1):** `preconnect`
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:fetch`, `test:tests/bun_capabilities.test.ts`

#### Bun.listen

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/listen)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:listen`, `test:tests/bun_capabilities.test.ts` · deep dive: [§8.1](./bun_server_runtime_shapes_runbook.md)

#### Bun.serve

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/serve)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/docs_server.ts`, `services/sportsdesk_webview_server.ts`
- **Evidence:** `surface:serve`, `test:tests/bun_capabilities.test.ts` · deep dive: [§2](./bun_server_runtime_shapes_runbook.md)

#### Bun.udpSocket

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/udpSocket)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:udpSocket`, `test:tests/bun_capabilities.test.ts` · deep dive: [§8.3](./bun_server_runtime_shapes_runbook.md)

## Image and WebView

- `Bun.Image` and `Bun.WebView` are constructors; `metadata()` on a 1×1 PNG reads `{width:1, height:1, format:"png"}` — `image.metadata`. Both have deep contracts in the server shapes runbook.

#### Bun.Image

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Image)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (4):** `backend`, `clipboardChangeCount`, `fromClipboard`, `hasClipboardImage`
- **Here:** `lib/screenshot_encode.ts`, `services/blob_and_live_bets_server.ts`
- **Evidence:** `surface:Image`, `test:tests/bun_capabilities.test.ts`, `probe:image.metadata`

#### Bun.WebView

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/WebView)
- **Shape:** value: `function` · writable false · enumerable true
- **Members (1):** `closeAll`
- **Here:** `scripts/capture/webview.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:WebView` · deep dive: [§9](./bun_server_runtime_shapes_runbook.md)

## Runtime metadata and environment

- `Bun.version` and `Bun.revision` are strings; `Bun.version_with_sha` is `v<version> (<short sha>)` where the short sha is a prefix of `Bun.revision` — `proc.meta`.
- `Bun.env` is the process environment object (`proc.shell`); `Bun.Env` is a type.

#### Bun.Env (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/Env)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/secret_manifest.ts`, `types/env.d.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`

#### Bun.env

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/env)
- **Shape:** value: `object` · writable false · enumerable true
- **Here:** `scripts/probe/parse-tree-only.ts`, `scripts/capture/reprobe_pending_500s.ts`
- **Evidence:** `probe:proc.shell`

#### Bun.revision

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/revision)
- **Shape:** value: `string` · writable false · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/f402_portal_runtime_pin.ts`
- **Evidence:** `probe:proc.meta`

#### Bun.version

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/version)
- **Shape:** value: `string` · writable false · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/manager_fetch.ts`
- **Evidence:** `probe:proc.meta`

#### Bun.version_with_sha

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/globals/bun/version_with_sha)
- **Shape:** value: `string` · writable false · enumerable false
- **Here:** `scripts/probe_bun.ts`, `scratch/bench_dod6_into.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`
