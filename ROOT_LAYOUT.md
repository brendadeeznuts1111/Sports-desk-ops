# Repository layout (root)

The root holds **workspace metadata** (`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `.npmrc`, `.oxlintrc*.json`, `dashboard.md`, and top-level docs) alongside canonical root entrypoints (`index.js`, `index.jsx`, `index.ts`, `index.tsx`) which delegate to `cli/sportsdesk_cli.ts`. Executable CLIs, scripts, and SSOT live in subdirectories (`cli/`, `scripts/`, `bin/`, `packages/sportsdesk-ops/bin/`) and link into `node_modules/.bin/` for `bun x <cli>` execution.

| Path                    | Purpose                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `index.{js,jsx,ts,tsx}` | Root CLI & programmatic entrypoints delegating to `cli/sportsdesk_cli.ts`                  |
| `cli/`                  | All `sportsdesk_*_cli.ts` entrypoints ([cli/README.md](cli/README.md))                     |
| `services/`             | Daemon, bot, R2, churn engine, ingestion ([services/README.md](services/README.md))        |
| `catalog/`              | Fantasy402 sport navigation catalog ([catalog/README.md](catalog/README.md))               |
| `design/`               | `tokens.toml` + generated `domain-branded-types.ts` ([design/README.md](design/README.md)) |
| `lib/`                  | Shared modules; token math in `lib/validation/`                                            |
| `schema/`               | Migrations, local manifest, schema preload ([schema/README.md](schema/README.md))          |
| `infra/`                | Pages `_headers` for docs deploy ([infra/README.md](infra/README.md))                      |
| `types/`                | Ambient `env.d.ts` ([types/README.md](types/README.md))                                    |
| `scripts/`              | Generators, Manager Tools fetchers, capture, audits; `scripts/deploy/` for VPS/docs        |
| `reports/`              | Auditable surveillance outputs, Plane 3 ingestion JSONL, and docs-review artifacts         |
| `static/`               | Token-compiled daemon HTML dashboards                                                      |
| `docs/`                 | Evidence portal; `docs/runbooks/`; `docs/provenance/`                                      |
| `tests/`                | Bun test suites                                                                            |
| `client/`               | Browser-side overlay seam preload (`security-seams.preload.js`)                            |
| `config/`               | Wagers capture configuration (`wagers.json`, `wagers-capture.toml`)                        |
| `packages/`             | Workspace packages (`sportsdesk-ops` CLI bin package, `nsh-desk`, `ba-example`)            |
| `verification/`         | TLA+/gate verification specs (e.g. the gen-tokens zero-drift gate)                         |
| `bin/`                  | Operator wrappers (`bin/dx`, `bin/wrangler`), image/XML/blob CLIs, and CI AST gates        |

**Harness plugins (`dsh-plugin*`).** Removable DeepSeek Harness bundles live at the root, each its own
package with a `cordis.patch.yml` manifest and a dependency-free `verify-load.mjs` smoke harness so it
can be installed, disabled, or removed independently: `dsh-plugin/` (Host tools), `dsh-plugin-ui/`
(composer desk-status row), `dsh-plugin-sidebar/` (left-sidebar SportsDesk desk page),
`dsh-plugin-security/` (read-only security/fraud console), and `dsh-plugin-watchlist-autobet/`
(paper-only watchlist autobet control plane). `tests/plugin_bundles.test.ts` enforces that every
bundle's `verify-load.mjs` passes; it does not prove a running Host UI.

**Deploy & reports**

- `bun run deploy` → `scripts/deploy/deploy_to_vps.sh`
- `bun run reports` → `scripts/deploy/run_reports.sh`
- `bun run deploy:docs` → `scripts/deploy/deploy_docs.sh`

## Bun runtime flags vs script arguments

Bun flags fall into three clear positional tiers (derived from Bun `v1.4.x` grammar: `bun [bun flags] run <script> [script flags]`):

1. **Top-level Bun flags** (place immediately after `bun`, before the subcommand or entrypoint):
   - `bun --watch run dev` or `bun --watch index.tsx` ✔️ (runtime watcher active; canonical documented form)
   - `bun --check run script.ts` or `bun --check scripts/foo.ts` ✔️ (type-checks, then **runs** the target when it type-checks — a gate before execution, not a check-only mode; `bun check <files…>` is the check-only form, and `bun --check a.ts b.ts` checks only `a.ts` and passes `b.ts` to it as argv)
   - `bun --smol run dev` or `bun --smol index.tsx` ✔️ (runs GC more often to keep memory low; `smol = true` in `bunfig.toml`)
   - `bun --console-depth=5 run dev` or `bun --console-depth=5 index.tsx` ✔️ (sets `console.log` object depth to 5)
   - `bun --cpu-prof run dev` or `bun --cpu-prof index.tsx` ✔️ (writes CPU profile to disk on exit)
   - `bun --no-env-file run dev` ✔️ (disables automatic `.env` file loading)

2. **Dual-position runner flags** (accepted before `run` or immediately before target `<cli>`):
   - `bun --bun run dev` or `bun run --bun vite` ✔️ (forces `#!/usr/bin/env node` shebangs to run under Bun; canonical doc form is `bun run --bun <cli>`)

3. **Always forwarded to `process.argv`** (never recognized by Bun):
   - By Bun's trailing-flag passthrough rule, any flag placed **after** the target script or entrypoint is passed verbatim to the script as arguments, bypassing Bun runtime controls:
     - `bun run dev --watch` ❌ (`--watch` forwarded to script `process.argv`, ignored by Bun)
     - `bun run script.ts --check` ❌ (`--check` forwarded to script `process.argv`, code runs anyway!)
     - `bun run dev --smol` ❌ (`--smol` forwarded to script `process.argv`, ignored by Bun)
     - `bun run dev --console-depth=5` ❌ (forwarded to script `process.argv`, depth stays at default 2)
     - `bun run dev --bun` ❌ (forwarded to script `process.argv`, ignored by Bun)

> _Note: Reflects Bun v1.4.x CLI parsing behavior. Top-level positioning for flags like `--no-env-file` and `--cpu-prof` derives from the general top-level flag parsing rule (`bun [bun flags] run <script> [script flags]`)._

## Script execution & subshell resolution

When executing `package.json` scripts (`bun run <script>`):

- Bun runs the script command string inside a subshell.
- **Linux & macOS**: Bun checks for available shells in priority order, launching the first one found: `bash` → `sh` → `zsh`.
- **Windows**: Bun invokes the native Bun Shell (`bun:shell`; see [upstream `shell.d.ts`](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-types/shell.d.ts)), bringing consistent bash-like syntax and built-in utilities (`rm`, `echo`, `cp`, `mv`, pipes, redirects) to Windows without requiring WSL or MSYS2.
- **Startup latency**: `bun run` starts in ~6ms (Linux) / ~7–14ms (macOS), compared to ~170ms for `npm run`, because Bun is a native Zig/JSC binary with SIMD JSON parsing that bypasses Node's multi-module CLI bootstrap.
- **Shorthand `bun <script>` vs explicit `bun run <script>`**:
  - Non-colliding scripts can be invoked directly as `bun <script>` (e.g. `bun clean`, `bun dev`, `bun health`).
  - If a script name collides with a native Bun CLI command (e.g. `test`, `build`, `check`, `install`, `add`, `remove`, `update`, `pm`), the **native built-in command takes precedence** (e.g. `bun test` runs Bun's native test runner).
  - To explicitly run the `package.json` script when shadowed by a built-in, use the explicit prefix: **`bun run <script>`** (e.g. `bun run test`).
- **Listing scripts**: Running `bun run` without arguments displays all supported runtime flags followed by a formatted manifest of every script declared in `package.json` and its exact underlying shell command.
- **Resolution Order for `bun run <target>`**: When resolving `<target>`, Bun traverses a 4-step priority hierarchy (empirically verified on Bun v1.4.4):
  1. **`package.json` scripts**: (e.g. `bun run target`). If a script and a local file share the same name, `bun run` always prioritizes the package script. Furthermore, under `bun run`, extensioned targets (like `bun run target.ts`) still evaluate `package.json` scripts first.
  2. **Source files**: (e.g. `bun run src/main.js`, `bun run target`). If no script matches, Bun resolves `<target>` as a source file. Explicit paths starting with `./` or `.\` (or absolute paths) always bypass script lookups and execute directly as source files.
     - **Extension probing order**: When `<target>` has no extension, Bun automatically probes extensions using the default sequence: `.tsx` → `.ts` → `.jsx` → `.js` (from `--extension-order`, default: `.tsx,.ts,.jsx,.js,.json`). Consequently, if both `target.ts` and `target.js` exist in the same directory, Bun resolves and executes `target.ts`.
  3. **Package binaries**: Executables linked in `node_modules/.bin/` (e.g. `bun run oxlint`, `bun run tsc`, `bun run wrangler`). Confirmed to take strict precedence over same-named binaries on system `$PATH`.
  4. **System commands (`bun run` only)**: Falls back to `$PATH` binaries (e.g. `bun run ls`). By default, if `<target>` matches neither a script, source file, package binary, nor system executable, Bun halts with `error: Script not found "<target>"` (exit 1). Passing **`--if-present`** (`bun run --if-present <target>`) suppresses this error and exits 0 cleanly if the entrypoint does not exist.
- **Resolution Modifiers & Bypasses**:
  - **Inline evaluation (`-e` / `-p`)**: Passing `-e, --eval <code_str>` or `-p, --print <code_str>` bypasses the 4-step resolution hierarchy entirely, evaluating JavaScript/TypeScript code directly in memory.
  - **Auto-install control (`--no-install` / `--install`)**: Controls whether missing packages in Step 3 are automatically fetched from npm during execution (`--install=auto` [default when no `node_modules`], `fallback`, or `force`; `--no-install` disables auto-install).
  - **Working directory rebase (`--cwd`)**: Passing `--cwd <dir>` rebases the root for script lookups, source file probing, and `node_modules/.bin/` resolution to `<dir>`.
  - **Shell selector (`--shell bun|system`)**: Forces `package.json` script subshells to use the embedded Bun Shell or the host system shell (`bash`/`sh`/`zsh`).
- **Bare `bun <target>` (without `run`)**:
  - With an allowed extension (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`), bare `bun target.ts` **prioritizes the file on disk over a same-named script in `package.json`**.
  - Without an extension (`target`), bare `bun target` checks `package.json` scripts first; if absent, it probes allowed extensions (`target.tsx` → `target.ts` → `target.jsx` → `target.js`) on disk.
  - Bare `bun <cmd>` **never falls back to system commands** and fails on Bun v1.4.4 with `error: Script not found "<cmd>"`.
- **Trap / Footgun (Script collisions with file names)**: Naming a `package.json` script after an entrypoint file (e.g. `"index.ts": "echo SCRIPT"`) means `bun run index.ts` silently runs the _script_, completely bypassing the source file on disk. Use bare `bun index.ts`, `bun ./index.ts`, or `bun run ./index.ts` to guarantee file execution.
- **Lifecycle hooks (`pre<script>` and `post<script>`)**: Bun automatically respects lifecycle hooks:
  - Executing `bun run <script>` runs `pre<script>`, then `<script>`, then `post<script>` in sequence.
  - If `pre<script>` exits with a non-zero exit code, Bun halts execution immediately; `<script>` and `post<script>` are not executed.
  - Production examples in `package.json`: `"pretest"` executes `scripts/pretest-oracle-guard.ts` before `"test"`, and `"preschema"` / `"postschema"` enforce typechecking and snapshot generation around `"schema"`.
- **Forcing Bun execution on Node shebangs (`--bun` / `-b`)**: Package CLI tools (e.g. in `node_modules/.bin/`) typically declare `#!/usr/bin/env node`. Passing `--bun` (or `-b`) before `run` directs Bun to create an internal shim where `node` points directly to the Bun binary. This transparently forces Node CLIs and child processes to run under Bun's runtime without altering shebangs on disk.
- **Monorepo workspace filtering (`--filter` / `-F`)**: In workspaces (`packages/*`), `bun run --filter <pattern> <script>` executes `<script>` across matched packages with prefixed Foreman-style output:
  - **Package name glob**: `--filter 'ba*'` matches `ba-example`, `--filter '@sportsdesk-ops/*'` matches all `@sportsdesk-ops` scoped packages.
  - **Path & directory**: `--filter './packages/backend'` or `--filter '{packages/ui}'`.
  - **Dependency relations**: `--filter 'foo...'` runs on `foo` and its dependencies; `--filter '...foo'` runs on `foo` and its dependents.
  - **Concurrency controls**: `--parallel` runs targets concurrently; `--sequential` (default) runs in dependency topological order; `--no-exit-on-error` keeps executing remaining packages if one fails; `--if-present` gracefully skips matching packages that do not declare the requested script.
- **Executing from STDIN (`bun run -` / `bun -`)**: Passing `-` directs Bun to read and evaluate code streamed from standard input:
  - Supports JS, TS, and JSX/TSX without temporary files: `echo "const x: string = 'Hello'; console.log(x)" | bun run -`
  - `--check` gates execution rather than replacing it: `echo "const x: number = 'err';" | bun --check run -` halts on the type error, and a clean script is then **run**. For analysis only there is no stdin form — `bun check -` answers `error: Unknown flag "-"`.
  - **Extension-independent parsing via redirection**: Running `bun file.js` enforces standard JavaScript parser rules (rejecting TS syntax like `as any` or `!`). Redirecting through `bun run - < file.js` defaults `[stdin]` to the universal TypeScript/TSX loader, running `.js` files containing TypeScript seamlessly.

## Testing upstream Bun releases & PRs (`./bin/dx pr`)

To test unmerged bugfixes, regressions, or candidate runtime patches from `oven-sh/bun`:

- **Download and verify against repository gates**:
  ```sh
  ./bin/dx pr <pr-number|url|branch> --verify
  ```
  Downloads the CI release binary from GitHub Actions into `~/.bun/bin/bun-<pr>`, runs `bun check`, `check:spec-citations`, and `verify:fast` using the candidate binary.
- **Immediate execution via `-x` / `--run`**:
  ```sh
  ./bin/dx pr 16420 -x run test tests/bun_cli_flags.test.ts
  ```
- **Managing installed candidate builds**:
  - `./bin/dx pr --list`: Lists all installed `bun-*` PR binaries and symlinks in `~/.bun/bin`.
  - `./bin/dx pr --clean <target|all>`: Removes installed PR artifacts to reclaim disk space.
- **Targeted builds**: Supports `--asan` (Linux AddressSanitizer), `--profile` (profiling build), `--baseline` (x86-64 without AVX2), `--musl` (Alpine Linux), and `--lldb` / `--gdb` (direct debugger launch).
