# Sportsdesk Desk (`ops.sportsdesk.desk`) — Design, Endpoint Parity & Motion Specification

Normative product design document for `packages/nsh-desk`, authored before feature UI changes per
`nsh-design-guides` ("Start from the task", "Establish the app's design system first",
"Designing data-heavy interfaces", and "Motion inventory"), taking direct layout, density, and
native-motion inspiration from the NSH Gallery **`Stocks`** application (`Prev close` … `Turnover`).

## 1. Task, Primary Objects, and 5-Plane Scope ("Start from the task")

- **Primary task:** Operate a high-density, signal-honest sports market & risk surveillance terminal
  against the local `:4020` Sportsdesk daemon (`services/sportsdesk_webview_server.ts`) with full
  endpoint parity, zero fabricated zeroes, explicit provenance badges, and native 60/120fps `<Canvas>`
  market visualizations.
- **5 Workspace Planes (top `SegmentedTabs` switcher):**
  1. **`Markets` (Default — NSH `Stocks` Terminal + Dockable Desk):**
     - **Watchlist Sidebar:** Collapsible **Composite** strip (market index, signed delta, spring-rotated
       chevron revealing advancers/decliners breadth & per-league diverging `SpringBar`s), live pulse
       indicator (`LiveDot`), `All / Gainers / Losers / Active` segmented filter (`LayoutAnimation`),
       and 64pt instrument rows with `<Canvas>` **Sparklines** (dotted `Prev close` line, smooth curve,
       translucent area fill, pulsing latest-point ring) + tabular fair-cents & edge `%`.
     - **Master-Detail Quote & 8-Stat Grid (`Open`, `Prev close`, `Avg price`, `Amplitude`, `Volume`,
       `Turnover`, `Book high`, `Book low`):** Hero price/probability figure, spring-rotated direction
       arrow (`↑`), signed edge bps & delta, spring-animated **`DayRangeBar`** (`L <low>` — `Prev close`
       tick — `H <high>`), and the 2×4 `25%`-width `StatGrid` anchored on `Prev close` … `Turnover`.
     - **Interactive `<Canvas>` Chart, Order Book, Depth, Tape, Flow & Ticket:**
       - Multi-period `<Canvas>` **`MarketChartCanvas`** (`Intraday`, `1m`, `5m`, `15m`, `4W`) with
         `PanResponder` horizontal crosshair scrub (`panActivation={{ activeOffsetX: 6, failOffsetY: 8 }}`),
         dotted `Prev close`, `MA5` line, handle bars, and cursor readout pill.
       - **`Order book`** (`5 → 10` / `10 → 5` `LayoutAnimation` ladder toggle, `BID %` / `spread` /
         `ASK %` `SpringBar`, `A10..A1` & `B1..B10` depth bars) + `<Canvas>` **`DepthChartCanvas`**
         (cumulative bid/ask steps + hatched spread corridor).
       - **`Time & sales`** account/bet tape (`BLOCK` badges, `At ask` / `At bid` / `Blocks` legend),
         **`Trade flow`** diverging `SpringBar`s by stake tier, and **`RangesDumbbellCanvas`**.
       - **`Execution Ticket`** (`DeskDialog` on desktop, `DeskSheet` on compact mobile) wired to
         `GET /api/execution/plan`, `POST /api/execution/mode` (`paper` / `paused`), and
         `POST /api/execution/run` (`auto` / `maker` / `taker` paper-fill) with `- / +` stepper,
         stake presets, risk-cap progress bar, expandable `Review` breakdown, and spring
         `OrderToastBanner`.
     - **Dockable Classic Panels:** Preserves `SignalsPanel` (sortable `Float64Array` `DataTable`),
       `ExposurePanel` (`nsh/base/plot` bar chart), `ScoreboardPanel`, left `KpisPanel` dock, and
       bottom `DiagnosticsPanel` (`#78` `[DATA-STALE]` & `/api/live-bets/summary` `503` honesty).
  2. **`Board` (`Board & Sports` Plane):**
     - `GET /api/game-admin/board?window=24|48|-1` (opener vs current spread/money/total ladders),
       `GET /api/game-admin` (`Straight` / `Parlay` / `Teaser` wager rollups), `GET /api/scoreboard`,
       `GET /api/logo/:team?meta=1&lqip=1` (logo asset dimensions & LQIP probe), `GET /api/sports`,
       `GET /api/sports/catalog` (`19` sports, `230` sub-sports, collisions & migration risks),
       `GET /api/contests?group=...&q=...` (`227` futures filter), and Live Bets `v1` vs `v2` vs
       `summary` vs `live-wagers` (`?source=auto|file|live`) + retired `410` `/api/f402/get-pending`
       guard verification.
  3. **`Surveillance` (`Syndicate Graph & GSLive` Plane):**
     - `GET /api/graph/summary`, `GET /api/graph-feed` (`walletProfiles`, `pendingBets`,
       `perOfficeIpTrackerClusters`, `tenModeSnapshot`, `backtest4Wk` weekly hold & savings),
       `GET /api/graph/stream` bounded SSE frame sampler (`text/event-stream`),
       `GET /api/gslive/weblogs`, `GET /api/gslive/session-health` (`?probe=0|1`), and
       `GET /api/bridge3c/status`.
  4. **`Forensics` (`Agents, Portal Analysis & Customer Book` Plane):**
     - `GET /api/agents/search?q=...&limit=20` typeahead (`>= 2` chars), `GET /api/agent-tree` (flat
       `2,276` nodes + `?view=hierarchy` roots/collisions/problems), `GET /api/analysis/filters`,
       `GET /api/analysis/reports`, `GET /api/analysis?report=...&agent=...&sport=...&week=...`
       (integer cents formatted as USD + discrepancy flags), `GET /api/customer/profile?id=...`,
       `GET /api/customer/rating?id=...` (Bayesian skill & Kelly metrics), and admin-gated
       `GET /api/watchlist`.
  5. **`Ops` (`Health, Governance, Telegram, Parsers & 38-Route Parity` Plane):**
     - `GET /health`, `GET /api/status` (`/status.json`), `GET /api/dns/telemetry`,
       `GET /governance.json` (`/governance` oracle gates, owner scorecards, P0 tasks & decisions),
       Telegram admin console (`GET /api/telegram/status`, `GET /api/telegram/activity`,
       `POST /api/telegram/{webhook,alert,report}`), 9-endpoint interactive **Parser Workbench**
       (`POST /api/parse-{xml,bet-ticker,customer-profile,customer-performance,transactions,ajax-xml,fantasy402-ajax,toml,formdata}`),
       explicit `500` error-boundary sanitizer probe (`GET /api/test/error`), and the live
       **38-Endpoint Parity Matrix** (`Sweep all endpoints`).

## 2. Supported Platform Targets

- **Desktop & Web (`platform.desktop === true`):**
  - Compact 28pt (`sm`) toolbar controls, 28pt dense `DataTable` rows, master-detail split panes,
    pointer hover washes, outward `focus-visible:` rings, `Toolbar` & `Tabs` arrow-key roving focus,
    `keymap` shortcuts (`mod+r`, `mod+1`, `mod+2`, `mod+shift+l`, `mod+shift+c`, `mod+u`), and
    `nsh/desktop` menu bar integration.
- **Mobile (`!platform.desktop`, iOS / Android / narrow viewport `< 760pt`):**
  - Single-column watchlist -> detail drilldown and `DeskSheet` bottom execution ticket with
    `closeOnSwipe`, `DockArea` compact drawers/sheets, and `ios:min-h-11 android:min-h-12` /
    `hitSlop` touch targets (`>= 44pt` / `48dp`).

## 3. Visual System, Scales, and Semantic Theme Tokens (`theme.json`)

All presentation colors — including `<Canvas>` strokes, fills, gridlines, and crosshairs — resolve
exclusively through `theme.json` tokens via Tailwind classes (`bg-card`, `text-positive`) or
`token("<name>")` from `"nsh"`. Raw hex (`#...`), `rgb()`/`rgba()`/`hsl()`, and Tailwind palette
shades (`red-*`, `emerald-*`, `zinc-*`) are strictly prohibited in `.tsx` files; `<Canvas>`
translucency uses `cx.globalAlpha` over semantic `token(...)` colors.

- **Radius scale (concentric):**
  - `--radius-lg`: `8px` — outer cards, floating dialogs, compact sheets.
  - `--radius`: `6px` — default controls, inputs, popovers, menus, tables.
  - `--radius-sm`: `4px` — inset segments, depth bars, and compact badges (`8 - 4 = 4`).
- **Typography scale (minimum 12pt everywhere, `tabular-nums` on all figures):**
  - `text-xl` / `text-base` (20pt / 16pt, `font-semibold font-mono tabular-nums`): hero quote price & primary KPIs.
  - `text-sm` (14pt, `font-semibold` / `font-medium`): workspace title, instrument headers, section titles.
  - `text-xs` (12pt, `font-medium` / `font-normal`): toolbar controls, `StatGrid` labels/values,
    order-book ladders, dense table cells, `<Canvas>` `"12px system-ui"` axis labels (`cx.fontVariantNumeric = "tabular-nums"`).
  - Zero sub-12pt sizes (`text-[9px]`, `text-[10px]`, `text-[11px]` are forbidden).

## 4. Architecture, Root Component (`App.tsx`), `components/`, & `ui/` Layer

Verified statically via `Bun.Transpiler` (`auditNshModuleGraph` in `scripts/nsh_desk_cli.ts`):

- **Pure model (`desk_model.ts`):** Zero runtime imports; pure parsers, `Float64Array` arena,
  `Stocks` instrument synthesis, parser presets, and `DESK_ENDPOINT_CATALOG`.
- **Root (`App.tsx`):** Single `mount(App)` owner, safe-area shell, root `<ErrorBoundary>`,
  `createDeskStore()`, keyboard shortcuts, desktop menu bar, and plane/dock dispatch.
- **Feature views (`components/*`):** `DeskHeader`, `MarketsPanel`, `ExecutionTicketModal`,
  `BoardWorkspace`, `SurveillanceWorkspace`, `ForensicsWorkspace`, `OpsWorkspace`, `SignalsPanel`,
  `ExposurePanel`, `ScoreboardPanel`, `KpisPanel`, `DiagnosticsPanel`. Never import `nsh/base` or
  `nsh/desktop`.
- **Design-system `ui/` layer (`ui/*`):**
  - `ui/tokens.ts` — `MOTION`, focus/popup/scrim tokens, `animateUserLayoutChange()`.
  - `ui/Button.tsx` — `DeskButton` & `DeskIconButton` (`split()`).
  - `ui/Switch.tsx` — `DeskSwitch` (`split()`).
  - `ui/Field.tsx` — `DeskInput`, `DeskSelect`, `DeskSheet` (`split()`).
  - `ui/SegmentedTabs.tsx` — `SegmentedTabs` (`Tabs` + `Tab` spring indicator).
  - `ui/Menu.tsx` — `DeskMenu`, `DeskMenuItem`, `DeskMenuSeparator`.
  - `ui/Dialog.tsx` — `DeskDialog`.
  - `ui/Surface.tsx` — `Surface`, `Badge`, `SectionHeader`, `Separator`, `StateNotice` (`split()`).
  - `ui/DataView.tsx` — `DeskDataTable`, `DeskExposurePlot`, `DeskToolbar`, `DeskWorkspace`.
  - `ui/StockPrimitives.tsx` — `LiveDot`, `SpringBar`, `StatGrid`, `DayRangeBar`,
    `SparklineCanvas`, `MarketChartCanvas`, `DepthChartCanvas`, `RangesDumbbellCanvas`,
    `OrderToastBanner`.
  - `ui/UiKitGallery.tsx` — interactive gallery showcasing every `ui/` primitive in Light & Dark.

## 5. Motion Tokens & Screen Motion Inventory

### Motion Tokens

| Token     | Value / Class                 | Curve             | Purpose                                                       |
| --------- | ----------------------------- | ----------------- | ------------------------------------------------------------- |
| `instant` | `100ms` (`duration-100`)      | `ease-out`        | Pointer hover washes, watchlist row highlight                 |
| `fast`    | `150ms` (`duration-150`)      | `ease-out`        | Button press scale (`0.97`), switch thumb, popup exit         |
| `base`    | `200ms` (`duration-200`)      | `ease-in-out`     | Panel entrance fade, `LayoutAnimation` expand/reorder         |
| `spring`  | `stiffness: 260, damping: 26` | Critically damped | `Tabs` indicator, `SpringBar`, `DayRangeBar` knob, arrow turn |
| `pulse`   | `1600ms` (`keyframes [0, 1]`) | `easeOut`         | `LiveDot` & Sparkline latest-point native `<Canvas>` ring     |

### Motion Inventory (`ops.sportsdesk.desk`)

| #   | State Change Kind            | Concrete Screen Element                                                                                       | Tool & Motion Tokens                                                                                                                                                         | `reduceMotion` Behavior                                                                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Press & hover on controls    | `DeskButton`, `DeskSelect` trigger, Watchlist ticker rows, `Order book` `5 → 10` chip                         | `transition duration-100 ease-out hover:bg-accent active:scale-[0.97] duration-150`                                                                                          | `motion-reduce:transition-none motion-reduce:active:scale-100`                             |
| 2   | Glyph or direction rotation  | Quote direction arrow (`↑` `0deg` ↔ `180deg`), Composite breadth chevron (`›` `0deg` ↔ `90deg`), `DeskSwitch` | `createAnimatedValue` `.spring(deg, { stiffness: 280, damping: 24 })` bound to `transform: [{ rotate }]`; frequent poll ms counter uses **no motion**                        | `.set(deg)` jumps immediately when `reduceMotion()` is true                                |
| 3   | Selection that moves         | Top 5-plane `SegmentedTabs`, Watchlist `All/Gainers/Losers/Active`, Chart period `Intraday..4W`, League tabs  | `nsh/base` `Tabs` single `indicatorClass` sliding natively via `spring_move`                                                                                                 | Native `Tabs` indicator snaps without travel                                               |
| 4   | Watchlist & ladder layout    | Composite breadth expand/collapse, Watchlist filter reorder, Order Book `5 → 10` toggle, Ticket `Review`      | `animateUserLayoutChange()` (`LayoutAnimation.configureNext` `200ms` `easeInEaseOut` `opacity`) invoked strictly on user command                                             | `if (reduceMotion()) return;` — immediate layout commit                                    |
| 5   | Continuous proportion bars   | Composite league breadth bars, Order Book `BID %`/`ASK %` bar, `Trade flow` diverging bars, `DayRangeBar`     | `SpringBar` & `DayRangeBar` drive `createAnimatedValue` `translateX` via `.spring(target, { stiffness: 240, damping: 26 })` on UI thread                                     | `.set(target)` snaps bar & range knob without spring travel                                |
| 6   | Interactive chart scrub      | `MarketChartCanvas` horizontal crosshair & floating price/time pill                                           | `PanResponder` (`activeOffsetX: 6, failOffsetY: 8`) updates cursor index 1:1 with pointer/finger; `calm(0.22)` dampens Y-axis bounds across period switches                  | 1:1 direct scrub tracking preserved (user-driven gesture)                                  |
| 7   | Surface opening or closing   | `Execution Ticket` (`DeskDialog` / `DeskSheet`), `UI kit…` `DeskDialog`, `Workspace` `DeskMenu`, `DeskSelect` | `Dialog` `animation="fade"`, `Sheet` edge slide + scrim fade (`closeOnSwipe`), `Menu` scale/fade popup classes                                                               | `Dialog` `animation="none"`, `Sheet` & `Menu` settle instantly                             |
| 8   | Action confirmation toast    | `OrderToastBanner` after paper execution run / mode switch / parser or webhook run                            | `createAnimatedValue` `translateY` (`-12` → `0`) + `opacity` (`0` → `1`) spring entrance, auto-dismiss after `4s`                                                            | Appears at `translateY: 0, opacity: 1` immediately                                         |
| 9   | Content arriving & tables    | Initial `loading` → `ready` panel fade; `DataTable` sorted cells & polling refreshes                          | Panel ready wrapper runs `createMotion({ enter: "fadeIn", duration: 150 })` once; `DataTable` rows and background poll updates use **no motion** so figures stay razor-sharp | `createMotion` lands at rest immediately                                                   |
| 10  | Live telemetry pulse & sound | `LiveDot` in Watchlist header & Sparkline latest-point ring while `Auto 10s` is active; audio                 | `<Canvas>` reads `AnimatedValue` `pulse` (`cx.arc` radius & `cx.globalAlpha` animated natively without JS re-recording); **no audio**                                        | Static crisp dot at rest (`pulse.set(0)`), zero loop keyframes when `reduceMotion()` is on |
