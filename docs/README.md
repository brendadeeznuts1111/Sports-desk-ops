# SportsDesk ops docs

Evidence-labelled API documentation and real-time surveillance topology for the SportsDesk & Fantasy402 wire surface. The portal is
**Scalar**, pinned to a single CDN version with SRI; the markdown reference is **generated** from the
OpenAPI spec plus the evidence ledger, so a claim cannot drift away from its evidence tier.

## What is verified vs inferred

- **Captured responses (tier A):** 5 Manager operations (`2026-10-31` live capture session) carry full request+response captures and capture-derived schemas (`x-capture`).
- **Verified (tier B):** operations with a captured request or an implementation-verified route (`2026-10-28` Manager HAR, portal `v1.0.279`).
- **Inferred (tier C):** authored proposals where no request or response was observed; kept clearly labelled.
- **GS Partner 118:** live acquisition is `blocked_contract` by design (see [gs-manager-contracts.md](./gs-manager-contracts.md)).

Read the full model in [EVIDENCE.md](./EVIDENCE.md). The machine-readable source of truth is
[evidence/ledger.json](./evidence/ledger.json).

## Docs set

| Doc                                                                                        | Audience                       | Contents                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md](./OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md) | **All Operators (Start Here)** | **Day-1 60s Quickstart (`./bin/dx`), 6-layer data cleaning pipeline (`report.js`, `bet-ticker.js`, `ip-tracker.js`, Polymarket), and 10-Mode Action Playbook**                                                                |
| [api-reference.md](./api-reference.md)                                                     | Developers & Risk              | Generated reference: evidence tiers, headers matrix, auth, per-operation sections, inferred/missing-surface appendices                                                                                                        |
| [openapi.json](./openapi.json)                                                             | API / OpenAPI 3.1              | Machine-readable spec (`info.version` 2026.10.31) with per-operation `x-evidence`                                                                                                                                             |
| [index.html](./index.html)                                                                 | Interactive portal             | Scalar viewer (`@scalar/api-reference@1.76.4`, SRI-pinned), dark theme, header link to `./graph.html`                                                                                                                         |
| [graph.html](./graph.html)                                                                 | Surveillance & Ops             | 6-Tab Surveillance Graph, Pending Bets, 39-Wallet Registry (23 live / 16 quarantined), 4-Week Backtest + Cross-Domain Value Bridge (fee-aware PnL, three CFB combo gates), ROT Bet-Ticker & IP-Tracker, and 10-Mode Workbench |
| [cross-market-parlay-matching.md](./cross-market-parlay-matching.md)                       | Risk & Quant Desk              | Phase 1–6C architecture: LineHundredths, sub-500ms WSS Shadow Syncer, 180s Quarantine Auto-Resolver, & 15% Siloed Capital Cap                                                                                                 |
| [EVIDENCE.md](./EVIDENCE.md)                                                               | Auditors                       | Evidence standard, tier legend, what is verified vs inferred, contradictions, limitations                                                                                                                                     |
| [gs-manager-contracts.md](./gs-manager-contracts.md)                                       | GS integration                 | Why the GS manager CLI has **no** HTTP contract: 6 report kinds, all `blocked_contract`, the one observed `getBetReport` payload                                                                                              |
| [report-surfaces.md](./report-surfaces.md)                                                 | Operators                      | Openable GSLive surfaces: 7-parameter `#/reports/users` deep link and `#/events/bet-history` sidecar, with an evidence level per surface                                                                                      |
| [settings.md](./settings.md)                                                               | Operators & Developers         | The portal `#update-settings` modal: four server-side preferences, the one that never leaves the browser, the exact write call, and what this dashboard does instead                                                          |
| [REAL_INGESTION.md](./REAL_INGESTION.md)                                                   | Data / Ops                     | Phase 4 live ingestion: Polymarket positions (shipped, `--live`), F402 session plan, provenance, stale cache, failure semantics                                                                                               |
| [polymarket-combos.md](./polymarket-combos.md)                                             | Quant / Ops                    | CFB combo endpoints, product-of-legs pricing, three gates (permissive/all-legs-cfb/full-game), whole-series active+closed index and a subset verifier                                                                         |
| [REMAINING_TASKS.md](./REMAINING_TASKS.md)                                                 | Ops / Planning                 | GFM meta task list: trust blockers, coverage gaps, and hygiene items with basis, done-when and blockers                                                                                                                       |
| [customer-poly-bridge.md](./customer-poly-bridge.md)                                       | Value / Ops                    | Cross-domain join between the customer book and Polymarket wallets: attribution, fee-aware PnL, leg-level mirror/opposite matching                                                                                            |
| [evidence/capture-tooling.md](./evidence/capture-tooling.md)                               | Capture operators              | WebView+FetchSession architecture, capture store schema v1, live gating, read-only allowlist, redaction, B→A upgrade rules                                                                                                    |
| [schema-dump-operations.md](./schema-dump-operations.md)                                   | Registry + release             | `dump-prod` vs `sync-prod-dump`, snapshot parity, allowlist, `captured_at` / dump lag                                                                                                                                         |
| [schema-sqlite-failure-mode-matrix.md](./schema-sqlite-failure-mode-matrix.md)             | Debug parity exits             | Exit **2** / **3**, env knobs, SQLite strict/sentinel, EOD WAL                                                                                                                                                                |
| [runbooks/README.md](./runbooks/README.md)                                                 | Ops / engineering              | Long-form runbooks (Manager wire evidence, Bun runtime, tokens, R2, cron, VPS) moved from repo root                                                                                                                           |

## Zero-Friction DX Workflow (`./bin/dx`)

```bash
./bin/dx status                           # Verify sandbox $HOME, XDG re-anchoring, Git config, Wrangler 4.156.0 & dist/
./bin/dx stage                            # Stage docs/{index.html,graph.html,graph.js,openapi.json} + infra/pages/_headers -> dist/
./bin/dx deploy                           # Stage + publish dist/ to Cloudflare R2 Edge (pub-d061f943df0e4477ba7ff200721eddb1.r2.dev) & Pages
./bin/dx ship                             # Stage + deploy to Cloudflare Edge + push main to origin
./bin/dx gslive <LOGIN>                   # Partner 118 links: 7-param #/reports/users + #/events/bet-history sidecar
./bin/dx docs                             # Deployed docs portal URLs (`./bin/dx docs gslive` for GSLive surfaces)
./bin/dx stale -i <export>                # Stale-line cohort from a bet-log export (CSV/JSON/JSONL)
```

## Regenerating and gating the docs

```bash
bun run scripts/generate_docs.ts          # writes docs/api-reference.md (deterministic)
bun run scripts/generate_docs.ts --out /tmp/api-reference.md
bun run test:docs                         # docs invariants (spec, ledger, markdown, portal, headers)
bun run verify:docs                       # structural gate + markdown freshness + staging parity
```

`docs/api-reference.md` is generated, not edited by hand. If you change [openapi.json](./openapi.json)
or [evidence/ledger.json](./evidence/ledger.json), re-run the generator and commit the result.

**Portal deploy staging:** `bun run docs:stage` (or `./bin/dx stage`) copies `docs/index.html`, `docs/graph.html`, `docs/graph.js`, `docs/openapi.json`, and
`infra/pages/_headers` into `dist/`. Do not unpin the Scalar version or remove the `integrity`/`crossorigin` attributes.

**Live Edge URLs:**

- **Surveillance Graph & Shadow Portfolio:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph.html` (and `https://desk.bookdeskops.com/graph`)
- **API Reference Portal:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/index.html` (and `https://fantasy402-docs-4ay.pages.dev`)

**Diagram:** [assets/ARCH-Guide.jpg](./assets/ARCH-Guide.jpg)
