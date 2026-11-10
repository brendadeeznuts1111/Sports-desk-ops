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

| URL                                                               | Covers                                                                                                      | Use when                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [`/reference`](https://bun.com/reference)                         | the tree: 51 `node:*` pages, 6 `bun:*` pages, and [`/reference/globals`](https://bun.com/reference/globals) | you do not know which namespace holds it |
| [`/reference/globals/bun`](https://bun.com/reference/globals/bun) | every symbol in the `bun` module, value and type — **322** symbol pages                                     | you have a name and need its page        |
| `/reference/node/<module>`                                        | Node-compat surface, one page per module                                                                    | a dependency's Node call, not repo code  |
| `/reference/bun/<module>`                                         | `bun`, `bun:bundle`, `bun:ffi`, `bun:jsc`, `bun:sqlite`, `bun:test`                                         | the module behind an import              |

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

### Built-in module reference (`/reference/bun/<module>`)

Module pages cover imports, not globals:

| Module                                               | Purpose                                    | Key Symbols & Patterns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`bun:test`](https://bun.com/reference/bun/test)     | Native test runner and assertion framework | [`expect`](https://bun.com/reference/bun/test/expect), [`test`](https://bun.com/reference/bun/test/test), [`describe`](https://bun.com/reference/bun/test/describe), [`expectTypeOf`](https://bun.com/reference/bun/test/expectTypeOf), [`onTestFinished`](https://bun.com/reference/bun/test/onTestFinished), [`setSystemTime`](https://bun.com/reference/bun/test/setSystemTime), [`mock`](https://bun.com/reference/bun/test/mock), [`spyOn`](https://bun.com/reference/bun/test/spyOn); declaration merging via `interface Matchers<T>`. |
| [`bun:bundle`](https://bun.com/reference/bun/bundle) | Build-time dead-code elimination           | [`feature`](https://bun.com/reference/bun/bundle/feature) (compile-time flag replacement; call sites must be an `if` condition or ternary) and [`Registry`](https://bun.com/reference/bun/bundle/Registry) (declaration merging for type-safe flag unions).                                                                                                                                                                                                                                                                                  |
| [`bun:sqlite`](https://bun.com/reference/bun/sqlite) | In-process high-performance SQLite driver  | `Database`, `Statement`, transaction helpers, zero-copy serialization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [`bun:ffi`](https://bun.com/reference/bun/ffi)       | Foreign Function Interface                 | `dlopen`, `ptr`, `FFIType`, `CString`, direct C library interop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`bun:jsc`](https://bun.com/reference/bun/jsc)       | JavaScriptCore engine internals            | Heap profiling, GC triggers, memory inspection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

#### `bun:test` core patterns

1. **The Declaration Merging Triad:** Together with `Bun.Env` and `bun:bundle` `Registry`, `bun:test` exposes the third official declaration-merging point in Bun:
   ```ts
   declare module "bun:test" {
     interface Matchers<T> {
       toBeCustomAssertion(param: number): void;
     }
     interface AsymmetricMatchers {
       toBeCustomAssertion(param: number): void;
     }
   }
   ```
2. **First-Class Type Testing (`expectTypeOf`):** Directly exported from `bun:test` (vendoring `expect-type`) for compile-time type assertions in `.test-d.ts` suites without external dependencies.
3. **Scoped Cleanup (`onTestFinished`):** Registers teardown logic directly scoped to the test body, executing after `afterEach` even if assertions fail.
4. **Deterministic Clock (`setSystemTime`):** Zero-dependency native system clock mocking (`setSystemTime(new Date(...))` and `setSystemTime()` to reset).

#### `bun:bundle` & `Bun.build` core patterns ([docs/bundler#features](https://bun.com/docs/bundler#features))

1. **The `Registry` vs `BuildConfig` Type Boundary:**
   `bun:bundle` defines an empty interface intended specifically for declaration merging:
   ```ts
   declare module "bun:bundle" {
     interface Registry {}
     function feature(
       flag: Registry extends { features: infer Features extends string }
         ? Features
         : string,
     ): boolean;
   }
   ```
   Augmenting `interface Registry { features: Feature }` narrows `feature()` to your union (`"DEBUG" | "PROD"`). Conversely, in `"bun"`, `BuildConfig` declares `features?: string[]`. Attempting to merge a narrowed `features?: Feature[]` onto `BuildConfig` fails with `TS2717: Subsequent property declarations must have the same type`. Type safety for `Bun.build` options is enforced by custom wrappers (e.g. `TargetBuildConfig`) typed against `BUILD_FEATURES`.
2. **Build-Time Dead-Code Elimination Triad:**
   - **`feature("FLAG")`:** Compile-time AST macro. Replaced with `true` or `false` by Bun's Zig bundler; unreachable `if` or ternary branches are pruned completely from the bundle. Must appear strictly inside an `if` or ternary condition and requires a literal string argument (no dynamic values).
   - **Minification Collapsing:** When `--minify` / `minify: true` is enabled, Bun collapses ternary expressions into scalar values (e.g. `const mode = feature("PREMIUM") ? "premium" : "free"` collapses directly to `var mode = "premium"` or `var mode = "free"`).
   - **Import Removal:** Bun completely prunes the `import { feature } from "bun:bundle"` statement from the final bundled output.
   - **`drop: string[]`:** Drops function call sites at bundle time (e.g. `drop: ["console.debug"]`).
   - **`define` / `env: "inline"`:** Inlines constants/env-vars, enabling standard AST constant-folding and tree-shaking.
3. **`BuildOutput` and `BuildArtifact` Contract:**
   `Bun.build(options: BuildOptions): Promise<BuildOutput>` produces artifacts where `BuildArtifact extends Blob`. Bundled code is read directly via `await artifact.text()` or streamed via `artifact.stream()` without intermediate filesystem round-trips. Failed builds return `{ success: false, logs: BuildMessage[] }` when `throw: false` is configured.

The index also carries one page per `node:*` module under `/reference/node/<module>` — Bun's Node-compatibility surface, module by module ([`node:fs`](https://bun.com/reference/node/fs), [`node:child_process`](https://bun.com/reference/node/child_process), [`node:dns`](https://bun.com/reference/node/dns), [`node:util`](https://bun.com/reference/node/util), [`node:zlib`](https://bun.com/reference/node/zlib)). That answers a dependency's Node usage — whether the call exists and what it does under Bun — and it is not licence for Node-style code here: that is a review convention, and since 2026-11-09 no automated ratchet enforces it (the `policy:check` platform gate was removed).

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

## Bun Shell (`Bun.$`) — measured 2026-11-04

`Bun.$` is a lazy template tag: a command starts no process until the promise is awaited or an
output method is called. Measured: a command's marker file was absent before the first `await`
and present after it.

- **Awaited → `ShellOutput`**, with **synchronous** `text(encoding?)`, `json()`, `bytes()`,
  `arrayBuffer()` and `blob()`.
- **Un-awaited → `ShellPromise`**, with the same names returning promises plus `.lines()` (an
  async iterable), `.quiet()`, `.nothrow()`, `.throws(bool)`, `.cwd(str)` and `.env(obj)`.
  Iterating the promise itself throws (`iterable should have an iterator symbol`); iterate
  `.lines()`. bun-types 1.4.4 declares `text()` on the promise but **not** `bytes()`; await the
  output first (or cast) when reading bytes.
- **Bytes over text, lines over split.** Use `.bytes()` for byte-level work and `.lines()` for
  line scanning. `printf 'one\ntwo\nthree\n'` through `.lines()` yields
  `["one", "two", "three", ""]` — the trailing newline is a final empty line.
- **Output methods quietly capture.** A bare `await` of the tag echoes the process stdout
  (measured: `BARE-ECHO` appeared before the next `console.log`); call `.quiet()` when that is
  unwanted. Calling an output method already implies quiet.
- **Failures still yield bytes.** `ShellError` carries `exitCode`, `stdout` and `stderr` as
  `Buffer`s; the stderr bytes are available even though the promise rejected.
- **Do not copy the `T[P<P>]` generic signatures** from the reference page; they are malformed.

**Where it may be used:** tooling only (`scripts/`, `bin/`), and every command must capture its
output (`.text()`/`.bytes()`/`.lines()`/…) or call `.quiet()` — a bare await would echo. The tag
quotes interpolations, which is safer than building an `sh -c` string: `scripts/compute_dump_lag.ts`
now passes a fixture path through the tag instead of `execSync("… \"${dumpPath}\"")`. Library and
daemon code (`lib/`, `services/`, `cli/`) uses `Bun.spawn` with an argv array, and credentials/TTY
reads never use a shell (`lib/f402_credentials_policy.ts`). `tests/bun_shell_contract.test.ts`
enforces that split and the capture rule.

## Live docs and reference (check behavior on 1.4.4)

- Docs: [bun.com/docs](https://bun.com/docs)
- API reference (generated declarations, per-symbol permalinks): [bun.com/reference](https://bun.com/reference), [`globals/bun`](https://bun.com/reference/globals/bun)
- Walkthroughs: [bun.com/guides](https://bun.com/guides)
- PM topics that match this repo: [install](https://bun.com/docs/pm/cli/install), [add](https://bun.com/docs/pm/cli/add), [remove](https://bun.com/docs/pm/cli/remove), [workspaces](https://bun.com/docs/pm/workspaces), [lifecycle](https://bun.com/docs/pm/lifecycle), [lockfile](https://bun.com/docs/pm/lockfile), [isolated installs](https://bun.com/docs/pm/isolated-installs), [patch](https://bun.com/docs/pm/cli/patch)

**Ahead of the release — the `/docs/lint` linter.** [bun.com/docs/lint](https://bun.com/docs/lint)
documents a built-in `bun lint` (rules in `bunfig.toml [lint]`, `--type-aware` backed by
`bun check`, `--no-script`, `--doctor`). Measured 2026-11-04 on this machine: the latest GitHub
release is **v1.4.4**, whose tag `bun-v1.4.4` is commit `38afee6c84…` — exactly the installed
binary's revision (`1.4.4+38afee6c8`) — and the v1.4.4 blog post announces `bun fmt`, not a
linter (`bun lint` appears zero times there; the only "lint" is `lint-staged` in the `bun fmt
--staged` section). The command is absent from the binary: `bun --help` lists `fmt` but no `lint`,
and `bun lint` (with or without `--no-script`) in a directory with no `lint` script fails with
`Script not found "lint"`. In this repo the `package.json` `lint` script shadows the name, so
`bun lint --type-aware` executes `oxlint --fix --type-aware` — a mutating oxlint run, not the
documented linter. Until a release ships the command, `bun run lint:check` (oxlint 1.90.0 plus
`.oxlintrc.type-aware.json`) remains the gate; after an upgrade, run `bun lint --doctor` to see
which oxlint/ESLint rules run natively, then decide whether the shadowing script becomes
`bun lint --fix` (inside that script `bun lint` is the linter, per the docs) or `--no-script`.

**Type-aware parity, measured on oxlint 1.90.0 (2026-11-04).** oxlint implements the same 61
type-aware rules the docs describe (the docs' `@typescript-eslint/*` names map to `typescript/*`),
but with two operational differences the docs' builtin would remove:

- Type-aware runs require the pinned native package `oxlint-tsgolint@7.0.2005` (declared in
  `package.json`; platform binaries ship as optional deps). Outside a project that installs it,
  `oxlint --type-aware` fails with `Failed to find tsgolint executable` — so the gate is not
  self-contained the way a builtin would be.
- oxlint's `--type-check` reports TypeScript diagnostics: on this checkout it reproduced exactly
  the three `tsc` errors in `lib/bridge_and_channel_router.ts` (TS2412 + 2×TS2379) in 1.6 s over
  925 files. `bun run typecheck` (tsc) is faster (~0.2 s) and remains the type-error SSOT; adding
  `--type-check` to lint would only duplicate it. `--tsconfig` with a narrower `include` did not
  change those type-check diagnostics, confirming the docs' caveat: next to an oxlint config it
  sets import resolution, not the tsconfig used to type-check each file.

**Ahead of the release — `import.meta.glob` and the `bun test` env view.** The
[`ImportMeta` reference](https://bun.com/reference/globals/bun/ImportMeta) documents
`import.meta.glob()` (lazy and `{ eager: true }`) as a transpiler/bundler transform and says that
under `bun test` `import.meta.env` also carries Vite's `MODE`, `DEV`, `PROD`, `SSR` and
`BASE_URL`. Measured on 1.4.4 (2026-11-04), neither holds, and both are absent from the pinned
`bun-types@1.4.4` as well:

- `import.meta.glob` is `undefined` in `.ts`, `.tsx`, `.js` and `.mjs` at runtime (calling it
  throws `TypeError: import.meta.glob is not a function`), and `bun --hot` does not add it.
  `Bun.build({ entrypoints, target: "bun" })` and `bun build --target=bun|browser` report success
  but leave the `import.meta.glob(...)` call untransformed; running that bundle throws the same
  TypeError. `bun-types@1.4.4` has no `glob`/`ImportMetaGlobOptions` declaration, so any use is a
  TS2339 until a release declares it.
- Under `bun test`: `import.meta.env === process.env` and `NODE_ENV=test` hold, but `MODE`, `DEV`,
  `PROD`, `SSR` and `BASE_URL` are absent (`"MODE" in env === false`, values undefined).

Everything else on the page measured as documented: `dir`/`dirname` (equal), `file` (basename),
`filename`/`path` (equal), `url` (`file:`), `main`, `env === process.env`, `require` (loads CJS),
`resolve` (file URL; accepts a parent URL or path; **does not check existence** — a missing path
still resolves), and `hot` as `undefined` in a normal run and even under `bun --hot` on a plain
script. The two gaps are pinned as tripwires in
[tests/import_meta_contract.test.ts](../tests/import_meta_contract.test.ts).

**Runtime ahead of the docs — `Bun.file` metadata.** The
[`file` reference](https://bun.sh/reference/globals/bun#file) says `size` "is not valid until the
contents of the file are read at least once" and documents `BlobPropertyBag.type` as "Set a
default 'type'. Not yet implemented." Measured on 1.4.4 (2026-11-04), both statements are stale:
`.size` stats lazily on the first property access (18 for an 18-byte file before any read; 0 for a
missing path, which rejects only when read, with `ENOENT`), and
`Bun.file(path, { type: "text/plain" }).type` returns `text/plain;charset=utf-8`. Inference
appends `;charset=utf-8` for `.json` (`application/json;charset=utf-8`; the reference example
shows no charset), while unknown extensions and the `fd` overload report
`application/octet-stream`. The byte-buffer path overload copies its input (mutating the buffer
after creation did not change the target); URL and `fd` overloads work. Ten repo call sites
already read `.size` before any read (e.g. `services/sportsdesk_telegram_bot.ts:1114`'s max-bytes
guard and `lib/dod6_v54_lifetime_reader.ts`), which is correct on this binary, and no site passes
`{ type }` today. The pinned `bun-types@1.4.4` still carries the stale "Not yet implemented"
comment. Pinned by [tests/bun_file_response.test.ts](../tests/bun_file_response.test.ts).

**`SharedArrayBuffer`, measured 1.4.4 (2026-11-04).** Growable SABs work:
`new SharedArrayBuffer(16, { maxByteLength: 64 })` reports `growable: true` / `maxByteLength: 64`,
and `grow(32)` grows in place (byteLength 16→32, an existing `Uint8Array` view's length follows to
32, new bytes zeroed, old bytes preserved). Growing past `maxByteLength` and any shrink throw
`RangeError`; a fixed SAB reports `growable: false` and `grow()` throws `TypeError:
SharedArrayBuffer is not growable`. `slice()` returns a copied, non-growable `SharedArrayBuffer`
(subclass species is respected). One reference mismatch: the page's second overload
`grow(size): SharedArrayBuffer` returns **`undefined`** at runtime — matching the first
`grow(newByteLength?): void` overload and TypeScript's `lib.es2024.sharedmemory.d.ts` — so do not
chain the call. The repo's only SAB use is the `Atomics.wait` sleep in
[lib/f402_profile_lock.ts:145](../lib/f402_profile_lock.ts), measured working.

Byte streams measured **`ArrayBuffer`-backed, not SAB-backed**, across `Bun.file().stream()`,
`DecompressionStream` output, `Response` bodies (including one built from a SAB view), request
bodies, `fetch` bodies, `spawn` stdout and TCP `Bun.listen`/`Bun.connect` data. The
`Uint8Array<ArrayBufferLike>` annotations in [lib/f402_weblog.ts](../lib/f402_weblog.ts) and
[lib/jsonl_stream_replay.ts](../lib/jsonl_stream_replay.ts) are therefore conservative rather than
observed; keep the types (a stream source may change) but the "may sit on a SharedArrayBuffer"
comment is not reproducible on this binary. `Bun.JSONL.parse` over a SAB-backed view, `Bun.write(
path, sabView)` and `Bun.file(sabPathBytes)` all work.

## TypedArray views, slabs, and zero-copy windows (measured 1.4.4, 2026-11-05)

A **`ArrayBuffer`** is raw bytes. A **`Uint8Array`** (or any TypedArray) is a **view**: a triple of
`(buffer, byteOffset, byteLength)` into that store. Several views can overlap the same bytes; they
are not copies unless you explicitly copy.

```text
ArrayBuffer  [ 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 ]
Uint8Array   ^---------------- byteLength=8, byteOffset=0
Uint8Array(,,4) at offset 2     ^-- bytes 2..5 only
subarray(0,4) on full view      ^-- bytes 0..3 (same backing as parent)
```

### Zero initialization vs `Bun.allocUnsafe`

| Source               | Unwritten bytes                   | Typical use                                                                                     |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `new ArrayBuffer(n)` | **0**                             | Trust “empty tail is zero”                                                                      |
| `new Uint8Array(n)`  | **0** (new buffer under the hood) | Same                                                                                            |
| `Bun.allocUnsafe(n)` | **Undefined** (prior RAM)         | Hot slabs when every **read** index is written first or the consumer only sees `subarray(0, k)` |

The tally SoA path ([`lib/gslive_tally_rollup.ts`](../lib/gslive_tally_rollup.ts)) and ticker read
([`lib/f402_bet_ticker_jsonl.ts`](../lib/f402_bet_ticker_jsonl.ts)) rely on the last row of that
table. Full audit rules live under
[When to use `Bun.allocUnsafe`](#when-to-use-bunallocunsafe-and-when-not--2026-11-04-audit) below.

### `subarray` vs `slice` (TypedArray)

| API                          | Allocates               | Same `ArrayBuffer`?       | Index base                                        |
| ---------------------------- | ----------------------- | ------------------------- | ------------------------------------------------- |
| `view.subarray(start, end?)` | No                      | Yes — shared mutation     | **Relative to this view** (respects `byteOffset`) |
| `view.slice(start, end?)`    | Yes — new buffer        | No                        | Relative to this view                             |
| `buffer.slice(start, end?)`  | Yes — new `ArrayBuffer` | N/A (on buffer, not view) | Absolute byte indices in the buffer               |

```ts
const buffer = new ArrayBuffer(8);
const uint8 = new Uint8Array(buffer);
uint8.set([1, 2, 3, 0, 0, 0, 0, 0]);

const sub = uint8.subarray(0, 4); // [1,2,3,0], shared backing
sub[0] = 99; // uint8[0] becomes 99

const copy = uint8.slice(0, 4); // new ArrayBuffer; uint8[1] stays 2 if copy[1]=88

const window = new Uint8Array(buffer, 2, 4); // bytes [2..5] → [3,0,0,0]
const tail = window.subarray(1); // still into `buffer`, starts at byte 3
```

**Do not confuse** `SharedArrayBuffer.slice` (copy of a region) with `Uint8Array.subarray` (alias).
The SAB section above documents buffer-level `slice`; stream and JSONL code almost always mean
**view `subarray`**.

### JSONL: byte `read` and carry-forward (no memcpy)

`Bun.JSONL.parseChunk(buf)` returns `read`: bytes consumed from **`buf`’s index 0**, not from the
underlying buffer origin when `buf.byteOffset > 0`. The published docs say to resume with
`TypedArray.subarray()` — https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array

This repo centralizes byte-window rules in [`lib/jsonl_stream_replay.ts`](../lib/jsonl_stream_replay.ts):

| Helper                               | Role                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `mergeUint8JsonlChunks`              | Append stream chunks (`Bun.concatArrayBuffers`) — used by replay and [`lib/f402_weblog.ts`](../lib/f402_weblog.ts)  |
| `carryForwardJsonlBuffer`            | Drop `parseChunk().read` prefix via `subarray`                                                                      |
| `writtenUint8Prefix`                 | `subarray(0, bytesRead)` after disk read / `allocUnsafe` fill                                                       |
| `jsonlAdvancePastLineFeedDelimiters` | File offset after `read` (skip trailing `0x0a`) — [`lib/f402_bet_ticker_jsonl.ts`](../lib/f402_bet_ticker_jsonl.ts) |

End-to-end stepping (slab → complete lines → held-back tail) is in
[`tests/jsonl_stream_replay.test.ts`](../tests/jsonl_stream_replay.test.ts) (`worked example: bet-ticker slab read`).

Partial-line streaming keeps one growing buffer (via `Bun.concatArrayBuffers` when appending
chunks), parses complete records, then **`subarray(result.read)`** so the next `parseChunk` sees
the remainder at index 0. Using `String.slice` or copying to a new `Uint8Array` on every chunk
would work but adds allocations; the runbook’s “zero-copy byte slices” note refers to this pattern
([`bun_server_runtime_shapes_runbook.md`](./runbooks/bun_server_runtime_shapes_runbook.md)).

Weblog ingestion uses the same idea on a sliding pending buffer:
[`lib/f402_weblog.ts`](../lib/f402_weblog.ts) (`pending.subarray(cut)` after a consumed window).

### Draining `ReadableStream`s (whole buffer vs incremental JSONL)

[`Bun.readableStreamToArrayBuffer(stream)`](https://bun.com/reference/globals/bun/readableStreamToArrayBuffer)
reads until close/error and concatenates chunks into **one** `ArrayBuffer`. Each chunk must be a
**TypedArray or `ArrayBuffer`**; mixed chunk types (strings + bytes) need
[`Bun.readableStreamToBlob`](https://bun.com/reference/globals/bun/readableStreamToBlob) instead.

| Goal                                           | API                                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small/medium body; need exact byte length once | `await Bun.readableStreamToArrayBuffer(body)` → `new Uint8Array(ab)` (see [`lib/http_body.ts`](../lib/http_body.ts) — uses `Response.arrayBuffer()`, equivalent drain) |
| Known JSONL file; bounded memory via windows   | [`replayHistoricalJsonlStream`](../lib/jsonl_stream_replay.ts) — `mergeUint8JsonlChunks` + `parseChunk` + `carryForwardJsonlBuffer`                                    |
| “Give me all stream bytes” SSOT wrapper        | `drainReadableStreamToUint8(stream)` in the same module                                                                                                                |

Do **not** replace the JSONL replay loop with a full-stream drain on multi‑hundred‑MB ticker archives:
that duplicates the file in RAM. Drain helpers fit probes, tests, and bodies that are already size-capped.

### SoA slabs and “logical length”

Structure-of-arrays rollup storage keeps **fixed-capacity** typed columns (`Uint32Array`,
`BigInt64Array`, `Bun.allocUnsafe` byte labels, …). Logical row count (`groupCount`, `cellCount`)
is always **≤ capacity**; only indices `< count` are read. There is no `array.length = n` shrink —
capacity is the arena size. **`subarray(0, count)`** is the pattern when an API needs a dense
prefix (file read, hash, decode); the tally path instead indexes `0..count-1` in place and never
passes the unfilled tail to consumers.

### Footguns (read before `allocUnsafe` or `subarray`)

1. **Expose only the written prefix** — `Bun.write(path, buf)` or `Bun.hash(buf)` uses **full
   `buf.length`**, not “bytes read”. Use `writtenUint8Prefix(buf, bytesRead)` or
   `buf.subarray(0, bytesRead)` (see `scripts/live_positions_cron.ts` in the allocUnsafe table).
2. **`[...view]` and `Array.from(view)` copy** — fine for tests; avoid on megabyte slabs in hot
   loops.
3. **Assuming tail is zero** — safe after `new ArrayBuffer` / `new Uint8Array`; **false** after
   `Bun.allocUnsafe` unless you zero or slice.
4. **Detached buffers** — `ArrayBuffer.transfer` / resizing can invalidate views; this repo’s paths
   use fixed-size arenas and concat, not transfer, on these hot paths.

Pinned by [tests/shared_array_buffer_contract.test.ts](../tests/shared_array_buffer_contract.test.ts) and
[tests/jsonl_stream_replay.test.ts](../tests/jsonl_stream_replay.test.ts).

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

## Bun.secrets (R2/BLOB keychain)

Repo rules for [`Bun.secrets`](https://bun.com/docs/runtime/secrets):

- Canonical service: **`com.bookdeskops.sportsdesk`**; the old `sportsdesk-ops` service is read as a
  migration fallback. `scripts/secrets_r2.ts seed` copies legacy entries and the macOS Keychain
  values into the canonical service.
- Every `Bun.secrets.set` passes `persist: "local"` (Windows stays on this machine) and validates the
  platform bounds first: service/name are 1..255 printable ASCII characters; value is 1..2048 UTF-8
  bytes.
- Credentials are read into local variables/maps, never copied into `process.env`; Bun's memory
  zeroing for the returned string is preserved.
- `scripts/secrets_r2.ts seed` also generates CSPRNG 32-byte hex values for `BLOB_API_TOKEN` and
  `BLOB_TICKET_SECRET` when they are absent, so the gateway and supervisor can start from the
  keychain when `.env` is an unmounted FIFO.

## Cloudflare R2 (`Bun.S3Client` / `Bun.s3`)

The four upstream patterns this repo's R2 integration is pinned to:

- [Bun.S3Client and the `Bun.s3` global](https://bun.com/docs/runtime/s3#bun-s3client-bun-s3): `lib/r2_s3_client.ts` wraps one `Bun.S3Client`; `Bun.s3` is asserted in `tests/bun_s3client_contract.test.ts`.
- [Using Bun's S3Client with Cloudflare R2](https://bun.com/docs/runtime/s3#using-bun-s-s3client-with-cloudflare-r2): the adapter builds `new Bun.S3Client({ bucket, accessKeyId, secretAccessKey, endpoint: "https://<account>.r2.cloudflarestorage.com" })`.
- [`method` in presign options](https://bun.com/docs/runtime/s3#method): Bun's presigner cannot sign custom headers, so `writeWithMetadata` uses a Web-Crypto SigV4 PUT for `x-amz-meta-*`; plain uploads and downloads still use `Bun.S3Client` write/presign.
- [`new Response(s3file)`](https://bun.com/docs/runtime/s3#new-response-s3file): `redirectResponse` wraps the lazy `S3File` in a 200 response; the blob gateway serves it for `GET /api/v1/blobs/{key}?download=1`.

The wagers capture pipeline uses the same adapter for its optional `--publish-r2` sink: it writes
the aggregate `wagers-by-state/latest.json` with `writeWithMetadata`, and the graph poller embeds
the local sidecar in `graph-live-feed.json` before publishing.

Environment resolution is documented in `lib/r2_s3_client.ts`: credential precedence is `R2_*` → `CLOUDFLARE_R2_TOKEN_ID` + SHA-256(`CLOUDFLARE_R2_API_TOKEN`) → `S3_*` → `AWS_*`; endpoint precedence is `S3_ENDPOINT` → `AWS_ENDPOINT` → `https://<accountId>.r2.cloudflarestorage.com`. The adapter also exposes `write`, `stat` (never the deprecated `S3File.size`), `size`, `exists`, `sliceBytes`, `list`, `delete`/`unlink`, and classifies the six `ERR_S3_*` codes plus `S3Error` (`isS3Error`). The blob gateway maps those failures to a 502 response carrying the S3 code.

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

## v1.4.0 breaking-change audit (2026-11-03)

Contracts exercised against Bun 1.4.4 (`.bun-version`), the version the CI `setup-bun@v2` step pins.

| Upstream change                                      | Repo contract                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Temporal timezone conversion (#32978, #37024) | `lib/gslive_bet_event_log.ts::parseGsliveTimestampMs` uses `Temporal.PlainDateTime.from(raw.trim().replace(" ", "T")).toZonedDateTime("America/Los_Angeles").epochMilliseconds` (Intl fallback only if Temporal is absent). Desk dates use `Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("America/Chicago")` in `lib/f402_bet_ticker_delta.ts::deskClock` and `lib/gslive_tally_rollup.ts::chicagoDate`. | `2026-10-27T21:58:47.695` → `1793163527695`; DST tests cover Oct 27 PDT and Nov 3 PST; parsing is process-TZ independent (`tests/gslive_bet_event_log.test.ts`).                                |
| Whole-second `logTime` vs millisecond `acceptTime`   | `deltaSec = floor(acceptMs/1000) − logTimeSec − delaySec`. `DELAY_MISMATCH` flags only `deltaSec < −1` (true underflow) or `deltaSec > +5` (abnormal hold overflow); 0s..+2s is normal second-floor + DGS ticket-RPC jitter.                                                                                                                                                                                              | 24,778 getBetReport rows: `<−1s 15`, `−1s 0`, `0s 11,460`, `+1s 12,304`, `+2s 815`, `+3s 143`, `+4..+5s 37`, `>+5s 4` → **19 mismatches**.                                                      |
| Strict `Bun.TOML` (#32953)                           | Quoted strings and safe integers only; no unquoted values or missing newlines.                                                                                                                                                                                                                                                                                                                                            | `Bun.TOML.parse` accepts `bunfig.toml` (`fmt`, `run`) and `config/wagers-capture.toml` (`capture`, `paths`, `alerts`, `publish`, `session`).                                                    |
| `Bun.YAML` is YAML 1.2 (#25537)                      | `yes/no/on/off` are strings; workflow `on:` remains the string key `"on"` (correct for GitHub Actions).                                                                                                                                                                                                                                                                                                                   | `Bun.YAML.parse("a: yes\nb: no\nc: on\nd: off")` → all strings; `dsh-plugin/cordis.patch.yml` parses as a 1-element array. `scripts/ci_local.ts` reads only `jobs[*].steps[*].run`, never `on`. |
| `res.writeHeader()` removed (#31991)                 | No use of the removed Node API.                                                                                                                                                                                                                                                                                                                                                                                           | `grep -rn "writeHeader("` → no matches.                                                                                                                                                         |
| Bun-as-node skips `.env` (#36610)                    | Only `bun --bun` scripts are `lint` / `lint:check` (oxlint), which do not read `.env`. No `bunx` or node-shebang invocation paths.                                                                                                                                                                                                                                                                                        | `package.json` scripts; regular `bun run` scripts keep `.env` loading.                                                                                                                          |
| `server.publish()` vs `ws.publish()` (#32889)        | `services/blob_and_live_bets_server.ts` broadcasts with `server.publish()` only (`ws.publish()` excludes the sender) and answers `{channel, published, delivered, subscribers}` where `subscribers = server.subscriberCount(channel)`: `-1` → HTTP 503 `backpressure`, `0` → HTTP 202 `delivered: false`, `>0` → HTTP 200 `delivered: true`.                                                                              | POST `/api/v1/live-bets` handler; `publish reports server.subscriberCount` and `publish with no subscriber` tests.                                                                              |

## v1.4.0 long-tail runtime primitives

Pinned/used by this repo (Bun 1.4.4):

| Primitive                                                                                                                        | Where used / contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.JSONL.parseChunk` (#26356)                                                                                                  | `lib/f402_bet_ticker_jsonl.ts` parses the 440 MB tail window natively, advances by `chunk.read`, and holds back a partial trailing line. A malformed line mid-chunk falls back to per-line parsing of complete lines (the fallback is tested).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ServerWebSocket.subscriptions` (#24299)                                                                                         | `services/blob_and_live_bets_server.ts` keeps no JS mirror: `channels` and `subscriptions` on the SUBSCRIBED/UNSUBSCRIBED ack are both read from `ws.subscriptions`, the 32-topic cap counts `ws.subscriptions.length` with `ws.isSubscribed(topic)` so re-subscribing costs no slot, and uWebSockets drops membership on close (there is no close-time unsubscribe loop). The array is in hash order, not insertion order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `tests/blob_and_live_bets_server.test.ts` sorts before comparing topics, and pins the cap to `channel_limit` only for a new topic.                                                                                                                           |
| Auto-`cork()` in `open`/`message` (older `WebSocketHandler` contract)                                                            | Control frames (`PING`/`PONG`, `SUBSCRIBE`/`SUBSCRIBED`, `UNSUBSCRIBE`/`UNSUBSCRIBED`) are written synchronously from `message`, so Bun's automatic cork batches them; nothing is sent after an `await`. `ws.send` returning `-1` closes the socket with 1011 instead of dropping the frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `services/blob_and_live_bets_server.ts::sendFrame`; ordering is covered by the gateway WS tests.                                                                                                                                                             |
| Browser bridge client (`ws.subscriptions` ack + live frames)                                                                     | `static/customer-churn-simulation-dashboard.html` keeps the topic list, badge mapping and `msg.subscriptions` handling. Empty `<meta name="sportsdesk-bridge-ws">` now means SAME ORIGIN: it connects to the daemon's guarded `/api/live-bets` upgrade path, offering `Sec-WebSocket-Protocol: sportsdesk.bridge.v1, bearer-<admin token>` because a browser cannot set an `authorization` header on a handshake. A non-empty content overrides the endpoint. Frames are raw bridge events routed by their own `kind` (no envelope), and Mode 6 re-renders from `f402-weblog`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/weblog_dashboard.test.ts`; the unwrapped frame shape is pinned in `tests/blob_and_live_bets_server.test.ts`.                                                                                                                                          |
| Same-origin guarded WebSocket upgrade (`Server.upgrade` in `fetch`)                                                              | `services/sportsdesk_webview_server.ts` upgrades the **already-registered** guarded route `/api/live-bets` when `upgrade: websocket`, so `DAEMON_ROUTES`, the OpenAPI fragment and the ledger's route counts are unchanged and a remote peer without the admin token is refused by the route's own `piiRejection` (the token is moved from the `bearer-` subprotocol into a synthetic `authorization` header). The hub speaks the gateway's `SUBSCRIBE`/`SUBSCRIBED` protocol from `ws.subscriptions` and a lazily started relay mints a server-side ticket with `BLOB_API_TOKEN`, subscribes the five topics and republishes each frame by `kind`. No token is ever put in a URL. Deployment note: a reverse proxy must forward the `Upgrade` header on this path, and behind a proxy that is not declared with `SPORTSDESK_TRUST_PROXY=1` the dashboard's token must equal `SPORTSDESK_ADMIN_TOKEN`, because the route guard then checks it.                                                                                                                                                                                                                                                                                                 | `tests/webview_bridge_ws.test.ts` (handshake pieces, guard reuse against a non-loopback peer, and a real stub-gateway → hub → browser relay).                                                                                                                |
| `Bun.serve` `development: { hmr: false }`                                                                                        | The daemon serves an API plus hand-written pages, so no module graph calls `import.meta.hot.accept()`. Dev mode keeps Bun's error pages but disables the HMR reload channel, which would otherwise warn that every update invalidated the page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `tests/server_port.test.ts` starts the daemon with the object form and asserts `/health`.                                                                                                                                                                    |
| `Bun.cron` in-process bridge schedules                                                                                           | `services/reporting_scheduler_service.ts` owns the bridge rollups; the **webview daemon** starts them (`startBridgeSchedules()`) on the desk clock, `{ tz: "America/Chicago" }`: `*/15` runs `bridge3a --once` (skipped unless `F402_AGENT_ID` is set), `bridge3b` (needs an F402 token) and `bridge3c --fetch-open` (needs `GSID`); minute 7 of every hour runs the WebLog rollup (its `--from` default is the CWD-relative `out/f402/weblog/<date>.jsonl` corpus). The Telegram bot daemon starts the other schedules with `BRIDGE_SCHEDULE_IDS` excluded, so running both processes cannot publish or page twice. `startInProcessCron` skips overlapping ticks; a job whose credentials are missing is recorded as failed WITHOUT spawning, so cron cannot hammer a CLI that would exit 2. The first tick only records the baseline; alerts fire on a gate/flag/job-status CHANGE, so an unchanged 15-minute run sends nothing — suppression is keyed on new alerts, meaning a standing failure that already paged stays off Telegram until it changes again (it remains visible on the dashboard Review Queue), and a manual `Dispatch digest` always sends that last recorded state instead of spawning the CLIs inside the HTTP request. | `tests/reporting_scheduler_bridge.test.ts` drives the scheduler with an injected cycle runner and a fake Telegram client (no CLI spawn, no message sent); `tests/bridge_rollup_cron.test.ts` covers the diff/state layer and pins each CLI's verified flags. |
| `Bun.markdown.html()` / `render()` are sinks, not sanitizers                                                                     | The native renderer passes raw HTML and attributes through, so `bin/check-innerhtml.ts` now fails any `Bun.markdown.html(...)`/`Bun.markdown.render(...)` call without a `// trusted-markdown: <reason>` annotation (same line or line above), while text that merely names the API is not treated as a call. The five call sites in `lib/docs_render_cache.ts`, `lib/manager_boot_runbook_render.ts`, `scripts/render_tasks.ts` and `services/sportsdesk_ingestion_replay.ts` render repo-owned markdown and are annotated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/check_innerhtml_meta.test.ts` (unannotated call fails; same-line and preceding-line annotations pass; help text does not false-positive).                                                                                                             |
| `process.on("memoryPressure")` (#32594)                                                                                          | Same server prunes expired `pendingTickets` on `"warning"`, clears them on `"critical"`, and removes the listener from `close()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--no-orphans` / `--no-env-file` (#29930, #24767)                                                                                | `services/supervisor.ts` spawns children with `--no-orphans`; `--no-env-file` is added when `SUPERVISOR_NO_ENV_FILE=1` or `noEnvFile: true`, so an unmounted `.env` FIFO cannot block startup when secrets come from `Bun.secrets`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Bun.S3Client` `contentDisposition`/`contentEncoding`/`slice().stream()` (#25363, #25999)                                        | Not yet used; `lib/gslive_tally_sink.ts`/R2 readers remain Range-capable through `R2S3Client`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Shape catalog (`Bun.JSON5`, `JSONC`, `XML`, `Archive`, `CSRF`, `isStandaloneExecutable`, `sliceAnsi`, `wrapAnsi`, `stringWidth`) | `Bun.JSONL`, `JSON5`, `JSONC`, `XML`, `Archive`, `wrapAnsi`, `stringWidth` are in `lib/bun_shapes.ts`; `Bun.CSRF`, `Bun.isStandaloneExecutable`, `Bun.sliceAnsi`, and `Bun.JSONL.parseChunk` are pinned in `lib/bun_shapes.ts` with `surface:` probes; the three values absent from `bun-types@1.4.4` carry explicit runtime-only anchors in `RUNTIME_ONLY_SHAPES` and are documented under the matching runbook sections. `types/bun-api.d.ts` aliases remain intentionally absent because the upstream declarations do not exist yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Native TOML adoption

There is no hand-rolled TOML parser in this repo. `lib/toml_parse.ts` is a 4-line wrapper over `Bun.TOML.parse` (Bun 1.4.0 passes 708/708 TOML v1.1 cases), and `tests/bun_toml.test.ts` pins the project `bunfig.toml` and `config/wagers-capture.toml` to it. `Bun.TOML.stringify` is available for future config writers; do not reintroduce a JS parser for either direction.

Measured on Bun 1.4.4: an offset date-time (`released = 2026-08-10T12:00:00Z`) parses to a **Temporal.Instant** (`epochMilliseconds: 1786363200000`), not the string shown in the upstream snippet; the instant's `toJSON()` returns the ISO string. `Bun.TOML.stringify({ name: "app", deps: { bun: "1.4.0" } })` matches upstream (quoted table `[deps]`). The test pins the Temporal behaviour so a future Bun change is visible.

## CPU / heap profiling

Bun ships the profilers; no npm package is involved.

```sh
# CPU profile (Chrome DevTools / VS Code), Markdown summary for bugs or review
bun --cpu-prof --cpu-prof-dir scratch/profiles --cpu-prof-name bridge3a.cpuprofile scripts/f402_bet_ticker_bridge3a.ts --once
bun --cpu-prof-md --cpu-prof-dir scratch/profiles scripts/f402_bet_ticker_bridge3a.ts --once

# V8-compatible heap snapshot + Markdown report
bun --heap-prof --heap-prof-dir scratch/profiles scripts/f402_bet_ticker_bridge3a.ts --once
bun --heap-prof-md --heap-prof-dir scratch/profiles scripts/f402_bet_ticker_bridge3a.ts --once
```

For processes the supervisor starts, set the environment instead of editing argv:

```sh
BUN_CPU_PROFILE=1 BUN_CPU_PROFILE_DIR=scratch/profiles BUN_CPU_PROFILE_NAME=supervisor bun run services/supervisor.ts
```

Profiles are diagnostics, not artifacts: write them under `scratch/profiles/` (gitignored), never `docs/` or `dist/`, and do not attach them to commits. Use CPU profiles for the poll loops and heap profiles for the supervisor/webview children when memory pressure is reported.

## When NOT to migrate to `Bun.JSONL` (2026-11-04 audit)

The repo reaches for `Bun.JSONL.parse()` / `Bun.JSONL.parseChunk()` by default on new JSONL work
(25+ call sites; see the long-tail table above, [`lib/f402_bet_ticker_jsonl.ts`](../lib/f402_bet_ticker_jsonl.ts),
[`lib/cron_journal.ts`](../lib/cron_journal.ts), [`services/sportsdesk_ingestion_replay.ts`](../services/sportsdesk_ingestion_replay.ts)).
A sweep of the remaining hand-rolled `for (line of text.split("\n")) { try { JSON.parse(line) } catch {…} }`
sites found **six intentional holdouts**, each because `Bun.JSONL` lacks a specific semantic they
depend on. Future "migrate to `Bun.JSONL`" audits should stop here before touching these files.

| File:line                                        | Pattern                                     | Semantic `Bun.JSONL` does not provide                                                       |
| :----------------------------------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------ |
| `lib/execution_paper.ts:161`                     | per-line try/catch, skip malformed          | Ledger reads skip malformed lines; `parse()` stops at the first bad line and drops the rest |
| `lib/f402_bet_ticker_jsonl.ts:101` (zst/gz path) | per-line try/catch + `skippedLines` counter | Per-line skip count; `parseChunk` reports one aggregate `error`, not a per-row tally        |
| `scripts/live_positions_cron.ts:355`             | chunked streaming + per-line skip           | Crash-tolerant reader for a 16 MB chunked stream (writer may truncate mid-line on signal)   |
| `scripts/audit_tool_calls.ts:109`                | per-line try/catch                          | DSH session files can have bad **middle** lines, not just a partial trailing one            |
| `scripts/ingestion_replay_xml_golden_gate.ts:45` | strict parse + original-text passthrough    | Gate must throw on malformed; preserves the exact original line text when `xml` is absent   |
| `lib/stale_line_cohort.ts:256`                   | strict parse in a `catch` fallback          | Must throw on malformed input; `parse()` returns the parsed prefix silently                 |

### Decision rule

- **Use `Bun.JSONL.parse(text | Uint8Array)`** when every line is expected to be valid JSON and
  a malformed line should either throw (if nothing parsed) or be acceptable as silent truncation
  of the prefix. Drop-in replacement for the `.split("\n").filter(…).map(JSON.parse)` pipeline.
  With `Uint8Array` input, Bun skips a UTF-8 BOM at byte 0.
- **Use `Bun.JSONL.parseChunk(input, start?, end?)`** for streaming or zero-copy byte handling.
  The return shape is `{ values, read, done, error }`:
  - `read` is a **byte** offset when `input` is a `Uint8Array` (character offset for strings) and
    always points into the original buffer, so `buf = buf.subarray(result.read)` is the correct
    zero-copy continuation.
  - `done: true` means the entire input was consumed; prefer that over
    `result.read < input.length` to decide whether to hold a tail.
  - The optional `start` / `end` **byte** offsets (`Uint8Array` only) let you reparse a subrange
    of an existing buffer without a `.subarray()` allocation.
  - A malformed middle line stops parsing and reports `error`; no per-line recovery. If you
    need skip-middle-line semantics on top of `parseChunk`, you must find the next `\n` after
    `result.read` and re-call with that as the new `start` — at which point the hand-rolled loop
    is simpler and that site belongs in the holdout table above.
- **Keep the hand-rolled `for (line of text.split("\n")) { try { JSON.parse(line) } catch {…} }`
  loop** when any of the following holds:
  - Skip-malformed is the intended semantic (append-only ledgers, audit logs).
  - A per-line error count is needed in the output.
  - The reader must tolerate bad middle lines (concurrent writers, crash recovery, chunked
    streaming where the writer may die mid-line).
  - The gate must **throw** on the first bad line — `Bun.JSONL.parse()` returns the parsed
    prefix silently instead.

If you migrate one of the six holdouts above, remove its row from this table in the same PR.

## `Bun.$` — available, but argv-only for credentials (2026-11-04 audit)

[`Bun.$`](https://bun.com/reference/globals/bun#bun.$) is the shell-tag that runs a command
through a parser, with a fluent `.env()` / `.cwd()` / `.nothrow()` / `.text()` API plus pure
helpers `Bun.$.escape(str)` (shell-safe quote) and `Bun.$.braces(pattern)` (bash-brace
expansion). It is pinned in `bin/bun_surface.ts` and covered by
`tests/bun_capabilities.test.ts` ("Bun.$ exposes the shell-tag…").

**The repo-wide rule is argv-only for anything that touches a credential.** This codifies what
[`lib/f402_credentials_policy.ts`](../lib/f402_credentials_policy.ts) says in prose:

> Never `Bun.$` — interpolation routes bytes through a shell parser.

**What to use where (audit measured 2026-11-04: 80 call sites use `Bun.spawn(argv, …)`, 1 test
uses `Bun.$`, 0 production uses):**

| Scenario                                                                        | Use                                                                                       | Why                                                                                                                           |
| :------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| Anything that reads/writes a credential, API key, cookie, or session ID         | **`Bun.spawn([argv…], { env: buildMinimalSpawnEnv() })`**                                 | Argv array bypasses the shell parser; minimal env allowlist denies `LD_PRELOAD`-class attacks                                 |
| A test or dev script that needs stdout as a single string from a static command | `Bun.$\`…\`.text()` with **no interpolation of untrusted input**                          | Fluent API reads cleaner than `Bun.spawn + Response(proc.stdout).text()`                                                      |
| A test or dev script that needs to interpolate a path we control                | `Bun.$\`…${path}…\``**only if`path`is repo-internal** or wrapped with`Bun.$.escape(path)` | `$` auto-quotes template values, but the safe habit is to assume every interpolated value is tainted and `.escape` it anyway  |
| Any production daemon reading stdout line-by-line                               | `Bun.spawn(argv, { stdout: "pipe" })` + `proc.stdout` reader                              | Independent `proc.exited` / `proc.stdout` / `proc.stderr` reads are clearer than `$\`…\`.lines()` for the 3-stream assertions |
| Pure bash brace expansion without running a shell                               | `Bun.$.braces("logs/{2024,2025}-*.jsonl")`                                                | No I/O, no shell spawn, no injection surface                                                                                  |

**Do not migrate the existing 80 `Bun.spawn([argv…])` sites.** The current argv form is the
defensive default; `Bun.$` is only a readability win on one-liner dev scripts. Migrating a
daemon or capture path would re-introduce the exact injection surface the policy was written to
prevent.

**Before adopting `Bun.$` in a new file**, check the capability test and this rule table. If a
dev script needs to interpolate a user-provided value, use `Bun.$.escape(value)` inside the
template; if the script touches credentials at all, fall back to `Bun.spawn`.

## When to use `Bun.allocUnsafe` (and when NOT to) — 2026-11-04 audit

[`Bun.allocUnsafe(size)`](https://bun.com/reference/globals/bun#bun.allocUnsafe) returns a
`Uint8Array` **without zeroing the bytes**. Bun's docs claim up to 3.5× faster than
`new Uint8Array(size)`; measured on this machine (Bun 1.4.4, Apple Silicon, 2026-11-04) the win
scales with size:

| Allocation size | `new Uint8Array(n)` | `Bun.allocUnsafe(n)` | Speedup |
| --------------: | ------------------: | -------------------: | ------: |
|            1 KB |              166 ns |               200 ns |   0.83× |
|           64 KB |             1134 ns |               312 ns |   3.64× |
|            1 MB |           37,535 ns |             2,540 ns |  14.78× |
|           16 MB |          314,321 ns |             8,385 ns |  37.49× |

Below ~a page the per-call overhead dominates; above 64 KB the win is real and matches the docs.
The docs warn, verbatim:

> if you send uninitialized memory to your users (even unintentionally), it can leak anything
> recently in memory.

This invariant — "every byte the consumer may read is written first" — is not something
`bun check` or `oxlint` can enforce. Every call site needs a per-site argument.

**Where this repo uses it (pinned 2026-11-04):**

| File:line                            | Fill pattern                                                                                                               | Why it is safe                                                                                                   |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `lib/f402_bet_ticker_jsonl.ts:169`   | `while (read < length) { chunk = await handle.read(buffer, read, length - read, …) }`                                      | `writtenUint8Prefix(buffer, read)` — only the written prefix is ever read; the tail is never exposed             |
| `scripts/live_positions_cron.ts:375` | `const bytesRead = readSync(fd, buf, 0, len, offset)` then `decoder.decode(buf.subarray(0, bytesRead))`                    | The `readSync` return is captured and used to slice the exposed prefix; migrating closed a latent short-read bug |
| `lib/gslive_tally_rollup.ts:432-679` | Eight SoA `Uint8` columns; only indices `0..groupCount-1` / `0..cellCount-1` are read after insert paths write every field | ~131 KiB zeroing skipped per rollup; unfilled arena tail is never indexed                                        |

**When to migrate a `new Uint8Array(n)` call site to `Bun.allocUnsafe(n)`:**

1. **Every byte the consumer sees must be written first.** A full fill is enough; a partial fill
   is only safe if the exposed prefix is sliced to the actual-written length (`.subarray(0, k)`).
2. **`n` is large enough for the zeroing cost to matter.** Bun's 3.5× number is on large
   allocations; micro-allocations (≤ a few KB) have no visible win and burn the audit budget.
3. **The allocation is on a hot path.** A one-shot allocation during startup is not worth the
   foot-gun — keep `new Uint8Array(n)`.

**When to keep `new Uint8Array(n)`:**

- **Size 0 sentinels** (`new Uint8Array(0)`) — no allocation to speak of; no win.
- **Small fixed buffers** (≤ a few KB, header slots, 1-byte peek) — the zeroing cost is ns-scale.
- **Any site that may pass the buffer to a consumer before it is fully written** — fetch
  responses, log writes, hash inputs where the length is set upstream, decoder inputs without a
  matching bytes-read capture.
- **Buffers whose consumer trusts "unwritten = zero"** — do not swap silently; `Bun.allocUnsafe`
  bytes are whatever was last in that RAM page.

Before adding a third call site, open `tests/bun_capabilities.test.ts` ("Bun.allocUnsafe returns
a Uint8Array of the requested length (unzeroed)") and add the new file:line to the table above.

## Future: `bun lint --type-check` unification (2026-11-04 audit)

Bun ships `bun check` (type errors) and `bun fmt` as built-ins on 1.4.4; **`bun lint` is not in
1.4.4** (`bun --help` does not list it; `cd /tmp/empty && bun lint` returns `error: Script not
found "lint"`). The [`/docs/lint`](https://bun.com/docs/lint) page describes a future feature
whose relevant surface for this repo is:

- `bun lint --type-aware --type-check` — reports type errors too, the way `bun check` does, in a
  single pass that also runs the type-aware lint rules.
- `bun lint --tsconfig <path>` — pins one `tsconfig.json` for the whole run, bypassing per-file
  auto-discovery. A `tsconfig.json` without `"include"` triggers a `warn: Loaded N files in Ts to
lint foo.ts` warning because it covers every file below it.

**What the repo already looks like, measured 2026-11-04:**

| Audit                                   | This repo                                                                                                                                     | Future `bun lint` implication                                                                                                                      |
| :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `tsconfig.json` has `"include"`?   | `"include": ["**/*.ts"]`                                                                                                                      | Won't trigger the "no `include`" warning.                                                                                                          |
| Monorepo with multiple `tsconfig.json`? | No — one root tsconfig, plus `Scratch/security/tsconfig.scoped.json` (scratch area, ignored by `.oxlintrc.type-aware.json` `ignorePatterns`). | Per-file tsconfig discovery is unambiguous; no `--tsconfig` flag needed.                                                                           |
| Current lint pass shape                 | `lint:check` runs oxlint twice: regular + `--type-aware -c .oxlintrc.type-aware.json`.                                                        | Could collapse to one `bun lint --type-check --type-aware -c .oxlintrc.type-aware.json` call.                                                      |
| Current typecheck pass shape            | `typecheck` runs `bun check --no-script -p tsconfig.json` after `ensure:deep-tsconfig`.                                                       | The `bun check` invocation could merge into the single `bun lint --type-check` pass, cutting one full-repo type-check cycle out of the gate chain. |

**When Bun ships `bun lint`, the migration shape is:**

1. Confirm the Bun version in `AGENTS.md` ships `bun lint` built-in (not just the docs page);
   `bun --help | grep -w lint` must list it.
2. Rename the `package.json` `"lint"` script to `"oxlint"` (or similar) to clear the shadow —
   see `/docs/lint`: _"If `package.json` has a `lint` script, `bun lint` runs that script."_
3. Collapse `lint:check` + `typecheck` into one call:
   `bun lint --type-check --type-aware -c .oxlintrc.type-aware.json --no-script`
4. Keep `ensure:deep-tsconfig` — it's a strict-flags gate on the single tsconfig, orthogonal
   to whichever linter reads it.
5. Measure: time the before/after, and verify the oxlint `-f github` CI annotation path
   ([PR #50](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/50)) still works
   (`bun lint -f github` is documented).

Do not pre-migrate before `bun --help` lists `lint`; the docs have been ahead of the binary.

## v1.4.0 feed/transport primitives in use

- **`.jsonl.zst` / `.jsonl.gz`**: `lib/f402_bet_ticker_jsonl.ts` detects compressed paths and pipes `Bun.file(path).stream()` through `new DecompressionStream("zstd" | "gzip")`, then `new Response(stream).textStream()` into the JSONL reader. Tested with both formats.
- **Compression streams**: contract test round-trips `CompressionStream("gzip" | "deflate" | "deflate-raw" | "zstd" | "brotli")` through `DecompressionStream` with byte-identical output.
- **`Response.textStream()`**: `lib/gslive_tally_rollup.ts::streamBetReportBets` now consumes `new Response(Bun.file(path)).textStream()`, so BOM stripping and multi-byte chunk reassembly are Bun's responsibility (tested with a BOM + `€🌍` split across bytes).
- **`Bun.stringWidth` / `wrapAnsi` / `sliceAnsi`**: contract tests pin ANSI stripping, cursor/hyperlink sequences, ZWJ/flags/skin-tone/keycap graphemes, zero-width soft hyphen + combining marks, and CJK double width.
- **`Bun.Archive`**: contract test round-trips `Bun.Archive.from` → `Bun.Archive.write` → `extract`.
- **`URLPattern`**: contract test matches `/api/v1/blobs/:key` and rejects `/api/v1/live-bets`.
- **PQC**: contract tests exercise `crypto.subtle` ML-KEM-768 bits round-trips, JWK/raw-public/raw-seed export-import, structuredClone of PQC CryptoKeys, `node:crypto` `ml-dsa-65` sign/verify, JWK `kty: "AKP"`, PEM/DER/encrypted PKCS#8, `createPublicKey`/`createPrivateKey` imports, and ML-KEM-768 keypairs. `encapsulateKey` and `decapsulateKey` take 5/6 arguments respectively (`algorithm, key, sharedKeyAlgorithm, extractable, keyUsages` + ciphertext for decapsulation); the contract test derives matching AES-GCM-256 shared keys and compares their raw exports.
- Contract test: `tests/bun_v140_primitives.test.ts`.

## F402 WebLog + Mode 6 overlap bridge

`lib/f402_weblog_fetch.ts` fetches `Manager/getWebLog` directly in four modes:

| Mode | Wire shape                                      | Date         |
| ---- | ----------------------------------------------- | ------------ |
| A    | `type:"A"`, `customerID:<loginId>`              | `MM/DD/YYYY` |
| B    | `type:"B"`, `customerID:<officeAgentId \| "0">` | `MM/DD/YYYY` |
| C    | `type:"C"`, `customerID:<loginId>`              | `YYYY-MM-DD` |
| I    | `type:"I"`, `customerID:"0"`, `ip:<ip>`         | as supplied  |

All carry `operation:"getWebLog"`, `RRO:1`, `agentID`, `agentOwner`. Token resolution is read-only
(`--bearer-token` → `F402_BEARER_TOKEN` → `F402_TOKEN_FILE` →
`session:login` `authorizationHeader` in `f402-session.json`), rejecting empty/`"0"`/`<24`-char
tokens before I/O.
Responses pass a Class A guard (200, JSON, not HTML) and are atomically persisted 0600 as JSONL.

CLI (`scripts/f402_weblog_bridge.ts`):

| Mode             | Command                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Capture + rollup | `bun run weblog:rollup --fetch-mode A\|B\|C\|I [--date YYYY-MM-DD] [--save-capture path] [--customer-id id] [--ip addr]` |
| Rollup only      | `bun run weblog:rollup --from out/f402/weblog/MM-DD-YYYY.jsonl`                                                          |

`--fetch-mode` calls `fetchAndPersistWebLog` then rolls up the captured JSONL (default capture:
`out/f402/weblog/<MM-DD-YYYY>.jsonl` from `--date`). Without `--fetch-mode`, `--from` is required
(no hard-coded demo corpus). Token: `--bearer-token`, `F402_BEARER_TOKEN`, or `F402_TOKEN_FILE`.

The rollup is gated by GATE-WL-01 (row/grammar conservation, 523,632 rows), GATE-WL-02 (causal
wager conservation), GATE-WL-03 (negative/positive controls), and GATE-WL-04 (byte-level raw
LoginID/IP leak scan). Publications: `f402-weblog/<desk-date>/rollup.json` + `f402-weblog/latest.json`;
WS channel `f402-weblog` when the live-bets gateway is running.

## bun-docs MCP probe (2026-11-04)

Probe method: `https://bun.sh/docs/mcp` speaks JSON-RPC 2.0 (protocol `2025-06-18`) and exposes
`search_bun`, `read_bun_page`, `list_bun_pages`, `grep_bun`. It matches the shape recorded in
[`bun-mcp.md`](./bun-mcp.md). The repo-native client (`bun run bun:docs-mcp`) now owns this probe: `surfaces` audits every
catalog shape against the docs and `surfaces --check` is an offline CI gate on the committed
baseline (`tests/bun_docs_surface_baseline.json`). Note that `/reference/**` is not indexed, and in the DSH session this
server is not registered (only `chrome` is), so the probe spoke JSON-RPC directly over HTTP.

**Usage census:** 77 distinct `Bun.*` surfaces are used in non-test source; all 77 are declared and
evidenced in `lib/bun_shapes.ts` (78 catalog entries, 1 unused). `tests/bun_shapes_coverage.test.ts`
enforces that with no undocumented surface.

**Confirmed by the published docs (bun.com URLs):**

- `Bun.JSONL.parseChunk`: `read` is "Number of bytes (for `Uint8Array`) or characters (for strings)
  consumed" and, for `Uint8Array`, "always a byte offset into the original buffer. Use it with
  `TypedArray.subarray()`" — https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
- `ServerWebSocket.subscriptions` is a getter returning "an array of every topic the socket is
  currently subscribed to" (shipped in 1.3.2; the anchor is in the v1.4 blog's runtime
  long-tail) — https://bun.com/blog/bun-v1.4#runtime (PR #24299). The announcement states no
  ordering, which is why the gateway compares subscription sets and the test sorts.
- `server.publish()` / `ws.publish()` return `0` (dropped) or `-1` (backpressure), "honoring the
  same contract as `ws.send()`" — https://bun.com/blog/bun-v1.4
- `subscriberCount(topic: string)` counts subscribers for a topic —
  https://bun.com/blog/bun-v1.1.26
- `Bun.cron(schedule, handler, { tz?: string })` is the in-process form; schedules default to the
  system local time zone, `tz` is an IANA name, and the docs carry a **No-overlap guarantee**
  section — https://bun.com/docs/runtime/cron#time-zone and
  https://bun.com/docs/runtime/cron#no-overlap-guarantee
- `Bun.secrets`: `get` returns `string | null`, `delete` returns `boolean`, and `set` takes
  `{ service, name, value, persist?: "local" | "enterprise" }` (persist is Windows-only, default
  `"enterprise"`) — https://bun.com/docs/runtime/secrets
  The same page also shows a positional `Bun.secrets.get("my-app", "alice@example.com")` overload.
  Measured on 1.4.4: it **works at runtime** (returns the value; the declared arity is 1), but
  `@types/bun` accepts only the options object — TypeScript reports `TS2554: Expected 1 arguments,
but got 2`. Repo code therefore uses the object form exclusively, and `lib/secrets.ts` types its
  provider as `Pick<typeof Bun.secrets, "get">` so a positional call cannot slip in.
- `Bun.markdown`: `html`, `render` and `react` share the GFM `Options` (`tables`, `strikethrough`,
  `tasklists`, `autolinks`, `headings`, `tagFilter`, `noHtmlBlocks`/`noHtmlSpans`, `wikiLinks`,
  `underline`, `latexMath`, …); `html` callbacks receive `html` — "Raw HTML content"; `tagFilter` is
  the GFM tag filter; `react(..., undefined, { reactVersion: 18 })` is the React 18 element symbol;
  the API is marked "Unstable API" — https://bun.com/docs/runtime/markdown
- `Bun.markdown.react()` SSR lives in `lib/markdown_react_ssr.ts`: `renderMarkdownSsr(markdownText(s))`
  returns a `RenderedHtml` brand, so Markdown input and rendered HTML cannot be passed in the wrong
  direction. The repo pins `react`/`react-dom` 18.3.1, so it passes `reactVersion: 18`; React 18's
  renderer rejects React 19 elements and React 19's renderer rejects the legacy element symbol.
- Child processes expose `.terminal.close()` and `exited` —
  https://bun.com/docs/runtime/child-process#reusable-terminal
- `--no-env-file` disables automatic `.env` loading —
  https://bun.com/docs/runtime/environment-variables#disabling-automatic-env-loading
- `--no-orphans` exits when the parent dies (bunfig equivalent `run.noOrphans`) —
  https://bun.com/blog/bun-v1.3.14#no-orphans-exit-when-the-parent-process-dies and
  https://bun.com/docs/runtime/bunfig#run-noorphans-don-t-leave-orphan-processes-behind
- `ServerWebSocket.cork(callback)` passes the socket as the callback's first argument (v1.4) —
  https://bun.com/blog/bun-v1.4

**Measured here, NOT stated by the indexed corpus — do not cite bun.com for these:**

- `parseChunk(...).read` excludes the newline that terminates the last parsed record (byte-level
  probe; see `tests/bun_jsonl_chunking.test.ts` / `tests/f402_weblog.test.ts`).
- `ws.subscriptions` **ordering**: the runtime returns topics in hash order, not insertion order.
  Existence/array/current-state semantics are doc-confirmed above; the ordering is not documented
  anywhere indexed (black-box probe; the gateway treats it as a set and tests sort).
- `open`/`message` are automatically corked (from the `/reference` docs, which this MCP does not
  index).
- `ws.publish()` excludes the sender and `publishToSelf` changes that (0.6.3 change; not present in
  the indexed corpus).

### `bun repl` (native since 1.4.0) — verified 2026-11-04

Adoption: **probes only.** No production code or script depends on the REPL; automation keeps
`bun -e` / `bun -p`, whose patterns are pinned in `tests/bun_eval_patterns.test.ts`. The REPL is
useful for one-off inspection, so its measured behavior is recorded rather than assumed.

**Confirmed on 1.4.4 (macOS arm64):**

- `-e` evaluates without printing the value; `-p` prints it through `Bun.inspect` to stdout.
  Top-level `await` works in both. Bare object literals are expressions there, so
  `bun repl -p '{a:1}'` prints `{ a: 1 }` while `bun -p '{a:1}'` prints the label value `1`.
- Piped stdin runs a full REPL, not a line sink: `_` (last result) and `_error` (last error) work,
  `function f() {` … `}` continuation works, `.help` lists keybindings/special variables,
  `.save <path>` writes the session and `.load <path>` replays it, `.editor` ends on EOF, and the
  process exits `0` at EOF instead of hanging. Piped stdout also carries the `> ` prompt around
  each result, so a caller must strip it. `bun repl --help` is not a subcommand: it falls
  through to `bun run` usage.
- Dot-command output (`.help`, `.save` notice) carries ANSI escapes even when stdout is a pipe;
  parse the values, never the console transcript.
- `~/.bun_repl_history` (mode 0600) is written by interactive **and piped** sessions; `-e`/`-p`
  one-shots do not write it. Automated probes must set `HOME` to a scratch directory (the tests do).
- `bun completions` selects the script from **`$SHELL`** (zsh `#compdef`, fish, bash); a positional
  shell argument is ignored on 1.4.4, and an unsupported `$SHELL` errors with a pointer to
  `bun getcompletes` (which prints the completion word list, not a script).

### Chrome/WebView diagnostics (measured 2026-11-04)

Bun's Chrome backend spawns a headless Chrome and talks CDP over `--remote-debugging-pipe`. When
that browser dies, the first navigation rejects with the opaque
`navigate-failed: … Chrome process closed the pipe`; the cause exists only on Chrome's stderr. In
this environment the measured stderr was:

```
sandbox initialization failed: Operation not permitted
ERROR: … Crashpad …/Google Chrome/Crashpad/new/….dmp: Operation not permitted (1)
FATAL: … gpu_data_manager_impl_private.cc:389] GPU process isn't usable. Goodbye.
```

`lib/webview_backend_diagnostics.ts` runs a minimal headless probe (`--dump-dom about:blank`, an
isolated `--user-data-dir`, killed after a timeout), classifies that stderr in root-cause order
(`sandbox-denied` → `gpu-denied` → `crashpad-denied` → `profile-locked` → `not-found`), and maps it to
remediation. `bun run session:status --diagnose` prints the binary, the class and the fixes;
`session:login` appends the same advice to a launch/navigate failure. The advice deliberately never
suggests `--no-sandbox`: disabling the browser's sandbox is not a fix for a credential login. The
binary search follows Bun's documented order (`BUN_CHROME_PATH`, PATH candidates, macOS install
paths) and a configured-but-missing `BUN_CHROME_PATH` reports `not-found` instead of silently
falling back.

### `Bun.Terminal` and `TerminalSession` Agent Architecture (Bun v1.4.4)

`Bun.Terminal` introduced zero-dependency native pseudo-terminal support (`#25415` macOS/Linux, `#29522` Windows ConPTY) without `node-pty`.

#### Architectural Distinctions: Process I/O vs Session Orchestration

| Component                      | Bun Native API                  | `TerminalSession` Responsibility                     |
| :----------------------------- | :------------------------------ | :--------------------------------------------------- |
| **Interactive agent sessions** | `Bun.spawn({ terminal })`       | Process lifecycle & ownership                        |
| **Noninteractive commands**    | `Bun.$` or ordinary `Bun.spawn` | Reserved for deterministic pipeline tasks            |
| **Live terminal output**       | `terminal.data` callback        | Multiplexed stream, live streaming listener          |
| **User / agent input**         | `terminal.write()`              | Stream stdin driving via `.write()` / `.writeLine()` |
| **Dynamic terminal sizing**    | `terminal.resize()`             | Runtime resize via `.resize(cols, rows)`             |
| **Process completion**         | `proc.exited`                   | Awaits `proc.exited`, distinct from PTY stream EOF   |
| **Session cleanup**            | `terminal.close()`              | Async resource disposal via `[Symbol.asyncDispose]`  |

#### Two Critical Implementation Subtleties

1. **`proc.exited` vs PTY `exit` callback**: The terminal's PTY `exit` callback describes the PTY stream closing (`0` for clean EOF, `1` for read error), NOT the subprocess exit code. Subprocess exit status (e.g. exit 42) must always be resolved via `await proc.exited`.
2. **Multiplexed stream & raw ANSI bytes**: PTY multiplexes stdout and stderr into a single terminal stream. `TerminalSession` preserves the verbatim ANSI bytes in `.raw` for accurate terminal replay and web streaming, while `.text` provides clean plain-text stripping (`stripPtyCapture`) for assertion engines and loggers.
3. **Compile-time flags under PTY**: `TerminalSession.startBun(script, args, { target: "dev" | "prod" })` merges `BUILD_FEATURES` into `--feature=FLAG` arguments placed before the script, executing feature-flagged scripts inside a real PTY.

### `bun:ffi` Native Interop and the Three-Tier Agent Execution Model (Bun v1.4.4)

For operator and AI agent infrastructure in Bun, three execution layers must be kept architecturally distinct:

| Layer                                 | Execution Mechanism                | Primary Use Case                                                             | Performance & Isolation Characteristics                                                      |
| :------------------------------------ | :--------------------------------- | :--------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| **Tier 1: Shell Automation**          | `Bun.$` / `Bun.spawn`              | Deterministic pipeline scripts, tool wrappers, non-interactive CI gates      | Subprocess isolation, pipe streams, zero TTY overhead                                        |
| **Tier 2: Interactive Terminal**      | `Bun.Terminal` / `TerminalSession` | Interactive CLI driving, agent debugging, TTY streaming, ANSI replay         | Real PTY allocation (`/dev/pty`), session ownership, dynamic resize, async resource disposal |
| **Tier 3: Native In-Process Interop** | `bun:ffi` (`dlopen`)               | Performance-critical parsers, compression, specialized cryptographic digests | In-process C ABI, zero process/IPC overhead, direct pointer manipulation                     |

#### High-Performance Bun FFI Capabilities

Bun FFI simplifies native library interop with two zero-copy idioms:

1. **Automatic Buffer-Length Resolution (`"buffer"` + `"buffer_length"`):**

   ```ts
   import { dlopen } from "bun:ffi";

   const { symbols } = dlopen("libhash.so", {
     hash: {
       args: ["buffer", "buffer_length"],
       returns: "cstring",
     },
   });

   const data = new TextEncoder().encode("SportsDesk");
   // Passing the same buffer twice:
   // Arg 0 receives the memory pointer (`const uint8_t *`)
   // Arg 1 receives the current byte length (`size_t`) evaluated at call time
   const digest = symbols.hash(data, data);
   ```

   _Advantage:_ Bun extracts the pointer and `.byteLength` at the moment of invocation. This avoids separate length evaluations in JavaScript that could become stale or race when using resizable, transferred, or sub-allocated `ArrayBuffer` views.

2. **Native C-String Conversion (`"cstring"`):**
   - **Arguments:** JavaScript strings passed to a `"cstring"` argument are automatically transformed into null-terminated UTF-8 C strings (`const char *`).
   - **Returns:** Null-terminated C string pointers returned from native functions are automatically converted into JavaScript `string` primitives (or `null` for null pointers).

#### Operational Precautions for Native Interop

1. **Memory Ownership:** Returning `"cstring"` copies the native string into a JavaScript string managed by JSC, but it does **not** free native heap memory allocated by the native library (`malloc`). Native functions returning dynamically allocated strings must expose a matching native `free()` symbol or accept a caller-owned output buffer (`["buffer", "buffer_length"]`).
2. **Production Stability Boundary:** Bun upstream documents `bun:ffi` as experimental and explicitly recommends Node-API (`napi`) for production-critical native extensions requiring long-term ABI stability guarantees.

### `bun run --parallel` and `--sequential` (Bun v1.4.0 / PR #26551)

Bun v1.4 natively runs multiple `package.json` scripts concurrently with Foreman-style name-prefixed output, replacing npm packages like `concurrently` and `npm-run-all`.

#### Core Capabilities & CLI Semantics

1. **Concurrent Execution:** `bun run --parallel scriptA scriptB` executes scripts concurrently, prefixing each line of stdout and stderr with the aligned task name (e.g. `typecheck | ...`).
2. **Sequential Execution:** `bun run --sequential scriptA scriptB` runs scripts sequentially with identical Foreman-style prefixing.
3. **Glob Matching:** `bun run --parallel "build:*"` expands glob patterns against script names in `package.json`.
4. **Workspace Fan-Out:** `bun run --parallel --filter '*' build` or `--workspaces` executes the target across all monorepo packages.
5. **Lifecycle Hook Grouping:** `pre<script>` and `post<script>` lifecycle hooks are automatically grouped and executed in dependency order with their main script under the same prefix.
6. **Fault Tolerance (`--no-exit-on-error`):** By default, when any script fails, Bun sends `SIGINT` to cancel sibling scripts. Passing `--no-exit-on-error` (which must precede positional script arguments or globs) keeps running remaining scripts to completion.

### Dev Tooling & Process Lifecycle Contracts (Bun v1.4.0)

| Tooling Feature        | Upstream PR                                                                                              | Primary Mechanism & Flags                                                | Operational Invariant in `sportsdesk-ops`                                                                                                                            |
| :--------------------- | :------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CPU Profiling**      | [#24112](https://github.com/oven-sh/bun/pull/24112), [#26327](https://github.com/oven-sh/bun/pull/26327) | `--cpu-prof`, `--cpu-prof-md`, `BUN_CPU_PROFILE=1`                       | Markdown reports are written to gitignored `scratch/profiles/` for LLM inspection; `BUN_CPU_PROFILE=1` profiles daemons started via supervisor without editing argv. |
| **Heap Profiling**     | [#26326](https://github.com/oven-sh/bun/pull/26326)                                                      | `--heap-prof`, `--heap-prof-md`                                          | Retained-size breakdown & GC roots in Markdown; used to verify fixed-capacity TypedArray allocations and zero-allocation invariants.                                 |
| **Async Stack Traces** | [#28652](https://github.com/oven-sh/bun/pull/28652)                                                      | Automatic across `Bun.file()`, `fs.promises`, S3, DNS, crypto, `fetch()` | Native errors preserve call frame continuity back to the application `await` site, eliminating blind async rejections in telemetry.                                  |
| **Orphan Prevention**  | [#29930](https://github.com/oven-sh/bun/pull/29930)                                                      | `--no-orphans` (`[run] noOrphans = true`)                                | Enforced on all long-lived workers and watch scripts (`wagers:watch`, `positions:cron`, `supervisor.ts`); exits when parent dies and SIGKILLs descendants.           |
| **Env File Isolation** | [#24767](https://github.com/oven-sh/bun/pull/24767)                                                      | `--no-env-file` (`env = false` in `bunfig.toml`)                         | Enforced on cron jobs to prevent accidental loading of local 1Password `.env` pipes; secrets are injected via `Bun.secrets` or explicit supervisor env.              |

### Connected `bun run --help` Surface (`lib/bun_cli_flags.ts` & `scripts/dx_run_control.ts`)

Rather than duplicating upstream CLI documentation by hand, `readBunRunCliSurface()` in [`lib/bun_cli_flags.ts`](../lib/bun_cli_flags.ts) spawns `bun run --help` against the active binary (`process.execPath`), parses every flag/alias/description row dynamically, classifies each flag into `control`, `monitor`, `workspace`, `environment`, `network`, or `transpiler`, and connects that live surface directly into `./bin/dx --help` and `bun run cli --help`:

- **Help introspection**: `./bin/dx --help` and `bun run cli --help` append the curated control/monitoring footer; `./bin/dx help --bun` (and `bun run cli --bun-help`) render the full categorized `bun run --help` catalog with `--category=<kind>`, `--filter=<substring>`, and `--raw` passthrough.
- **Validated runtime forwarding (`./bin/dx run` & `DX_BUN_FLAGS`)**: [`scripts/dx_run_control.ts`](../scripts/dx_run_control.ts) validates every forwarded Bun flag against `surface.flags` (suggesting nearest flag names on typos), injects containment defaults (`--no-orphans`, `--unhandled-rejections=strict`, `--title=dx:<target>`), maps operator presets (`--profile-cpu`, `--profile-heap`, `--isolated-env`, `--low-mem`, `--watch-safe`, `--debug`, `--timeout-ms`), and blocks execution whenever `BUN_CONFIG_VERBOSE_FETCH` is enabled alongside any populated credential from [`lib/secret_manifest.ts`](../lib/secret_manifest.ts).
- **Live telemetry (`./bin/dx monitor` & `./bin/dx live-bets`)**: `./bin/dx monitor` joins `ps` Bun process telemetry (`--no-orphans` and `--title` visibility), `:4020` `/health` + `/api/v2/live-bets` probes (honoring `--offline` and `DX_STATUS_OFFLINE=1`), and `scratch/profiles/` hotspot extraction/pruning; `./bin/dx live-bets` exposes direct CLI control and watch polling over the explicit `/api/v2/live-bets` `source`/`fallback` contract.

### macOS kqueue Event Loop Bug & Event Filter Semantics

#### Root Cause Analysis: Signed Filter Enums vs Bitwise Masks

In BSD and macOS Darwin kernels (`<sys/event.h>`), kernel events (`struct kevent`) distinguish event types via `int16_t filter`:

```c
struct kevent {
    uintptr_t ident;       /* identifier for this event (e.g. socket fd) */
    int16_t   filter;      /* filter for event */
    uint16_t  flags;       /* action flags (e.g. EV_ADD, EV_ENABLE, EV_ONESHOT) */
    uint32_t  fflags;      /* filter-specific flag bits */
    intptr_t  data;        /* filter-specific data value */
    void      *udata;      /* opaque user data identifier */
};
```

Kernel filters are defined as signed negative integer constants (ordinals), **not** orthogonal bitmasks:

- `EVFILT_READ` = `-1` (`0xFFFF` in 16-bit two's complement)
- `EVFILT_WRITE` = `-2` (`0xFFFE` in 16-bit two's complement)
- `EVFILT_AIO` = `-3` (`0xFFFD`)
- `EVFILT_VNODE` = `-4` (`0xFFFC`)
- `EVFILT_PROC` = `-5` (`0xFFFB`)
- `EVFILT_SIGNAL` = `-6` (`0xFFFA`)
- `EVFILT_TIMER` = `-7` (`0xFFF9`)

#### The 100% CPU Busy-Loop Mechanism

1. **Incorrect Bitwise Comparison:** When kqueue event polling checked filters using bitwise AND (`filter & EVFILT_WRITE`) instead of strict equality (`filter == EVFILT_WRITE`), any `EVFILT_READ` event resulted in:
   $$-1 \ \& \ -2 \ = \ \text{0xFFFF} \ \& \ \text{0xFFFE} = \text{0xFFFE} \ (-2) \neq 0$$
   Because the result is non-zero, every readable event erroneously evaluated as a writable event.
2. **Missing `EV_ONESHOT` on Writable Sockets:** In BSD sockets, a writable condition is level-triggered: as long as space remains in the socket send buffer, the kernel continuously reports readiness. Without `EV_ONESHOT` (or `EV_CLEAR`) to automatically disarm the filter upon firing, a writable registration on an open socket remains continuously active.
3. **The Spin Cycle:** Combined with the bitwise filter check evaluating true for incoming read events, the event loop woke up repeatedly with phantom writable readiness when no write I/O was pending or scheduled, spinning at 100% CPU in a tight `kevent()` loop.

#### Operational Rules for `sportsdesk-ops`

1. **Strict Separation of Bitwise Flags vs Scalar Enums:**
   - **Bitwise flags**: Orthogonal flags packed into bitsets (`Uint32Array` arenas in `lib/bitwise_pattern_inspect.ts`, `lib/gslive_tally_rollup.ts`, and `InspectableBitSet32`) must use explicit bit shifts (`1 << bit`) with mask checks `(flags & MASK) !== 0`.
   - **Scalar enums / ordinals**: Kernel filters (`EVFILT_*`), HTTP status codes, error codes, and TypeScript union discriminants must **always** be tested with strict equality (`===`), never bitwise masking.
2. **Process and Socket Supervision under kqueue:**
   - In `bunfig.toml`, `noOrphans = true` registers `EVFILT_PROC` with `NOTE_EXIT` to guarantee that spawned child processes (including headless browser workers) terminate when parent daemons exit.
   - Long-lived daemons (`:4020` webview server, websocket streams, and `positions:cron`) on macOS rely on Bun versions containing this fix to avoid socket spin loops during idle write readiness.

## `bun fmt`: CI gates vs. `pre-commit` (`--staged`)

Bun 1.4.4 ships `bun fmt --staged`, `bun fmt --changed`, and `bun fmt --check` (exit `0` clean, `1` needs formatting, `2` syntax/tool error). In `sportsdesk-ops`, formatting is enforced at two layers and **intentionally not wired to a `pre-commit` hook**:

- **PR gate (`.github/workflows/ci.yml` `verify-changed`):** runs `bun fmt --check --changed="origin/${GITHUB_BASE_REF}"`, distinguishing exit `1` (unformatted files) from exit `2` (tool/syntax failure).
- **Mainline backstop (`.github/workflows/ci.yml` `verify` & `bun run format:check`):** runs full-repo `bun fmt --check` across all tracked files not excluded by `.gitignore` or `bunfig.toml [fmt].ignorePatterns`.
- **Why `bun fmt --staged` is not wired to `pre-commit`:** `.git/hooks/` is untracked unless the repo adopts a `core.hooksPath` / hook-runner policy, reformatting partially staged files rewrites the working tree relative to staged hunks, and the existing `pre-push` gate plus PR `verify-changed` already catch drift without per-commit friction.
