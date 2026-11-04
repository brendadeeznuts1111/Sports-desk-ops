# Repository layout (root)

The root holds **workspace metadata** and **operator entrypoints**. Code and SSOT live in subdirectories.

| Path        | Purpose                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `cli/`      | All `sportsdesk_*_cli.ts` entrypoints ([cli/README.md](cli/README.md))                     |
| `services/` | Daemon, bot, R2, churn engine, ingestion ([services/README.md](services/README.md))        |
| `catalog/`  | Fantasy402 sport navigation catalog ([catalog/README.md](catalog/README.md))               |
| `design/`   | `tokens.toml` + generated `domain-branded-types.ts` ([design/README.md](design/README.md)) |
| `lib/`      | Shared modules; token math in `lib/validation/`                                            |
| `schema/`   | Migrations, local manifest, schema preload ([schema/README.md](schema/README.md))          |
| `infra/`    | Pages `_headers` for docs deploy ([infra/README.md](infra/README.md))                      |
| `types/`    | Ambient `env.d.ts` ([types/README.md](types/README.md))                                    |
| `scripts/`  | Generators, capture, audits; `scripts/deploy/` for VPS/docs/reports                        |
| `static/`   | Token-compiled daemon HTML dashboards                                                      |
| `docs/`     | Evidence portal; `docs/runbooks/`; `docs/provenance/`                                      |
| `tests/`    | Bun test suites                                                                            |
| `bin/dx`    | Primary operator wrapper                                                                   |

**Harness plugins.** Three removable DeepSeek Harness bundles live at the root, each its own
package with a `cordis.patch.yml` row so it can be installed, disabled or removed independently:
`dsh-plugin/` (Host tools), `dsh-plugin-ui/` (composer desk-status row) and `dsh-plugin-sidebar/`
(left-sidebar SportsDesk desk page). `dsh-plugin-sidebar/verify-load.mjs` structurally verifies the
bundle; it does not prove the running UI (see its README).

**Deploy & reports**

- `bun run deploy` → `scripts/deploy/deploy_to_vps.sh`
- `bun run reports` → `scripts/deploy/run_reports.sh`
- `bun run deploy:docs` → `scripts/deploy/deploy_docs.sh`
