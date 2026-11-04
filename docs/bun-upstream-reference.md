# Bun docs (upstream)

When to trust oven-sh/bun docs vs this repo. Evidence labels here beat upstream prose.

## Runtime (behavior SSOT)

| What          | Where                                                                             |
| ------------- | --------------------------------------------------------------------------------- |
| Release       | [bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (2026-10-22) |
| Commit        | `38afee6c84fcf48c0edb2466aa4b27d287a59c30`                                        |
| This repo     | `package.json` `packageManager` / `engines`, `@types/bun@1.4.4`                   |
| After upgrade | `bun run probe:bun` vs `tests/bun_baseline.json`                                  |

## Type declarations

Two different things:

| Layer                      | What                                                                                             | This repo                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Project types              | `@types/bun` → `bun-types` on npm                                                                | `devDependencies` `@types/bun@1.4.4`; must match `Bun.version` (`bin/bun_surface --strict`)                                 |
| Embedded in the Bun binary | `@types/node`, `undici-types`, plus types pulled in via `bun-types` (`expect-type`, `jest-mock`) | Used when you `bun build --compile --aot` without installing `@types/bun`; not a substitute for day-to-day `bun check` here |

Legal list and licenses: [project/license → type declarations](https://bun.com/docs/project/license#type-declarations). Prod dependency audit: regenerate root `licenses.json` per `.gitignore` comment (`bun pm licenses --prod --json`).

## API reference (`bun.com/reference`)

[reference/globals/bun](https://bun.com/reference/globals/bun) is the **third** upstream surface: an index of the symbols in the `bun` module, one page per symbol, generated from the release's TypeScript declarations rather than written by hand. Pages exist for symbols ([`wrapAnsi`](https://bun.com/reference/globals/bun/wrapAnsi)), the types in their signatures ([`WrapAnsiOptions`](https://bun.com/reference/globals/bun/WrapAnsiOptions)), and nested members ([`Image/ErrorCode`](https://bun.com/reference/globals/bun/Image/ErrorCode)). Each page carries the release it was generated from (`Bun v 1.4.4` on 2026-11-03).

Four URL shapes, each with one job (counts read off the site on 2026-11-03):

| URL                                                               | Covers                                                                  | Use when                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| [`/reference`](https://bun.com/reference)                         | the tree: 51 `node:*` pages, 6 `bun:*` pages, and `/reference/globals`  | you do not know which namespace holds it |
| [`/reference/globals/bun`](https://bun.com/reference/globals/bun) | every symbol in the `bun` module, value and type — **322** symbol pages | you have a name and need its page        |
| `/reference/node/<module>`                                        | Node-compat surface, one page per module                                | a dependency's Node call, not repo code  |
| `/reference/bun/<module>`                                         | `bun:test`, `bun:sqlite`, `bun:ffi`, `bun:jsc`, `bun:bundle`            | the module behind an import              |

Search is **UI-only**: press `/` on the site, and note there is no addressable query — `/reference?q=stringWidth` returns byte-identical HTML, and `/reference/search` is 404 (both checked 2026-11-03). So the shareable unit is a symbol permalink, never a search URL; that is why this doc cites `/reference/globals/bun/<symbol>` rather than pointing at a query.

### The module and the global are one surface

The page opens with the model itself: _"The `bun` module is where most of Bun's APIs are located. You can import all of the values and types in this module with an import statement, or by referencing the `Bun` global namespace."_ On 1.4.4 that is one object set, not two implementations:

```sh
bun -e 'const m = await import("bun"); console.log(Object.getOwnPropertyNames(m).length, Object.getOwnPropertyNames(Bun).length, Object.keys(m).length)'
# 117 117 112
```

The same 117 names on both, every value identical (`m.file === Bun.file`, and so on for all 117, checked 2026-11-03). Three consequences for reading code and for this doc:

- **`Object.keys` undercounts.** Five exports are non-enumerable — `cwd`, `jest`, `origin`, `registerMacro`, `version_with_sha` — so a keys-based inventory says 112 while `in` and direct access see 117. Inventory with `Object.getOwnPropertyNames`:

  ```sh
  bun -e 'const m = await import("bun"); console.log(Object.getOwnPropertyNames(m).filter(k => !Object.keys(m).includes(k)).sort().join(", "))'
  # cwd, jest, origin, registerMacro, version_with_sha
  ```

  What the five are, on 1.4.4:

  | Member             | runtime value / type                                                         | In `bun-types@1.4.4`? | Read here              |
  | ------------------ | ---------------------------------------------------------------------------- | --------------------- | ---------------------- |
  | `cwd`              | string, writable — the process working directory                             | no (runtime-only)     | no                     |
  | `jest`             | function                                                                     | no (runtime-only)     | no                     |
  | `origin`           | string; `""` in every context tried (eval, file, `--port`, `--origin`, `-u`) | no (runtime-only)     | no                     |
  | `registerMacro`    | function                                                                     | no (runtime-only)     | no                     |
  | `version_with_sha` | string, `"v1.4.4 (38afee6c8)"`                                               | yes, `bun.d.ts`       | `scripts/probe_bun.ts` |

  `origin` is the one that looks settable and is not. At the pin, `--origin`/`-u` fills **`TransformOptions.origin`** — the bundler's origin, with `--port` alone synthesizing `http://localhost:<port>/` into the same field ([`Arguments.rs`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/cli/Arguments.rs#L1103-L1105), [L1505](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/cli/Arguments.rs#L1505-L1510)). `Bun.origin` reads something else: **`VirtualMachine.origin`**, a `bun_url::URL` used to build source URLs in error frames when `is_from_devserver` ([`get_origin`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/api/BunObject.rs#L686-L688)), registered as a lazy read-only `PropertyCallback` ([`BunObject.cpp:996`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/BunObject.cpp#L996)). The VM field starts empty (`VirtualMachine` init) and I found no CLI or bunfig path that writes it — `bunfig.toml` sets the same bundler field instead ([`bunfig.rs:405`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/bunfig/bunfig.rs#L405-L408)). When it _is_ non-empty it rewrites imported assets to public URLs rather than filesystem paths ([`jsc_hooks.rs:3471`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/jsc_hooks.rs#L3471-L3476)), which is the dev-server case and nobody else's. That is why it measured `""` for every invocation tried — `--origin` included. And note the descriptor surprise: all five report as **data** properties from JS even though C++ declares `origin` a lazy `PropertyCallback`; the lazy slot materializes before the descriptor is observable.

  So the trap is not academic: four of the five are undeclared runtime extras, and the one the repo does read — `version_with_sha` in [`scripts/probe_bun.ts`](../scripts/probe_bun.ts) — is stored in [`tests/bun_baseline.json`](../tests/bun_baseline.json) as the `_bun` runtime row, which the baseline diff deliberately skips. Its presence is unguarded; only its use is visible.

- **There is no default export** (`m.default === undefined`). `import Bun from "bun"` does not give you the global; use `import { … } from "bun"`, `import * as Bun from "bun"`, or the bare `Bun` global.
- **Filed under the module page ≠ exported.** `WebSocket`, `Worker` and `EventSource` are listed on the module page yet are properties of neither `m` nor `Bun` — `globalThis.WebSocket` is the only spelling, which is the `websocket-global` drift id below.

The module page files **25 namespaces** under `Bun.*`. Eighteen exist at runtime — `$`, `CSRF`, `dns`, `Image`, `inspect`, `JSON5`, `JSONC`, `JSONL`, `markdown`, `peek`, `RedisClient`, `semver`, `SQL`, `TOML`, `unsafe`, `WebView`, `XML`, `YAML` — and seven do **not** (`typeof Bun.X === "undefined"`). Those seven are type companions, not missing features:

| Declared, type-only | Runtime value to reach for | What the namespace is for                        |
| ------------------- | -------------------------- | ------------------------------------------------ |
| `Bun.Serve`         | `Bun.serve()`              | server/handler option types                      |
| `Bun.Spawn`         | `Bun.spawn()`              | `Subprocess` and spawn option types              |
| `Bun.Password`      | `Bun.password`             | argon2/bcrypt hash + verify types                |
| `Bun.udp`           | `Bun.udpSocket()`          | UDP socket types                                 |
| `Bun.Build`         | `Bun.build()`              | build result and option types                    |
| `Bun.Security`      | —                          | `bun install` security-scanner declarations only |
| `Bun.WebAssembly`   | `globalThis.WebAssembly`   | types only; the value is the JS global           |

`./bin/dx bun --types` prints the same split (`namespace 18 value · 7 type-only`, same seven names), so this table is machine-checked rather than read off prose. The consequence is small but sharp: `Bun.Serve` and friends are for **type positions** — annotations and signatures — and are `undefined` if you reach for them as values. The lower-case counterparts each have their own symbol page ([`serve`](https://bun.com/reference/globals/bun/serve), [`spawn`](https://bun.com/reference/globals/bun/spawn), [`password`](https://bun.com/reference/globals/bun/password), [`udpSocket`](https://bun.com/reference/globals/bun/udpSocket), [`build`](https://bun.com/reference/globals/bun/build)); the capitalised one is the type.

Pick the layer by the question you are asking:

| Question                                                       | Layer                                              | Why                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How does this behave, and what are the defaults?               | [docs](https://bun.com/docs)                       | Prose + worked examples. The only layer that states defaults.                                                                                          |
| What is this called, where does it live, what's the signature? | [reference](https://bun.com/reference/globals/bun) | Per-symbol permalinks to cite; exact option keys and types.                                                                                            |
| Will it work in this runtime, right now?                       | The binary in `Bun.version`                        | The reference renders declarations; a declaration can lag or lead the executable.                                                                      |
| What does `bun check` accept?                                  | `node_modules/.bun/node_modules/bun-types`         | Pinned `@types/bun@1.4.4` — this repo's compile surface. On 2026-11-03 the reference's `/dns` page matched this file exactly (no `resolve` in either). |

The reference is a **declaration** view, not a behavior view — verified both directions on **2026-11-03** against `Bun.version` **1.4.4**:

| Probe                              | Reference says                                                                                                                                       | This 1.4.4 binary                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Bun.dns.resolve`                  | Absent: [/dns](https://bun.com/reference/globals/bun/dns) lists `lookup`, `prefetch`, `getCacheStats` only                                           | `typeof Bun.dns.resolve === "function"`                                                                     |
| `Bun.WebSocket`, `Bun.Worker`      | Filed under the `bun` module: [/WebSocket](https://bun.com/reference/globals/bun/WebSocket), [/Worker](https://bun.com/reference/globals/bun/Worker) | `Bun.WebSocket` and `Bun.Worker` are `undefined`; the constructors are the globals `WebSocket` and `Worker` |
| Defaults on `Bun.wrapAnsi` options | No `default` anywhere on [/WrapAnsiOptions](https://bun.com/reference/globals/bun/WrapAnsiOptions) (0 occurrences)                                   | Defaults exist and are measurable — see [Text width and ANSI](#text-width-and-ansi-bun-native)              |

Both drift cases are already pinned in [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts) (globals-vs-`Bun` assertions, and the `dns` cast comment), so the doc is describing a guarded fact, not a new claim.

### Declaration drift, measured

`./bin/dx bun --types` diffs `bun-types@1.4.4` against the running binary instead of trusting either. Its output on **2026-11-03** (`Bun 1.4.4 (38afee6c84)`):

| Measure                          | Value                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared names                   | 113                                                                                                                                                                                                                 |
| Runtime names                    | 117                                                                                                                                                                                                                 |
| Runtime, undeclared at top level | `FFI`, `cwd`, `jest`, `origin`, `registerMacro`                                                                                                                                                                     |
| Runtime, undeclared in `Bun.dns` | 15: `resolve`, `resolveSrv`, `resolveTxt`, `resolveSoa`, `resolveNaptr`, `resolveMx`, `resolveCaa`, `resolveNs`, `resolvePtr`, `resolveCname`, `resolveAny`, `getServers`, `setServers`, `reverse`, `lookupService` |
| Declared, absent at runtime      | `CryptoHashInterface` — a type name, so "absent" is the correct answer, not a gap                                                                                                                                   |

Cross-checked against the reference the same day: its [`/dns`](https://bun.com/reference/globals/bun/dns) page documents `lookup`, `prefetch` and `getCacheStats`, and **none** of those fifteen; the index has no page for `cwd`, `jest`, `origin`, `registerMacro` or `FFI`, while [`CryptoHashInterface`](https://bun.com/reference/globals/bun/CryptoHashInterface) does have one. So **20 members of this binary are undocumented upstream**, and the undocumented `dns` set is node's resolver family grafted onto `Bun.dns` — they are not stubs:

```sh
bun -e 'console.log(Bun.dns.getServers()); console.log(await Bun.dns.resolve("example.com", "A"))'
# [ "2600:1700:6560:2470::1", "192.168.1.254" ]
# [ { address: "104.20.23.154", ttl: 55 }, … ]      ← real answers; TTL and order vary per query
```

The `drift` array in `./bin/dx bun --json` carries the two cases as ids — `websocket-global` and `dns-resolve` — which are exactly the rows in the table above. When the counts move, the tool is the thing to re-run; do not hand-maintain this table.

### Permalinks for the surface this tooling calls

The ops code leans on these eighteen. Each link is a symbol page, not the index — what you cite when a review asks where a name or option key came from. Representative module, not an exhaustive caller list (counts drift; re-grep when in doubt).

| Called here        | Reference page                                                       | Representative module                                                             |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Bun.file`         | [`file`](https://bun.com/reference/globals/bun/file)                 | [lib/f402_agent_graph_view_http.ts](../lib/f402_agent_graph_view_http.ts)         |
| `Bun.write`        | [`write`](https://bun.com/reference/globals/bun/write)               | [scripts/capture/f402_probe.ts](../scripts/capture/f402_probe.ts)                 |
| `Bun.env`          | [`env`](https://bun.com/reference/globals/bun/env)                   | [lib/f402_hierarchy_config.ts](../lib/f402_hierarchy_config.ts)                   |
| `Bun.spawn`        | [`spawn`](https://bun.com/reference/globals/bun/spawn)               | [lib/bun_terminal.ts](../lib/bun_terminal.ts)                                     |
| `Bun.which`        | [`which`](https://bun.com/reference/globals/bun/which)               | [scripts/pm_doctor.ts](../scripts/pm_doctor.ts)                                   |
| `Bun.dns`          | [`dns`](https://bun.com/reference/globals/bun/dns)                   | [lib/preflight.ts](../lib/preflight.ts)                                           |
| `Bun.serve`        | [`serve`](https://bun.com/reference/globals/bun/serve)               | [services/sportsdesk_webview_server.ts](../services/sportsdesk_webview_server.ts) |
| `Bun.WebView`      | [`WebView`](https://bun.com/reference/globals/bun/WebView)           | [scripts/capture/webview.ts](../scripts/capture/webview.ts)                       |
| `Bun.FetchSession` | [`FetchSession`](https://bun.com/reference/globals/bun/FetchSession) | [scripts/capture/session.ts](../scripts/capture/session.ts)                       |
| `Bun.SQL`          | [`SQL`](https://bun.com/reference/globals/bun/SQL)                   | [lib/probe_index.ts](../lib/probe_index.ts)                                       |
| `Bun.JSONL`        | [`JSONL`](https://bun.com/reference/globals/bun/JSONL)               | [lib/cron_journal.ts](../lib/cron_journal.ts)                                     |
| `Bun.secrets`      | [`secrets`](https://bun.com/reference/globals/bun/secrets)           | [scripts/secrets_f402.ts](../scripts/secrets_f402.ts)                             |
| `Bun.Archive`      | [`Archive`](https://bun.com/reference/globals/bun/Archive)           | [lib/eod_archive.ts](../lib/eod_archive.ts)                                       |
| `Bun.cron`         | [`cron`](https://bun.com/reference/globals/bun/cron)                 | [lib/bun_cron.ts](../lib/bun_cron.ts)                                             |
| `Bun.Image`        | [`Image`](https://bun.com/reference/globals/bun/Image)               | [lib/screenshot_encode.ts](../lib/screenshot_encode.ts)                           |
| `Bun.markdown`     | [`markdown`](https://bun.com/reference/globals/bun/markdown)         | [scripts/render_tasks.ts](../scripts/render_tasks.ts)                             |
| `Bun.XML`          | [`XML`](https://bun.com/reference/globals/bun/XML)                   | [lib/customer_profile.ts](../lib/customer_profile.ts)                             |
| `Bun.stringWidth`  | [`stringWidth`](https://bun.com/reference/globals/bun/stringWidth)   | [lib/wagers_report.ts](../lib/wagers_report.ts)                                   |

Refresh the inventory with:

```sh
grep -rhoE '\bBun\.[A-Za-z_][A-Za-z0-9_]*' --include=*.ts lib scripts bin cli services tests | sort | uniq -c | sort -rn
```

### Deep pages

The permalink grammar is `/reference/globals/bun/<Namespace>/<Member>`, and **nested member pages resolve even when the parent page's body never names them**. The [`Image`](https://bun.com/reference/globals/bun/Image) namespace page lists `ConstructorOptions`, `ResizeOptions`, `ModulateOptions`, `Metadata`, `Format`, `Filter` and `ErrorCode` — and says nothing about `backend`, which nevertheless has its own page at [`Image/backend`](https://bun.com/reference/globals/bun/Image/backend) carrying the rule this repo already encodes in [`lib/screenshot_encode.ts`](../lib/screenshot_encode.ts): `"system"` is the macOS default, `"bun"` is byte-identical to a Linux build, and in-flight pipelines keep whichever value was current when they were scheduled. A parent page's body is therefore **not an inventory** — probe the member permalink before recording a gap (nearly logged `backend` as undocumented that way on 2026-11-03).

| Deep page                                                                                                                                                                                                                                                                                     | Answers                                                                              | Anchors here                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`StringWidthOptions`](https://bun.com/reference/globals/bun/StringWidthOptions)                                                                                                                                                                                                              | the three width flags — see [Text width and ANSI](#text-width-and-ansi-bun-native)   | `lib/wagers_report.ts`                                                 |
| [`WhichOptions`](https://bun.com/reference/globals/bun/WhichOptions)                                                                                                                                                                                                                          | `PATH`, `cwd`                                                                        | `scripts/pm_doctor.ts`                                                 |
| [`CronOptions`](https://bun.com/reference/globals/bun/CronOptions), [`CronJob`](https://bun.com/reference/globals/bun/CronJob)                                                                                                                                                                | `tz`; in-process vs OS-level registration, and which survives a restart              | `lib/bun_cron.ts`                                                      |
| [`ArchiveOptions`](https://bun.com/reference/globals/bun/ArchiveOptions), [`ArchiveExtractOptions`](https://bun.com/reference/globals/bun/ArchiveExtractOptions)                                                                                                                              | compression settings, extract filters                                                | `lib/eod_archive.ts`                                                   |
| [`BunFile`](https://bun.com/reference/globals/bun/BunFile)                                                                                                                                                                                                                                    | the lazy `Blob` behind `Bun.file` — size invalid until read, type from the extension | `lib/f402_agent_graph_view_http.ts`                                    |
| [`Subprocess`](https://bun.com/reference/globals/bun/Subprocess)                                                                                                                                                                                                                              | the shape `Bun.spawn` returns (stdin/stdout/exit)                                    | `lib/bun_terminal.ts`                                                  |
| [`Serve`](https://bun.com/reference/globals/bun/Serve), [`Server`](https://bun.com/reference/globals/bun/Server), [`ServerWebSocket`](https://bun.com/reference/globals/bun/ServerWebSocket)                                                                                                  | handler options, upgrade contract, websocket framing                                 | `services/sportsdesk_webview_server.ts`                                |
| [`WebView`](https://bun.com/reference/globals/bun/WebView)                                                                                                                                                                                                                                    | headless WebView surface                                                             | `scripts/capture/webview.ts`                                           |
| [`Image`](https://bun.com/reference/globals/bun/Image) + [`ConstructorOptions`](https://bun.com/reference/globals/bun/Image/ConstructorOptions), [`Image/backend`](https://bun.com/reference/globals/bun/Image/backend), [`ErrorCode`](https://bun.com/reference/globals/bun/Image/ErrorCode) | `maxPixels`/`autoOrient` gating, backend pinning, rejection codes                    | `lib/logo_image.ts`, `lib/screenshot_encode.ts`, `lib/image_errors.ts` |

Module pages cover imports, not globals: [`bun:test`](https://bun.com/reference/bun/test) (nearly every test file here, 251 of them at 2026-11-03, 6 without it), [`bun:sqlite`](https://bun.com/reference/bun/sqlite) (21 imports), [`bun:ffi`](https://bun.com/reference/bun/ffi) (2), [`bun:jsc`](https://bun.com/reference/bun/jsc) (1) — [`bun:bundle`](https://bun.com/reference/bun/bundle) is build-time only.

The index also carries one page per `node:*` module under `/reference/node/<module>` — Bun's Node-compatibility surface, module by module ([`node:fs`](https://bun.com/reference/node/fs), [`node:child_process`](https://bun.com/reference/node/child_process), [`node:dns`](https://bun.com/reference/node/dns), [`node:util`](https://bun.com/reference/node/util), [`node:zlib`](https://bun.com/reference/node/zlib)). That answers a dependency's Node usage — whether the call exists and what it does under Bun — and it is not licence for Node-style code here: `bun run policy:check` decides that, and the frozen baseline is where exceptions live.

Two practical notes: the reference serves **HTML only** — `/reference/globals/bun.md` and a `.json` sibling both return 404 (2026-11-03) — so cite permalinks instead of scraping; and the site tracks the newest release, so a permalink describes _that_ version, not necessarily this repo's pin. When the two differ, `@types/bun` here and `Bun.version` here win, and `bun run probe:bun` is what says so.

## JavaScriptCore (Bun engine builds only)

Bun is MIT. The runtime **statically links** JavaScriptCore/WebKit (LGPL-2), so distributors who modify that stack must offer a relink path. Fork: [github.com/oven-sh/WebKit](https://github.com/oven-sh/WebKit) (docs also spell the URL `oven-sh/webkit`; GitHub treats it as the same repo).

| Step            | Command                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| Clone fork      | `git clone https://github.com/oven-sh/WebKit vendor/WebKit`                   |
| Match Bun’s pin | `bun sync-webkit-source` (`WEBKIT_VERSION` in `scripts/build/deps/webkit.ts`) |
| Relink binary   | `bun run build:local`                                                         |

Full context: [project/license → JavaScriptCore](https://bun.com/docs/project/license#javascriptcore). **sportsdesk-ops** consumes the official [bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) binary; this section applies only if you patch Bun/JSC upstream.

## `bun install`

Upstream: [pm/cli/install](https://bun.com/docs/pm/cli/install). **Operational SSOT for this repo** (machine bunfig, `bun-deps`, lock traps, walkthroughs, test matrix, doctor catalog): **[runbooks/bun-pm-policy.md](./runbooks/bun-pm-policy.md)**.

Summary only:

| Upstream                                                | sportsdesk-ops                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Reproducible install via `--frozen-lockfile` / `bun ci` | CI + README: `bun install --frozen-lockfile`                                     |
| Dependency lifecycle via `trustedDependencies`          | Root list pinned to **`[]`** (no default allow list)                             |
| Project + global `bunfig.toml` merge                    | **`[install]` machine keys only in global dotfiles** — not in repo `bunfig.toml` |
| Lockfile text `bun.lock`                                | Committed; `pm:doctor` + policy tests stricter than frozen alone                 |

Changing deps on a maintainer machine: **`bun-deps`** / `bun run deps` / `./bin/dx deps` (see runbook). Verify: `bun run pm:doctor`, `bun test tests/bun_config_policy.test.ts`.

<!-- Detailed PM sections live in runbooks/bun-pm-policy.md; do not duplicate here. -->

## Project `bunfig.toml` (non-PM)

Install-related keys stay out of the repo copy ([runbook → machine keys](./runbooks/bun-pm-policy.md)). This repo **does** set `[run] noOrphans = true` (parent-death cleanup for spawned processes including headless WebView). Fmt ignore patterns are tool-owned; see file header comments.

## Text width and ANSI (Bun-native)

Upstream: [runtime/utils → `Bun.wrapAnsi()` Options](https://bun.com/docs/runtime/utils#options) for behavior and defaults; [`wrapAnsi`](https://bun.com/reference/globals/bun/wrapAnsi) and [`WrapAnsiOptions`](https://bun.com/reference/globals/bun/WrapAnsiOptions) for spelling and types. The three ANSI/width helpers are core runtime APIs — no dependency, no `typeof Bun` guard.

| Need                                | Bun API             | npm package it replaces |
| ----------------------------------- | ------------------- | ----------------------- |
| Strip escape codes                  | `Bun.stripANSI()`   | `strip-ansi`            |
| Rendered column width (emoji-aware) | `Bun.stringWidth()` | `string-width`          |
| Wrap to a column width, ANSI-safe   | `Bun.wrapAnsi()`    | `wrap-ansi`             |

None of the npm originals is a dependency here — no `strip-ansi`, `string-width`, or `wrap-ansi` in `package.json` or `bun.lock` — and the native versions are already in use: `Bun.stringWidth` at 25 call sites, `Bun.wrapAnsi` at 6, `Bun.stripANSI` at 3 (2026-11-03).

`Bun.wrapAnsi(input: string, columns: number, options?: WrapAnsiOptions): string` — four flags, defaults per [`WrapAnsiOptions`](https://bun.com/reference/globals/bun/WrapAnsiOptions), semantics measured here:

| Flag                | Default | Measured on 1.4.4 (2026-11-03)                                                                                                                 |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `hard`              | `false` | An over-long token is left whole, so a row can exceed `columns`: `wrapAnsi("abcdefgh", 3)` → `"abcdefgh"`; with `true` → `"abc\ndef\ngh"`.     |
| `wordWrap`          | `true`  | `false` breaks mid-word at exactly `columns` **even when `hard` is `false`**: `"abcdefgh"` at 3 → `"abc\ndef\ngh"`, identical to `hard: true`. |
| `trim`              | `true`  | `false` keeps per-row padding and the trailing-space row: `wrapAnsi("  hello   world  ", 8, { trim: false })` → `"  hello \n  world \n "`.     |
| `ambiguousIsNarrow` | `true`  | Applies to wrapping, not only measuring: `wrapAnsi("─────", 3, { hard: true })` → `"───\n──"`; with `false` → `"─\n─\n─\n─\n─"`.               |

`Bun.stringWidth(input, options?: StringWidthOptions)` takes three flags. The [Utils docs page](https://bun.com/docs/runtime/utils) inlines two of them (`countAnsiEscapeCodes`, `ambiguousIsNarrow`, both with defaults); [`StringWidthOptions`](https://bun.com/reference/globals/bun/StringWidthOptions) is the only upstream page that also names `perCodePoint` — the flag that changes emoji/ZWJ measurement:

| Flag                   | Default                 | Measured on 1.4.4 (2026-11-03)                                    |
| ---------------------- | ----------------------- | ----------------------------------------------------------------- |
| `ambiguousIsNarrow`    | `true`                  | `─` → 1 column; `false` → 2                                       |
| `countAnsiEscapeCodes` | unset ignores the codes | `ESC[31mhelloESC[39m` → 5; `true` → 13 (counts the escape bytes)  |
| `perCodePoint`         | `false` (grapheme-wise) | ZWJ family `👨‍👩‍👧‍👦` → 2; `true` → 8 (Node's `util.inspect` algorithm) |

`Bun.which` takes [`WhichOptions`](https://bun.com/reference/globals/bun/WhichOptions) — `PATH` to override the lookup path and `cwd` to resolve from a directory. Measured: `Bun.which("bun")` → `/Users/nolarose/.bun/bin/bun`, `Bun.which("bun", { PATH: "" })` → `null`.

Probe output for the two headline cases, measured **2026-11-03** on `Bun.version` **1.4.4** (`bun --version`), not against 1.3.x prose:

```sh
bun -e 'console.log(Bun.wrapAnsi("\u001b[31mThe quick brown fox jumps over the lazy dog\u001b[0m", 20))'
# "\u001b[31mThe quick brown fox\u001b[39m\n\u001b[31mjumps over the lazy\u001b[39m\n\u001b[31mdog\u001b[0m"
bun -e 'console.log(Bun.wrapAnsi("Hello World", 5, { wordWrap: false }))'
# "Hello\nWorld"
```

Two consequences for code here:

- **Each row carries its own style codes.** An open SGR style is closed with that style's matching reset at the end of every row (`ESC[31m`→`ESC[39m`, `ESC[1m`→`ESC[22m`, `ESC[4m`→`ESC[24m` in the probes above) and re-opened at the start of the next; only the final row keeps the original closing code. Exact bytes therefore depend on per-row style bookkeeping — do not hash or byte-snapshot wrapped output as evidence; compare the rendered text or per-row `Bun.stringWidth()`.
- **Width is not `.length`.** Use `Bun.stringWidth()` for any column math (padding, table alignment, `Bun.inspect.table` widths); `.length` counts UTF-16 units, not columns.

## Live docs and reference (check behavior on 1.4.4)

- Docs: [bun.com/docs](https://bun.com/docs)
- API reference (generated declarations, per-symbol permalinks): [bun.com/reference](https://bun.com/reference), [`globals/bun`](https://bun.com/reference/globals/bun)
- Walkthroughs: [bun.com/guides](https://bun.com/guides)
- PM topics that match this repo: [install](https://bun.com/docs/pm/cli/install), [add](https://bun.com/docs/pm/cli/add), [remove](https://bun.com/docs/pm/cli/remove), [workspaces](https://bun.com/docs/pm/workspaces), [lifecycle](https://bun.com/docs/pm/lifecycle), [lockfile](https://bun.com/docs/pm/lockfile), [isolated installs](https://bun.com/docs/pm/isolated-installs), [patch](https://bun.com/docs/pm/cli/patch)

## Bun docs MCP (live server; repo-native client)

`https://bun.sh/docs/mcp` (also `https://bun.com/docs/mcp`) is Bun's **MCP server**, not a docs
page. It is stateless JSON-RPC over POST (a GET returns a JSON-RPC "method not allowed"), read-only,
no auth, and exposes four tools plus one resource:

| Tool / resource                           | Use                                          |
| ----------------------------------------- | -------------------------------------------- |
| `search_bun {query, limit?, section?}`    | ranked sections with deep links (start here) |
| `read_bun_page {path}`                    | full markdown of one page                    |
| `list_bun_pages {path}`                   | pages under a prefix                         |
| `grep_bun {pattern, paths?, ignoreCase?}` | regex over page markdown                     |
| `bun://skill`                             | primer on Bun and the tools                  |

**Harness gap:** this profile has `@deepseek-ai/dsh-mcp-resources` enabled but **unconfigured**
(Config status `absent`) and it is resources-only; no MCP _tools_ client is installed, so
`search_bun`/`read_bun_page`/… are **not** on the agent tool roster. The repo therefore ships its
own client:

```sh
bun run bun:docs-mcp probe          # contract: 4 tools + bun://skill, exit 1 on drift
bun run bun:docs-mcp search "Bun.WebView attach existing Chrome" --limit 3
bun run bun:docs-mcp read /docs/runtime/webview
bun run bun:docs-mcp grep -- "--inspect-wait"
bun run bun:docs-mcp list /docs/runtime
bun run bun:docs-mcp skill
```

`BUN_DOCS_MCP_URL` overrides the endpoint (declared in `types/env.d.ts`). Transport tests use an
injected fetch (`scripts/bun_docs_mcp.test.ts`), so CI stays offline. Remaining gap: wiring the
probe into a live drift check is opt-in (`probe:bun` owns the offline runtime baseline), and the
Harness would need an MCP tools plugin plus a `mcp-resources` config to expose these natively.

### Protocol behavior measured on 1.4.4

| Observation                                                                                       | Consequence                                                                |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| GET returns an HTTP 405 whose body is a JSON-RPC error ("stateless; POST JSON-RPC")               | clients must POST                                                          |
| Tool failures return **HTTP 200** with `result.isError:true` and the error in `content[].text`    | check `isError`; our `BunDocsMcp.callTool` throws (`MCP tool … failed: …`) |
| Unknown _method_ returns JSON-RPC `-32601` ("Method not found")                                   | method errors and tool errors are different channels                       |
| `initialize` with an older `protocolVersion` still answers `2025-06-18`                           | no version downgrade; client uses the server's version                     |
| No `prompts` (`prompts/list` → `[]`) and `resources/subscribe` is `-32601`                        | retrieval only, no prompt/subscription surface                             |
| Input schemas are informational: `search_bun` with `limit: 26` was accepted despite `maximum: 25` | clients validate their own arguments                                       |
| `search_bun` returns ranked sections with deep links; `grep_bun` caps output at 30 KB             | wildcard greps need `paths`/`maxMatches`                                   |

`bun run bun:docs-mcp audit` compares five repo-pinned claims against the live docs. Current
result: `bun check`, `--inspect-wait`, WebView `headless:false`-throws, and flags-before-`run`
ordering all match; the **skill resource is stale** ("Don't use Bun for type-checking — run `tsc`")
even though 1.4 ships `bun check`. The audit reports it as drift; pass `--fail-on-drift` to make
drift fatal. Transport is covered offline by `scripts/bun_docs_mcp.test.ts` (fake fetch).

## Cloudflare R2 (`Bun.S3Client` / `Bun.s3`)

The four upstream patterns this repo's R2 integration is pinned to:

- [Bun.S3Client and the `Bun.s3` global](https://bun.com/docs/runtime/s3#bun-s3client-bun-s3): `lib/r2_s3_client.ts` wraps one `Bun.S3Client`; `Bun.s3` is asserted in `tests/bun_s3client_contract.test.ts`.
- [Using Bun's S3Client with Cloudflare R2](https://bun.com/docs/runtime/s3#using-bun-s-s3client-with-cloudflare-r2): the adapter builds `new Bun.S3Client({ bucket, accessKeyId, secretAccessKey, endpoint: "https://<account>.r2.cloudflarestorage.com" })`.
- [`method` in presign options](https://bun.com/docs/runtime/s3#method): `putWithMetadata` presigns `{ method: "PUT", expiresIn: 300, type }`, then forwards `x-amz-meta-*` headers without a local SigV4 signer.
- [`new Response(s3file)`](https://bun.com/docs/runtime/s3#new-response-s3file): `redirectResponse` wraps the lazy `S3File` in a 200 response; the blob gateway serves it for `GET /api/v1/blobs/{key}?download=1`.

Environment resolution is documented in `lib/r2_s3_client.ts` (`R2_*` → `S3_*` → `AWS_*`, or `CLOUDFLARE_R2_TOKEN_ID` + SHA-256 of `CLOUDFLARE_R2_API_TOKEN`).

## Optional git pins (upstream doc PRs only)

Commits on `main` **after** 1.4.4. Navigation and voice, not runtime.

| Pin        | Tree                                                                                                                  | Use                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `6cdb3835` | [docs → contributing](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing) | MDX [voice](https://bun.com/docs/project/contributing#voice) |
| `6a380492` | [docs/snippets](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets)           | `guides.jsx` (guide index), `cli/*.mdx` (CLI flag blocks)    |

## Where to start

| You are changing…           | Start here                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| sportsdesk-ops              | `AGENTS.md`, `bun run ci:local`                                                             |
| A Bun API name or signature | [reference/globals/bun](https://bun.com/reference/globals/bun), then `./bin/dx bun --types` |
| bun.com MDX                 | [contributing#voice](https://bun.com/docs/project/contributing#voice)                       |
| Bun engine (Rust/C++/JSC)   | [CONTRIBUTING.md](https://github.com/oven-sh/bun?tab=contributing-ov-file)                  |
| Install policy in this repo | [runbooks/bun-pm-policy.md](./runbooks/bun-pm-policy.md), `AGENTS.md`, `bun run pm:doctor`  |

## Related in this repo

- **Package manager policy (full):** [`runbooks/bun-pm-policy.md`](./runbooks/bun-pm-policy.md)
- Eval one-liners: [`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md)
- Server / WebView runtime shapes: [`runbooks/bun_server_runtime_shapes_runbook.md`](./runbooks/bun_server_runtime_shapes_runbook.md)
- Every `Bun.*` shape the code calls, with its declaration source and local evidence: [`runbooks/bun_shape_contracts_runbook.md`](./runbooks/bun_shape_contracts_runbook.md) (coverage gate: `tests/bun_shapes_coverage.test.ts`)
- Runtime surface + declaration drift: [`bin/bun_surface.ts`](../bin/bun_surface.ts) (`./bin/dx bun --types`), guarded by [`tests/bun_capabilities.test.ts`](../tests/bun_capabilities.test.ts) and the [`tests/bun_baseline.json`](../tests/bun_baseline.json) probe baseline

```sh
bun run pm:doctor
bun test tests/bun_config_policy.test.ts tests/pm_policy_workspaces.test.ts tests/dx_deps.test.ts
bun run probe:bun                      # after Bun upgrade
```
