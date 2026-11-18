# CLI entrypoints

Bun CLIs invoked via `bun x <bin>` (linked from `packages/sportsdesk-ops` + root `package.json` `bin` into `node_modules/.bin/`), `bun run <script>`, or `bun run cli/<name>.ts`.

The table below is generated from the root `package.json` `bin`/`scripts` maps; run
`bun run cli:readme` to regenerate it (`bun run cli:readme:check` fails on drift).

<!-- BEGIN GENERATED BUN X CATALOG (run bun run cli:readme) -->
<!-- prettier-ignore -->
| `bun x` Bin | `bun run` Script | Target | Description |
| :-- | :-- | :-- | :-- |
| `bun x blob-formdata` | `bun run blob:formdata` | `bin/blob-formdata.ts` | Echo the fields of a multipart or urlencoded body. |
| `bun x bun-surface` | `bun run bun:surface` | `bin/bun_surface.ts` | What this Bun build can actually do, and where its declarations disagree. |
| `bun x desk-provenance` | `bun run desk:provenance` | `bin/desk-provenance.ts` | Self-contained desk provenance CLI: inspects the active Bun binary ('Bun.version', |
| `bun x dx` | `bun run dx` | `bin/dx` | SportsDesk & Dotfiles Zero-Friction DX Runner (bin/dx) |
| `bun x image-meta` | `bun run image:meta` | `bin/image-meta.ts` | Native 'Bun.file().image()' & 'Bun.Image' metadata, SHA-256, and LQIP inspector. |
| `bun x nsh-desk` | `bun run nsh` | `scripts/nsh_desk_cli.ts` | Operator & CI CLI for 'packages/nsh-desk' ('https://nsh.dev/docs/cli/'), |
| `bun x sportsdesk` | `bun run sportsdesk` | `cli/sportsdesk_cli.ts` | SportsDesk & Fantasy402 Downline Intelligence & Automation CLI (Bun v1.4+). |
| `bun x sportsdesk-autobet` | `bun run autobet` | `cli/watchlist_autobet_cli.ts` | Watchlist autobet CLI — paper-only bet intents over the desk's own watchlist signals. |
| `bun x sportsdesk-bet-flags` | `bun run bet:flags` | `cli/sportsdesk_bet_flags_cli.ts` | SportsDesk incoming-bet flags CLI — the reference implementation behind the autobet control |
| `bun x sportsdesk-candidate` | `bun run candidate` | `cli/sportsdesk_candidate_cli.ts` | Candidate overlay evaluation — golden pin check + policy replay (append-only audit). |
| `bun x sportsdesk-catalog` | `bun run catalog` | `cli/sportsdesk_catalog_cli.ts` | Fantasy402 desk catalog — validate, diff, refresh fixtures. |
| `bun x sportsdesk-combo` | `bun run combo` | `cli/sportsdesk_combo_cli.ts` | Universal combo index + venue lead-lag (not actor copy-trading). |
| `bun x sportsdesk-flags` | `bun run flags` | `cli/flags.ts` | Deterministic anomaly signatures over a getBetTicker capture. |
| `bun x sportsdesk-fraud` | `bun run fraud` | `cli/sportsdesk_fraud_cli.ts` | SportsDesk security/fraud CLI — the one implementation behind the 'fraud_*' plugin tools. |
| `bun x sportsdesk-hierarchy-ingest` | `bun run manager:ingest-hierarchy` | `cli/f402_manager_hierarchy_ingest_cli.ts` | Manager hierarchy SQLite ingest ('bun run manager:ingest-hierarchy'). |
| `bun x sportsdesk-layoff-risk` | `bun run layoff:risk` | `cli/sportsdesk_layoff_risk_cli.ts` | Cross-Market Parlay Matching & Layoff Risk Surveillance CLI (CFB, NFL, NBA, All Periods). |
| `bun x sportsdesk-replay` | `bun run replay` | `cli/sportsdesk_replay_cli.ts` | SportsDesk Plane 3 — self-healing JSONL ingestion replay (stream · XML · patterns · optional bitemporal WAL). |
| `bun x sportsdesk-schema` | `bun run schema` | `cli/sportsdesk_schema_cli.ts` | Typed SQLite schema report (util.parseArgs + Bun.inspect.custom). |
| `bun x sportsdesk-settlement` | `bun run settlement` | `cli/sportsdesk_settlement_cli.ts` | Fantasy402 settlement/history poll — append-only wager lifecycle ingest (Option A). |
| `bun x sportsdesk-ticket` | `bun run ticket` | `cli/sportsdesk_ticket_cli.ts` | Inspect one live bet ticket, or list every ticket with its leg count, from the latest |
| `bun x sql-query` | `bun run sql:query` | `bin/sql-query.ts` | Read-only unified SQL inspector powered by 'Bun.SQL' & 'Bun.sql'. |
| `bun x wrangler` | `bun run wrangler` | `bin/wrangler` | Official Wrangler CLI wrapper located in 'bin/wrangler' (linked into 'node_modules/.bin/wrangler' |
| `bun x xml-parse` | `bun run xml:parse` | `bin/xml-parse.ts` | Parse an XML document and print the tree as JSON, or serialize it back to XML. |

Run `bun run cli:bins` (or `./bin/dx scripts --bins [--json | --yaml]`) to inspect all 23 workspace CLI mappings and verify `node_modules/.bin/` symlink status.
<!-- END GENERATED BUN X CATALOG -->

Every bin above answers `-h` / `--help` with exit 0 (`tests/bun_x_cli_help.test.ts`
spawns each one). A bin must not treat the flag as an input path — `xml-parse` and
`blob-formdata` did until 2026-11-18.

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
