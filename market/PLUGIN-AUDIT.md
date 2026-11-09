# Plugin audit — pin `4f847435` (`market-pin-1`)

Catalog metadata is gated by CI job **`market-index`**. This doc tracks **bundle contents** at the index git pin: manifest parity, shipped surface, and open install/usability gaps.

Re-run: `bash scripts/audit-plugins.sh` (exits non-zero on version/name mismatch).

## Report card (pin `4f847435`)

| Plugin | Ver @ pin | Name | Entry | Client | `dist/` @ pin | Repo tests |
|---|---|---|---|---|---|---|
| ops | 0.10.0 | ✅ | `index.js` | — | ✅ none | `verify-load` skipped in CI without fixture |
| security | 0.1.0 | ✅ | `index.js` | ✅ | ✅ | `verify-load` in CI |
| desk-status | 0.1.2 | ✅ | `index.js` | ✅ | ✅ | `verify-load` in CI |
| desk-panel | 0.4.0 | ✅ | `index.js` | ✅ | ✅ | `verify-load` in CI |
| watchlist-autobet | 0.2.0 | ✅ | `index.js` | ✅ | ✅ | `verify-load` in CI |

Bundles expose **Cordis tools** in `index.js` (not `bin` / `dsh.commands`). UI rows are **client-only** (`dsh-plugin-ui`, `dsh-plugin-sidebar`).

## Open findings

1. **Behavior audit (per release)** — scratch profile install + tool import smoke (not in `market-index` CI).

## Closed (recent)

- **`repoPath` default (High)** — `resolveConfiguredRepoPath()` at `apply()`; removed baked-in path from `cordis.patch.yml`. Shim when bundle sits inside monorepo (`@tennis-hq/sportsdesk-workspace`). **ops 0.10.1**, **security 0.1.1**, **watchlist 0.2.1**.
- **ops `verify-load` in CI** — CI copies `tests/fixtures/backtest/enriched_customers_full.json`.

## Closed / upstream

- **License in catalog** — format 1 drops unknown fields; tracked in `dsh-ops/notes/PLUGIN-MARKET-FORMAT-2-DRAFT.md`.
- **Index ↔ manifest @ pin** — enforced by `bun run test:market-index` and `scripts/audit-plugins.sh`.
