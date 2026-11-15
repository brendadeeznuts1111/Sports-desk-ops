# @sportsdesk-ops/contracts

Shared contracts for the SportsDesk operator workspace: wager token vocabulary,
slice metrics and registries, shadow pricing, feature flags, and dashboard
hydration.

## Install

```sh
bun add @sportsdesk-ops/contracts
# or
npm install @sportsdesk-ops/contracts
```

## Usage

```ts
import { CONTRACTS_PACKAGE } from "@sportsdesk-ops/contracts";
import { FEATURES } from "@sportsdesk-ops/contracts/features";
import { parseWagerToken } from "@sportsdesk-ops/contracts/wager-tokens";
```

## Module resolution

The package publishes conditional exports:

- `types` / `bun` — the TypeScript source in `src/` (fast local resolution under Bun)
- `default` — ESM JavaScript in `dist/` (Node and bundlers)

`dist/` is built by `scripts/build.ts` during `prepack`, so it is present in the
tarball but not in the repository. Node consumers need Node 18 or newer.

## Exports

| Path                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `.`                     | aggregate surface (`CONTRACTS_PACKAGE` and the re-exported modules) |
| `./wager-tokens`        | wager token vocabulary and parsing                                  |
| `./slice-metrics`       | slice metric definitions                                            |
| `./slice-registry`      | slice registry contracts                                            |
| `./slice-data-table`    | data-table contracts                                                |
| `./slice-diff-view`     | diff-view contracts                                                 |
| `./shadow-pricing`      | shadow pricing contracts                                            |
| `./features`            | feature flags and build targets                                     |
| `./dashboard-hydration` | dashboard hydration types                                           |
