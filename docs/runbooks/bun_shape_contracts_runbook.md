# Bun shape contracts — the 134 shapes this repository calls

The single source of truth is layered, and nothing here restates upstream text: **declarations** come from `bun-types@1.4.4` (the surface the reference site renders), **behaviour** from probes against the local `Bun 1.4.4` binary (`tests/bun_baseline.json`), **property attributes** from the pinned Bun commit `38afee6c84`. When they disagree: declarations win on names and signatures, the Bun source wins on attributes, and the measured binary wins on behaviour.

Each entry names its declaration, what the binary says about the member (kind and descriptor), the files that call it, the local evidence, and — where one exists — the deep dive that already owns the detail. Call sites are bare paths, never line numbers: `check:spec-citations` does not audit runbooks, so a line number here would rot silently.

Adding a `Bun.*` call, `import { ... } from "bun"` binding, or `bun:*` submodule import without a row in `lib/bun_shapes.generated.ts` fails `tests/bun_shapes_coverage.test.ts`. The table is derived by `bun scripts/bun_shapes_catalog.ts --write`: membership comes from the tracked-source usage scan, `kind`/`heading` from `bun-types`, and subsystem/evidence from `lib/bun_shapes_overlay.ts`, which the generator reports as `ERR_SHAPE_OVERLAY_MISSING` when a new call has no row. The same test fails when the generated file is stale, or when an entry loses its heading, cites evidence that no longer exists, or drifts from `bun scripts/bun_shape_contracts.ts --check`.

## Upgrading

When upstream moves: bump `packageManager`, `engines.bun`, `.bun-version` and `@types/bun` together, run `bun run probe:bun` (baseline drift is the behaviour diff), then re-derive the declared surface with `./bin/dx bun --types`. Regenerate the member snapshot with `bun scripts/bun_shape_members.ts --baseline tests/bun_shape_members.json` and the catalog with `bun scripts/bun_shape_contracts.ts --write` (`--refresh-links` re-checks the permalinks), then review the diff. The coverage test reports the name diff before any prose is touched. Canary builds are out of scope.

---

## Process, filesystem and shell

- `Bun.argv` is an array, `Bun.env` an object, `Bun.main` a string — `proc.shell`.
- `Bun.stdin` / `Bun.stdout` are Blob-like with `text()`; nothing here reads them — `proc.stdio`.
- `Bun.nanoseconds()` is a monotonic, process-relative counter (within 50 ms of `process.uptime()`), and `Bun.sleepSync(5)` blocks for at least 5 ms — `proc.timing`.
- `Bun.spawnSync(["echo","ok"])` returns `stdout` + `exitCode`; `Bun.gc(false)` returns a value that is `undefined` — `proc.spawn`.
- `Bun.which` honours a `PATH` override; `Bun.resolveSync` resolves against a directory; `Bun.fileURLToPath("file:///tmp/x.ts")` → `/tmp/x.ts`; `Bun.openInEditor` is a 1-arity function — `proc.paths`.
- `Bun.Terminal` is a constructor; `Bun.FileSink` has no runtime value — `proc.terminal`.

#### Bun.$

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/$)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (9):** `Shell`, `ShellError`, `ShellPromise`, `braces`, `cwd`, `env`, `escape`, `nothrow`, `throws`
- **Here:** `dsh-plugin/verify-load.mjs`, `bin/bun_surface.ts`
- **Evidence:** `surface:$`

#### Bun.argv

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/argv)
- **Shape:** value: `object` · writable true · enumerable true
- **Here:** `scripts/audit_bun_surface.ts`, `scripts/generate_customer_decision_rankings.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_eval_patterns.test.ts`, `test:tests/bun_lint_cli_contract.test.ts`, `test:tests/fetch_proxy_isolation.test.ts`

#### Bun.build

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/build)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `packages/contracts/scripts/build.ts`
- **Evidence:** `test:tests/bun_assets_build_latency.test.ts`, `test:tests/bun_bundle_namespace.test.ts`, `test:tests/bun_bundler_plugin_contract.test.ts`, `test:tests/bun_capabilities.test.ts`

#### Bun.BunFile (type, declared-only)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/BunFile)
- **Shape:** type-only: declared, no runtime value
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_file_blob_contract.test.ts`, `test:tests/bun_globals_map_summaries.test.ts`, `test:tests/bun_shapes_manifest.test.ts`

#### Bun.embeddedFiles

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/embeddedFiles)
- **Shape:** value: `object` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.file

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/file)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `dsh-plugin/verify-load.mjs`, `lib/fraud_logs.ts`
- **Evidence:** `surface:file`, `test:lib/f402_agent_graph.test.ts`, `test:lib/f402_agent_graph_svg.test.ts`, `test:lib/f402_deleted_transaction_history.test.ts`

#### Bun.FileSink (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/FileSink)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/f402_hierarchy_redact_log.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_globals_map.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`

#### Bun.fileURLToPath

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/fileURLToPath)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_cli_errors.ts`, `packages/contracts/scripts/build.ts`
- **Evidence:** `test:lib/bun_cron.test.ts`, `test:lib/wagers_capture_config.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_pr_cli.test.ts`

#### Bun.gc

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/gc)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/bench_bridge3a_workload.ts`, `scripts/bench_bridge3b_workload.ts`
- **Evidence:** `test:tests/bun_test_patterns.test.ts`, `test:tests/f402_bet_ticker_delta.test.ts`, `test:tests/nsh_frame_evidence.test.ts`, `probe:proc.spawn`

#### Bun.generateHeapSnapshot

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/generateHeapSnapshot)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.isMainThread

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/isMainThread)
- **Shape:** value: `boolean` · writable false · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.isStandaloneExecutable

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/isStandaloneExecutable)
- **Shape:** value: `boolean` · writable false · enumerable true
- **Here:** `bin/bun_surface.ts`, `scripts/code_mode_binary_reference.ts`
- **Evidence:** `surface:isStandaloneExecutable`, `test:tests/bun_capabilities.test.ts`

#### Bun.main

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/main)
- **Shape:** value: `undefined` · writable undefined · enumerable true
- **Here:** `scripts/graph_feed_poller_daemon.ts`, `services/sportsdesk_webview_server.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `probe:proc.shell`

#### Bun.mmap

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/mmap)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_eval_patterns.test.ts`, `test:tests/bun_modules_surface.test.ts`, `test:tests/bun_shapes_manifest.test.ts`

#### Bun.ModuleGraph

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/ModuleGraph)
- **Shape:** value: `function` · writable false · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (1):** `current`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.nanoseconds

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/nanoseconds)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/probe/parse-tree-only.ts`, `scripts/nsh_desk_cli.ts`
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_test_patterns.test.ts`, `test:tests/dashboard_backend_workspace.test.ts`, `test:tests/dashboard_build_and_markdown.test.ts`

#### Bun.openInEditor

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/openInEditor)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_cli_errors.ts`, `src/lib/source_location_url.ts`
- **Evidence:** `test:tests/bun_url_native_utils.test.ts`, `probe:proc.paths`

#### Bun.pathToFileURL

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/pathToFileURL)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_report.ts`, `scripts/capture/shot.ts`
- **Evidence:** `test:tests/bun_file_response.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/config_file.test.ts`, `test:tests/sqlite_schema_snapshot.test.ts`

#### Bun.peek

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/peek)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (1):** `status`
- **Here:** no call site
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.plugin

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/plugin)
- **Shape:** value: `function` · writable false · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (1):** `clearAll`
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.resolve

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/resolve)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.resolveSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/resolveSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/bun_globals_map_summaries.ts`, `packages/sportsdesk-ops/src/lib/bun_surface_dts_inventory.ts`
- **Evidence:** `test:tests/bun_shapes_coverage.test.ts`, `test:tests/peer_satisfaction.test.ts`, `test:tests/react_element_version.test.ts`, `probe:proc.paths`

#### Bun.ResourceUsage (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (see [docs](https://bun.com/docs/runtime/child-process#resource-usage))
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/bun_terminal.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`

#### Bun.sleep

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/sleep)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/evidence_capture.ts`, `lib/bun_terminal.ts`
- **Evidence:** `surface:sleep`, `test:scripts/wagers_by_state_history.test.ts`, `test:tests/api_usage.test.ts`, `test:tests/auth/auth.test.ts`

#### Bun.sleepSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/sleepSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_profile_lock.ts`
- **Evidence:** `test:tests/f402_profile_lock.test.ts`, `probe:proc.timing`

#### Bun.spawn

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/spawn)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `cli/sportsdesk_cli.ts`, `lib/bun_terminal.ts`
- **Evidence:** `surface:spawn`, `test:lib/bun_terminal.test.ts`, `test:scripts/r2_manifest_cas_promote.test.ts`, `test:scripts/wagers_by_state_history.test.ts`

#### Bun.SpawnOptions (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (see [docs](https://bun.com/docs/runtime/child-process#reference))
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/bun_terminal.ts`
- **Evidence:** `test:tests/bun_globals_map_summaries.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`

#### Bun.spawnSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/spawnSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `scripts/gdocs_template_instantiate.ts`, `scripts/dx_workspaces.ts`
- **Evidence:** `test:lib/wagers_capture_config.test.ts`, `test:tests/ansi_color.test.ts`, `test:tests/audit_bun_glob_scan.test.ts`, `test:tests/audit_fetch_options.test.ts`

#### Bun.stderr

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/stderr)
- **Shape:** value: `object` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (17):** snapshot in tests/bun_shape_members.json
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_modules_surface.test.ts`, `test:tests/subprocess_deadlock.test.ts`

#### Bun.stdin

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/stdin)
- **Shape:** value: `object` · writable true · enumerable true
- **Here:** `bin/image-meta.ts`, `scripts/gdocs_template_instantiate.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_eval_patterns.test.ts`, `test:tests/bun_terminal_write_buffer_source.test.ts`, `probe:proc.stdio`

#### Bun.stdout

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/stdout)
- **Shape:** value: `object` · writable true · enumerable true
- **Here:** `cli/sportsdesk_replay_cli.ts`, `src/pty-session.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/subprocess_deadlock.test.ts`, `probe:proc.stdio`

#### Bun.Subprocess (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (see [docs](https://bun.com/docs/runtime/child-process#spawn-a-process-bun-spawn))
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/bun_terminal.ts`, `src/pty-session.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bundle_runtime.test.ts`, `test:tests/dev_dashboard_endpoints.test.ts`, `test:tests/pty_feature_flags.test.ts`

#### Bun.Terminal

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Terminal)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/bun_terminal.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:Terminal`, `test:tests/bun_aspects_contract.test.ts`, `test:tests/bun_terminal_write_buffer_source.test.ts`, `test:tests/bun_urls.test.ts`

#### Bun.TerminalOptions (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (see [docs](https://bun.com/docs/runtime/child-process#reference))
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/bun_terminal.ts`
- **Evidence:** `test:tests/bun_aspects_contract.test.ts`, `test:tests/bun_reference_symbols.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_urls.test.ts`

#### Bun.unsafe

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/unsafe)
- **Shape:** value: `object` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (5):** `arrayBufferToString`, `gcAggressionLevel`, `memoryFootprint`, `mimallocDump`, `setJITPolicy`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.which

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/which)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `scripts/agent_env_doctor.ts`
- **Evidence:** `surface:which`, `test:lib/bun_terminal.test.ts`, `test:lib/bun_terminal_blog_programs.test.ts`, `test:lib/f402_agent_graph_dot.test.ts`

#### Bun.Worker (type, declared-only)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Worker)
- **Shape:** type-only: declared, no runtime value
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/agent_diagnostics.test.ts`, `test:tests/auth_and_rate_limit.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_globals_map_summaries.test.ts`

#### Bun.write

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/write)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `dsh-plugin/verify-load.mjs`, `scripts/generate_pipeline_reference_images.ts`
- **Evidence:** `surface:write`, `test:lib/live_capture.test.ts`, `test:lib/wagers_capture_config.test.ts`, `test:scripts/gslive_all_states_suspect_cron.test.ts`

## Text and terminal rendering

- `Bun.stringWidth("漢")` → 2 and ANSI escape codes are ignored by default; `Bun.wrapAnsi` wraps at the given column width — `text.width`.
- `Bun.color("red", "hex")` → `#ff0000`; `Bun.enableANSIColors` is a boolean; `Bun.escapeHTML` escapes `&`, `<`, `>` — `text.ansi`.
- `Bun.inspect({a:[1]})` renders a stable multi-line form — `text.inspect`; `Bun.markdown` is exercised by the `markdown` surface check.

#### Bun.color

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/color)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/token_automation.ts`, `cli/sportsdesk_cli.ts`
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/token_automation.test.ts`, `test:tests/token_theme_registry.test.ts`, `test:tests/verify_tokens.test.ts`

#### Bun.ColorInput (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (declaration only)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/bun_profiled_terminal.ts`, `lib/token_automation.ts`
- **Evidence:** `test:tests/bun_profiled_terminal.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`, `test:tests/token_automation.test.ts`

#### Bun.enableANSIColors

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/enableANSIColors)
- **Shape:** value: `boolean` · writable true · enumerable true
- **Here:** `lib/ansi_color.ts`
- **Evidence:** `test:tests/ansi_color.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_eval_patterns.test.ts`, `test:tests/wagers_report.test.ts`

#### Bun.escapeHTML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/escapeHTML)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/telegram.ts`, `services/sportsdesk_telegram_bot.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_url_native_utils.test.ts`, `probe:text.ansi`

#### Bun.inspect

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/inspect)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (2):** `custom`, `table`
- **Here:** `lib/bitwise_pattern_inspect.ts`, `lib/cli_inspect.ts`
- **Evidence:** `test:lib/f402_credentials_policy.test.ts`, `test:lib/wager_soa.test.ts`, `test:tests/bitwise_pattern_inspect.test.ts`, `test:tests/bun_capabilities.test.ts`

#### Bun.markdown

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/markdown)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (4):** `ansi`, `html`, `react`, `render`
- **Here:** `lib/token_automation.ts`, `lib/cli_markdown_renderer.ts`
- **Evidence:** `surface:markdown`, `test:scripts/diff-bun-docs-vs-types.test.ts`, `test:tests/ansi_markdown_theme.test.ts`, `test:tests/bun_aspects_contract.test.ts` · deep dive: [§12](./bun_server_runtime_shapes_runbook.md)

#### Bun.sliceAnsi

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/sliceAnsi)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/token_watch_native.ts`
- **Evidence:** `surface:sliceAnsi`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`

#### Bun.stringWidth

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/stringWidth)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/terminal_format.ts`
- **Evidence:** `test:scripts/gslive_wagers_by_state.test.ts`, `test:tests/ansi_markdown_theme.test.ts`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`

#### Bun.stripANSI

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/stripANSI)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/terminal_format.ts`
- **Evidence:** `surface:stripANSI`, `test:lib/wagers_capture_config.test.ts`, `test:scripts/gslive_wagers_by_state.test.ts`, `test:tests/ansi_markdown_theme.test.ts`

#### Bun.wrapAnsi

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/wrapAnsi)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/terminal_format.ts`
- **Evidence:** `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_url_native_utils.test.ts`, `test:tests/bun_v140_primitives.test.ts`

## Data formats and parsing

- `Bun.JSON5` / `Bun.TOML` / `Bun.YAML` / `Bun.XML` / `Bun.JSONL` each parse a tiny document in-process — `data.parse`; `Bun.JSONC` also accepts comments — `data.json`.
- `new Bun.Glob("*.ts").match("a.ts")` → true, `"a.js"` → false — `data.glob`.
- `Bun.deepEquals` compares structure, not identity — `data.compare`.
- `new Bun.Cookie("a","b")` and `new Bun.CookieMap("a=b").get("a")` agree on the pair — `data.cookies`.
- `Bun.semver.satisfies("1.2.3", "^1.0.0")` → true and `Bun.semver.order("1.0.0", "1.0.1")` → -1 — `data.semver`.

#### Bun.Cookie

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Cookie)
- **Shape:** value: `function` · writable false · enumerable true
- **Members (2):** `from`, `parse`
- **Here:** `lib/cookie_jar.ts`
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/cookie_jar.test.ts`, `probe:data.cookies`

#### Bun.CookieMap

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/CookieMap)
- **Shape:** value: `function` · writable false · enumerable true
- **Here:** `lib/cookie_jar.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:CookieMap`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_request_contract.test.ts`

#### Bun.deepEquals

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/deepEquals)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `dsh-plugin/verify-load.mjs`, `lib/alerts.ts`
- **Evidence:** `test:lib/f402_hierarchy.test.ts`, `test:tests/agent_tree_matcher.test.ts`, `test:tests/alerts.test.ts`, `test:tests/bun_deep_equals.test.ts`

#### Bun.deepMatch

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/deepMatch)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/agent_tree_matcher.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.Glob

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Glob)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/pm_policy.ts`, `scripts/dx_workspaces.ts`
- **Evidence:** `test:tests/audit_bun_glob_scan.test.ts`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_reference_symbols.test.ts`

#### Bun.Import (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Import)
- **Shape:** type-only: declared, no runtime value
- **Here:** `scripts/nsh_desk_cli.ts`
- **Evidence:** `test:tests/bun_loaders_and_import_attributes.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`

#### Bun.ImportKind (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/ImportKind)
- **Shape:** type-only: declared, no runtime value
- **Here:** `scripts/nsh_desk_cli.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`, `test:tests/bun_urls.test.ts`

#### Bun.indexOfLine

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/indexOfLine)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_bet_ticker_jsonl.ts`, `lib/jsonl_stream_replay.ts`
- **Evidence:** `test:tests/bun_index_of_line.test.ts`, `test:tests/bun_runtime_contracts.test.ts`

#### Bun.JSON5

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/JSON5)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `bin/bun_surface.ts`, `lib/bun_xml_golden_ast.ts`
- **Evidence:** `surface:JSON5`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/language_coverage.test.ts`

#### Bun.JSONC

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/JSONC)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (1):** `parse`
- **Here:** `lib/pm_policy.ts`, `scripts/bun_native_rules.ts`
- **Evidence:** `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_radix_literal_rounding.test.ts`, `test:tests/react_version_pairing.test.ts`

#### Bun.JSONL

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/JSONL)
- **Shape:** value: `object` · writable false · enumerable true
- **Members (2):** `parse`, `parseChunk`
- **Here:** `lib/cron_journal.ts`, `bin/bun_surface.ts`
- **Evidence:** `test:scripts/gslive_all_states_suspect_cron.test.ts`, `test:scripts/wagers_by_state_history.test.ts`, `test:tests/bridge_3c_system_error.test.ts`, `test:tests/bun_aspects_contract.test.ts` · deep dive: [§8.4](./bun_server_runtime_shapes_runbook.md)

#### Bun.semver

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/semver)
- **Shape:** value: `object` · writable false · enumerable true
- **Members (2):** `order`, `satisfies`
- **Here:** `scripts/nsh_desk_cli.ts`, `bin/bun_surface.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_cli_flags.test.ts`, `test:tests/bun_config_policy.test.ts`, `test:tests/bun_semver_wildcards.test.ts`

#### Bun.TOML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/TOML)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `bin/bun_surface.ts`, `lib/config_file.ts`
- **Evidence:** `surface:TOML`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_runtime_contracts.test.ts`

#### Bun.Transpiler

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Transpiler)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/code_mode.ts`
- **Evidence:** `surface:Transpiler`, `test:tests/nsh_desk_contract.test.ts`, `test:tests/status_page.test.ts`

#### Bun.XML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/XML)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `lib/customer_profile.ts`, `lib/bun_xml_golden_ast.ts`
- **Evidence:** `surface:XML`, `test:tests/bun_aspects_contract.test.ts`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_loaders_and_import_attributes.test.ts`

#### Bun.YAML

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/YAML)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `parse`, `stringify`
- **Here:** `bin/bun_surface.ts`, `bin/desk-provenance.ts`
- **Evidence:** `surface:YAML`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_loaders_and_import_attributes.test.ts`, `test:tests/bun_runtime.test.ts`

## Storage and scheduling

- `Bun.SQL`, `Bun.S3Client`, `Bun.RedisClient` are constructors; `Bun.Archive` round-trips in memory — write `{"a.txt":"hi"}`, read `files()` back to the same key — `storage.archive`.
- `Bun.cron` returns a `CronJob`; `Bun.CronController` is a type (no runtime value).
- `Bun.secrets.get` is covered by the `secrets.get` surface check.

#### Bun.Archive

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Archive)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (1):** `write`
- **Here:** `lib/eod_archive.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:Archive`, `test:tests/bun_archive_contract.test.ts`, `test:tests/bun_builtin_replacements.test.ts`, `test:tests/bun_eval_patterns.test.ts`

#### Bun.cron

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/cron)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (2):** `parse`, `remove`
- **Here:** `lib/bun_cron.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:cron`, `test:lib/bun_cron.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_urls.test.ts`

#### Bun.CronController (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/CronController)
- **Shape:** type-only: declared, no runtime value
- **Here:** `scripts/wagers_by_state_capture.ts`, `lib/bun_cron.ts`
- **Evidence:** `test:lib/bun_cron.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_reference_symbols.test.ts`, `test:tests/bun_shapes_manifest.test.ts`

#### Bun.redis

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/redis)
- **Shape:** value: `object` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (212):** snapshot in tests/bun_shape_members.json
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.RedisClient

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/RedisClient)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:RedisClient`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_urls.test.ts`

#### Bun.s3

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/s3)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (9):** `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`, `unlink`, `write`
- **Here:** `scripts/verify-gslive-tickets.ts`, `src/telemetry/runtime-preflight.ts`
- **Evidence:** `surface:s3`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_runtime_contracts.test.ts`, `test:tests/bun_s3client_contract.test.ts`

#### Bun.S3Client

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3Client)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (9):** `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`, `unlink`, `write`
- **Here:** `scripts/verify-gslive-tickets.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:S3Client`, `test:scripts/r2_manifest_cas_promote.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_s3client_contract.test.ts`

#### Bun.S3File (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3File)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`, `types/bun-api.d.ts`
- **Evidence:** `test:tests/bun_runtime_contracts.test.ts`, `test:tests/bun_s3client_contract.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/f402_bet_ticker_sink.test.ts`

#### Bun.S3FilePresignOptions (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3FilePresignOptions)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/r2_s3_client.test.ts`

#### Bun.S3ListObjectsOptions (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3ListObjectsOptions)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`

#### Bun.S3ListObjectsResponse (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3ListObjectsResponse)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/f402_bet_ticker_sink.test.ts`, `test:tests/gslive_event_log_sink.test.ts`, `test:tests/gslive_weblog_sink.test.ts`

#### Bun.S3Options (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3Options)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`, `types/bun-api.d.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/r2_s3_client.test.ts`

#### Bun.S3Stats (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/S3Stats)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/r2_s3_client.ts`, `types/bun-api.d.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/f402_bet_ticker_sink.test.ts`, `test:tests/gslive_event_log_sink.test.ts`, `test:tests/gslive_weblog_sink.test.ts`

#### Bun.secrets

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/secrets)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (3):** `delete`, `get`, `set`
- **Here:** `scripts/secrets_r2.ts`, `scripts/verify-gslive-tickets.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_eval_patterns.test.ts`, `test:tests/bun_urls.test.ts`, `test:tests/r2_s3_client.test.ts`

#### Bun.sql

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/sql)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (18):** snapshot in tests/bun_shape_members.json
- **Here:** `bin/bun_surface.ts`, `bin/sql-query.ts`
- **Evidence:** `surface:sql`, `test:tests/bun_capabilities.test.ts`, `test:tests/sql_query_cli.test.ts`

#### Bun.SQL

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SQL)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (13):** snapshot in tests/bun_shape_members.json
- **Here:** `bin/sql-query.ts`, `lib/customer_index.ts`
- **Evidence:** `surface:SQL`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_eval_patterns.test.ts`, `test:tests/bun_urls.test.ts`

## Crypto, hashing and compression

- `new Bun.CryptoHasher("sha256").update("x").digest("hex")` is 64 hex chars; `Bun.hash("x")` returns a bigint while `Bun.hash.crc32`/`adler32` return numbers; `Bun.randomUUIDv7()` is 36 chars with version nibble `7` — `crypto.hash`.
- zstd and gzip round-trip: compress → decompress returns the input; `new Bun.ArrayBufferSink()` and `Bun.concatArrayBuffers` exist — `crypto.compress`.

#### Bun.allocUnsafe

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/allocUnsafe)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/f402_bet_ticker_jsonl.ts`
- **Evidence:** `surface:allocUnsafe`, `test:tests/bun_capabilities.test.ts`, `test:tests/jsonl_stream_replay.test.ts`

#### Bun.ArrayBufferSink

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/ArrayBufferSink)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/shared_array_buffer_contract.test.ts`, `probe:crypto.compress`

#### Bun.concatArrayBuffers

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/concatArrayBuffers)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `services/blob_and_live_bets_server.ts`, `lib/jsonl_stream_replay.ts`
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_urls.test.ts`, `probe:crypto.compress`

#### Bun.CryptoHasher

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/CryptoHasher)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (2):** `algorithms`, `hash`
- **Here:** `lib/gslive_users_report.ts`, `lib/r2_manifest_cas.ts`
- **Evidence:** `test:lib/live_provenance.test.ts`, `test:scripts/r2_manifest_cas_promote.test.ts`, `test:tests/bun_runtime_contracts.test.ts`, `test:tests/bun_terminal_write_buffer_source.test.ts`

#### Bun.CryptoHashInterface (type, declared-only)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/CryptoHashInterface)
- **Shape:** type-only: declared, no runtime value
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_surface_cli.test.ts`

#### Bun.CSRF

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/CSRF)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (2):** `generate`, `verify`
- **Here:** `bin/bun_surface.ts`, `lib/csrf.ts`
- **Evidence:** `surface:CSRF`, `test:tests/bun_csrf_contract.test.ts`, `test:tests/bun_v144_hardened_surfaces.test.ts`

#### Bun.deflateSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/deflateSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_compression_contract.test.ts`, `test:tests/bun_modules_surface.test.ts`, `test:tests/bun_v144_hardened_surfaces.test.ts`

#### Bun.gunzipSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/gunzipSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/ppm_socket_feed.ts`, `lib/eod_archive.ts`
- **Evidence:** `test:tests/bun_compression_contract.test.ts`, `test:tests/eod_archive.test.ts`, `test:tests/http_compression.test.ts`, `test:tests/language_coverage.test.ts`

#### Bun.gzipSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/gzipSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`, `lib/http_compression.ts`
- **Evidence:** `test:tests/blob_ingest.test.ts`, `test:tests/bridge_3c_reader.test.ts`, `test:tests/bun_compression_contract.test.ts`, `test:tests/bun_runtime_contracts.test.ts`

#### Bun.hash

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/hash)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (12):** `adler32`, `cityHash32`, `cityHash64`, `crc32`, `murmur32v2`, `murmur32v3`, `murmur64v2`, `rapidhash`, `wyhash`, `xxHash3`, `xxHash32`, `xxHash64`
- **Here:** `lib/manager_fetch.ts`, `lib/f402_figure_date_enricher.ts`
- **Evidence:** `test:tests/audit_bun_glob_scan.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_runtime_contracts.test.ts`

#### Bun.inflateSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/inflateSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_compression_contract.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.MD4

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/MD4)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.MD5

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/MD5)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.password

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/password)
- **Shape:** value: `object` · writable true · enumerable true
- **Members (4):** `hash`, `hashSync`, `verify`, `verifySync`
- **Here:** `bin/bun_surface.ts`, `lib/auth.ts`
- **Evidence:** `surface:password`, `test:tests/bun_capabilities.test.ts`, `test:tests/db_integration.test.ts`

#### Bun.Password (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Password)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/auth.ts`
- **Evidence:** `test:lib/agent_account.test.ts`, `test:lib/f402_config_web_reports_customer_admin.test.ts`, `test:lib/f402_customer_admin_list.test.ts`, `test:lib/f402_deleted_wager_list.test.ts`

#### Bun.randomUUIDv5

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/randomUUIDv5)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.randomUUIDv7

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/randomUUIDv7)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `cli/flags.ts`, `lib/audit_run_id.ts`
- **Evidence:** `test:tests/bun_eval_patterns.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_surface_cli.test.ts`, `test:tests/bun_test_patterns.test.ts`

#### Bun.readableStreamToArray

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/readableStreamToArray)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.readableStreamToArrayBuffer

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/readableStreamToArrayBuffer)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `bin/image-meta.ts`
- **Evidence:** `surface:readableStreamToArrayBuffer`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_urls.test.ts`

#### Bun.readableStreamToFormData

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/readableStreamToFormData)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.sha

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/sha)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.SHA1

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SHA1)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.SHA224

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SHA224)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.SHA256

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SHA256)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`, `test:tests/bun_runtime_contracts.test.ts`

#### Bun.SHA384

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SHA384)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.SHA512

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SHA512)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.SHA512_256

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/SHA512_256)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Members (2):** `byteLength`, `hash`
- **Here:** no call site
- **Evidence:** `test:tests/bun_modules_surface.test.ts`

#### Bun.zstdCompress

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/zstdCompress)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_hierarchy_pack.ts`
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `probe:crypto.compress`

#### Bun.zstdCompressSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/zstdCompressSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/schema_binary.ts`, `lib/docs_render_cache.ts`
- **Evidence:** `test:tests/bun_compression_contract.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`, `test:tests/gslive_tally_rollup.test.ts`

#### Bun.zstdDecompress

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/zstdDecompress)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/bun_modules_surface.test.ts`

#### Bun.zstdDecompressSync

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/zstdDecompressSync)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/f402_weblog.ts`, `lib/schema_binary.ts`
- **Evidence:** `test:tests/bun_compression_contract.test.ts`, `test:tests/bun_formats_and_utilities.test.ts`, `test:tests/docs_render_cache.test.ts`, `test:tests/docs_server.test.ts`

## Network and serving

- `Bun.fetch`, `Bun.serve`, `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.FetchSession` are functions (surface checks + capabilities test).
- `Bun.dns` is an object; the reference documents only `lookup`/`prefetch`/`getCacheStats` while the binary also has 15 resolver methods — see the drift section in ../bun-upstream-reference.md.
- `Bun.Server`, `Bun.FetchProxyOption`, and `Bun.FetchSessionInit` are types (`Server<WebSocketData>` takes a type argument).

#### Bun.BunRequest (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/BunRequest)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/docs_server.ts`, `services/blob_and_live_bets_server.ts`
- **Evidence:** `test:tests/bun_headers.test.ts`, `test:tests/bun_request_contract.test.ts`, `test:tests/bun_serve_routing_diagram.test.ts`, `test:tests/bun_shapes_manifest.test.ts`

#### Bun.connect

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/connect)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/tls_provenance.ts`
- **Evidence:** `surface:connect`, `test:lib/f402_bet_ticker_config.test.ts`, `test:tests/bun_aspects_contract.test.ts`, `test:tests/bun_capabilities.test.ts` · deep dive: [§8.2](./bun_server_runtime_shapes_runbook.md)

#### Bun.dns

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/dns)
- **Shape:** value: `object` · writable false · enumerable true
- **Members (21):** snapshot in tests/bun_shape_members.json
- **Here:** `lib/preflight.ts`, `scripts/verify-gslive-tickets.ts`
- **Evidence:** `test:lib/preflight.test.ts`, `test:tests/audit_bun_glob_scan.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_runtime_contracts.test.ts`

#### Bun.EventSource (type, declared-only)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/EventSource)
- **Shape:** type-only: declared, no runtime value
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_globals_map_summaries.test.ts`, `test:tests/bun_shapes_manifest.test.ts`

#### Bun.fetch

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/fetch)
- **Shape:** value: `function` · writable false · enumerable true
- **Members (1):** `preconnect`
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:fetch`, `test:tests/bun_capabilities.test.ts`

#### Bun.FetchProxyOption (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/FetchProxyOption)
- **Shape:** type-only: declared, no runtime value
- **Here:** `scripts/capture/session.ts`, `scripts/catalog_probe.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts`, `test:tests/fetch_proxy_isolation.test.ts` · deep dive: [§7.2](./bun_server_runtime_shapes_runbook.md)

#### Bun.FetchSession

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/FetchSession)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `services/sportsdesk_telegram_bot.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:FetchSession`, `test:tests/bun_aspects_contract.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_shapes_types.test-d.ts` · deep dive: [§7.3](./bun_server_runtime_shapes_runbook.md)

#### Bun.FetchSessionInit (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/FetchSessionInit)
- **Shape:** type-only: declared, no runtime value
- **Here:** `services/sportsdesk_telegram_bot.ts`
- **Evidence:** `test:tests/bun_reference_symbols.test.ts`, `test:tests/bun_shape_contracts_links.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_shapes_types.test-d.ts` · deep dive: [§7.3](./bun_server_runtime_shapes_runbook.md)

#### Bun.FileSystemRouter

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/FileSystemRouter)
- **Shape:** value: `function` · writable true · enumerable true
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/bun_capabilities.test.ts`, `test:tests/bun_modules_surface.test.ts`, `test:tests/inspect_ansi_diagnostics.test.ts`

#### Bun.listen

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/listen)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:listen`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_socket_contract.test.ts`, `test:tests/bun_socket_contracts.test.ts` · deep dive: [§8.1](./bun_server_runtime_shapes_runbook.md)

#### Bun.MatchedRoute (type)

- **Source:** declared in `bun-types@1.4.4` · no reference page (see [docs](https://bun.com/blog/bun-v0.5.5#changelog))
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/inspect_diagnostics.ts`
- **Evidence:** `test:tests/bun_reference_symbols.test.ts`, `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_urls.test.ts`, `test:tests/inspect_ansi_diagnostics.test.ts`

#### Bun.serve

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/serve)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `lib/docs_server.ts`, `services/sportsdesk_webview_server.ts`
- **Evidence:** `surface:serve`, `test:scripts/r2_manifest_cas_promote.test.ts`, `test:scripts/wagers_by_state_capture.test.ts`, `test:scripts/wagers_by_state_history.test.ts` · deep dive: [§2](./bun_server_runtime_shapes_runbook.md)

#### Bun.Serve (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Serve)
- **Shape:** type-only: declared, no runtime value
- **Here:** `services/live_bets_typed_server.ts`
- **Evidence:** `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bun_surface_cli.test.ts`, `test:tests/live_bets_typed_server.test.ts`

#### Bun.Server (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Server)
- **Shape:** type-only: declared, no runtime value
- **Here:** `services/sportsdesk_webview_server.ts`, `services/blob_and_live_bets_server.ts`
- **Evidence:** `test:tests/bench_server.test.ts`, `test:tests/blob_and_live_bets_server.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_shapes_manifest.test.ts` · deep dive: [§2](./bun_server_runtime_shapes_runbook.md)

#### Bun.udpSocket

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/udpSocket)
- **Shape:** value: `function` · writable true · enumerable true
- **Here:** `bin/bun_surface.ts`
- **Evidence:** `surface:udpSocket`, `test:tests/bun_capabilities.test.ts` · deep dive: [§8.3](./bun_server_runtime_shapes_runbook.md)

#### Bun.WebSocket (type, declared-only)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/WebSocket)
- **Shape:** type-only: declared, no runtime value
- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used
- **Here:** no call site
- **Evidence:** `test:tests/blob_and_live_bets_server.test.ts`, `test:tests/blob_live_bets_trace.test.ts`, `test:tests/bun_141_runtime.test.ts`, `test:tests/bun_aspects_contract.test.ts`

## Image and WebView

- `Bun.Image` and `Bun.WebView` are constructors; `metadata()` on a 1×1 PNG reads `{width:1, height:1, format:"png"}` — `image.metadata`. Both have deep contracts in the server shapes runbook.

#### Bun.Image

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Image)
- **Shape:** value: `function` · writable true · enumerable true
- **Members (4):** `backend`, `clipboardChangeCount`, `fromClipboard`, `hasClipboardImage`
- **Here:** `services/blob_and_live_bets_server.ts`, `lib/screenshot_encode.ts`
- **Evidence:** `surface:Image`, `test:lib/f402_agent_graph_webp.test.ts`, `test:lib/image_errors.test.ts`, `test:scripts/bun_docs_mcp.test.ts`

#### Bun.WebView

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/WebView)
- **Shape:** value: `function` · writable false · enumerable true
- **Members (1):** `closeAll`
- **Here:** `scripts/capture/webview.ts`, `bin/bun_surface.ts`
- **Evidence:** `surface:WebView`, `test:scripts/bun_docs_mcp.test.ts`, `test:tests/bun_surface_cli.test.ts`, `test:tests/bun_urls.test.ts` · deep dive: [§9](./bun_server_runtime_shapes_runbook.md)

## Runtime metadata and environment

- `Bun.version` and `Bun.revision` are strings; `Bun.version_with_sha` is `v<version> (<short sha>)` where the short sha is a prefix of `Bun.revision` — `proc.meta`.
- `Bun.env` is the process environment object (`proc.shell`); `Bun.Env` is a type.

#### Bun.env

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/env)
- **Shape:** value: `object` · writable false · enumerable true
- **Here:** `scripts/verify-gslive-tickets.ts`, `services/sportsdesk_webview_server.ts`
- **Evidence:** `test:lib/wagers_capture_config.test.ts`, `test:scripts/gslive_wagers_by_state.test.ts`, `test:scripts/wagers_by_state_history.test.ts`, `test:tests/agent_tree_hierarchy.test.ts`

#### Bun.Env (type)

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/Env)
- **Shape:** type-only: declared, no runtime value
- **Here:** `lib/db.ts`, `lib/secret_manifest.ts`
- **Evidence:** `test:tests/bun_aspects_contract.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_registry_config.test.ts`, `test:tests/bun_shapes_manifest.test.ts`

#### Bun.revision

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/revision)
- **Shape:** value: `string` · writable false · enumerable true
- **Here:** `lib/bun_runtime.ts`, `packages/sportsdesk-ops/src/bin/bun-surface.ts`
- **Evidence:** `test:lib/f402_portal_runtime_pin.test.ts`, `test:tests/bun_capabilities.test.ts`, `test:tests/bun_reference_cli.test.ts`, `test:tests/bun_runtime.test.ts`

#### Bun.version

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/version)
- **Shape:** value: `string` · writable false · enumerable true
- **Here:** `bin/bun_surface.ts`, `lib/bun_runtime.ts`
- **Evidence:** `test:lib/f402_portal_runtime_pin.test.ts`, `test:scripts/wagers_by_state_capture.test.ts`, `test:tests/blob_ingest.test.ts`, `test:tests/bun_capabilities.test.ts`

#### Bun.version_with_sha

- **Source:** declared in `bun-types@1.4.4` · [reference](https://bun.com/reference/bun/version_with_sha)
- **Shape:** value: `string` · writable false · enumerable false
- **Here:** `lib/bun_runtime.ts`, `scripts/probe_bun.ts`
- **Evidence:** `test:tests/bun_capabilities.test.ts`

## Built-in `bun:*` submodules

Non-test production imports from `bun:sqlite`, `bun:jsc`, and `bun:bundle` are inventoried alongside `MODULE "bun"` / `globalThis.Bun` (`BUN_SUBMODULE_SHAPES` in `lib/bun_shapes.ts`).

- **`bun:bundle` → `feature`** (bundler macro) — here: `lib/bun_reference_probe.ts`, `packages/ui/src/runtime_flags.ts` · evidence: `test:tests/bun_shapes_manifest.test.ts`, `test:tests/bundle_runtime.test.ts`, `test:tests/bundle_types.test-d.ts`, `test:tests/pty_feature_flags.test.ts`
- **`bun:jsc` → `estimateShallowMemoryUsageOf`** (runtime export) — here: `bin/bun_surface.ts`, `lib/f402_hierarchy_memory.ts` · evidence: `surface:bun:jsc.estimateShallowMemoryUsageOf`
- **`bun:jsc` → `heapStats`** (runtime export) — here: `bin/bun_surface.ts`, `scripts/bench_bridge3a_workload.ts` · evidence: `surface:bun:jsc.heapStats`, `test:tests/f402_bet_ticker_delta.test.ts`
- **`bun:sqlite` → `constants`** (runtime export) — here: `bin/bun_surface.ts`, `lib/sportsdesk_sqlite.ts` · evidence: `surface:bun:sqlite.constants`
- **`bun:sqlite` → `Database`** (runtime export) — here: `bin/bun_surface.ts`, `cli/review.ts` · evidence: `surface:bun:sqlite.Database`, `test:tests/bun_loaders_and_import_attributes.test.ts`, `test:tests/candidate_cli.test.ts`, `test:tests/code_mode/profile_query.differential.test.ts`

## Window-adjacent Web globals (`globalThis`)

Bun implements a broad subset of the browser `Window` surface as true globals on `globalThis` — no import required, and no DOM (`window`, `document` are strictly `undefined` in server/CLI runtimes). Each entry below is checked at runtime against `Bun 1.4.4`, and non-empty static member sets are snapshotted under `webGlobals` in `tests/bun_shape_members.json`.

- **No DOM:** `window` and `document` are absent; use `globalThis` or bare constructors.
- **`Bun.file(url)` scheme boundary (measured on `1.4.4`):** string `Bun.file("s3://bucket/key")` and `Bun.s3.file(...)` return an `S3File`, whereas passing a `URL` instance accepts `file:` only (`new URL("s3://...")` throws `ERR_INVALID_URL_SCHEME`) and ignores query strings such as `?mode=ro`.
- **Path ↔ URL conversion:** use `Bun.pathToFileURL` / `Bun.fileURLToPath` (or `node:url`).

| Global                        | Category             | Topic               | `typeof`   | Static members                                               | Prototype members                                          | Here                                                                                 | Notes                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------- | ------------------- | ---------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `URL`                         | URL                  | WHATWG URL          | `function` | `canParse`, `createObjectURL`, `parse`, `revokeObjectURL`    | 13 (snapshot)                                              | `packages/api/src/router.ts`, `lib/urls.ts` (+103)                                   | Full WHATWG URL (`URL.canParse`, `URL.parse`). `Bun.file(url)` accepts `file:` `URL` instances only (`new URL("s3://...")` throws `ERR_INVALID_URL_SCHEME`, whereas string `Bun.file("s3://bucket/key")` or `Bun.s3.file(...)` works) and ignores query strings. |
| `URLPattern`                  | URL                  | URL routing         | `function` | —                                                            | 11 (snapshot)                                              | `src/lib/route_audit_table.ts`                                                       | WHATWG URLPattern matcher (`exec`, `test`).                                                                                                                                                                                                                      |
| `URLSearchParams`             | URL                  | Query params        | `function` | —                                                            | 13 (snapshot)                                              | `lib/fantasy402_manager_wire.ts`, `client/auth/auth.js` (+46)                        | Standalone or via `url.searchParams`.                                                                                                                                                                                                                            |
| `Blob`                        | Binary & Files       | Binary blob         | `function` | —                                                            | 17 (snapshot)                                              | `lib/blob_ingest.ts`, `lib/desk-parser.ts` (+16)                                     | Base of `BunFile`.                                                                                                                                                                                                                                               |
| `File`                        | Binary & Files       | Web file            | `function` | —                                                            | 17 (snapshot)                                              | `lib/market_edge_engine.ts`, `scripts/enrich_bets_from_figure_date.ts` (+2)          | Web File constructor; base alongside `Blob`.                                                                                                                                                                                                                     |
| `CompressionStream`           | Web Streams          | Stream compression  | `function` | —                                                            | `readable`, `writable`                                     | `lib/desk-parser.ts`                                                                 | WHATWG streaming compressor (`gzip`, `deflate`, `deflate-raw`).                                                                                                                                                                                                  |
| `DecompressionStream`         | Web Streams          | Stream compression  | `function` | —                                                            | `readable`, `writable`                                     | `lib/f402_weblog.ts`, `packages/sportsdesk-ops/src/bridge/bridge_3c_reader.ts` (+4)  | WHATWG streaming decompressor (`gzip`, `deflate`, `deflate-raw`).                                                                                                                                                                                                |
| `ReadableStream`              | Web Streams          | Byte streams        | `function` | `from`                                                       | 11 (snapshot)                                              | `lib/desk-parser.ts`, `packages/sportsdesk-ops/src/bridge/bridge_3c_reader.ts` (+12) | Direct and byte streams (`ReadableStream.from`).                                                                                                                                                                                                                 |
| `ReadableStreamDefaultReader` | Web Streams          | Byte streams        | `function` | —                                                            | `cancel`, `closed`, `read`, `readMany`, `releaseLock`      | `types/bun-api.d.ts`                                                                 | Default stream reader (`read`, `readMany`, `cancel`, `releaseLock`).                                                                                                                                                                                             |
| `TransformStream`             | Web Streams          | Byte streams        | `function` | —                                                            | `readable`, `writable`                                     | `lib/desk-parser.ts`                                                                 | WHATWG transform stream.                                                                                                                                                                                                                                         |
| `WritableStream`              | Web Streams          | Byte streams        | `function` | —                                                            | `abort`, `close`, `getWriter`, `locked`                    | declared-only                                                                        | WHATWG writable stream.                                                                                                                                                                                                                                          |
| `atob`                        | Encoding             | Base64              | `function` | —                                                            | —                                                          | `lib/f402_browser_token_manager.ts`                                                  | Base64 decode.                                                                                                                                                                                                                                                   |
| `btoa`                        | Encoding             | Base64              | `function` | —                                                            | —                                                          | declared-only                                                                        | Base64 encode.                                                                                                                                                                                                                                                   |
| `TextDecoder`                 | Encoding             | Text encoding       | `function` | —                                                            | `decode`, `encoding`, `fatal`, `ignoreBOM`                 | `scripts/pin_cdn_assets.ts`, `lib/f402_cdn_pin.ts` (+49)                             | UTF-8 / text decoder.                                                                                                                                                                                                                                            |
| `TextDecoderStream`           | Encoding             | Streaming decode    | `function` | —                                                            | `encoding`, `fatal`, `ignoreBOM`, `readable`, `writable`   | `lib/token_watch_native.ts`                                                          | WHATWG streaming text decoder.                                                                                                                                                                                                                                   |
| `TextEncoder`                 | Encoding             | Text encoding       | `function` | —                                                            | `encode`, `encodeInto`, `encoding`                         | `services/sportsdesk_webview_server.ts`, `lib/desk-parser.ts` (+48)                  | UTF-8 encoder.                                                                                                                                                                                                                                                   |
| `AbortController`             | HTTP & Fetch         | Cancellation        | `function` | —                                                            | `abort`, `signal`                                          | `dsh-plugin-sidebar/client.js`, `dsh-plugin-watchlist-autobet/client.js` (+8)        | Cancellation controller for fetch/streams/timers.                                                                                                                                                                                                                |
| `AbortSignal`                 | HTTP & Fetch         | Cancellation        | `function` | `abort`, `any`, `timeout`                                    | 7 (snapshot)                                               | `lib/fantasy402_manager_wire.ts`, `services/sportsdesk_telegram_bot.ts` (+59)        | Cancellation signal (`AbortSignal.timeout`, `any`, `abort`).                                                                                                                                                                                                     |
| `fetch`                       | HTTP & Fetch         | Fetch client        | `function` | `preconnect`                                                 | —                                                          | `docs/graph.js`, `lib/gslive_auto_session.ts` (+104)                                 | Standard Fetch API (`fetch.preconnect` extension in Bun).                                                                                                                                                                                                        |
| `FormData`                    | HTTP & Fetch         | Multipart           | `function` | `from`                                                       | 11 (snapshot)                                              | declared-only                                                                        | Multipart form container (`FormData.from`).                                                                                                                                                                                                                      |
| `Headers`                     | HTTP & Fetch         | HTTP primitives     | `function` | —                                                            | 13 (snapshot)                                              | `lib/http_compression.ts`, `scripts/capture/provenance_helpers.ts` (+10)             | Case-insensitive HTTP headers map.                                                                                                                                                                                                                               |
| `HTMLRewriter`                | HTTP & Fetch         | HTML streaming      | `function` | —                                                            | `on`, `onDocument`, `transform`                            | `lib/ticket_html.ts`, `bin/bun_surface.ts` (+2)                                      | Cloudflare-compatible streaming HTML transformer (`on`, `onDocument`, `transform`).                                                                                                                                                                              |
| `Request`                     | HTTP & Fetch         | HTTP primitives     | `function` | —                                                            | 22 (snapshot)                                              | `packages/api/src/router.ts`, `services/sportsdesk_webview_server.ts` (+19)          | Standard Fetch `Request`.                                                                                                                                                                                                                                        |
| `Response`                    | HTTP & Fetch         | HTTP primitives     | `function` | `error`, `json`, `redirect`                                  | 17 (snapshot)                                              | `services/sportsdesk_webview_server.ts`, `packages/api/src/router.ts` (+76)          | Standard Fetch `Response` (`Response.json`, `error`, `redirect`).                                                                                                                                                                                                |
| `WebSocket`                   | HTTP & Fetch         | WebSocket           | `function` | `CLOSED`, `CLOSING`, `CONNECTING`, `OPEN`                    | 26 (snapshot)                                              | `packages/ui/src/App.tsx`, `services/sportsdesk_webview_server.ts` (+6)              | Client WebSocket constructor (`CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`).                                                                                                                                                                                           |
| `BroadcastChannel`            | Workers & IPC        | Worker IPC          | `function` | —                                                            | 9 (snapshot)                                               | declared-only                                                                        | Pub/sub channel across workers in the same process.                                                                                                                                                                                                              |
| `MessageChannel`              | Workers & IPC        | Worker IPC          | `function` | —                                                            | `port1`, `port2`                                           | declared-only                                                                        | Paired `MessagePort` channel.                                                                                                                                                                                                                                    |
| `MessagePort`                 | Workers & IPC        | Worker IPC          | `function` | —                                                            | 11 (snapshot)                                              | declared-only                                                                        | Cross-worker messaging endpoint.                                                                                                                                                                                                                                 |
| `postMessage`                 | Workers & IPC        | Worker IPC          | `function` | —                                                            | —                                                          | declared-only                                                                        | Worker global message dispatch.                                                                                                                                                                                                                                  |
| `self`                        | Workers & IPC        | Global alias        | `object`   | `globalThis` alias                                           | —                                                          | `client/overlay/security-seams.preload.js`, `lib/desk_enhanced_health.ts`            | Worker-compatible alias for `globalThis` (`self === globalThis`).                                                                                                                                                                                                |
| `structuredClone`             | Workers & IPC        | Deep clone          | `function` | —                                                            | —                                                          | `scripts/apply_captures.ts`                                                          | Deep structured clone.                                                                                                                                                                                                                                           |
| `Worker`                      | Workers & IPC        | Worker threads      | `function` | —                                                            | 16 (snapshot)                                              | `lib/f402_agent_graph_layouts.ts`                                                    | JS worker thread alternative to `Bun.spawn`.                                                                                                                                                                                                                     |
| `crypto`                      | WebCrypto            | WebCrypto           | `object`   | `getRandomValues`, `randomUUID`, `subtle`, `timingSafeEqual` | —                                                          | `lib/auth.ts`, `lib/f402_hierarchy_hash.ts` (+14)                                    | WebCrypto (`getRandomValues`, `randomUUID`, `subtle`, `timingSafeEqual`).                                                                                                                                                                                        |
| `CryptoKey`                   | WebCrypto            | WebCrypto           | `function` | —                                                            | `algorithm`, `extractable`, `type`, `usages`               | `types/bun-api.d.ts`                                                                 | WebCrypto key handle.                                                                                                                                                                                                                                            |
| `SubtleCrypto`                | WebCrypto            | WebCrypto           | `function` | `supports`                                                   | 17 (snapshot)                                              | declared-only                                                                        | WebCrypto subtle operations (`SubtleCrypto.supports`).                                                                                                                                                                                                           |
| `clearInterval`               | Timers & Performance | Timers & microtasks | `function` | —                                                            | —                                                          | `packages/ui/src/App.tsx`, `docs/graph.js` (+14)                                     | Cancels a `setInterval` handle.                                                                                                                                                                                                                                  |
| `clearTimeout`                | Timers & Performance | Timers & microtasks | `function` | —                                                            | —                                                          | `dsh-plugin-sidebar/client.js`, `dsh-plugin-sidebar/index.js` (+30)                  | Cancels a `setTimeout` handle.                                                                                                                                                                                                                                   |
| `performance`                 | Timers & Performance | High-res timing     | `object`   | 21 (snapshot)                                                | —                                                          | `cli/sportsdesk_bet_flags_cli.ts`, `lib/code_mode.ts` (+22)                          | High-resolution timing (`now`, `mark`, `measure`, `eventLoopUtilization`).                                                                                                                                                                                       |
| `queueMicrotask`              | Timers & Performance | Timers & microtasks | `function` | —                                                            | —                                                          | `services/sportsdesk_webview_server.ts`                                              | Microtask queue scheduler.                                                                                                                                                                                                                                       |
| `setInterval`                 | Timers & Performance | Timers & microtasks | `function` | —                                                            | —                                                          | `docs/graph.js`, `packages/ui/src/App.tsx` (+15)                                     | Standard repeating timer.                                                                                                                                                                                                                                        |
| `setTimeout`                  | Timers & Performance | Timers & microtasks | `function` | —                                                            | —                                                          | `packages/ui/src/App.tsx`, `lib/bun_terminal.ts` (+37)                               | Standard timer.                                                                                                                                                                                                                                                  |
| `Temporal`                    | Timers & Performance | Date & time         | `object`   | 9 (snapshot)                                                 | —                                                          | `lib/desk-parser.ts`, `scripts/batch_rank_all_players.ts`                            | TC39 `Temporal` namespace (`Instant`, `PlainDate`, `ZonedDateTime`, `Duration`).                                                                                                                                                                                 |
| `alert`                       | Console & CLI        | CLI prompts         | `function` | —                                                            | —                                                          | `packages/ui/src/panels/AlertsTabPanel.tsx`, `packages/ui/src/alert_audit.ts` (+14)  | CLI-friendly prompt (not a browser dialog).                                                                                                                                                                                                                      |
| `confirm`                     | Console & CLI        | CLI prompts         | `function` | —                                                            | —                                                          | `dsh-plugin-security/index.js`, `dsh-plugin-watchlist-autobet/verify-load.mjs` (+1)  | CLI-friendly y/n confirmation (not a browser dialog).                                                                                                                                                                                                            |
| `console`                     | Console & CLI        | Structured logging  | `object`   | 30 (snapshot)                                                | —                                                          | `cli/sportsdesk_cli.ts`, `scripts/governance_check.ts` (+312)                        | Structured console (`log`, `warn`, `error`, `table`, `write`).                                                                                                                                                                                                   |
| `navigator`                   | Console & CLI        | Runtime info        | `object`   | `hardwareConcurrency`, `platform`, `userAgent`               | —                                                          | `dsh-plugin-sidebar/client.js`, `packages/ui/src/clipboard.ts` (+2)                  | Runtime hardware/platform info (`hardwareConcurrency`, `platform`, `userAgent`).                                                                                                                                                                                 |
| `prompt`                      | Console & CLI        | CLI prompts         | `function` | —                                                            | —                                                          | `scripts/create_operator.ts`, `scripts/secrets_github.ts`                            | CLI-friendly stdin line prompt (not a browser dialog).                                                                                                                                                                                                           |
| `CloseEvent`                  | Events               | DOM-free events     | `function` | `AT_TARGET`, `BUBBLING_PHASE`, `CAPTURING_PHASE`, `NONE`     | 24 (snapshot)                                              | declared-only                                                                        | WebSocket close event.                                                                                                                                                                                                                                           |
| `CustomEvent`                 | Events               | DOM-free events     | `function` | `AT_TARGET`, `BUBBLING_PHASE`, `CAPTURING_PHASE`, `NONE`     | 23 (snapshot)                                              | declared-only                                                                        | Typed `detail` event.                                                                                                                                                                                                                                            |
| `ErrorEvent`                  | Events               | DOM-free events     | `function` | `AT_TARGET`, `BUBBLING_PHASE`, `CAPTURING_PHASE`, `NONE`     | 26 (snapshot)                                              | declared-only                                                                        | Error event payload.                                                                                                                                                                                                                                             |
| `Event`                       | Events               | DOM-free events     | `function` | `AT_TARGET`, `BUBBLING_PHASE`, `CAPTURING_PHASE`, `NONE`     | 21 (snapshot)                                              | `packages/ui/src/desk_quick_jump.ts`                                                 | DOM-free `Event` base class.                                                                                                                                                                                                                                     |
| `EventTarget`                 | Events               | DOM-free events     | `function` | —                                                            | `addEventListener`, `dispatchEvent`, `removeEventListener` | declared-only                                                                        | DOM-free event dispatcher.                                                                                                                                                                                                                                       |
| `MessageEvent`                | Events               | DOM-free events     | `function` | `AT_TARGET`, `BUBBLING_PHASE`, `CAPTURING_PHASE`, `NONE`     | 27 (snapshot)                                              | `scripts/capture/webview.ts`                                                         | Worker/WebSocket message event.                                                                                                                                                                                                                                  |
| `reportError`                 | Realms & Errors      | Error hooks         | `function` | —                                                            | —                                                          | declared-only                                                                        | Unhandled error reporting hook.                                                                                                                                                                                                                                  |
| `ShadowRealm`                 | Realms & Errors      | Isolated realms     | `function` | —                                                            | `evaluate`, `importValue`                                  | declared-only                                                                        | Stage 3 isolated evaluation realm.                                                                                                                                                                                                                               |
