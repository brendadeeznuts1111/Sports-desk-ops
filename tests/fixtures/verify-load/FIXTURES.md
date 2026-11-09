# verify-load pinned artifacts (CI)

Tracked tree mirrored at the repository root when
`VERIFY_LOAD_FIXTURES=tests/fixtures/verify-load` (see `dsh-plugin/verify-load.mjs`).

CI proves the **shape contract**: tools import, register, and answer against these
inputs. Local `bun dsh-plugin/verify-load.mjs` without the env var still exercises
the operator book and gitignored `dist/*` / `data/*` when present.

**Do not** set `VERIFY_LOAD_FIXTURES` locally unless you intend to overwrite root-level
`enriched_customers_full.json`, `sportsdesk_downline_data.json`, and mirrored paths
under `data/` and `dist/` with this pinned tree (those root names are gitignored).
