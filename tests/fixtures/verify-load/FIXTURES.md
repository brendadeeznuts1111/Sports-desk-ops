# verify-load pinned artifacts (CI)

Tracked tree used **in place** when `VERIFY_LOAD_FIXTURES=tests/fixtures/verify-load`
(see `dsh-plugin/verify-load.mjs`). The harness **does not copy** files into the repo root;
`BOOK_ROOT` points at this directory instead of `data/` / `dist/` operator paths.

CI proves the **shape contract**: tools import, register, and answer against these
inputs. Local `bun dsh-plugin/verify-load.mjs` without the env var still exercises
the operator book and gitignored `dist/*` / `data/*` when present.

Do not delete operator `data/live-bets.json` expecting verify-load to refresh it — that
file is only read by the HTTP server when you opt into `?source=file` or degraded
`?source=auto`.
