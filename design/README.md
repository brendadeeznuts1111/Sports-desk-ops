# Design token SSOT

- `tokens.toml` — authoritative neuron tokens, surfaces, ingestion lanes, routes, UI chrome
- `domain-branded-types.ts` — generated branded primitives and registry sections (`bun run gen:tokens`)
- `packages/ui/src/tokens.registry.generated.ts` — generated palette/alias data the Build-Matrix
  drawer renders and the dashboard footer reads its token version from

Evidence and OpenAPI cite **`domain-branded-types.ts`** by filename (line numbers match this file).

## `:root` alias layer

`[aliases.legacy]` and `[aliases.dashboard]` hold every non-token custom property the generated
stylesheets emit, as `<alias> = "<target token>"`:

- `legacy` is emitted into every generated stylesheet (dashboard CSS and the static snapshots).
  Each ingestion channel's `legacy_token_name` must appear here and point back at that channel's
  token, so the two sources cannot drift.
- `dashboard` is emitted into `src/dashboard/tokens.generated.css` only; the static snapshots keep
  their own hand-maintained theme mapping (`--sd-primary`, `--primary`, …).

Aliases are never emitted as `@property` and never introduce a colour. `bun run gen:tokens` fails
if an alias targets an unknown token, shadows a canonical token, is defined twice, or if a
`legacy_token_name` is missing/mismatched here.

The drawer's **Copy registry** action rebuilds the served `:root` from the generated registry
(41 canonical tokens + 25 aliases at v1.4.0); a test compares it to `tokens.generated.css`, so the
copied block and the page cannot diverge.
