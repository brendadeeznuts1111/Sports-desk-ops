# Script exit codes

Generated from package.json. Most gate/test scripts exit non-zero on failure; long-running servers/watchers stay alive.

## apply

- `apply:captures`: `bun run scripts/apply_captures.ts`

## artifacts

- `artifacts:value`: `bun run scripts/generate_value_artifacts.ts`
- `artifacts:lock`: `bun run scripts/artifacts_lock.ts`
- `artifacts:cron`: `bun --no-orphans run scripts/artifacts_cron.ts`

## audit

- `audit:customer-book`: `bun run scripts/audit_customer_book.ts`
- `audit:release`: `bun run scripts/audit_release.ts`
- `audit:archives`: `bun run scripts/audit_archives.ts`
- `audit:ops`: `bun run scripts/audit_release.ts && bun run scripts/audit_archives.ts`

## backtest

- `backtest:4wk`: `./bin/dx backtest`

## bot

- `bot`: `bun run services/sportsdesk_telegram_bot.ts`

## candidate

- `candidate`: `bun run cli/sportsdesk_candidate_cli.ts`

## capture

- `capture:f402-har`: `bun run scripts/capture/f402_manager_boot_har.ts`
- `capture:evidence`: `bun run scripts/evidence_capture.ts --mode mock`
- `capture:f402`: `bun run scripts/capture/f402_probe.ts`
- `capture:har`: `bun run scripts/capture/har_probe.ts`
- `capture:discover`: `bun run scripts/capture/discover_customers.ts`
- `capture:tls`: `bun run scripts/capture/tls_provenance.ts`
- `capture:preflight`: `bun run scripts/capture/preflight.ts`
- `capture:report-tiers`: `bun run scripts/capture/report_tiers.ts`
- `capture:report-all-tiers`: `bun run scripts/capture/report_all_tiers.ts`
- `capture:cf-ray-ledger`: `bun run scripts/capture/build_cf_ray_ledger.ts`
- `capture:waf-ray-brief`: `bun run scripts/capture/waf_ray_brief.ts`
- `capture:repair-manifest`: `bun run scripts/capture/repair_manifest_hashes.ts`
- `capture:reprobe-pending-500s`: `bun run scripts/capture/reprobe_pending_500s.ts`
- `capture:ingest-deleted-wagers`: `bun run scripts/capture/ingest_deleted_wager_list.ts`
- `capture:ingest-deleted-transactions`: `bun run scripts/capture/ingest_deleted_transaction_history.ts`
- `capture:ingest-customer-admin-list`: `bun run scripts/capture/ingest_customer_admin_list.ts`
- `capture:probe-deleted-wagers`: `bun run scripts/capture/probe_deleted_wager_targets.ts`
- `capture:probe-protocol-matrix`: `bun run scripts/capture/probe_f402_protocol_matrix.ts`
- `capture:verify-batch-pending-delete`: `bun run scripts/capture/verify_batch_pending_delete.ts`
- `capture:batch-pending-delete`: `bun run scripts/capture/batch_pending_delete_session.ts`
- `capture:batch-probe-deleted-summary`: `bun run scripts/capture/batch_pending_delete_session.ts`
- `capture:evidence:live`: `bun run scripts/evidence_capture.ts --mode live`

## catalog

- `catalog`: `bun run cli/sportsdesk_catalog_cli.ts`
- `catalog:probe`: `bun run scripts/catalog_probe.ts`
- `catalog:probe:dry`: `bun run scripts/catalog_probe.ts --dry-run`

## check

- `check:fetch-init`: `bun run bin/check-fetch-init.ts`
- `check:innerhtml`: `bun run bin/check-innerhtml.ts`

## cli

- `cli`: `bun run cli/sportsdesk_cli.ts`

## combo

- `combo`: `bun run cli/sportsdesk_combo_cli.ts`

## crawl

- `crawl:tiles`: `bun run scripts/portal_tile_crawler.ts --offline`

## customers

- `customers`: `bun run scripts/customer_lookup.ts`

## deploy

- `deploy`: `./scripts/deploy/deploy_to_vps.sh`
- `deploy:docs`: `./scripts/deploy/deploy_docs.sh`

## docs

- `docs:stage`: `mkdir -p dist/assets && cp docs/index.html dist/index.html && cp docs/graph.html dist/graph.html && cp docs/graph.js dist/graph.js && cp docs/gslive-links.js dist/gslive-links.js && cp docs/graph-live-feed.json dist/graph-live-feed.json && cp docs/backtest-4wk-cfb-nba.json dist/backtest-4wk-cfb-nba.json && cp docs/combo-uniqueness.json dist/combo-uniqueness.json && cp docs/cross-domain-bridge.json dist/cross-domain-bridge.json && cp docs/openapi.json dist/openapi.json && cp docs/api-reference.md dist/api-reference.md && cp -f docs/assets/* dist/assets/ && cp infra/pages/_headers dist/_headers`
- `docs:openapi`: `bun run scripts/generate_openapi.ts`
- `docs:render`: `bun run scripts/render_docs.ts`
- `docs:serve`: `bun --no-orphans run scripts/serve_docs.ts`
- `docs:deploy`: `bun run test:docs && bun run verify:docs && bun run audit:release && bun run docs:stage && ./wrangler pages deploy dist --project-name=fantasy402-docs --branch=main`
- `docs:verify:live`: `bun run scripts/verify_docs.ts --live https://fantasy402-docs-4ay.pages.dev`
- `docs:audit:portal`: `bun run scripts/audit_docs_webview_cron.ts --once`
- `docs:audit:portal:watch`: `bun run scripts/audit_docs_webview_cron.ts --watch`

## dx

- `dx`: `./bin/dx status`
- `dx:stage`: `./bin/dx stage`
- `dx:deploy`: `./bin/dx deploy`
- `dx:ship`: `./bin/dx ship`

## ensure

- `ensure:deep-tsconfig`: `bun run scripts/ensure_deep_tsconfig.ts`

## env

- `env:audit`: `bun run scripts/env_audit.ts`

## eod

- `eod:archive`: `bun run scripts/eod_archive.ts`
- `eod:smoke`: `bun run scripts/eod_archive_smoke.ts`

## extract

- `extract:f402-oracle-fixture`: `bun run scripts/extract/f402_production_oracle_fixture_from_har.ts`
- `extract:f402-har-from-scratch`: `bun run scripts/extract/f402_redact_har_from_scratch_export.ts`

## fetch

- `fetch:pinned-portal`: `bun run scripts/verify/fetch-pinned-portal-bundles.ts`

## format

- `format`: `bun fmt`
- `format:check`: `bun fmt --check`

## gen

- `gen:tokens`: `bun run scripts/generate_tokens.ts`
- `gen:tokens:gate`: `bun run scripts/gen_tokens_gate.ts`

## graph

- `graph:agent`: `bun run scripts/build_agent_graph.ts`
- `graph:agent:view`: `bun run scripts/serve_agent_graph_view.ts`
- `graph:agent:image`: `bun run scripts/build_agent_graph_image.ts`
- `graph:agent:views`: `bun run scripts/build_agent_graph_views.ts`
- `graph:agent:readability`: `bun run scripts/agent_graph_readability.ts`
- `graph:agent:judge`: `bun run scripts/agent_graph_judge.ts`
- `graph:poll`: `./bin/dx poll`
- `graph:watch`: `./bin/dx watch`
- `graph:deploy`: `./bin/dx deploy`

## hierarchy

- `hierarchy:probe`: `bun run scripts/capture/f402_hierarchy_probe.ts`
- `hierarchy:replay`: `bun run scripts/capture/f402_hierarchy_replay.ts`

## ingestion

- `ingestion:enrich-xml-golden`: `bun run scripts/enrich_ingestion_jsonl_xml_golden.ts`
- `ingestion:replay-xml-golden-gate`: `bun run scripts/ingestion_replay_xml_golden_gate.ts`

## lint

- `lint`: `bun --bun run oxlint --fix`
- `lint:check`: `bun --bun run oxlint --deny-warnings`

## manager

- `manager:ingest-hierarchy`: `bun run cli/f402_manager_hierarchy_ingest_cli.ts`

## manager-boot

- `manager-boot:runbook`: `bun run scripts/manager_boot_runbook_cli.ts`

## normalize

- `normalize:customer-book`: `bun run scripts/normalize_customer_book.ts`

## onepass

- `onepass`: `bun run services/agent_onepass_plugin.ts`

## pin

- `pin:manager-oracle-snapshot`: `bun run verification/manager-boot-oracle/run-oracle-snapshot-pin.ts`

## portal

- `portal:drift:cron`: `bun run scripts/f402_portal_drift_cron.ts`

## postschema

- `postschema`: `SPORTSDESK_SCHEMA_CA=system SPORTSDESK_SCHEMA_SNAPSHOT_QUIET=1 bun --use-system-ca run --silent schema:snapshot`

## preschema

- `preschema`: `bun run --silent schema:typecheck`

## pretest

- `pretest`: `bun run scripts/pretest-oracle-guard.ts`

## probe

- `probe:parse-tree`: `bun run scripts/probe/parse-tree-only.ts`
- `probe:ingest-tree`: `bun run scripts/probe/ingest-parsed-tree.ts`

## probes

- `probes:index`: `bun run scripts/capture/probe_index.ts`
- `probes:prune`: `bun run scripts/capture/probes_prune.ts`

## proxy

- `proxy:record`: `bun run scripts/net/record_proxy.ts`

## r2

- `r2:info`: `bun run services/sportsdesk_r2_sync.ts --info`
- `r2:verify`: `bun run services/sportsdesk_r2_sync.ts --verify`
- `r2:sync`: `bun run services/sportsdesk_r2_sync.ts --sync reports/`
- `r2:list`: `bun run services/sportsdesk_r2_sync.ts --list`
- `r2:verify:local`: `bun run scripts/r2_verify.ts`

## redact

- `redact:f402-envelope`: `bun run scripts/redact/f402_list_agents_envelope.ts`

## registry

- `registry:check`: `bun run scripts/registry_check.ts`

## replay

- `replay`: `bun run cli/sportsdesk_replay_cli.ts`

## reports

- `reports`: `./scripts/deploy/run_reports.sh`
- `reports:r2`: `./scripts/deploy/run_reports.sh --sync-r2`

## scheduler

- `scheduler`: `bun run services/reporting_scheduler_service.ts`

## schema

- `schema`: `bun run cli/sportsdesk_schema_cli.ts`
- `schema:list`: `bun run schema --list`
- `schema:json`: `bun run schema --json`
- `schema:workspaces`: `bun --parallel --elide-lines 10 --if-present --filter 'sportsdesk-*' run schema:json`
- `schema:parallel`: `bun --parallel --elide-lines 10 --if-present --filter 'sportsdesk-*' run schema`
- `schema:sequential`: `bun --sequential --no-exit-on-error --if-present --filter 'sportsdesk-*' run schema`
- `schema:watch`: `bun --watch --no-clear-screen run cli/sportsdesk_schema_cli.ts`
- `schema:watch:match_evaluations`: `bun --watch --no-clear-screen run schema --table match_evaluations`
- `schema:debug`: `bun --inspect-wait=127.0.0.1:6499 run cli/sportsdesk_schema_cli.ts --table match_evaluations`
- `schema:debug:brk`: `bun --inspect-brk=127.0.0.1:6499 cli/sportsdesk_schema_cli.ts --table match_evaluations`
- `schema:probe`: `bun --preload ./schema/preload/schema-inspect.ts -p "globalThis.__schemaReport.summary.map((r) => r.table)"`
- `schema:inspect`: `bun --preload ./schema/preload/schema-inspect.ts -p "console.log(__schemaReport)"`
- `schema:repl`: `bun run --preload ./schema/preload/schema-inspect.ts -`
- `schema:strict`: `bun --define=SCHEMA_STRICT:true run schema`
- `schema:strict:match_evaluations`: `bun --define=SCHEMA_STRICT:true run schema --table match_evaluations`
- `schema:json:file`: `bun cli/sportsdesk_schema_cli.ts --json`
- `schema:typecheck`: `bun --check lib/ssot_table_name.ts lib/ssot_registry_sync.ts lib/schema_validation_error.ts lib/schema_unknown_table_error.ts lib/schema_brand_error.ts lib/schema_cli_errors.ts lib/brand.ts lib/brand-validate.ts lib/units.ts lib/invariants.ts lib/assert.ts lib/urls.ts lib/urls-query.ts lib/key_role.ts lib/parse.ts lib/env.ts lib/sqlite_schema_types.ts lib/sqlite_schema_ssot.ts lib/sqlite_schema_derive.ts lib/sqlite_schema_snapshot.ts lib/inspect.ts lib/canonical_json.ts lib/sqlite_schema_registry.ts lib/sportsdesk_sqlite_schema_report.ts lib/schema_report.ts lib/schema_validate.ts lib/schema_runtime_flags.ts lib/schema_binary.ts lib/schema_sqlite_affinity.ts lib/schema_prod_dump.ts lib/schema_manifest_db_parity.ts lib/schema_fixture_drift.ts lib/schema_parity_gauntlet.ts lib/sportsdesk_sqlite.ts lib/archive_policy.ts lib/eod_archive.ts cli/sportsdesk_schema_cli.ts scripts/schema_snapshot.ts scripts/schema_dump_prod.ts scripts/schema_check_fixture_drift.ts scripts/schema_parity_gauntlet.ts scripts/eod_archive_smoke.ts scripts/compute_dump_lag.ts tests/sqlite_schema_types.test.ts`
- `schema:snapshot`: `bun run scripts/schema_snapshot.ts`
- `schema:dump-prod`: `bun run scripts/schema_dump_prod.ts`
- `schema:sync-prod-dump`: `bun run scripts/schema_dump_prod.ts --from-registry`
- `schema:dump-lag`: `bun run scripts/compute_dump_lag.ts`
- `schema:check-fixture-drift`: `bun run scripts/schema_check_fixture_drift.ts`
- `schema:parity-gauntlet`: `bun run scripts/schema_parity_gauntlet.ts`
- `schema:gate`: `bun run preschema && CI=true bun run schema:snapshot && bun run schema:check-fixture-drift && bun run schema:parity-gauntlet && bun run eod:smoke && bun run ingestion:replay-xml-golden-gate`
- `schema:snapshot:shell`: `bun --shell=bun run schema:snapshot`
- `schema:match_evaluations`: `bun --title=schema:match_evaluations run schema --table match_evaluations`

## secrets

- `secrets:f402`: `bun run scripts/secrets_f402.ts`

## serve

- `serve`: `bun run services/sportsdesk_webview_server.ts`

## settlement

- `settlement`: `bun run cli/sportsdesk_settlement_cli.ts`

## sim

- `sim`: `bun run services/simulate_bettor_churn_suite.ts`

## tasks

- `tasks:render`: `bun run scripts/render_tasks.ts`

## test

- `test`: `bun test`
- `test:manager-oracle-readonly`: `PRETEST_SKIP=1 bun test --parallel lib/f402_portal_oracle_slice.test.ts lib/f402_production_fixture_redaction.test.ts lib/f402_portal_runtime_pin.test.ts`
- `test:har-redaction-verifier`: `bun test lib/f402_har_redaction_proof_verify.test.ts`
- `test:docs`: `bun test tests/api_reference.test.ts tests/docs_evidence.test.ts`
- `test:capture`: `bun test tests/capture_*.test.ts tests/portal_audit.test.ts`

## typecheck

- `typecheck`: `bun run ensure:deep-tsconfig && bunx tsc -p tsconfig.json --noEmit`

## verify

- `verify:manager-oracle-slices`: `bun run verification/manager-boot-oracle/run-slice-guard.ts`
- `verify:manager-oracle-runtime`: `bun run verification/manager-boot-oracle/run-runtime-pin-guard.ts`
- `verify:agent-graph`: `bun run scripts/verify_agent_graph_pipeline.ts`
- `verify:agent-graph:strict`: `bun run scripts/verify_agent_graph_pipeline.ts -- --strict`
- `verify:manager-har-redaction-proof`: `bun run verification/manager-boot-oracle/run-har-redaction-proof-gate.ts`
- `verify:manager-oracle-production`: `bun run verification/manager-boot-oracle/run-real-fixture-gate.ts`
- `verify:manager-oracle-variance`: `bun run verification/manager-boot-oracle/run-variance-gate.ts`
- `verify:manifest-consistency`: `bun run verification/manager-boot-oracle/run-manifest-consistency.ts`
- `verify:gen-tokens-gate`: `bun run verification/gen-tokens-zero-drift-gate/run.ts`
- `verify:docs`: `bun run scripts/verify_docs.ts`

## Long-running / non-exiting (by heuristic)

- `artifacts:cron`
- `docs:audit:portal`
- `docs:audit:portal:watch`
- `docs:serve`
- `graph:agent:view`
- `graph:poll`
- `graph:watch`
- `portal:drift:cron`
- `scheduler`
- `schema:watch`
- `schema:watch:match_evaluations`
- `serve`

## Gate/test-like (exit non-zero on failure)

- `apply:captures`
- `artifacts:lock`
- `artifacts:value`
- `audit:archives`
- `audit:customer-book`
- `audit:ops`
- `audit:release`
- `backtest:4wk`
- `bot`
- `candidate`
- `capture:batch-pending-delete`
- `capture:batch-probe-deleted-summary`
- `capture:cf-ray-ledger`
- `capture:discover`
- `capture:evidence`
- `capture:evidence:live`
- `capture:f402`
- `capture:f402-har`
- `capture:har`
- `capture:ingest-customer-admin-list`
- `capture:ingest-deleted-transactions`
- `capture:ingest-deleted-wagers`
- `capture:preflight`
- `capture:probe-deleted-wagers`
- `capture:probe-protocol-matrix`
- `capture:repair-manifest`
- `capture:report-all-tiers`
- `capture:report-tiers`
- `capture:reprobe-pending-500s`
- `capture:tls`
- `capture:verify-batch-pending-delete`
- `capture:waf-ray-brief`
- `catalog`
- `catalog:probe`
- `catalog:probe:dry`
- `check:fetch-init`
- `check:innerhtml`
- `cli`
- `combo`
- `crawl:tiles`
- `customers`
- `deploy`
- `deploy:docs`
- `docs:deploy`
- `docs:openapi`
- `docs:render`
- `docs:stage`
- `docs:verify:live`
- `dx`
- `dx:deploy`
- `dx:ship`
- `dx:stage`
- `ensure:deep-tsconfig`
- `env:audit`
- `eod:archive`
- `eod:smoke`
- `extract:f402-har-from-scratch`
- `extract:f402-oracle-fixture`
- `fetch:pinned-portal`
- `format`
- `format:check`
- `gen:tokens`
- `gen:tokens:gate`
- `graph:agent`
- `graph:agent:image`
- `graph:agent:judge`
- `graph:agent:readability`
- `graph:agent:views`
- `graph:deploy`
- `hierarchy:probe`
- `hierarchy:replay`
- `ingestion:enrich-xml-golden`
- `ingestion:replay-xml-golden-gate`
- `lint`
- `lint:check`
- `manager-boot:runbook`
- `manager:ingest-hierarchy`
- `normalize:customer-book`
- `onepass`
- `pin:manager-oracle-snapshot`
- `postschema`
- `preschema`
- `pretest`
- `probe:ingest-tree`
- `probe:parse-tree`
- `probes:index`
- `probes:prune`
- `proxy:record`
- `r2:info`
- `r2:list`
- `r2:sync`
- `r2:verify`
- `r2:verify:local`
- `redact:f402-envelope`
- `registry:check`
- `replay`
- `reports`
- `reports:r2`
- `schema`
- `schema:check-fixture-drift`
- `schema:debug`
- `schema:debug:brk`
- `schema:dump-lag`
- `schema:dump-prod`
- `schema:gate`
- `schema:inspect`
- `schema:json`
- `schema:json:file`
- `schema:list`
- `schema:match_evaluations`
- `schema:parallel`
- `schema:parity-gauntlet`
- `schema:probe`
- `schema:repl`
- `schema:sequential`
- `schema:snapshot`
- `schema:snapshot:shell`
- `schema:strict`
- `schema:strict:match_evaluations`
- `schema:sync-prod-dump`
- `schema:typecheck`
- `schema:workspaces`
- `secrets:f402`
- `settlement`
- `sim`
- `tasks:render`
- `test`
- `test:capture`
- `test:docs`
- `test:har-redaction-verifier`
- `test:manager-oracle-readonly`
- `typecheck`
- `verify:agent-graph`
- `verify:agent-graph:strict`
- `verify:docs`
- `verify:gen-tokens-gate`
- `verify:manager-har-redaction-proof`
- `verify:manager-oracle-production`
- `verify:manager-oracle-runtime`
- `verify:manager-oracle-slices`
- `verify:manager-oracle-variance`
- `verify:manifest-consistency`
