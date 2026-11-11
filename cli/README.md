# CLI entrypoints

Bun CLIs invoked via `bun x <bin>` (linked from `packages/sportsdesk-ops` + root `package.json` `bin` into `node_modules/.bin/`), `bun run <script>`, or `bun run cli/<name>.ts`.

| `bun x` Bin                         | `package.json` Script              | File                                                                    |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `bun x sportsdesk`                  | `bun run cli`                      | `sportsdesk_cli.ts` — primary surveillance / wire / R2 / replay surface |
| `bun x dx`                          | `bun run dx`                       | `../bin/dx` — sandbox-safe operator runner & Cloudflare deploy          |
| `bun x wrangler`                    | `bun run wrangler`                 | `../bin/wrangler` — credential-isolated Bun Wrangler runner             |
| `bun x nsh-desk`                    | `bun run nsh`                      | `../scripts/nsh_desk_cli.ts` — native shell desk CLI                    |
| `bun x sportsdesk-ticket`           | `bun run ticket`                   | `sportsdesk_ticket_cli.ts`                                              |
| `bun x sportsdesk-flags`            | `bun run flags`                    | `flags.ts`                                                              |
| `bun x sportsdesk-bet-flags`        | `bun run bet:flags`                | `sportsdesk_bet_flags_cli.ts`                                           |
| `bun x sportsdesk-layoff-risk`      | `bun run layoff:risk`              | `sportsdesk_layoff_risk_cli.ts`                                         |
| `bun x sportsdesk-hierarchy-ingest` | `bun run manager:ingest-hierarchy` | `f402_manager_hierarchy_ingest_cli.ts`                                  |
| `bun x sportsdesk-schema`           | `bun run schema`                   | `sportsdesk_schema_cli.ts`                                              |
| `bun x sportsdesk-replay`           | `bun run replay`                   | `sportsdesk_replay_cli.ts`                                              |
| `bun x sportsdesk-catalog`          | `bun run catalog`                  | `sportsdesk_catalog_cli.ts`                                             |
| `bun x sportsdesk-candidate`        | `bun run candidate`                | `sportsdesk_candidate_cli.ts`                                           |
| `bun x sportsdesk-settlement`       | `bun run settlement`               | `sportsdesk_settlement_cli.ts`                                          |
| `bun x sportsdesk-combo`            | `bun run combo`                    | `sportsdesk_combo_cli.ts`                                               |
| `bun x sportsdesk-fraud`            | `bun run fraud`                    | `sportsdesk_fraud_cli.ts`                                               |
| `bun x sportsdesk-autobet`          | `bun run autobet`                  | `watchlist_autobet_cli.ts`                                              |
| `bun x image-meta`                  | `bun run image:meta`               | `../bin/image-meta.ts`                                                  |
| `bun x blob-formdata`               | `bun run blob:formdata`            | `../bin/blob-formdata.ts`                                               |
| `bun x xml-parse`                   | `bun run xml:parse`                | `../bin/xml-parse.ts`                                                   |
| `bun x bun-surface`                 | `bun run bun:surface`              | `../bin/bun_surface.ts`                                                 |

Run `bun run cli:bins` (or `./bin/dx scripts --bins [--json | --yaml]`) to inspect all 21 workspace CLI mappings and verify `node_modules/.bin/` symlink status.

Shared libraries live under `../lib/`; long-running daemons under `../services/`.

## Connected `bun run --help` Surface, Runtime Control & Monitoring

Both `./bin/dx --help` and `bun run cli --help` connect directly to the live `bun run --help` output of the active Bun binary via `readBunRunCliSurface()` (`../lib/bun_cli_flags.ts`) and `../scripts/dx_run_control.ts`:

- **Inspect live Bun run flags**:
  - `./bin/dx --help` / `bun run cli --help` — prints operator commands plus the curated `bun run` control & monitoring summary.
  - `./bin/dx help --bun` / `bun run cli --bun-help` — expands the full categorized `bun run --help` catalog (`--category=control|monitor|workspace|environment|network|transpiler`, `--filter=<text>`, `--raw`).
- **Controlled execution (`run` + `DX_BUN_FLAGS`)**:
  - `./bin/dx run [presets | bun-flags] <script|file> [args...]` (or `bun run cli run ...`) validates every forwarded flag against live `bun run --help` and blocks `BUN_CONFIG_VERBOSE_FETCH` whenever any secret in `../lib/secret_manifest.ts` is populated in the environment.
  - Presets: `--containment` (default ON: `--no-orphans`, `--unhandled-rejections=strict`, `--title=dx:<target>`), `--no-containment`, `--isolated-env` (`--no-env-file`), `--profile-cpu` (`--cpu-prof-md` into `scratch/profiles/` with automatic hotspot extraction), `--profile-heap` (`--heap-prof-md` with retained-type summary), `--profile`, `--low-mem` (`--smol`), `--watch-safe`, `--debug` / `--debug-brk`, `--timeout-ms=<ms>`, and `--dry-run [--json]`.
  - Setting `DX_BUN_FLAGS="--smol --no-env-file"` forwards validated Bun runtime flags across `./bin/dx <subcommand>` invocations.
- **Process, daemon & profile monitoring (`monitor`)**:
  - `./bin/dx monitor [--url=http://127.0.0.1:4020] [--offline] [--watch] [--interval=5] [--prune] [--max-files=20] [--json]` (or `bun run cli monitor ...`) reports active Bun processes (`ps` RSS, CPU%, `--no-orphans`, `--title`), daemon `/health` + `/api/v2/live-bets` status (skipped under `--offline` or `DX_STATUS_OFFLINE=1`), and latest CPU/heap Markdown profile summaries in `scratch/profiles/`.
- **v2 Live-Bets control & monitoring (`live-bets`)**:
  - `./bin/dx live-bets [--source=db|file|fixture|none] [--fallback=strict|sample] [--path=<file>] [--daemon[=<url>]] [--watch] [--interval=5] [--json]` (or `bun run cli live-bets ...`) resolves or polls the explicit `/api/v2/live-bets` contract (`dataSource`, `fallbackUsed`, `provenance`, `warnings`, exposure, and agent/scoreboard joins).
