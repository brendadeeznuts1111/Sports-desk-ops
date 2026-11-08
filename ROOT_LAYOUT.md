# Repository layout (root)

The root holds **workspace metadata** and **operator entrypoints**. Code and SSOT live in subdirectories.

| Path            | Purpose                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `cli/`          | All `sportsdesk_*_cli.ts` entrypoints ([cli/README.md](cli/README.md))                     |
| `services/`     | Daemon, bot, R2, churn engine, ingestion ([services/README.md](services/README.md))        |
| `catalog/`      | Fantasy402 sport navigation catalog ([catalog/README.md](catalog/README.md))               |
| `design/`       | `tokens.toml` + generated `domain-branded-types.ts` ([design/README.md](design/README.md)) |
| `lib/`          | Shared modules; token math in `lib/validation/`                                            |
| `src/dod6/`     | DOD6 v5.4 Merkle manifest, R2 chunk layout, and edge hydrator                              |
| `schema/`       | Migrations, local manifest, schema preload ([schema/README.md](schema/README.md))          |
| `infra/`        | Pages `_headers` for docs deploy ([infra/README.md](infra/README.md))                      |
| `types/`        | Ambient `env.d.ts` ([types/README.md](types/README.md))                                    |
| `scripts/`      | Generators, capture, audits; `scripts/deploy/` for VPS/docs/reports                        |
| `reports/`      | Auditable surveillance outputs, Plane 3 ingestion JSONL, and docs-review artifacts         |
| `static/`       | Token-compiled daemon HTML dashboards                                                      |
| `docs/`         | Evidence portal; `docs/runbooks/`; `docs/provenance/`                                      |
| `tests/`        | Bun test suites                                                                            |
| `client/`       | Browser-side overlay seam preload (`security-seams.preload.js`)                            |
| `config/`       | Wagers capture configuration (`wagers.json`, `wagers-capture.toml`)                        |
| `packages/`     | Workspace packages (`sportsdesk-ops`, `ba-example`)                                        |
| `verification/` | TLA+/gate verification specs (e.g. the gen-tokens zero-drift gate)                         |
| `bin/dx`        | Primary operator wrapper                                                                   |

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
