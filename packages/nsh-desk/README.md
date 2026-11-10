# Sportsdesk NSH Desk (`packages/nsh-desk`)

Native Shell (`nsh`) operator workspace connected read-only to the local `:4020` Sportsdesk daemon.
Structured per [`nsh.dev/docs/project-structure`](https://nsh.dev/docs/project-structure/#the-root-component)
with a single `mount(App)` root component ([`App.tsx`](./App.tsx)) composing feature panels in
[`components/`](./components/), reactive state & persistence in [`store.ts`](./store.ts), pure
parsers & typed-array sort arenas in [`desk_model.ts`](./desk_model.ts), and an app-owned semantic
token & [`ui/`](./ui/) component system ([`DESIGN.md`](./DESIGN.md), [`theme.json`](./theme.json))
over `nsh/base` and `nsh/base/plot`.

## Quickstart & CLI (`./bin/dx nsh` / `bun run nsh:*`)

Ensure the `:4020` Sportsdesk server is running, then from the repository root:

```sh
./bin/dx nsh doctor           # Inspect nsh binary, semver, nsh.json mode/caps, skills YAML & origin (--json|--yaml)
./bin/dx nsh verify-loop      # Run nsh check -> nsh build (zero-warning gate) -> nsh test with timings (--json|--yaml)
./bin/dx nsh artifacts        # Inventory packages/nsh-desk/.nsh/out with byte sizes & SHA-256 digests (--json|--yaml)
bun run nsh -- -V             # Print NSH version and Git revision (e.g. nsh 0.4.0 (e626a8d))
bun run nsh -- run --help     # Print flags for any nsh <command>
bun run nsh:check             # TypeScript 7 + NSH bundle check
bun run nsh:build             # Static Tailwind/token class check + QuickJS bytecode bundle (.nsh/out)
bun run nsh:test              # Headless NSH UI suite (App.test.tsx)
bun run nsh:run               # Launch native macOS AppKit host connected to :4020
bun run nsh:package:web       # Package standalone web bundle under packages/nsh-desk/.nsh/out/web
```

To target a non-default local port:

```sh
SPORTSDESK_ORIGIN=http://127.0.0.1:4020 bun run nsh:run
```

## Keyboard Shortcuts & UI Kit

- `Cmd+R` / `Ctrl+R`: Refresh all `:4020` endpoints
- `Cmd+1` / `Ctrl+1`: Toggle `KPIs` dock
- `Cmd+2` / `Ctrl+2`: Toggle `Pipeline` dock
- `Cmd+Shift+L` / `Ctrl+Shift+L`: Lock/unlock workspace panes
- `Cmd+Shift+C` / `Ctrl+Shift+C` (or `Workspace → Copy diagnostics JSON`): Copy a signal-honest JSON snapshot of `:4020` endpoints and R2 sinks to the system clipboard
- `Cmd+U` / `Ctrl+U` (or `Workspace → UI kit…`): Open the interactive `ui/` component gallery in Light or Dark mode

## Capabilities, Design System & Signal Honesty

- **Root component & acyclic layering ([`App.tsx`](./App.tsx) → [`components/`](./components/) → [`ui/`](./ui/)):**
  `App.tsx` wraps the workspace in a root `<ErrorBoundary>` (`Reload workspace` reset) and delegates
  feature panels to `components/` while isolating `nsh/base` inside `ui/`.
- **Device storage & clipboard (`nsh` `Storage` & `Clipboard`):** Operator workspace preferences
  (`leagueFilter`, `autoPoll`, `locked`, dock open state) persist across launches under
  `ops.sportsdesk.desk.prefs.v1`; `Copy diagnostics JSON` exports live endpoint telemetry without
  coercing unavailable metrics to zero.
- **Design system & motion inventory ([`DESIGN.md`](./DESIGN.md)):** Semantic theme roles
  (`positive`, `warning`, `negative`, `destructive`, `chart-1..5`) in [`theme.json`](./theme.json),
  minimum 12pt typography (`tabular-nums`), and full `reduceMotion` support.
- **Least-privilege VM sandbox (`nsh.json`):** Grants only `GET` requests over `http://127.0.0.1` and
  `http://localhost`, plus `process.env.SPORTSDESK_ORIGIN`, `clipboard`, and `statusBar`.
- **Origin provenance (`resolveDeskOrigin`):** Displays the active `:4020` origin alongside its
  resolution source (`[env:SPORTSDESK_ORIGIN]` or `[default:4020]`).
- **No silent zeroes:** Non-2xx or unreachable endpoints (`/api/kpis`, `/api/signals/kalshi`,
  `/api/scoreboard`, `/api/live-bets/summary`) render their HTTP status, diagnostic code, and API
  message rather than coercing missing data to `0`.
- **Publish age vs data-window age (`#78`):** The R2 pipeline diagnostics dock surfaces both R2
  publish age and underlying data-window age, flagging `[DATA-STALE]` when a fresh upload carries an
  older data window.
- **Zero-object sort arena (`desk_model.ts`):** Kalshi signal metrics are stored in a fixed-stride
  `Float64Array` with a `Uint32Array` index permutation, preserving selected signal identity by
  domain `id` across sorting and refreshes.
